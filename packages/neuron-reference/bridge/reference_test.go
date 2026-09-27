package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/neuron-sdk/neuron-go-sdk/internal/payment"
	"github.com/neuron-sdk/neuron-go-sdk/internal/topic"
)

// This is an actual historical reference-demo HCS invoice, not a generated
// product record. Its mem-* references prove canonical format only; they never
// count as ERC20 settlement or candidate end-to-end evidence.
func TestHistoricalReferenceInvoiceBytesAndSignature(t *testing.T) {
	raw, e := os.ReadFile("testdata/upstream-invoice-mirror.json")
	if e != nil {
		t.Fatal(e)
	}
	var record struct {
		Message  string `json:"message"`
		TopicID  string `json:"topic_id"`
		Sequence uint64 `json:"sequence_number"`
	}
	if e = json.Unmarshal(raw, &record); e != nil {
		t.Fatal(e)
	}
	if record.TopicID != "0.0.10709352" || record.Sequence != 3 {
		t.Fatal("wrong historical fixture")
	}
	envelope, e := base64.StdEncoding.Strict().DecodeString(record.Message)
	if e != nil {
		t.Fatal(e)
	}
	msg, e := topic.TopicMessageFromJSON(envelope)
	if e != nil {
		t.Fatal(e)
	}
	if e = topic.ValidateTopicMessage(msg); e != nil {
		t.Fatal(e)
	}
	var invoice payment.Invoice
	if e = json.Unmarshal(msg.Payload(), &invoice); e != nil {
		t.Fatal(e)
	}
	canonical, e := json.Marshal(invoice)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(canonical, msg.Payload()) {
		t.Fatal("upstream canonical invoice bytes changed")
	}
	if invoice.Type != "invoice" || invoice.EscrowRef != "mem-escrow-1" {
		t.Fatal("historical fixture semantics changed")
	}
	var fields map[string]any
	if e = json.Unmarshal(canonical, &fields); e != nil {
		t.Fatal(e)
	}
	if _, ok := fields["evidenceHash"]; ok {
		t.Fatal("pinned implementation invoice must match observed eight-field format")
	}
}

func TestUnknownHistoricalNonceCannotBeOpenedAgain(t *testing.T) {
	v := &session{PendingIntent: &intent{ID: "old-intent", Status: "wallet-open", Kind: "deposit"}}
	s := &server{}
	if e := s.openWallet(v, "old-intent"); e == nil {
		t.Fatal("old unbound nonce may not be retried")
	}
	if v.PendingIntent == nil || v.PendingIntent.Status != "wallet-open" || v.PendingIntent.Transaction.Nonce != "" {
		t.Fatal("old uncertain intent was altered")
	}
	for _, raw := range []string{"0x00", "0x01", "1", "0x", "0x10000000000000000", "0X2"} {
		if _, e := exactNonce(raw); e == nil {
			t.Fatalf("unsafe or noncanonical nonce accepted: %s", raw)
		}
	}
	for _, raw := range []string{"0x0", "0x2", "0xffffffffffffffff"} {
		if _, e := exactNonce(raw); e != nil {
			t.Fatalf("valid nonce rejected: %s", raw)
		}
	}
}

func TestRejectedRetryCannotClearEarlierUncertainSubmission(t *testing.T) {
	dir := t.TempDir()
	if e := os.Chmod(dir, 0700); e != nil {
		t.Fatal(e)
	}
	id := "ea37b5be-c4f4-41e5-9a52-0b0e26a5b3b0"
	owner := "0x1111111111111111111111111111111111111111"
	authSession := "0123456789abcdef0123456789abcdef"
	v := &session{ID: id, BuyerAddress: owner, CustomerSessionID: authSession, State: "token-approved", PendingIntent: &intent{ID: id, Status: "wallet-open", Kind: "deposit", OpenAttempts: 2, Transaction: walletAction{Nonce: "0x2"}}}
	s := &server{stateDir: dir, token: "private-test-token", sessions: map[string]*session{id: v}}
	r := httptest.NewRequest("POST", "http://127.0.0.1:8098/v1/sessions/"+id+"/actions", strings.NewReader(`{"action":"wallet-rejected","intentId":"`+id+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer private-test-token")
	r.Header.Set("X-Customer-Wallet", owner)
	r.Header.Set("X-Customer-Session", authSession)
	s.serve(httptest.NewRecorder(), r)
	if v.PendingIntent == nil || v.PendingIntent.OpenAttempts != 2 || v.PendingIntent.Transaction.Nonce != "0x2" {
		t.Fatal("rejected retry discarded the original uncertain transaction")
	}
	v.PendingIntent.OpenAttempts = 3
	r = httptest.NewRequest("POST", "http://127.0.0.1:8098/v1/sessions/"+id+"/actions", strings.NewReader(`{"action":"open-wallet","intentId":"`+id+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer private-test-token")
	r.Header.Set("X-Customer-Wallet", owner)
	r.Header.Set("X-Customer-Session", authSession)
	recorder := httptest.NewRecorder()
	s.serve(recorder, r)
	if recorder.Code != 409 {
		t.Fatal("refused retry must not return an apparent successful open-wallet response")
	}
}

func TestPrivateFileRejectsLinkAndPublicPermissions(t *testing.T) {
	dir := t.TempDir()
	if e := os.Chmod(dir, 0700); e != nil {
		t.Fatal(e)
	}
	key := filepath.Join(dir, "key")
	if e := os.WriteFile(key, []byte("not-a-real-secret"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := privateFile(key); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(dir, "link")
	if e := os.Symlink(key, link); e != nil {
		t.Fatal(e)
	}
	if _, e := privateFile(link); e == nil {
		t.Fatal("symlink must fail")
	}
	if e := os.Chmod(key, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e := privateFile(key); e == nil {
		t.Fatal("public key-file permissions must fail")
	}
}
