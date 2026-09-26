package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestFullBrowserQueueStopsSellerStream(t *testing.T) {
	sub := &subscriber{frames: make(chan []byte), failure: make(chan struct{}, 1)}
	g := &gateway{subscriber: sub}
	if err := g.onBytes([]byte{0xff, 0x00}); err == nil {
		t.Fatal("unbounded browser backpressure was accepted")
	}
	select {
	case <-sub.failure:
	default:
		t.Fatal("browser was not notified of stream backpressure")
	}
}

func TestRejectedWebSocketRequestDoesNotConsumeTicket(t *testing.T) {
	secret := make([]byte, 32)
	instanceID := "0123456789abcdef0123456789abcdef"
	now := time.Now()
	expiry := strconv.FormatInt(now.Unix()+45, 10)
	nonce := "00112233445566778899aabbccddeeff"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v1:" + expiry + ":" + nonce + ":0.0.4318411:" + instanceID))
	ticket := "auth.v1." + expiry + "." + nonce + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{origin: "http://localhost:3000", sellerAccount: "0.0.4318411", secret: secret, instanceID: instanceID}
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "http://localhost:9080/stream", nil)
		r.Header.Set("Origin", g.origin)
		r.Header.Set("Sec-WebSocket-Protocol", "neuron.v1, "+ticket)
		r.RemoteAddr = "127.0.0.1:1234"
		return r
	}
	g.subscriber = &subscriber{}
	busy := httptest.NewRecorder()
	g.serveStream(busy, request())
	if busy.Code != http.StatusConflict || len(g.usedTickets) != 0 {
		t.Fatalf("busy subscriber consumed ticket: HTTP %d, tickets %d", busy.Code, len(g.usedTickets))
	}
	g.subscriber = nil
	malformed := httptest.NewRecorder()
	g.serveStream(malformed, request())
	if len(g.usedTickets) != 0 {
		t.Fatal("failed WebSocket upgrade consumed ticket")
	}
}

func TestTicketBindsSellerAndExpiry(t *testing.T) {
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i + 1)
	}
	now := time.Unix(1_790_405_500, 0)
	expiry := strconv.FormatInt(now.Unix()+45, 10)
	nonce := "00112233445566778899aabbccddeeff"
	instanceID := "0123456789abcdef0123456789abcdef"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v1:" + expiry + ":" + nonce + ":0.0.4318411:" + instanceID))
	ticket := "auth.v1." + expiry + "." + nonce + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{sellerAccount: "0.0.4318411", secret: secret, instanceID: instanceID}
	if !g.validTicket(ticket, now) {
		t.Fatal("valid seller ticket rejected")
	}
	g.mu.Lock()
	firstUse := g.consumeTicketLocked(ticket, now)
	replayUse := g.consumeTicketLocked(ticket, now)
	g.mu.Unlock()
	if !firstUse {
		t.Fatal("first use of ticket rejected")
	}
	if replayUse {
		t.Fatal("replayed ticket accepted")
	}
	if g.validTicket(ticket, now.Add(46*time.Second)) {
		t.Fatal("expired ticket accepted")
	}
	g.sellerAccount = "0.0.6340259"
	if g.validTicket(ticket, now) {
		t.Fatal("ticket accepted for another seller")
	}
	g.sellerAccount = "0.0.4318411"
	g.instanceID = "fedcba9876543210fedcba9876543210"
	if g.validTicket(ticket, now) {
		t.Fatal("ticket accepted after gateway restart")
	}
}

func TestCustomerTicketBindsWalletSessionSellerAndGateway(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	now := time.Unix(1_790_405_500, 0)
	expiry := strconv.FormatInt(now.Unix()+45, 10)
	nonce := "00112233445566778899aabbccddeeff"
	sessionID := "abcdefabcdefabcdefabcdefabcdefab"
	ownerHex := "1234567890123456789012345678901234567890"
	instanceID := "0123456789abcdef0123456789abcdef"
	seller := "0.0.4318411"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v2:" + expiry + ":" + nonce + ":" + sessionID + ":" + ownerHex + ":" + seller + ":" + instanceID))
	ticket := "auth.v2." + expiry + "." + nonce + "." + sessionID + "." + ownerHex + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{sellerAccount: seller, secret: secret, instanceID: instanceID}
	details, valid := g.parseTicket(ticket, now)
	if !valid || details.nonce != nonce || details.sessionID != sessionID || details.owner != "0x"+ownerHex {
		t.Fatalf("valid customer ticket lost binding: %+v valid=%v", details, valid)
	}
	if g.validTicket("auth", now) || g.validTicket("auth.v2", now) || g.validTicket("auth.v2."+expiry, now) {
		t.Fatal("short malformed ticket accepted")
	}
	changedSession := "fedcba9876543210fedcba9876543210"
	if g.validTicket("auth.v2."+expiry+"."+nonce+"."+changedSession+"."+ownerHex+"."+hex.EncodeToString(mac.Sum(nil)), now) {
		t.Fatal("ticket accepted after customer session substitution")
	}
	g.sellerAccount = "0.0.6340259"
	if g.validTicket(ticket, now) {
		t.Fatal("customer ticket accepted for another seller")
	}
	g.sellerAccount = seller
	g.instanceID = "fedcba9876543210fedcba9876543210"
	if g.validTicket(ticket, now) {
		t.Fatal("customer ticket accepted after gateway restart")
	}
}

func TestSessionCheckRequiresSecretAndActiveCustomer(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	owner := "0x1234567890123456789012345678901234567890"
	seller := "0.0.4318411"
	g := &gateway{sellerAccount: seller, secret: secret,
		subscriber: &subscriber{sessionID: testSession, owner: owner}}
	check := func(session, requestedOwner, signature string) (int, string) {
		r := httptest.NewRequest(http.MethodPost, "http://localhost/session-check", nil)
		r.Header.Set("X-Neuron-Session-ID", session)
		r.Header.Set("X-Neuron-Owner", requestedOwner)
		r.Header.Set("X-Neuron-Auth", signature)
		w := httptest.NewRecorder()
		g.serveSessionCheck(w, r)
		return w.Code, w.Body.String()
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("session-check:" + testSession + ":" + owner + ":" + seller))
	signature := hex.EncodeToString(mac.Sum(nil))
	if status, _ := check(testSession, owner, ""); status != http.StatusUnauthorized {
		t.Fatal("unsigned session check accepted")
	}
	if status, body := check(testSession, owner, signature); status != http.StatusOK || body != "{\"connected\":true}\n" {
		t.Fatalf("active owner session rejected: HTTP %d %s", status, body)
	}
	if status, body := check("00000000000000000000000000000000", owner, signature); status != http.StatusUnauthorized || body == "" {
		t.Fatal("session substitution accepted")
	}
	g.mu.Lock()
	g.subscriber = nil
	g.mu.Unlock()
	if status, body := check(testSession, owner, signature); status != http.StatusOK || body != "{\"connected\":false}\n" {
		t.Fatalf("disconnected owner session still active: HTTP %d %s", status, body)
	}
}

func TestCustomerTicketWebSocketCarriesBytesAndJournalsOwner(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	instanceID := "0123456789abcdef0123456789abcdef"
	seller := "0.0.4318411"
	nonce := "00112233445566778899aabbccddeeff"
	expiry := strconv.FormatInt(time.Now().Unix()+45, 10)
	ownerHex := "1234567890123456789012345678901234567890"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v2:" + expiry + ":" + nonce + ":" + testSession + ":" + ownerHex + ":" + seller + ":" + instanceID))
	ticket := "auth.v2." + expiry + "." + nonce + "." + testSession + "." + ownerHex + "." + hex.EncodeToString(mac.Sum(nil))
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(dir, "sessions.ndjson")
	journal, err := openSessionJournal(journalPath, seller, instanceID)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	g := &gateway{origin: "http://localhost:3000", sellerAccount: seller, secret: secret, instanceID: instanceID, journal: journal}
	server := httptest.NewServer(http.HandlerFunc(g.serveStream))
	defer server.Close()
	streamURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	streamURL.Scheme = "ws"
	streamURL.Path = "/stream"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, streamURL.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{g.origin}}, Subprotocols: []string{"neuron.v1", ticket},
	})
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("customer WebSocket rejected: %v, response=%v", err, response)
	}
	data := []byte{0x8d, 0x40, 0x62, 0x1d, 0x00, 0xff}
	if err := g.onBytes(data); err != nil {
		t.Fatal(err)
	}
	messageType, received, err := conn.Read(ctx)
	if err != nil || messageType != websocket.MessageBinary || string(received) != string(data) {
		t.Fatalf("binary WebSocket payload changed: type=%v bytes=%x err=%v", messageType, received, err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test complete")
	for attempt := 0; attempt < 30; attempt++ {
		events := readJournalEvents(t, journalPath)
		if len(events) == 2 {
			if events[0].Event != "opened" || events[1].Event != "closed" || events[0].OwnerAddress != testOwner ||
				events[1].OwnerAddress != testOwner || events[0].SessionID != testSession || events[1].SessionID != testSession ||
				events[1].Bytes != uint64(len(data)) {
				t.Fatalf("customer connection journal mismatch: %+v", events)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("customer connection did not close durably")
}
