package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fixedSellerStream struct{ since time.Time }

func (s *fixedSellerStream) ActiveSince() time.Time { return s.since }

func TestHealthSeparatesBrowserSellerConnectionAndFreshBytes(t *testing.T) {
	now := time.Now()
	stream := &fixedSellerStream{}
	g := &gateway{sellerAccount: "0.0.4318411", stream: stream,
		subscriber: &subscriber{frames: make(chan []byte, 1)}}
	read := func() map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		g.serveHealth(w, httptest.NewRequest(http.MethodGet, "/health", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("health returned HTTP %d", w.Code)
		}
		var data map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	state := read()
	if state["browserConnected"] != true || state["sellerStreamConnected"] != false || state["sellerDataFresh"] != false {
		t.Fatalf("browser alone was treated as seller delivery: %+v", state)
	}
	stream.since = now.Add(-2 * time.Second)
	state = read()
	if state["sellerStreamConnected"] != true || state["sellerDataFresh"] != false {
		t.Fatalf("open seller stream without bytes was treated as delivery: %+v", state)
	}
	g.lastDataAt = now.Add(-time.Second)
	state = read()
	if state["sellerDataFresh"] != true {
		t.Fatalf("recent bytes on current seller stream were not fresh: %+v", state)
	}
	stream.since = now
	state = read()
	if state["sellerStreamConnected"] != true || state["sellerDataFresh"] != false {
		t.Fatalf("new stream inherited previous seller bytes: %+v", state)
	}
	stream.since = now.Add(-30 * time.Second)
	g.lastDataAt = now.Add(-20 * time.Second)
	state = read()
	if state["sellerDataFresh"] != false {
		t.Fatalf("stale seller bytes were reported fresh: %+v", state)
	}
	stream.since = time.Time{}
	state = read()
	if state["sellerStreamConnected"] != false || state["sellerDataFresh"] != false || state["sellerStreamSince"] != nil {
		t.Fatalf("closed seller stream was reported active: %+v", state)
	}
}

func TestFullBrowserQueueDisconnectsSubscriberWithoutStoppingSeller(t *testing.T) {
	sub := &subscriber{frames: make(chan []byte), failure: make(chan struct{}, 1)}
	g := &gateway{subscriber: sub}
	if err := g.onBytes([]byte{0xff, 0x00}); err != nil {
		t.Fatalf("browser backpressure stopped seller stream: %v", err)
	}
	if !sub.failed {
		t.Fatal("slow browser was not marked failed")
	}
	select {
	case <-sub.failure:
	default:
		t.Fatal("browser was not notified of stream backpressure")
	}
	if err := g.onBytes([]byte{0x8d}); err != nil || g.bytes != 3 || g.chunks != 2 {
		t.Fatalf("seller ingress stopped after browser failure: err=%v bytes=%d chunks=%d", err, g.bytes, g.chunks)
	}
}

func TestBrowserQueueCopiesBytesAndBoundsChunks(t *testing.T) {
	sub := &subscriber{frames: make(chan []byte, 1), failure: make(chan struct{}, 1)}
	g := &gateway{subscriber: sub}
	chunk := []byte{0x8d, 0xff}
	if err := g.onBytes(chunk); err != nil {
		t.Fatal(err)
	}
	chunk[0] = 0x00
	if got := <-sub.frames; got[0] != 0x8d {
		t.Fatalf("queued seller bytes mutated: %x", got)
	}
	if err := g.onBytes(make([]byte, 32*1024+1)); err == nil {
		t.Fatal("oversized chunk was accepted")
	}
	if g.bytes != 2 || g.chunks != 1 {
		t.Fatal("rejected chunk changed ingress counters")
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

func TestPublicGatewayRejectsUnboundAndStaticTickets(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	instanceID := "0123456789abcdef0123456789abcdef"
	seller := "0.0.4318411"
	expiry := strconv.FormatInt(time.Now().Unix()+45, 10)
	nonce := "00112233445566778899aabbccddeeff"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v1:" + expiry + ":" + nonce + ":" + seller + ":" + instanceID))
	v1 := "auth.v1." + expiry + "." + nonce + "." + hex.EncodeToString(mac.Sum(nil))
	for _, gateway := range []*gateway{
		{origin: "https://pilot.example", sellerAccount: seller, secret: secret, token: hex.EncodeToString(secret), instanceID: instanceID},
		{origin: "http://localhost:3000", publicListener: true, sellerAccount: seller, secret: secret, token: hex.EncodeToString(secret), instanceID: instanceID},
	} {
		if gateway.validTicket(v1, time.Now()) {
			t.Fatal("public gateway accepted an identity-free v1 ticket")
		}
		for _, candidate := range []string{v1, "auth." + gateway.token} {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:9080/stream", nil)
			r.Header.Set("Origin", gateway.origin)
			r.Header.Set("Sec-WebSocket-Protocol", "neuron.v1, "+candidate)
			r.RemoteAddr = "127.0.0.1:1234"
			w := httptest.NewRecorder()
			gateway.serveStream(w, r)
			if w.Code != http.StatusUnauthorized || len(gateway.usedTickets) != 0 {
				t.Fatalf("public stream accepted an unbound ticket: status=%d ticket=%q", w.Code, candidate)
			}
		}
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
	var active atomic.Bool
	active.Store(true)
	checkServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/gateway-session" || r.ContentLength != 0 ||
			r.Header.Get("X-Neuron-Session-ID") != testSession || r.Header.Get("X-Neuron-Owner") != testOwner ||
			r.Header.Get("X-Neuron-Instance-ID") != instanceID {
			http.Error(w, "bad request", http.StatusUnauthorized)
			return
		}
		timestamp := r.Header.Get("X-Neuron-Timestamp")
		nonce := r.Header.Get("X-Neuron-Nonce")
		if _, err := strconv.ParseInt(timestamp, 10, 64); err != nil {
			http.Error(w, "bad timestamp", http.StatusUnauthorized)
			return
		}
		if !ticketHex32.MatchString(nonce) {
			http.Error(w, "bad nonce", http.StatusUnauthorized)
			return
		}
		checkMAC := hmac.New(sha256.New, secret)
		_, _ = checkMAC.Write([]byte("session-live:" + instanceID + ":" + timestamp + ":" + nonce + ":" + testSession + ":" + testOwner))
		if r.Header.Get("X-Neuron-Auth") != hex.EncodeToString(checkMAC.Sum(nil)) {
			http.Error(w, "bad auth", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeSignedSessionCheckResponse(w, r, secret, instanceID, active.Load())
	}))
	defer checkServer.Close()
	g := &gateway{origin: "http://localhost:3000", sellerAccount: seller, secret: secret, instanceID: instanceID,
		journal: journal, sessionCheckURL: checkServer.URL + "/api/gateway-session", sessionCheckHTTP: newSessionCheckClient()}
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
	active.Store(false)
	readCtx, stopRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRead()
	if _, _, err := conn.Read(readCtx); err == nil {
		t.Fatalf("revoked customer WebSocket remained open: %v", err)
	}
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

func TestCustomerSessionCheckFailsClosedBeforeTicketConsumption(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	instanceID := "0123456789abcdef0123456789abcdef"
	seller := "0.0.4318411"
	nonce := "00112233445566778899aabbccddeeff"
	expiry := strconv.FormatInt(time.Now().Unix()+45, 10)
	ownerHex := "1234567890123456789012345678901234567890"
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("v2:" + expiry + ":" + nonce + ":" + testSession + ":" + ownerHex + ":" + seller + ":" + instanceID))
	ticket := "auth.v2." + expiry + "." + nonce + "." + testSession + "." + ownerHex + "." + hex.EncodeToString(mac.Sum(nil))
	g := &gateway{origin: "http://localhost:3000", sellerAccount: seller, secret: secret, instanceID: instanceID}
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "http://localhost:9080/stream", nil)
		r.Header.Set("Origin", g.origin)
		r.Header.Set("Sec-WebSocket-Protocol", "neuron.v1, "+ticket)
		return r
	}
	response := httptest.NewRecorder()
	g.serveStream(response, request())
	if response.Code != http.StatusUnauthorized || len(g.usedTickets) != 0 {
		t.Fatalf("missing app check did not fail closed before consumption: HTTP %d tickets=%d", response.Code, len(g.usedTickets))
	}
	checkServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeSignedSessionCheckResponse(w, r, secret, instanceID, false)
	}))
	defer checkServer.Close()
	g.sessionCheckURL = checkServer.URL + "/api/gateway-session"
	g.sessionCheckHTTP = newSessionCheckClient()
	response = httptest.NewRecorder()
	g.serveStream(response, request())
	if response.Code != http.StatusUnauthorized || len(g.usedTickets) != 0 {
		t.Fatalf("inactive app session consumed ticket: HTTP %d tickets=%d", response.Code, len(g.usedTickets))
	}
}

func TestSessionCheckURLAndResponseRestrictions(t *testing.T) {
	for _, candidate := range []string{
		"http://127.0.0.1:3000/api/gateway-session", "http://[::1]:3000/api/gateway-session",
	} {
		if err := validateSessionCheckURL(candidate); err != nil {
			t.Fatalf("valid loopback URL rejected: %q: %v", candidate, err)
		}
	}
	for _, candidate := range []string{
		"http://localhost:3000/api/gateway-session", "http://127.0.0.2:3000/other",
		"https://127.0.0.1:3000/api/gateway-session", "http://127.0.0.1:3000/api/gateway-session?x=1",
		"http://127.0.0.1:3000/api/gateway-session#fragment", "http://user@127.0.0.1:3000/api/gateway-session",
		"http://example.com:3000/api/gateway-session", "http://127.0.0.1/api/gateway-session",
	} {
		if err := validateSessionCheckURL(candidate); err == nil {
			t.Fatalf("unsafe session check URL accepted: %q", candidate)
		}
	}
	instanceID := "0123456789abcdef0123456789abcdef"
	identity := ticketDetails{sessionID: testSession, owner: testOwner}
	secret := []byte("01234567890123456789012345678901")
	var replayedResponse string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.RawQuery {
		case "redirect":
			http.Redirect(w, r, "http://example.com/", http.StatusFound)
		case "oversize":
			writeSignedSessionCheckResponse(w, r, secret, instanceID, true)
			_, _ = w.Write([]byte(strings.Repeat(" ", 1025)))
		case "wrong-instance":
			writeSignedSessionCheckResponse(w, r, secret, "other", true)
		case "unavailable":
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		case "unsigned":
			_, _ = w.Write([]byte(`{"active":true,"instanceId":"` + instanceID + `","nonce":"` + r.Header.Get("X-Neuron-Nonce") + `"}`))
		case "forged-active":
			response := httptest.NewRecorder()
			writeSignedSessionCheckResponse(response, r, secret, instanceID, false)
			_, _ = w.Write([]byte(strings.Replace(response.Body.String(), `"active":false`, `"active":true`, 1)))
		case "capture":
			response := httptest.NewRecorder()
			writeSignedSessionCheckResponse(response, r, secret, instanceID, true)
			replayedResponse = response.Body.String()
			_, _ = w.Write([]byte(replayedResponse))
		case "replayed":
			_, _ = w.Write([]byte(replayedResponse))
		default:
			writeSignedSessionCheckResponse(w, r, secret, instanceID, true)
		}
	}))
	defer server.Close()
	g := &gateway{secret: secret, instanceID: instanceID,
		sessionCheckURL: server.URL + "/api/gateway-session", sessionCheckHTTP: newSessionCheckClient()}
	if !g.customerSessionActive(context.Background(), identity) {
		t.Fatal("valid active app response rejected")
	}
	for _, query := range []string{"redirect", "oversize", "wrong-instance", "unavailable", "unsigned", "forged-active"} {
		g.sessionCheckURL = server.URL + "/api/gateway-session?" + query
		if g.customerSessionActive(context.Background(), identity) {
			t.Fatalf("unsafe app response accepted: %s", query)
		}
	}
	g.sessionCheckURL = server.URL + "/api/gateway-session?capture"
	if !g.customerSessionActive(context.Background(), identity) {
		t.Fatal("signed capture response was rejected")
	}
	g.sessionCheckURL = server.URL + "/api/gateway-session?replayed"
	if g.customerSessionActive(context.Background(), identity) {
		t.Fatal("replayed signed response was accepted for a new nonce")
	}
}

func writeSignedSessionCheckResponse(w http.ResponseWriter, r *http.Request, secret []byte, instanceID string, active bool) {
	bit := "0"
	if active {
		bit = "1"
	}
	nonce := r.Header.Get("X-Neuron-Nonce")
	proofMAC := hmac.New(sha256.New, secret)
	_, _ = proofMAC.Write([]byte("session-live-response:" + instanceID + ":" + r.Header.Get("X-Neuron-Timestamp") + ":" + nonce + ":" +
		r.Header.Get("X-Neuron-Session-ID") + ":" + r.Header.Get("X-Neuron-Owner") + ":" + bit))
	_ = json.NewEncoder(w).Encode(struct {
		Active     bool   `json:"active"`
		InstanceID string `json:"instanceId"`
		Nonce      string `json:"nonce"`
		Proof      string `json:"proof"`
	}{active, instanceID, nonce, hex.EncodeToString(proofMAC.Sum(nil))})
}
