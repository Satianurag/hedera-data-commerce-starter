package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
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
	now := time.Now()
	expiry := strconv.FormatInt(now.Unix()+45, 10)
	nonce := "00112233445566778899aabbccddeeff"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v1:" + expiry + ":" + nonce + ":0.0.4318411"))
	ticket := "auth.v1." + expiry + "." + nonce + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{origin: "http://localhost:3000", sellerAccount: "0.0.4318411", secret: secret}
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
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v1:" + expiry + ":" + nonce + ":0.0.4318411"))
	ticket := "auth.v1." + expiry + "." + nonce + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{sellerAccount: "0.0.4318411", secret: secret}
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
}
