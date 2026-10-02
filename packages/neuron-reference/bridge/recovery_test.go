package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/eth/ethconfig"
	"github.com/ethereum/go-ethereum/ethclient/simulated"
	"github.com/ethereum/go-ethereum/node"
	"github.com/neuron-sdk/neuron-go-sdk/internal/keylib"
	bindings "github.com/neuron-sdk/neuron-go-sdk/internal/payment/bindings"
	"github.com/neuron-sdk/neuron-go-sdk/internal/topic"
)

func signedFixture(t *testing.T, kind string) hcsMessage {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	neuron, err := keylib.NeuronPrivateKeyFromBlockchainKey(key)
	if err != nil {
		t.Fatal(err)
	}
	// Significant whitespace, escaped characters and >2^53 integers exercise
	// actual byte identity, not just equivalent decoded JSON.
	payload := []byte("{\n \"type\":\"" + kind + "\",\"value\":\"<>&\\u2028\",\"n\":9007199254740993 }")
	signed, err := topic.NewTopicMessage(&neuron, 123, 456, payload)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(envelope)
	return hcsMessage{Kind: kind, TopicID: "0.0.123", TransactionID: "0.0.456@1790931000.000000001", SHA256: hex.EncodeToString(hash[:]), SenderAddress: signed.SenderAddress(), Payload: payload, Envelope: envelope}
}

func TestJournalPreservesSignedBytesAndMigratesLegacy(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	original := &session{ID: newID(), Messages: []hcsMessage{signedFixture(t, "serviceRequest")}}
	s := &server{stateDir: dir}
	for _, verified := range []bool{false, true} {
		original.Messages[0].MirrorVerified = verified
		if err := s.save(original); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(dir, original.ID+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var loaded session
		migrated, err := decodeJournal(raw, &loaded)
		if err != nil || migrated {
			t.Fatal(migrated, err)
		}
		if !bytes.Equal(original.Messages[0].Envelope, loaded.Messages[0].Envelope) || !bytes.Equal(original.Messages[0].Payload, loaded.Messages[0].Payload) || loaded.Messages[0].MirrorVerified != verified {
			t.Fatal("signed bytes or verification changed")
		}
	}
	legacy, err := json.MarshalIndent(original, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	var loaded session
	migrated, err := decodeJournal(legacy, &loaded)
	if err != nil || !migrated {
		t.Fatal(migrated, err)
	}
	if !bytes.Equal(loaded.Messages[0].Payload, original.Messages[0].Payload) || !bytes.Equal(loaded.Messages[0].Envelope, original.Messages[0].Envelope) {
		t.Fatal("legacy exact bytes not recovered")
	}
	path := filepath.Join(dir, "legacy.json")
	if err = os.WriteFile(path, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	if err = migrateJournal(path, legacy, &loaded); err != nil {
		t.Fatal(err)
	}
	backup, err := privateFile(path + ".v1.bak")
	if err != nil || !bytes.Equal(backup, legacy) {
		t.Fatal("backup differs", err)
	}
	if err = migrateJournal(path, legacy, &loaded); err != nil {
		t.Fatal("idempotent migration", err)
	}
	if err = migrateJournal(path, append(legacy, ' '), &loaded); err == nil {
		t.Fatal("conflicting backup accepted")
	}
}

func TestJournalRejectsCorruptedEnvelopePayloadSenderAndVersion(t *testing.T) {
	for _, version := range []int{0, 2} {
		for _, field := range []string{"envelope", "payload", "sender", "hash", "version"} {
			t.Run(string(rune('0'+version))+"/"+field, func(t *testing.T) {
				v := &session{ID: newID(), Messages: []hcsMessage{signedFixture(t, "serviceResponse")}}
				switch field {
				case "envelope":
					v.Messages[0].Envelope = bytes.Replace(v.Messages[0].Envelope, []byte("123"), []byte("124"), 1)
				case "payload":
					v.Messages[0].Payload = []byte(`{"type":"different"}`)
				case "sender":
					v.Messages[0].SenderAddress = common.Address{}.Hex()
				case "hash":
					v.Messages[0].SHA256 = "00"
				}
				var raw []byte
				var err error
				if version == 0 {
					raw, err = json.MarshalIndent(v, "", "  ")
				} else {
					raw, err = json.MarshalIndent(journalFor(v), "", "  ")
				}
				if err != nil {
					t.Fatal(err)
				}
				if field == "version" {
					var fields map[string]json.RawMessage
					_ = json.Unmarshal(raw, &fields)
					fields["journalVersion"] = json.RawMessage("99")
					raw, _ = json.Marshal(fields)
				}
				var recovered session
				if _, err = decodeJournal(raw, &recovered); err == nil {
					t.Fatal("corrupted journal accepted")
				}
			})
		}
	}
}

// SIGKILL after a durable save must leave byte-identical records. The child
// deliberately does not run defers or any graceful shutdown recovery.
func TestJournalSurvivesProcessKill(t *testing.T) {
	if os.Getenv("REFERENCE_JOURNAL_CHILD") == "1" {
		dir := os.Getenv("REFERENCE_JOURNAL_DIR")
		raw, err := os.ReadFile(filepath.Join(dir, "input"))
		if err != nil {
			t.Fatal(err)
		}
		var v session
		if _, err = decodeJournal(raw, &v); err != nil {
			t.Fatal(err)
		}
		s := &server{stateDir: dir}
		if err = s.save(&v); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "ready"), []byte("ready"), 0600); err != nil {
			t.Fatal(err)
		}
		select {}
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	v := &session{ID: newID(), Messages: []hcsMessage{signedFixture(t, "invoice")}}
	raw, err := json.Marshal(journalFor(v))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "input"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestJournalSurvivesProcessKill$")
	child.Env = append(os.Environ(), "REFERENCE_JOURNAL_CHILD=1", "REFERENCE_JOURNAL_DIR="+dir)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err = os.Stat(filepath.Join(dir, "ready")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child failed to save")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	saved, err := privateFile(filepath.Join(dir, v.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var recovered session
	if _, err = decodeJournal(saved, &recovered); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(v.Messages[0].Envelope, recovered.Messages[0].Envelope) || !bytes.Equal(v.Messages[0].Payload, recovered.Messages[0].Payload) {
		t.Fatal("SIGKILL changed signed bytes")
	}
}

type localClient struct{ simulated.Client }

func (localClient) Close() {}

type evmFixture struct {
	t                           *testing.T
	chain                       *simulated.Backend
	s                           *server
	buyer, seller, stranger     *bind.TransactOpts
	token                       *bindings.TestToken
	escrow                      *bindings.NeuronEscrow
	tokenAddress, escrowAddress common.Address
}

func newEVMFixture(t *testing.T) *evmFixture {
	t.Helper()
	f := &evmFixture{t: t}
	alloc := types.GenesisAlloc{}
	for _, out := range []**bind.TransactOpts{&f.buyer, &f.seller, &f.stranger} {
		key, err := crypto.GenerateKey()
		if err != nil {
			t.Fatal(err)
		}
		*out, err = bind.NewKeyedTransactorWithChainID(key, big.NewInt(296))
		if err != nil {
			t.Fatal(err)
		}
		alloc[(*out).From] = types.Account{Balance: new(big.Int).Exp(big.NewInt(10), big.NewInt(21), nil)}
	}
	f.chain = simulated.NewBackend(alloc, func(_ *node.Config, c *ethconfig.Config) {
		copy := *c.Genesis.Config
		copy.ChainID = big.NewInt(296)
		c.Genesis.Config = &copy
	})
	t.Cleanup(func() { _ = f.chain.Close() })
	var tx *types.Transaction
	var err error
	f.tokenAddress, tx, f.token, err = bindings.DeployTestToken(f.buyer, f.chain.Client())
	f.mine(tx, err)
	f.escrowAddress, tx, f.escrow, err = bindings.DeployNeuronEscrow(f.buyer, f.chain.Client())
	f.mine(tx, err)
	f.mine(f.token.Mint(f.buyer, f.buyer.From, big.NewInt(1000)))
	f.mine(f.token.Mint(f.stranger, f.stranger.From, big.NewInt(1000)))
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	f.s = &server{cfg: config{EscrowAddress: f.escrowAddress.Hex(), TokenAddress: f.tokenAddress.Hex(), PriceBaseUnits: "100"}, stateDir: dir, seller: f.seller.From, escrow: f.escrow, tokenContract: f.token, rpc: localClient{f.chain.Client()}, sessions: map[string]*session{}}
	return f
}
func (f *evmFixture) mine(tx *types.Transaction, err error) *types.Transaction {
	f.t.Helper()
	if err != nil {
		f.t.Fatal(err)
	}
	f.chain.Commit()
	receipt, err := f.chain.Client().TransactionReceipt(context.Background(), tx.Hash())
	if err != nil || receipt.Status != 1 {
		f.t.Fatal("mined failure", receipt, err)
	}
	return tx
}
func (f *evmFixture) newSession(deadline uint64) *session {
	f.t.Helper()
	agreement := crypto.Keccak256Hash([]byte(newID()))
	tx := f.mine(f.escrow.CreateEscrow(f.buyer, f.buyer.From, f.seller.From, common.Address{}, f.tokenAddress, 1, agreement, deadline))
	receipt, _ := f.chain.Client().TransactionReceipt(context.Background(), tx.Hash())
	var id string
	for _, log := range receipt.Logs {
		if e, err := f.escrow.ParseEscrowCreated(*log); err == nil {
			id = e.EscrowId.String()
		}
	}
	v := &session{ID: newID(), BuyerAddress: f.buyer.From.Hex(), State: "escrow-created", EscrowID: id, AgreementHash: agreement.Hex(), Deadline: deadline}
	v.Transactions = append(v.Transactions, transaction{Kind: "create", Status: "confirmed", TransactionHash: tx.Hash().Hex()})
	f.s.sessions[v.ID] = v
	return v
}
func (f *evmFixture) confirm(v *session, kind string, tx *types.Transaction) {
	f.t.Helper()
	action, err := f.s.unsigned(kind, v)
	if err != nil {
		f.t.Fatal(err)
	}
	action.Nonce = hexutil.EncodeUint64(tx.Nonce())
	v.PendingIntent = &intent{ID: newID(), Kind: kind, Status: "wallet-open", Transaction: action}
	if err = f.s.confirmWallet(v, tx.Hash().Hex()); err != nil {
		f.t.Fatal(err)
	}
}
func (f *evmFixture) approvedMessage(v *session, kind string) {
	m := signedFixture(f.t, kind)
	m.MirrorVerified = true
	v.Messages = append(v.Messages, m)
}

func TestSharedAllowanceReapprovalAndStaleWalletPreflight(t *testing.T) {
	f := newEVMFixture(t)
	deadline := uint64(time.Now().Add(time.Hour).Unix())
	a, b := f.newSession(deadline), f.newSession(deadline)
	first := f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	second := f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	f.confirm(a, "token-approve", first)
	f.confirm(b, "token-approve", second)
	// Prepare a deposit, then a different purchase consumes the shared allowance.
	action, err := f.s.unsigned("deposit", b)
	if err != nil {
		t.Fatal(err)
	}
	action.Nonce = hexutil.EncodeUint64(second.Nonce() + 2)
	b.PendingIntent = &intent{ID: newID(), Kind: "deposit", Status: "prepared", Transaction: action}
	f.mine(f.escrow.Deposit(f.buyer, integer(a.EscrowID), big.NewInt(100)))
	if err = f.s.openWallet(b, b.PendingIntent.ID); err == nil {
		t.Fatal("stale allowance opened wallet")
	}
	if b.PendingIntent.Status != "prepared" || b.PendingIntent.OpenAttempts != 0 {
		t.Fatal("preflight altered unopened intent")
	}
	b.PendingIntent = nil // the existing explicit cancel transition is safe pre-open
	if err = f.s.available(b); err != nil {
		t.Fatal(err)
	}
	if len(b.WalletActions) != 1 || b.WalletActions[0].Kind != "token-approve" {
		t.Fatal("exact reapproval unavailable", b.WalletActions)
	}
	// Confirmation of an earlier approval after it was consumed is still valid.
	f.confirm(a, "token-approve", first)
	f.confirm(b, "token-approve", f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100))))
	if err = f.s.available(b); err != nil || b.WalletActions[0].Kind != "deposit" {
		t.Fatal("deposit not restored", err)
	}
	f.approvedMessage(b, "escrowCreated")
	f.confirm(b, "deposit", f.mine(f.escrow.Deposit(f.buyer, integer(b.EscrowID), big.NewInt(100))))
	if b.State != "funded" {
		t.Fatal(b.State)
	}
}

func TestSurplusNegotiatedPayoutAndRefundLifecycle(t *testing.T) {
	f := newEVMFixture(t)
	v := f.newSession(uint64(time.Now().Add(time.Hour).Unix()))
	// Dust before funding does not prevent the buyer's one exact deposit.
	f.mine(f.token.Approve(f.stranger, f.escrowAddress, big.NewInt(10)))
	f.mine(f.escrow.Deposit(f.stranger, integer(v.EscrowID), big.NewInt(1)))
	f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	if err := f.s.checkDeposit(context.Background(), v); err != nil {
		t.Fatal("prefunding dust blocked deposit", err)
	}
	f.approvedMessage(v, "escrowCreated")
	f.confirm(v, "deposit", f.mine(f.escrow.Deposit(f.buyer, integer(v.EscrowID), big.NewInt(100))))
	f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	if err := f.s.checkDeposit(context.Background(), v); err == nil {
		t.Fatal("duplicate buyer deposit accepted")
	}
	// More dust after funding. Only the negotiated 100-unit release is accepted.
	f.mine(f.escrow.Deposit(f.stranger, integer(v.EscrowID), big.NewInt(1)))
	v.Delivery = &deliveredFile{Filename: "fixture", Bytes: 1}
	v.EvidenceHash = crypto.Keccak256Hash([]byte("proof")).Hex()
	v.ReleaseID = "1"
	f.mine(f.escrow.RequestRelease(f.seller, integer(v.EscrowID), big.NewInt(100), f.seller.From, hash32(v.EvidenceHash)))
	f.approvedMessage(v, "invoice")
	if err := f.s.deliver(v); err != nil {
		t.Fatal("dust blocked delivery lifecycle", err)
	}
	f.approvedMessage(v, "invoiceAck")
	f.confirm(v, "approve-release", f.mine(f.escrow.ApproveRelease(f.buyer, integer(v.EscrowID), integer(v.ReleaseID))))
	tx := f.mine(f.escrow.Withdraw(f.seller, integer(v.EscrowID), integer(v.ReleaseID)))
	v.Transactions = append(v.Transactions, transaction{Kind: "withdraw", Status: "confirmed", TransactionHash: tx.Hash().Hex()})
	if err := f.s.settle(v); err != nil {
		t.Fatal(err)
	}
	balance, err := f.token.BalanceOf(&bind.CallOpts{}, f.seller.From)
	if err != nil || balance.Cmp(big.NewInt(100)) != 0 {
		t.Fatal("seller overpaid", balance, err)
	}
	if v.State != "paid-with-remainder" || v.RemainingBalanceBaseUnits != "2" || v.PaidAmountBaseUnits != "100" {
		t.Fatal("surplus hidden", v.State, v.RemainingBalanceBaseUnits)
	}
	if err = f.chain.AdjustTime(2 * time.Hour); err != nil {
		t.Fatal(err)
	}
	f.confirm(v, "refund", f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID))))
	if v.State != "refunded" || v.RefundAmountBaseUnits != "2" || v.RemainingBalanceBaseUnits != "0" {
		t.Fatal("surplus refund not reconciled", v)
	}
	// Pinned contract even accepts deposits after refund. Never strand those.
	f.mine(f.escrow.Deposit(f.stranger, integer(v.EscrowID), big.NewInt(1)))
	if err = f.s.available(v); err != nil {
		t.Fatal(err)
	}
	if v.State != "refunded-with-remainder" || v.RemainingBalanceBaseUnits != "1" {
		t.Fatal("post-refund dust hidden")
	}
	f.confirm(v, "refund", f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID))))
	if v.RefundAmountBaseUnits != "1" || v.State != "refunded" {
		t.Fatal("second refund failed")
	}
	// A direct contract refund can empty surplus before the bridge refresh.
	for _, prior := range []string{"paid-with-remainder", "refunded-with-remainder"} {
		v.State = prior
		if err = f.s.available(v); err != nil {
			t.Fatal(err)
		}
		if v.RemainingBalanceBaseUnits != "0" || v.State == prior {
			t.Fatal("stale surplus remained after external recovery")
		}
	}
}

func TestUnpaidSurplusRefundOffersActionAndReconcilesActualAmount(t *testing.T) {
	f := newEVMFixture(t)
	v := f.newSession(uint64(time.Now().Unix() - 1))
	v.State = "funded"
	f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	f.mine(f.escrow.Deposit(f.buyer, integer(v.EscrowID), big.NewInt(100)))
	f.mine(f.token.Approve(f.stranger, f.escrowAddress, big.NewInt(1)))
	f.mine(f.escrow.Deposit(f.stranger, integer(v.EscrowID), big.NewInt(1)))
	if err := f.s.available(v); err != nil {
		t.Fatal(err)
	}
	if len(v.WalletActions) != 1 || v.WalletActions[0].Kind != "refund" {
		t.Fatal("refund unavailable")
	}
	f.confirm(v, "refund", f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID))))
	if v.RefundAmountBaseUnits != "101" || v.State != "refunded" {
		t.Fatal("actual refund not reconciled")
	}
}

// This local HTTP Mirror fixture exercises the real recovery verifier. It does
// not claim Hedera consensus; the separate live run verifies real Mirror rows.
type recoveryTransport struct{ target *url.URL }

func (r recoveryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	copy.URL.Scheme = r.target.Scheme
	copy.URL.Host = r.target.Host
	return http.DefaultTransport.RoundTrip(copy)
}
func TestRestartUnverifiedMessageReconcilesExactMirrorBytes(t *testing.T) {
	original := signedFixture(t, "serviceResponse")
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/topics/0.0.123/messages" {
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"messages": []any{map[string]any{"topic_id": "0.0.123", "payer_account_id": "0.0.456", "message": base64.StdEncoding.EncodeToString(original.Envelope), "sequence_number": 7, "consensus_timestamp": "1790931001.000000001", "chunk_info": map[string]any{"number": 1, "total": 1, "initial_transaction_id": map[string]any{"account_id": "0.0.456", "transaction_valid_start": "1790931000.000000001", "nonce": 0, "scheduled": false}}}}, "links": map[string]string{"next": ""}})
	}))
	defer fixture.Close()
	target, _ := url.Parse(fixture.URL)
	for _, legacy := range []bool{false, true} {
		v := &session{ID: newID(), Messages: []hcsMessage{original}}
		var raw []byte
		var err error
		if legacy {
			raw, err = json.MarshalIndent(v, "", "  ")
		} else {
			raw, err = json.MarshalIndent(journalFor(v), "", "  ")
		}
		if err != nil {
			t.Fatal(err)
		}
		var recovered session
		if _, err = decodeJournal(raw, &recovered); err != nil {
			t.Fatal(err)
		}
		s := &server{cfg: config{OperatorAccountID: "0.0.456"}, http: &http.Client{Transport: recoveryTransport{target}}}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err = s.verifyMessage(ctx, &recovered.Messages[0])
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		m := recovered.Messages[0]
		if !m.MirrorVerified || m.SequenceNumber != "7" || m.TransactionID != original.TransactionID || !bytes.Equal(m.Envelope, original.Envelope) || !bytes.Equal(m.Payload, original.Payload) {
			t.Fatal("recovery changed signed transaction")
		}
	}
}

func TestLegacyTerminalJournalWithNewDustPreservesUnknownHistoricalAmounts(t *testing.T) {
	for _, terminal := range []string{"paid", "refunded"} {
		t.Run(terminal, func(t *testing.T) {
			f := newEVMFixture(t)
			v := f.newSession(uint64(time.Now().Unix() - 1))
			f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
			f.mine(f.escrow.Deposit(f.buyer, integer(v.EscrowID), big.NewInt(100)))
			if terminal == "paid" {
				f.mine(f.escrow.RequestRelease(f.seller, integer(v.EscrowID), big.NewInt(100), f.seller.From, [32]byte{42}))
				f.mine(f.escrow.ApproveRelease(f.buyer, integer(v.EscrowID), big.NewInt(1)))
				tx := f.mine(f.escrow.Withdraw(f.seller, integer(v.EscrowID), big.NewInt(1)))
				v.Transactions = append(v.Transactions, transaction{Kind: "withdraw", Status: "confirmed", TransactionHash: tx.Hash().Hex()})
			} else {
				tx := f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID)))
				v.Transactions = append(v.Transactions, transaction{Kind: "refund", Status: "confirmed", TransactionHash: tx.Hash().Hex()})
			}
			v.State = terminal
			legacy, err := json.MarshalIndent(v, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			var recovered session
			if migrated, err := decodeJournal(legacy, &recovered); err != nil || !migrated {
				t.Fatal(migrated, err)
			}
			f.mine(f.token.Approve(f.stranger, f.escrowAddress, big.NewInt(1)))
			f.mine(f.escrow.Deposit(f.stranger, integer(v.EscrowID), big.NewInt(1)))
			if err = f.s.available(&recovered); err != nil {
				t.Fatal(err)
			}
			if recovered.State != terminal+"-with-remainder" || recovered.RemainingBalanceBaseUnits != "1" || recovered.PaidAmountBaseUnits != "" || recovered.RefundAmountBaseUnits != "" {
				t.Fatal("legacy amount invented or remainder hidden")
			}
			if len(recovered.WalletActions) != 1 || recovered.WalletActions[0].Kind != "refund" {
				t.Fatal("legacy surplus recovery unavailable")
			}
			f.confirm(&recovered, "refund", f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID))))
			if recovered.RefundAmountBaseUnits != "1" || recovered.State != "refunded" {
				t.Fatal("legacy surplus refund failed")
			}
		})
	}
}

func TestUnknownRefundRetriesAndNonceCancellationKeepHistory(t *testing.T) {
	f := newEVMFixture(t)
	v := f.newSession(uint64(time.Now().Unix() - 1))
	v.State = "funded"
	f.mine(f.token.Approve(f.buyer, f.escrowAddress, big.NewInt(100)))
	f.mine(f.escrow.Deposit(f.buyer, integer(v.EscrowID), big.NewInt(100)))
	action, err := f.s.unsigned("refund", v)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := f.chain.Client().PendingNonceAt(context.Background(), f.buyer.From)
	if err != nil {
		t.Fatal(err)
	}
	action.Nonce = hexutil.EncodeUint64(nonce)
	intentID := newID()
	v.PendingIntent = &intent{ID: intentID, Kind: "refund", Status: "prepared", Transaction: action}
	v.CustomerSessionID = "recovery-test-customer"
	f.s.token = "recovery-test-bearer"
	for attempt := 1; attempt <= 5; attempt++ {
		if err = f.s.openWallet(v, intentID); err != nil {
			t.Fatal("same-nonce retry blocked", attempt, err)
		}
		if attempt > 1 {
			r := httptest.NewRequest("POST", "http://127.0.0.1:8098/v1/sessions/"+v.ID+"/actions", strings.NewReader(`{"action":"wallet-rejected","intentId":"`+intentID+`"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+f.s.token)
			r.Header.Set("X-Customer-Wallet", v.BuyerAddress)
			r.Header.Set("X-Customer-Session", v.CustomerSessionID)
			f.s.serve(httptest.NewRecorder(), r)
		}
		if v.PendingIntent == nil || v.PendingIntent.ID != intentID || v.PendingIntent.Transaction.Nonce != action.Nonce || v.PendingIntent.OpenAttempts != attempt || len(v.PendingIntent.WalletOpenings) != attempt {
			t.Fatal("unknown original intent lost on rejected retry")
		}
	}
	// Prove eight mistaken pasted hashes cannot block the ninth, valid recovery.
	for i := 1; i <= 8; i++ {
		if err = f.s.confirmWallet(v, common.BigToHash(big.NewInt(int64(i))).Hex()); err == nil {
			t.Fatal("unknown hash accepted")
		}
	}
	tx := types.NewTransaction(nonce, f.buyer.From, big.NewInt(0), 21000, big.NewInt(2000000000), nil)
	signed, err := f.buyer.Signer(f.buyer.From, tx)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.chain.Client().SendTransaction(context.Background(), signed); err != nil {
		t.Fatal(err)
	}
	f.chain.Commit()
	if err = f.s.confirmWallet(v, signed.Hash().Hex()); err != nil {
		t.Fatal("mined exact cancellation not reconciled", err)
	}
	if v.PendingIntent != nil || len(v.IntentHistory) != 1 {
		t.Fatal("cancelled original intent not archived")
	}
	old := v.IntentHistory[0]
	if old.ID != intentID || old.Status != "cancelled-onchain" || old.Transaction.Nonce != action.Nonce || old.Transaction.Data != action.Data || old.OpenAttempts != 5 || len(old.CandidateHashes) != 9 || len(old.WalletOpenings) != 5 {
		t.Fatal("cancellation erased financial history")
	}
	if err = f.s.available(v); err != nil {
		t.Fatal(err)
	}
	if len(v.WalletActions) != 1 || v.WalletActions[0].Kind != "refund" {
		t.Fatal("refund not restored after cancellation")
	}
	// One fresh nonce now refunds exactly once; cancellation never moved funds.
	f.confirm(v, "refund", f.mine(f.escrow.ClaimRefund(f.buyer, integer(v.EscrowID))))
	if v.State != "refunded" || v.RefundAmountBaseUnits != "100" || len(v.IntentHistory) != 2 {
		t.Fatal("fresh refund after cancellation failed")
	}
	raw, err := privateFile(filepath.Join(f.s.stateDir, v.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var recovered session
	if _, err = decodeJournal(raw, &recovered); err != nil {
		t.Fatal(err)
	}
	if len(recovered.IntentHistory) != 2 || recovered.IntentHistory[0].Transaction.Nonce != action.Nonce {
		t.Fatal("restart lost cancellation history")
	}
}

func TestCancellationRequiresBuyerExactNonceSuccessfulMinedSelfTransfer(t *testing.T) {
	for _, variant := range []string{"wrong-nonce", "wrong-buyer", "pending", "historical-no-nonce", "nonzero-value", "nonempty-data"} {
		t.Run(variant, func(t *testing.T) {
			f := newEVMFixture(t)
			v := f.newSession(uint64(time.Now().Add(time.Hour).Unix()))
			v.State = "funded"
			nonce, err := f.chain.Client().PendingNonceAt(context.Background(), f.buyer.From)
			if err != nil {
				t.Fatal(err)
			}
			action, err := f.s.unsigned("refund", v)
			if err != nil {
				t.Fatal(err)
			}
			action.Nonce = hexutil.EncodeUint64(nonce)
			original := &intent{ID: newID(), Kind: "refund", Status: "wallet-open", Transaction: action, OpenAttempts: 1}
			v.PendingIntent = original
			signer := f.buyer
			txNonce := nonce
			to := f.buyer.From
			value := big.NewInt(0)
			var data []byte
			switch variant {
			case "wrong-nonce":
				original.Transaction.Nonce = hexutil.EncodeUint64(nonce + 1)
			case "wrong-buyer":
				signer = f.stranger
				txNonce, _ = f.chain.Client().PendingNonceAt(context.Background(), signer.From)
				to = signer.From
			case "historical-no-nonce":
				original.Transaction.Nonce = ""
			case "nonzero-value":
				value = big.NewInt(1)
			case "nonempty-data":
				data = []byte{1}
			}
			tx := types.NewTransaction(txNonce, to, value, 30000, big.NewInt(2000000000), data)
			signed, err := signer.Signer(signer.From, tx)
			if err != nil {
				t.Fatal(err)
			}
			if err = f.chain.Client().SendTransaction(context.Background(), signed); err != nil {
				t.Fatal(err)
			}
			if variant != "pending" {
				f.chain.Commit()
			}
			if err = f.s.confirmWallet(v, signed.Hash().Hex()); err == nil {
				t.Fatal("unsafe cancellation accepted")
			}
			if v.PendingIntent == nil || v.PendingIntent.ID != original.ID || len(v.IntentHistory) != 0 {
				t.Fatal("unproven cancellation erased original")
			}
		})
	}
}
