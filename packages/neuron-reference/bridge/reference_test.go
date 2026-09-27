package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
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
