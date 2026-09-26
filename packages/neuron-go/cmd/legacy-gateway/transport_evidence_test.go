package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestTransportEvidenceIsScopedAndInternal(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	seller := "0.0.4318411"
	journal, err := openSessionJournal(filepath.Join(dir, "sessions.ndjson"), seller, testInstanceOne)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if err := journal.recordOwned("opened", testConnection, 0, testOwner, testSession); err != nil {
		t.Fatal(err)
	}
	if err := journal.recordOwned("closed", testConnection, 9876, testOwner, testSession); err != nil {
		t.Fatal(err)
	}
	otherOwner := "0x2222222222222222222222222222222222222222"
	otherConnection := "11112222333344445555666677778888"
	if err := journal.recordOwned("opened", otherConnection, 0, otherOwner, testSession); err != nil {
		t.Fatal(err)
	}
	if err := journal.recordOwned("closed", otherConnection, 12345, otherOwner, testSession); err != nil {
		t.Fatal(err)
	}
	interruptedConnection := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := journal.recordOwned("opened", interruptedConnection, 0, testOwner, testSession); err != nil {
		t.Fatal(err)
	}
	if err := journal.recordOwned("interrupted", interruptedConnection, 0, testOwner, testSession); err != nil {
		t.Fatal(err)
	}
	secret := []byte("01234567890123456789012345678901")
	sellerKey := "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
	g := &gateway{sellerAccount: seller, sellerPublicKey: sellerKey, secret: secret, journal: journal}
	call := func(owner, remote, signature string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "http://localhost/transport-evidence", nil)
		r.RemoteAddr = remote
		r.Header.Set("X-Neuron-Session-ID", testSession)
		r.Header.Set("X-Neuron-Owner", owner)
		r.Header.Set("X-Neuron-Auth", signature)
		w := httptest.NewRecorder()
		g.serveTransportEvidence(w, r)
		return w
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("transport-evidence:" + testSession + ":" + testOwner + ":" + seller))
	signature := hex.EncodeToString(mac.Sum(nil))
	if got := call(testOwner, "203.0.113.10:1234", signature); got.Code != http.StatusForbidden {
		t.Fatalf("remote peer reached internal evidence: HTTP %d", got.Code)
	}
	if got := call(testOwner, "127.0.0.1:1234", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned evidence request was accepted: HTTP %d", got.Code)
	}
	if got := call(otherOwner, "127.0.0.1:1234", signature); got.Code != http.StatusUnauthorized {
		t.Fatalf("owner substitution was accepted: HTTP %d", got.Code)
	}
	response := call(testOwner, "127.0.0.1:1234", signature)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("scoped evidence failed: HTTP %d, cache %q", response.Code, response.Header().Get("Cache-Control"))
	}
	var body transportEvidence
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.TransportEvidenceOnly || body.OwnerAddress != testOwner || body.CustomerSessionID != testSession ||
		body.SellerAccount != seller || body.SellerPublicKey != sellerKey ||
		body.ClosedConnections != 1 || body.InterruptedConnections != 1 ||
		body.TotalWrittenBytes != 9876 || body.OpenConnections != 0 || body.Truncated ||
		len(body.Connections) != 1 || body.Connections[0].WrittenBytes != 9876 {
		t.Fatalf("wrong or cross-owner transport summary: %+v", body)
	}
	g.sellerPublicKey = ""
	if got := call(testOwner, "127.0.0.1:1234", signature); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("evidence served without startup-verified seller key: HTTP %d", got.Code)
	}
}

func TestTransportEvidenceBoundsConnectionList(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	journal, err := openSessionJournal(filepath.Join(dir, "sessions.ndjson"), "0.0.4318411", testInstanceOne)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	for i := 0; i < maxTransportEvidenceConnections+1; i++ {
		id := fmt.Sprintf("%032x", i+1)
		if err := journal.recordOwned("opened", id, 0, testOwner, testSession); err != nil {
			t.Fatal(err)
		}
		if err := journal.recordOwned("closed", id, 1, testOwner, testSession); err != nil {
			t.Fatal(err)
		}
	}
	evidence, err := journal.summarize(testOwner, testSession)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ClosedConnections != maxTransportEvidenceConnections+1 ||
		evidence.TotalWrittenBytes != maxTransportEvidenceConnections+1 ||
		len(evidence.Connections) != maxTransportEvidenceConnections || !evidence.Truncated {
		t.Fatalf("connection output bound was not explicit: %+v", evidence)
	}
}
