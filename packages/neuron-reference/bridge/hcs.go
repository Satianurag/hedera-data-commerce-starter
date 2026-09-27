package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/crypto"
	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"github.com/neuron-sdk/neuron-go-sdk/internal/keylib"
	"github.com/neuron-sdk/neuron-go-sdk/internal/topic"
)

func (s *server) mirrorJSON(ctx context.Context, path string, v any) error {
	if !strings.HasPrefix(path, "/api/v1/") {
		return errors.New("unexpected Mirror path")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", mirror+path, nil)
	if e != nil {
		return e
	}
	resp, e := s.http.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("Mirror returned HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(v)
}
func (s *server) preflight(ctx context.Context) error {
	chain, e := s.rpc.ChainID(ctx)
	if e != nil {
		return e
	}
	if chain.Uint64() != 296 {
		return errors.New("RPC is not Hedera testnet")
	}
	for _, pair := range [][2]string{{s.cfg.EscrowAddress, s.cfg.EscrowRuntimeCodeHash}, {s.cfg.TokenAddress, s.cfg.TokenRuntimeCodeHash}} {
		code, e := s.rpc.CodeAt(ctx, hexAddress(pair[0]), nil)
		if e != nil {
			return e
		}
		if len(code) == 0 || !strings.EqualFold(crypto.Keccak256Hash(code).Hex(), pair[1]) {
			return errors.New("contract runtime bytecode mismatch")
		}
	}
	for _, pair := range [][2]string{{s.cfg.OperatorAccountID, s.operatorKey.PublicKey().StringRaw()}, {s.cfg.SellerAccountID, hex.EncodeToString(crypto.CompressPubkey(&s.sellerECDSA.PublicKey))}} {
		var account struct {
			Account    string `json:"account"`
			Deleted    *bool  `json:"deleted"`
			EVMAddress string `json:"evm_address"`
			Key        *struct {
				Type string `json:"_type"`
				Key  string `json:"key"`
			} `json:"key"`
		}
		if e = s.mirrorJSON(ctx, "/api/v1/accounts/"+pair[0], &account); e != nil {
			return e
		}
		if account.Account != pair[0] || account.Deleted == nil || *account.Deleted || account.Key == nil || account.Key.Type != "ECDSA_SECP256K1" || !strings.EqualFold(account.Key.Key, pair[1]) {
			return errors.New("configured signer does not match active testnet account")
		}
		if pair[0] == s.cfg.SellerAccountID && !strings.EqualFold(account.EVMAddress, s.seller.Hex()) {
			return errors.New("seller EVM alias mismatch")
		}
	}
	for _, id := range []string{s.cfg.BuyerTopicID, s.cfg.SellerTopicID} {
		var t struct {
			ID         string `json:"topic_id"`
			Deleted    *bool  `json:"deleted"`
			SubmitKey  any    `json:"submit_key"`
			CustomFees struct {
				FixedFees []json.RawMessage `json:"fixed_fees"`
			} `json:"custom_fees"`
		}
		if e = s.mirrorJSON(ctx, "/api/v1/topics/"+id, &t); e != nil {
			return e
		}
		if t.ID != id || t.Deleted == nil || *t.Deleted || t.SubmitKey != nil || t.CustomFees.FixedFees == nil || len(t.CustomFees.FixedFees) > 0 {
			return errors.New("expected active open zero-custom-fee topic")
		}
	}
	decimals, e := s.tokenContract.Decimals(&bind.CallOpts{Context: ctx})
	if e != nil {
		return e
	}
	symbol, e := s.tokenContract.Symbol(&bind.CallOpts{Context: ctx})
	if e != nil {
		return e
	}
	if decimals != s.cfg.TokenDecimals || symbol != s.cfg.TokenSymbol {
		return errors.New("ERC20 metadata does not match configuration")
	}
	return nil
}

type mirrorRow struct {
	TopicID   string `json:"topic_id"`
	Payer     string `json:"payer_account_id"`
	Message   string `json:"message"`
	Sequence  uint64 `json:"sequence_number"`
	Consensus string `json:"consensus_timestamp"`
	Chunk     *struct {
		Number  int `json:"number"`
		Total   int `json:"total"`
		Initial struct {
			Account   string `json:"account_id"`
			Start     string `json:"transaction_valid_start"`
			Nonce     int    `json:"nonce"`
			Scheduled bool   `json:"scheduled"`
		} `json:"initial_transaction_id"`
	} `json:"chunk_info"`
}

func (s *server) verifyMessage(ctx context.Context, m *hcsMessage) error {
	tx, e := hiero.TransactionIdFromString(m.TransactionID)
	if e != nil || tx.ValidStart == nil || tx.AccountID == nil {
		return errors.New("invalid persisted HCS transaction ID")
	}
	start := fmt.Sprintf("%d.%09d", tx.ValidStart.Unix(), tx.ValidStart.Nanosecond())
	total := (len(m.Envelope) + 1023) / 1024
	for {
		chunks := map[int]mirrorRow{}
		path := "/api/v1/topics/" + m.TopicID + "/messages?limit=100&order=desc"
		for page := 0; page < 5; page++ {
			var p struct {
				Messages []mirrorRow `json:"messages"`
				Links    struct {
					Next string `json:"next"`
				} `json:"links"`
			}
			if e = s.mirrorJSON(ctx, path, &p); e != nil {
				break
			}
			for _, row := range p.Messages {
				if row.Chunk == nil {
					// Mirror can omit chunk metadata for a singleton. Bind it
					// to the preassigned transaction through its independent
					// transaction consensus timestamp, not identical bytes alone.
					decoded, decodeErr := base64.StdEncoding.Strict().DecodeString(row.Message)
					if total != 1 || decodeErr != nil || row.Payer != s.cfg.OperatorAccountID || row.TopicID != m.TopicID || !bytes.Equal(decoded, m.Envelope) {
						continue
					}
					var transactions struct {
						Rows []struct {
							Name      string `json:"name"`
							Result    string `json:"result"`
							Consensus string `json:"consensus_timestamp"`
							Nonce     int    `json:"nonce"`
							Scheduled bool   `json:"scheduled"`
						} `json:"transactions"`
					}
					txPath := fmt.Sprintf("/api/v1/transactions/%s-%d-%09d", tx.AccountID.String(), tx.ValidStart.Unix(), tx.ValidStart.Nanosecond())
					if lookupErr := s.mirrorJSON(ctx, txPath, &transactions); lookupErr != nil {
						continue
					}
					for _, record := range transactions.Rows {
						if record.Name == "CONSENSUSSUBMITMESSAGE" && record.Result == "SUCCESS" && record.Nonce == 0 && !record.Scheduled && record.Consensus == row.Consensus {
							if _, duplicate := chunks[1]; duplicate {
								return errors.New("duplicate selected HCS singleton")
							}
							chunks[1] = row
						}
					}
					continue
				}
				if row.Chunk.Initial.Account != s.cfg.OperatorAccountID || row.Chunk.Initial.Start != start {
					continue
				}
				c := row.Chunk
				if row.TopicID != m.TopicID || row.Payer != s.cfg.OperatorAccountID || c.Total != total || c.Number < 1 || c.Number > total || c.Initial.Nonce != 0 || c.Initial.Scheduled {
					return errors.New("Mirror message metadata mismatch")
				}
				if _, duplicate := chunks[c.Number]; duplicate {
					return errors.New("duplicate selected HCS chunk")
				}
				chunks[c.Number] = row
			}
			if len(chunks) == total {
				break
			}
			if p.Links.Next == "" {
				break
			}
			u, e := url.Parse(p.Links.Next)
			if e != nil || u.IsAbs() || u.Host != "" || u.Path != "/api/v1/topics/"+m.TopicID+"/messages" {
				return errors.New("Mirror next escaped selected topic")
			}
			path = u.String()
		}
		if len(chunks) == total {
			var raw []byte
			for n := 1; n <= total; n++ {
				b, e := base64.StdEncoding.Strict().DecodeString(chunks[n].Message)
				if e != nil {
					return e
				}
				raw = append(raw, b...)
			}
			if !bytes.Equal(raw, m.Envelope) {
				return errors.New("Mirror bytes do not match signed envelope")
			}
			signed, e := topic.TopicMessageFromJSON(raw)
			if e != nil {
				return e
			}
			if e = topic.ValidateTopicMessage(signed); e != nil {
				return e
			}
			if signed.SenderAddress() != m.SenderAddress || !bytes.Equal(signed.Payload(), m.Payload) {
				return errors.New("Mirror sender/payload binding mismatch")
			}
			m.MirrorVerified = true
			m.SequenceNumber = strconv.FormatUint(chunks[total].Sequence, 10)
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("HCS indexing unconfirmed; reconcile saved transaction before retry")
		case <-time.After(2 * time.Second):
		}
	}
}
func (s *server) publish(v *session, kind string, payload any, seller bool) error {
	// A crash or HTTP timeout resumes the same signed bytes and transaction ID.
	for i := range v.Messages {
		if v.Messages[i].Kind == kind {
			m := &v.Messages[i]
			if m.MirrorVerified {
				return nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			if e := s.verifyMessage(ctx, m); e != nil {
				return e
			}
			return s.save(v)
		}
	}
	p, e := json.Marshal(payload)
	if e != nil {
		return e
	}
	key := &s.buyerKey
	inbox := s.cfg.SellerTopicID
	if seller {
		key = &s.sellerKey
		inbox = s.cfg.BuyerTopicID
	}
	// Nanoseconds are a monotonic sender sequence across independent sessions;
	// actual prior maximum is retained by every persisted signed envelope.
	seq := uint64(time.Now().UnixNano())
	for _, old := range s.sessions {
		for _, m := range old.Messages {
			if m.SenderAddress == key.PublicKey().EVMAddress().Hex() {
				var envelope topic.TopicMessage
				if json.Unmarshal(m.Envelope, &envelope) == nil && envelope.SequenceNumber() >= seq {
					seq = envelope.SequenceNumber() + 1
				}
			}
		}
	}
	signed, e := topic.NewTopicMessage(key, uint64(time.Now().UnixNano()), seq, p)
	if e != nil {
		return e
	}
	raw, e := json.Marshal(signed)
	if e != nil {
		return e
	}
	if len(raw) > 8192 {
		return errors.New("signed payload exceeds 8 HCS chunks")
	}
	account, _ := hiero.AccountIDFromString(s.cfg.OperatorAccountID)
	id := hiero.TransactionIDGenerate(account)
	hash := sha256.Sum256(raw)
	v.Messages = append(v.Messages, hcsMessage{Kind: kind, TopicID: inbox, SequenceNumber: "0", TransactionID: id.String(), SHA256: hex.EncodeToString(hash[:]), SenderAddress: signed.SenderAddress(), Payload: p, Envelope: raw})
	if e = s.save(v); e != nil {
		return e
	}
	tid, _ := hiero.TopicIDFromString(inbox)
	tx := hiero.NewTopicMessageSubmitTransaction().SetTopicID(tid).SetMessage(raw).SetTransactionID(id).SetChunkSize(1024).SetMaxChunks(8).SetMaxTransactionFee(hiero.HbarFromTinybar(s.cfg.MaxHCSFeeTinybar / int64((len(raw)+1023)/1024)))
	_, e = tx.ExecuteAll(s.hcs)
	// Even a network failure may mean consensus accepted the message. Never
	// resubmit. A later request re-runs this read-only reconciliation.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	verifyErr := s.verifyMessage(ctx, &v.Messages[len(v.Messages)-1])
	if verifyErr != nil {
		return verifyErr
	}
	return s.save(v)
}
func canonicalKeyAddress(key *keylib.NeuronPrivateKey) string {
	return key.PublicKey().EVMAddress().Hex()
}
