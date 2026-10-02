package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/multiformats/go-multiaddr"
	"neuron-customer-app/neuron-go/legacy"
)

func testConfig() config {
	return config{Schema: "neuronNativeSeller/v1", Network: "testnet", SellerAccountID: "0.0.100", SellerKeyFile: "/tmp/key", SellerStdinTopicID: "0.0.101", BuyerTransportAccountID: "0.0.200", BuyerStdinTopicID: "0.0.201", BuyerSharedAccountID: "0.0.202", PayerAccountID: "0.0.300", RequestSequence: 7, RequestSHA256: strings.Repeat("a", 64), BuyerWalletAddress: "0x" + strings.Repeat("1", 40), EscrowContractID: "0.0.400", EscrowContractAddress: "0x" + strings.Repeat("4", 40), RuntimeSHA256: strings.Repeat("b", 64), FundingTransactionHash: "0x" + strings.Repeat("c", 64), EscrowID: "9", TermsHash: "0x" + strings.Repeat("d", 64), AmountTinybar: "1000000", QuoteExpiresAt: 1000, RefundAfter: 2000, SourceFile: "/tmp/source", SourceSHA256: strings.Repeat("e", 64), DurationSeconds: 1, JournalFile: "/tmp/journal"}
}

func scalar(v byte) []byte { out := make([]byte, 32); out[31] = v; return out }
func evm(public []byte) string {
	key, _ := secp256k1.ParsePubKey(public)
	return "0x" + hex.EncodeToString(keccak(key.SerializeUncompressed()[1:])[12:])
}
func buyerFixture() account {
	key := secp256k1.PrivKeyFromBytes(scalar(2)).PubKey().SerializeCompressed()
	a := account{Account: "0.0.200", EVMAddress: evm(key)}
	a.Key.Type = "ECDSA_SECP256K1"
	a.Key.Key = hex.EncodeToString(key)
	return a
}
func encryptedRequest(t *testing.T, c config, target string) []byte {
	t.Helper()
	buyer := buyerFixture()
	public, _ := hex.DecodeString(buyer.Key.Key)
	pk, _ := secp256k1.ParsePubKey(public)
	secret := secp256k1.GenerateSharedSecret(secp256k1.PrivKeyFromBytes(scalar(1)), pk)
	block, _ := aes.NewCipher(secret)
	plain := []byte("[" + target + "]")
	encrypted := make([]byte, len(plain))
	iv := []byte("yakfOMkPmf13a75EhWE795l9+be6/xcB+Duba5kvRfBHHqtCnUFYvKZlxLWFtVJQ")
	cipher.NewCFBEncrypter(block, iv[len(iv)-16:]).XORKeyStream(encrypted, plain)
	r := serviceRequest{MessageType: "serviceRequest", EncryptedAddress: encrypted, StdinTopic: 201, EVMAddress: strings.TrimPrefix(buyer.EVMAddress, "0x"), PublicKey: buyer.Key.Key, ServiceType: legacy.ADSBProtocol, SLAAgreed: 1, SharedAccount: 202, Version: "0.4"}
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestHCSRequestRequiresExactFreshEvidence(t *testing.T) {
	c := testConfig()
	now := time.Unix(1700000000, 0)
	data := encryptedRequest(t, c, "/ip4/8.8.8.8/udp/4000/quic-v1")
	c.RequestSHA256 = digest(data)
	base := hcsMessage{TopicID: c.SellerStdinTopicID, Sequence: c.RequestSequence, Payer: c.PayerAccountID, Consensus: "1700000000.000000000", Message: base64.StdEncoding.EncodeToString(data)}
	got, err := requestBytes(base, c, now)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("valid request rejected: %v", err)
	}
	cases := map[string]func(*hcsMessage){"wrong topic": func(m *hcsMessage) { m.TopicID = "0.0.999" }, "wrong payer": func(m *hcsMessage) { m.Payer = c.BuyerTransportAccountID }, "wrong sequence": func(m *hcsMessage) { m.Sequence++ }, "old": func(m *hcsMessage) { m.Consensus = "1699999399.000000000" }, "future": func(m *hcsMessage) { m.Consensus = "1700000031.000000000" }, "bad timestamp": func(m *hcsMessage) { m.Consensus = "1700000000.x" }, "tampered": func(m *hcsMessage) { m.Message = base64.StdEncoding.EncodeToString([]byte("{}")) }, "multipart": func(m *hcsMessage) {
		m.ChunkInfo = &struct {
			Number int `json:"number"`
			Total  int `json:"total"`
		}{1, 2}
	}}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			m := base
			change(&m)
			if _, err := requestBytes(m, c, now); err == nil {
				t.Fatal("untrusted request accepted")
			}
		})
	}
}

func TestDecryptRequestBindsBuyerProtocolAndTarget(t *testing.T) {
	c := testConfig()
	target := "/ip4/8.8.8.8/udp/4000/quic-v1"
	data := encryptedRequest(t, c, target)
	buyer := buyerFixture()
	_, got, err := verifyRequest(data, c, buyer, scalar(1))
	if err != nil || got.String() != target {
		t.Fatalf("valid ECDH request rejected: %v", err)
	}
	changes := map[string]func(*serviceRequest){"wrong service": func(r *serviceRequest) { r.SLAAgreed = 2 }, "wrong protocol": func(r *serviceRequest) { r.ServiceType = "other" }, "wrong key": func(r *serviceRequest) {
		r.PublicKey = hex.EncodeToString(secp256k1.PrivKeyFromBytes(scalar(3)).PubKey().SerializeCompressed())
	}, "wrong address": func(r *serviceRequest) { r.EVMAddress = strings.Repeat("4", 40) }, "wrong stdin": func(r *serviceRequest) { r.StdinTopic++ }, "wrong shared": func(r *serviceRequest) { r.SharedAccount++ }, "wrong version": func(r *serviceRequest) { r.Version = "0.5" }, "wrong message": func(r *serviceRequest) { r.MessageType = "scheduleRequest" }}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			var r serviceRequest
			_ = json.Unmarshal(data, &r)
			change(&r)
			bad, _ := json.Marshal(r)
			if _, _, err := verifyRequest(bad, c, buyer, scalar(1)); err == nil {
				t.Fatal("invalid buyer request accepted")
			}
		})
	}
	if _, _, err := verifyRequest(data, c, buyer, scalar(3)); err == nil {
		t.Fatal("different seller key decrypted request")
	}
	duplicate := append([]byte(`{"s":2,`), data[1:]...)
	if _, _, err := verifyRequest(duplicate, c, buyer, scalar(1)); err == nil {
		t.Fatal("duplicate JSON accepted")
	}
	if _, _, err := verifyRequest(encryptedRequest(t, c, "/ip4/169.254.169.254/udp/80/quic-v1"), c, buyer, scalar(1)); err == nil {
		t.Fatal("metadata destination accepted")
	}
}

func TestTargetRejectsSSRFAndLimitsLoopbackException(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "127.0.0.2", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"} {
		if _, err := targetAddress("/ip4/"+ip+"/udp/443/quic-v1", ""); err == nil {
			t.Errorf("nonpublic %s accepted", ip)
		}
	}
	for _, value := range []string{"/dns4/example.com/udp/443/quic-v1", "/ip4/8.8.8.8/tcp/443", "/ip4/8.8.8.8/udp/0/quic-v1", "/ip4/8.8.8.8/udp/0443/quic-v1", "/ip4/8.8.8.8/udp/443/quic-v1/p2p/id", "/ip4/8.8.8.8/udp/443/quic-v1 /ip4/1.1.1.1/udp/443/quic-v1"} {
		if _, err := targetAddress(value, ""); err == nil {
			t.Errorf("malformed %s accepted", value)
		}
	}
	target := "/ip4/127.0.0.1/udp/4444/quic-v1"
	if _, err := targetAddress(target, target); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"/ip4/127.0.0.1/udp/4445/quic-v1", "/ip4/127.0.0.2/udp/4444/quic-v1", "/ip4/8.8.8.8/udp/4444/quic-v1"} {
		if _, err := targetAddress(value, target); err == nil {
			t.Errorf("unpinned local target accepted %s", value)
		}
	}
	if _, err := targetAddress("/ip4/10.0.0.1/udp/4444/quic-v1", "/ip4/10.0.0.1/udp/4444/quic-v1"); err == nil {
		t.Fatal("private network exception accepted")
	}
}

func addressBytes(s string) []byte {
	data, _ := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	return append(make([]byte, 12), data...)
}
func storageFixture(c config, seller string) []byte {
	amount, _ := positiveUint(c.AmountTinybar)
	terms, _ := hexBytes(c.TermsHash)
	out := append(addressBytes(c.BuyerWalletAddress), addressBytes(seller)...)
	out = append(out, uintWord(amount)...)
	out = append(out, uintWord(big.NewInt(c.QuoteExpiresAt))...)
	out = append(out, uintWord(big.NewInt(c.RefundAfter))...)
	out = append(out, terms...)
	out = append(out, uintWord(big.NewInt(1))...)
	return out
}
func fundedFixture(c config, seller string) chainLog {
	id, _ := positiveUint(c.EscrowID)
	amount, _ := positiveUint(c.AmountTinybar)
	data := append(addressBytes(seller), uintWord(amount)...)
	data = append(data, uintWord(big.NewInt(c.QuoteExpiresAt))...)
	data = append(data, uintWord(big.NewInt(c.RefundAfter))...)
	return chainLog{Address: c.EscrowContractAddress, TransactionHash: c.FundingTransactionHash, Topics: []string{"0x" + hex.EncodeToString(keccak([]byte("Funded(uint256,address,address,uint256,uint64,uint64,bytes32)"))), "0x" + hex.EncodeToString(uintWord(id)), "0x" + hex.EncodeToString(addressBytes(c.BuyerWalletAddress)), c.TermsHash}, Data: "0x" + hex.EncodeToString(data)}
}

func TestEscrowAndFundingEvidenceRequiresExactTerms(t *testing.T) {
	c := testConfig()
	seller := "0x" + strings.Repeat("5", 40)
	storage := storageFixture(c, seller)
	event := fundedFixture(c, seller)
	if err := verifyStorage(storage, c, seller); err != nil {
		t.Fatal(err)
	}
	if err := verifyFundedLogs([]chainLog{event}, c, seller); err != nil {
		t.Fatal(err)
	}
	for word := 0; word < 7; word++ {
		t.Run(fmt.Sprint("storage word ", word), func(t *testing.T) {
			bad := append([]byte(nil), storage...)
			bad[(word+1)*32-1] ^= 1
			if err := verifyStorage(bad, c, seller); err == nil {
				t.Fatal("changed storage accepted")
			}
		})
	}
	if err := verifyStorage(append(storage, 0), c, seller); err == nil {
		t.Fatal("trailing storage accepted")
	}
	for _, state := range []int64{0, 2, 3, 4} {
		bad := append([]byte(nil), storage...)
		copy(bad[192:], uintWord(big.NewInt(state)))
		if err := verifyStorage(bad, c, seller); err == nil {
			t.Errorf("nonfunded state %d accepted", state)
		}
	}
	if err := verifyFundedLogs(nil, c, seller); err == nil {
		t.Fatal("missing event accepted")
	}
	if err := verifyFundedLogs([]chainLog{event, event}, c, seller); err == nil {
		t.Fatal("duplicate event accepted")
	}
	for i := 0; i < 4; i++ {
		bad := event
		raw, _ := hexBytes(event.Data)
		raw[(i+1)*32-1] ^= 1
		bad.Data = "0x" + hex.EncodeToString(raw)
		if err := verifyFundedLogs([]chainLog{bad}, c, seller); err == nil {
			t.Errorf("changed event data %d accepted", i)
		}
	}
	bad := event
	bad.Removed = true
	if err := verifyFundedLogs([]chainLog{bad}, c, seller); err == nil {
		t.Fatal("removed event accepted")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(value any) *http.Response {
	body, _ := json.Marshal(value)
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}
}

func TestChainPreflightPinsOneBlockAndRejectsFailure(t *testing.T) {
	c := testConfig()
	now := time.Unix(1700000000, 0)
	c.QuoteExpiresAt = now.Unix() - 20
	c.RefundAfter = now.Unix() + 300
	runtime := []byte{1, 2, 3}
	c.RuntimeSHA256 = digest(runtime)
	seller := "0x" + strings.Repeat("5", 40)
	for _, failure := range []string{"", "chain", "runtime", "receipt", "from", "deadline", "metadata"} {
		t.Run(failure, func(t *testing.T) {
			testConfig := c
			if failure == "deadline" {
				testConfig.RefundAfter = now.Unix() + 1
			}
			n := networkReader{&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Method == http.MethodGet {
					address := c.EscrowContractAddress
					if failure == "metadata" {
						address = seller
					}
					return response(map[string]any{"contract_id": c.EscrowContractID, "evm_address": address, "deleted": false}), nil
				}
				var call struct {
					Method string            `json:"method"`
					Params []json.RawMessage `json:"params"`
				}
				_ = json.NewDecoder(r.Body).Decode(&call)
				var result any
				switch call.Method {
				case "eth_chainId":
					result = "0x128"
					if failure == "chain" {
						result = "0x127"
					}
				case "eth_getBlockByNumber":
					result = map[string]string{"number": "0x200", "timestamp": fmt.Sprintf("0x%x", now.Unix())}
				case "eth_getCode":
					if string(call.Params[1]) != `"0x200"` {
						t.Error("runtime not pinned to block")
					}
					result = "0x010203"
					if failure == "runtime" {
						result = "0x01"
					}
				case "eth_call":
					if string(call.Params[1]) != `"0x200"` {
						t.Error("storage not pinned to block")
					}
					result = "0x" + hex.EncodeToString(storageFixture(c, seller))
				case "eth_getTransactionReceipt":
					status := "0x1"
					from := c.BuyerWalletAddress
					if failure == "receipt" {
						status = "0x0"
					}
					if failure == "from" {
						from = seller
					}
					result = map[string]any{"status": status, "transactionHash": c.FundingTransactionHash, "blockNumber": "0x100", "from": from, "to": c.EscrowContractAddress, "logs": []chainLog{fundedFixture(c, seller)}}
				default:
					t.Errorf("unexpected RPC %s", call.Method)
				}
				return response(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result}), nil
			})}}
			_, err := n.verifyEscrow(context.Background(), testConfig, seller, now)
			if (err != nil) != (failure != "") {
				t.Fatalf("failure=%s err=%v", failure, err)
			}
		})
	}
}

func TestMirrorMustExplicitlyConfirmActiveAndOpen(t *testing.T) {
	validAccount := map[string]any{"account": "0.0.200", "deleted": false, "evm_address": buyerFixture().EVMAddress,
		"key": map[string]string{"_type": "ECDSA_SECP256K1", "key": buyerFixture().Key.Key}}
	validTopic := map[string]any{"topic_id": "0.0.201", "deleted": false, "submit_key": nil, "custom_fees": map[string]any{"fixed_fees": []any{}}}
	for _, kind := range []string{"account", "topic"} {
		for _, failure := range []string{"", "missing deleted", "deleted", "wrong identity", "missing key or access"} {
			t.Run(kind+"/"+failure, func(t *testing.T) {
				body := map[string]any{}
				base := validAccount
				if kind == "topic" {
					base = validTopic
				}
				for k, v := range base {
					body[k] = v
				}
				switch failure {
				case "missing deleted":
					delete(body, "deleted")
				case "deleted":
					body["deleted"] = true
				case "wrong identity":
					if kind == "account" {
						body["account"] = "0.0.999"
					} else {
						body["topic_id"] = "0.0.999"
					}
				case "missing key or access":
					delete(body, "key")
					delete(body, "submit_key")
				}
				n := networkReader{&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return response(body), nil })}}
				var err error
				if kind == "account" {
					_, err = n.account(context.Background(), "0.0.200")
				} else {
					err = n.openTopic(context.Background(), "0.0.201")
				}
				if (err != nil) != (failure != "") {
					t.Fatalf("malformed Mirror acceptance mismatch: %v", err)
				}
			})
		}
	}
}

func TestConfigurationAndPrivateInputFailClosed(t *testing.T) {
	c := testConfig()
	if err := c.validate(); err != nil {
		t.Fatal(err)
	}
	changes := map[string]func(*config){"mainnet": func(c *config) { c.Network = "mainnet" }, "wrong schema": func(c *config) { c.Schema = "other" }, "overflow ID": func(c *config) { c.SellerAccountID = "0.0.18446744073709551616" }, "no request": func(c *config) { c.RequestSequence = 0 }, "negative amount": func(c *config) { c.AmountTinybar = "-1" }, "overflow amount": func(c *config) { c.AmountTinybar = new(big.Int).Lsh(big.NewInt(1), 256).String() }, "zero buyer": func(c *config) { c.BuyerWalletAddress = "0x" + strings.Repeat("0", 40) }, "zero terms": func(c *config) { c.TermsHash = "0x" + strings.Repeat("0", 64) }, "duration": func(c *config) { c.DurationSeconds = 121 }, "deadline": func(c *config) { c.RefundAfter = c.QuoteExpiresAt }, "relative key": func(c *config) { c.SellerKeyFile = "key.der" }, "private target": func(c *config) { c.LoopbackTarget = "/ip4/10.0.0.1/udp/443/quic-v1" }}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			bad := c
			change(&bad)
			if err := bad.validate(); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	encoded, _ := json.Marshal(c)
	duplicate := append([]byte(`{"network":"mainnet",`), encoded[1:]...)
	if err := strictJSON(duplicate, new(config)); err == nil {
		t.Fatal("duplicate config accepted")
	}
	if err := strictJSON(append(encoded, []byte(` {}`)...), new(config)); err == nil {
		t.Fatal("extra JSON accepted")
	}
	if err := strictJSON([]byte{'{', '"', 'x', '"', ':', '"', 255, '"', '}'}, new(config)); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	if err := os.WriteFile(path, []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFile(path, 2, true); err == nil {
		t.Fatal("oversized input accepted")
	}
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := readFile(path, 4, true); err == nil {
		t.Fatal("shared key permissions accepted")
	}
	link := filepath.Join(dir, "link")
	_ = os.Symlink(path, link)
	if _, err := readFile(link, 4, false); err == nil {
		t.Fatal("symlink source accepted")
	}
}

func TestStrictJSONRejectsFieldAliasesAndMissingOrNullValues(t *testing.T) {
	encoded, _ := json.Marshal(testConfig())
	for _, spelling := range []string{"RequestSequence", "REQUESTSEQUENCE", `request\u0053equence`} {
		// A second spelling must never override the exact canonical field.
		bad := append([]byte(`{"`+spelling+`":999,`), encoded[1:]...)
		if err := strictJSON(bad, new(config)); err == nil {
			t.Fatalf("semantic duplicate %q accepted", spelling)
		}
	}
	aliasOnly := bytes.Replace(encoded, []byte(`"requestSequence"`), []byte(`"RequestSequence"`), 1)
	if err := strictJSON(aliasOnly, new(config)); err == nil {
		t.Fatal("case alias accepted without canonical field")
	}
	request := encryptedRequest(t, testConfig(), "/ip4/8.8.8.8/udp/443/quic-v1")
	badRequest := append([]byte(`{"S":2,`), request[1:]...)
	if err := strictJSON(badRequest, new(serviceRequest)); err == nil {
		t.Fatal("HCS case alias accepted")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(request, &fields)
	delete(fields, "s")
	missing, _ := json.Marshal(fields)
	if err := strictJSON(missing, new(serviceRequest)); err == nil {
		t.Fatal("missing field accepted")
	}
	fields["s"] = json.RawMessage("null")
	nullValue, _ := json.Marshal(fields)
	if err := strictJSON(nullValue, new(serviceRequest)); err == nil {
		t.Fatal("null scalar accepted")
	}
}

func journalConfig(t *testing.T) config {
	t.Helper()
	c := testConfig()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	c.JournalFile = filepath.Join(dir, "delivery.jsonl")
	return c
}

func TestJournalPersistsReplayAndUnknownAttempt(t *testing.T) {
	for _, finish := range []string{"crash", "failed", "completed"} {
		t.Run(finish, func(t *testing.T) {
			c := journalConfig(t)
			j, err := claimDelivery(c, escrowSnapshot{BlockNumber: "0x123"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = claimDelivery(c, escrowSnapshot{BlockNumber: "0x123"}); err == nil {
				t.Fatal("concurrent journal accepted")
			}
			if finish != "crash" {
				if err = j.finish(finish == "completed", 10); err != nil {
					t.Fatal(err)
				}
			}
			_ = j.file.Close()
			if _, err = claimDelivery(c, escrowSnapshot{BlockNumber: "0x124"}); err == nil {
				t.Fatal("replayed escrow accepted after restart")
			}
			c.RequestSequence++
			if _, err = claimDelivery(c, escrowSnapshot{BlockNumber: "0x124"}); err == nil {
				t.Fatal("same escrow accepted with new request")
			}
			c.RequestSequence--
			c.EscrowID = "10"
			if _, err = claimDelivery(c, escrowSnapshot{BlockNumber: "0x124"}); err == nil {
				t.Fatal("same request accepted with new escrow")
			}
		})
	}
}

func TestJournalRejectsSymlinkAndPartialRecord(t *testing.T) {
	c := journalConfig(t)
	target := filepath.Join(filepath.Dir(c.JournalFile), "target")
	_ = os.WriteFile(target, []byte("keep"), 0600)
	_ = os.Symlink(target, c.JournalFile)
	if _, err := claimDelivery(c, escrowSnapshot{BlockNumber: "0x1"}); err == nil {
		t.Fatal("symlink journal accepted")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "keep" {
		t.Fatal("symlink target changed")
	}
	_ = os.Remove(c.JournalFile)
	_ = os.WriteFile(c.JournalFile, []byte(`{"state":"claimed"}`), 0600)
	if _, err := claimDelivery(c, escrowSnapshot{BlockNumber: "0x1"}); err == nil {
		t.Fatal("partial journal accepted")
	}
}

type shortWriter struct{}

func (shortWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

func TestPacedWritePreservesBytesDurationAndFailure(t *testing.T) {
	source := bytes.Repeat([]byte{0, 1, 255, 8}, 100)
	var got bytes.Buffer
	start := time.Now()
	n, err := pacedWrite(context.Background(), &got, source, 25*time.Millisecond)
	if err != nil || n != int64(len(source)) || !bytes.Equal(got.Bytes(), source) || time.Since(start) < 25*time.Millisecond {
		t.Fatalf("paced output invalid: %d %v", n, err)
	}
	if _, err = pacedWrite(context.Background(), shortWriter{}, source, time.Millisecond); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal("short write ignored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = pacedWrite(ctx, io.Discard, source, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored")
	}
}

// This is real local QUIC/libp2p integration, without mocked transport or chain.
func TestDeliveryUsesRealQUICAndExpectedSellerIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	buyerKey, err := crypto.UnmarshalSecp256k1PrivateKey(scalar(2))
	if err != nil {
		t.Fatal(err)
	}
	sellerPublic := hex.EncodeToString(secp256k1.PrivKeyFromBytes(scalar(1)).PubKey().SerializeCompressed())
	var mu sync.Mutex
	var received []byte
	receiver, err := legacy.NewReceiver(ctx, buyerKey, sellerPublic, 0, func(b []byte) error { mu.Lock(); defer mu.Unlock(); received = append(received, b...); return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	var target multiaddr.Multiaddr
	for _, a := range receiver.Addresses() {
		parts := strings.Split(a.String(), "/")
		if len(parts) == 6 && parts[1] == "ip4" {
			target, _ = multiaddr.NewMultiaddr("/ip4/127.0.0.1/udp/" + parts[4] + "/quic-v1")
			break
		}
	}
	if target == nil {
		t.Fatal("receiver had no QUIC listener")
	}
	source := bytes.Repeat([]byte{0, 255, 42, 0x8d}, 32769)
	n, err := deliver(ctx, scalar(1), buyerFixture().Key.Key, target, source, 50*time.Millisecond)
	if err != nil || n != int64(len(source)) {
		t.Fatalf("QUIC delivery failed: %d %v", n, err)
	}
	mu.Lock()
	actual := append([]byte(nil), received...)
	mu.Unlock()
	if !bytes.Equal(actual, source) {
		t.Fatalf("QUIC bytes truncated or changed: %d vs %d", len(actual), len(source))
	}
	wrong := hex.EncodeToString(secp256k1.PrivKeyFromBytes(scalar(3)).PubKey().SerializeCompressed())
	wrongCtx, stop := context.WithTimeout(ctx, 200*time.Millisecond)
	defer stop()
	if _, err = deliver(wrongCtx, scalar(1), wrong, target, source, time.Millisecond); err == nil {
		t.Fatal("wrong buyer peer accepted")
	}
}
