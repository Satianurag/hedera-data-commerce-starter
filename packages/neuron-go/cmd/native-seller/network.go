package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/sha3"
)

const mirrorURL = "https://testnet.mirrornode.hedera.com/api/v1"
const rpcURL = "https://testnet.hashio.io/api"

type networkReader struct{ client *http.Client }

func newNetworkReader() networkReader {
	return networkReader{&http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (n networkReader) request(ctx context.Context, method, url string, body []byte, out any) error {
	r, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := n.client.Do(r)
	if err != nil {
		return errors.New("network request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("network resource returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return errors.New("network response exceeded bound")
	}
	return json.Unmarshal(data, out)
}

func (n networkReader) get(ctx context.Context, path string, out any) error {
	return n.request(ctx, http.MethodGet, mirrorURL+path, nil, out)
}

func (n networkReader) rpc(ctx context.Context, method string, params any, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	var envelope struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if err := n.request(ctx, http.MethodPost, rpcURL, body, &envelope); err != nil {
		return err
	}
	if envelope.JSONRPC != "2.0" || envelope.ID != 1 || len(envelope.Result) == 0 || string(envelope.Result) == "null" || (len(envelope.Error) > 0 && string(envelope.Error) != "null") {
		return errors.New("RPC returned no verified result")
	}
	return json.Unmarshal(envelope.Result, out)
}

func hexBytes(s string) ([]byte, error) {
	if !strings.HasPrefix(s, "0x") || len(s)%2 != 0 {
		return nil, errors.New("invalid hex bytes")
	}
	return hex.DecodeString(s[2:])
}
func quantity(s string) (*big.Int, error) {
	if !strings.HasPrefix(s, "0x") || len(s) < 3 || len(s) > 66 {
		return nil, errors.New("invalid RPC quantity")
	}
	n, ok := new(big.Int).SetString(s[2:], 16)
	if !ok || n.Sign() < 0 {
		return nil, errors.New("invalid RPC integer")
	}
	return n, nil
}
func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func keccak(data []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write(data)
	return h.Sum(nil)
}
func uintWord(n *big.Int) []byte { word := make([]byte, 32); n.FillBytes(word); return word }
func addressWord(word []byte) (string, error) {
	if len(word) != 32 || !bytes.Equal(word[:12], make([]byte, 12)) {
		return "", errors.New("noncanonical ABI address")
	}
	return "0x" + hex.EncodeToString(word[12:]), nil
}

type account struct {
	Account    string `json:"account"`
	Deleted    *bool  `json:"deleted"`
	EVMAddress string `json:"evm_address"`
	Key        struct {
		Type string `json:"_type"`
		Key  string `json:"key"`
	} `json:"key"`
}

func (n networkReader) account(ctx context.Context, id string) (account, error) {
	var a account
	if err := n.get(ctx, "/accounts/"+id, &a); err != nil {
		return a, err
	}
	if a.Deleted == nil || *a.Deleted || a.Account != id || a.Key.Type != "ECDSA_SECP256K1" || len(a.Key.Key) != 66 || !addressPattern.MatchString(strings.ToLower(a.EVMAddress)) {
		return a, errors.New("account is not an active ECDSA testnet identity")
	}
	return a, nil
}

func (n networkReader) openTopic(ctx context.Context, id string) error {
	var t struct {
		ID         string          `json:"topic_id"`
		Deleted    *bool           `json:"deleted"`
		SubmitKey  json.RawMessage `json:"submit_key"`
		CustomFees struct {
			FixedFees []json.RawMessage `json:"fixed_fees"`
		} `json:"custom_fees"`
	}
	if err := n.get(ctx, "/topics/"+id, &t); err != nil {
		return err
	}
	if t.Deleted == nil || *t.Deleted || t.ID != id || string(t.SubmitKey) != "null" || t.CustomFees.FixedFees == nil || len(t.CustomFees.FixedFees) != 0 {
		return errors.New("request topic must be active, open, and free of custom fees")
	}
	return nil
}

type escrowSnapshot struct {
	BlockNumber    string `json:"blockNumber"`
	BlockTimestamp int64  `json:"blockTimestamp"`
}

// All mutable contract reads use the same block. Runtime pinning makes the
// Funded event and storage tuple meaningful rather than trusting arbitrary ABI.
func (n networkReader) verifyEscrow(ctx context.Context, c config, sellerAddress string, now time.Time) (escrowSnapshot, error) {
	var snap escrowSnapshot
	var chain string
	if err := n.rpc(ctx, "eth_chainId", []any{}, &chain); err != nil {
		return snap, err
	}
	if chain != "0x128" {
		return snap, errors.New("RPC is not Hedera testnet")
	}
	var metadata struct {
		ID      string `json:"contract_id"`
		Address string `json:"evm_address"`
		Deleted *bool  `json:"deleted"`
	}
	if err := n.get(ctx, "/contracts/"+c.EscrowContractID, &metadata); err != nil {
		return snap, err
	}
	if metadata.Deleted == nil || *metadata.Deleted || metadata.ID != c.EscrowContractID || !strings.EqualFold(metadata.Address, c.EscrowContractAddress) {
		return snap, errors.New("escrow contract ID and address do not match Mirror")
	}
	var block struct {
		Number    string `json:"number"`
		Timestamp string `json:"timestamp"`
	}
	if err := n.rpc(ctx, "eth_getBlockByNumber", []any{"latest", false}, &block); err != nil {
		return snap, err
	}
	blockNumber, err := quantity(block.Number)
	if err != nil {
		return snap, err
	}
	stamp, err := quantity(block.Timestamp)
	if err != nil || !stamp.IsInt64() {
		return snap, errors.New("invalid chain timestamp")
	}
	snap = escrowSnapshot{block.Number, stamp.Int64()}
	if snap.BlockTimestamp > now.Unix()+30 || snap.BlockTimestamp < now.Unix()-120 || c.RefundAfter <= snap.BlockTimestamp+int64(c.DurationSeconds)+15 || c.RefundAfter <= now.Unix()+int64(c.DurationSeconds)+15 {
		return snap, errors.New("escrow is too close to refund deadline or chain state is stale")
	}
	var code string
	if err := n.rpc(ctx, "eth_getCode", []any{c.EscrowContractAddress, block.Number}, &code); err != nil {
		return snap, err
	}
	runtime, err := hexBytes(code)
	if err != nil || len(runtime) == 0 || digest(runtime) != c.RuntimeSHA256 {
		return snap, errors.New("escrow runtime does not match reviewed build")
	}
	id, _ := positiveUint(c.EscrowID)
	input := append(keccak([]byte("escrows(uint256)"))[:4], uintWord(id)...)
	var storage string
	if err := n.rpc(ctx, "eth_call", []any{map[string]string{"to": c.EscrowContractAddress, "data": "0x" + hex.EncodeToString(input)}, block.Number}, &storage); err != nil {
		return snap, err
	}
	encoded, err := hexBytes(storage)
	if err != nil {
		return snap, err
	}
	if err = verifyStorage(encoded, c, sellerAddress); err != nil {
		return snap, err
	}
	var receipt struct {
		Status      string     `json:"status"`
		Hash        string     `json:"transactionHash"`
		BlockNumber string     `json:"blockNumber"`
		From        string     `json:"from"`
		To          string     `json:"to"`
		Logs        []chainLog `json:"logs"`
	}
	if err := n.rpc(ctx, "eth_getTransactionReceipt", []any{c.FundingTransactionHash}, &receipt); err != nil {
		return snap, err
	}
	receiptBlock, err := quantity(receipt.BlockNumber)
	if err != nil || receiptBlock.Cmp(blockNumber) > 0 || receipt.Status != "0x1" || !strings.EqualFold(receipt.Hash, c.FundingTransactionHash) || !strings.EqualFold(receipt.From, c.BuyerWalletAddress) || !strings.EqualFold(receipt.To, c.EscrowContractAddress) {
		return snap, errors.New("funding receipt is not the exact successful buyer transaction")
	}
	if err = verifyFundedLogs(receipt.Logs, c, sellerAddress); err != nil {
		return snap, err
	}
	return snap, nil
}

func verifyStorage(encoded []byte, c config, seller string) error {
	if len(encoded) != 7*32 {
		return errors.New("invalid escrow storage encoding")
	}
	buyer, e1 := addressWord(encoded[:32])
	payee, e2 := addressWord(encoded[32:64])
	amount, _ := positiveUint(c.AmountTinybar)
	if e1 != nil || e2 != nil || buyer != c.BuyerWalletAddress || payee != seller || new(big.Int).SetBytes(encoded[64:96]).Cmp(amount) != 0 || new(big.Int).SetBytes(encoded[96:128]).Cmp(big.NewInt(c.QuoteExpiresAt)) != 0 || new(big.Int).SetBytes(encoded[128:160]).Cmp(big.NewInt(c.RefundAfter)) != 0 || "0x"+hex.EncodeToString(encoded[160:192]) != c.TermsHash || new(big.Int).SetBytes(encoded[192:224]).Cmp(big.NewInt(1)) != 0 {
		return errors.New("escrow is not the exact funded buyer, seller, amount, terms, and deadline")
	}
	return nil
}

type chainLog struct {
	Address         string   `json:"address"`
	Topics          []string `json:"topics"`
	Data            string   `json:"data"`
	TransactionHash string   `json:"transactionHash"`
	Removed         bool     `json:"removed"`
}

func verifyFundedLogs(logs []chainLog, c config, seller string) error {
	event := "0x" + hex.EncodeToString(keccak([]byte("Funded(uint256,address,address,uint256,uint64,uint64,bytes32)")))
	id, _ := positiveUint(c.EscrowID)
	amount, _ := positiveUint(c.AmountTinybar)
	matches := 0
	for _, l := range logs {
		if !strings.EqualFold(l.Address, c.EscrowContractAddress) || len(l.Topics) == 0 || !strings.EqualFold(l.Topics[0], event) {
			continue
		}
		if l.Removed || !strings.EqualFold(l.TransactionHash, c.FundingTransactionHash) || len(l.Topics) != 4 {
			return errors.New("invalid funding event")
		}
		data, err := hexBytes(l.Data)
		buyerBytes, e2 := hexBytes(l.Topics[2])
		buyer, e3 := addressWord(buyerBytes)
		if err != nil || e2 != nil || e3 != nil || len(data) != 128 {
			return errors.New("invalid funding event data")
		}
		payee, err := addressWord(data[:32])
		if err != nil || buyer != c.BuyerWalletAddress || payee != seller || !strings.EqualFold(l.Topics[1], "0x"+hex.EncodeToString(uintWord(id))) || !strings.EqualFold(l.Topics[3], c.TermsHash) || new(big.Int).SetBytes(data[32:64]).Cmp(amount) != 0 || new(big.Int).SetBytes(data[64:96]).Cmp(big.NewInt(c.QuoteExpiresAt)) != 0 || new(big.Int).SetBytes(data[96:128]).Cmp(big.NewInt(c.RefundAfter)) != 0 {
			return errors.New("funding event differs from configured terms")
		}
		matches++
	}
	if matches != 1 {
		return errors.New("expected exactly one matching Funded event")
	}
	return nil
}
