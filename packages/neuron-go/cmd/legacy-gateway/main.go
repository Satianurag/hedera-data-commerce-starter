package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"github.com/libp2p/go-libp2p/core/crypto"
	"neuron-customer-app/neuron-go/directseller"
	"neuron-customer-app/neuron-go/legacy"
)

var idPattern = regexp.MustCompile(`^0\.0\.[1-9]\d*$`)
var ticketHex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)
var ticketHex40 = regexp.MustCompile(`^[0-9a-f]{40}$`)
var sellerPublicKeyPattern = regexp.MustCompile(`^0[23][0-9a-f]{64}$`)

type ticketDetails struct {
	nonce     string
	sessionID string
	owner     string
}

type subscriber struct {
	frames    chan []byte
	failure   chan struct{}
	revoked   chan struct{}
	sessionID string
	owner     string
	failed    bool // guarded by gateway.mu
}

type sellerStreamState interface {
	ActiveSince() time.Time
}

type gateway struct {
	mu               sync.Mutex
	subscriber       *subscriber
	stream           sellerStreamState
	sellerAccount    string
	sellerPublicKey  string
	origin           string
	token            string
	secret           []byte
	instanceID       string
	sessionCheckURL  string
	sessionCheckHTTP *http.Client
	journal          *sessionJournal
	publicListener   bool
	usedTickets      map[string]int64
	bytes            uint64
	chunks           uint64
	lastDataAt       time.Time
}

func (g *gateway) validTicket(candidate string, now time.Time) bool {
	_, valid := g.parseTicket(candidate, now)
	return valid
}

// A public gateway may only carry a customer-bound v2 ticket. Local legacy
// probes can still use v1 or the owner-held static token on loopback.
func (g *gateway) requiresCustomerSession() bool {
	return g.publicListener || strings.HasPrefix(g.origin, "https://")
}

func (g *gateway) parseTicket(candidate string, now time.Time) (ticketDetails, bool) {
	if len(g.instanceID) != 32 {
		return ticketDetails{}, false
	}
	parts := strings.Split(candidate, ".")
	if len(parts) < 5 || parts[0] != "auth" || !ticketHex32.MatchString(parts[3]) ||
		(parts[1] == "v1" && len(parts) != 5) || (parts[1] == "v2" && len(parts) != 7) ||
		(parts[1] != "v1" && parts[1] != "v2") ||
		(g.requiresCustomerSession() && parts[1] != "v2") {
		return ticketDetails{}, false
	}
	expiry, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || expiry < now.Unix() || expiry > now.Unix()+60 {
		return ticketDetails{}, false
	}
	details := ticketDetails{nonce: parts[3]}
	message := "v1:" + parts[2] + ":" + parts[3] + ":" + g.sellerAccount + ":" + g.instanceID
	signatureIndex := 4
	if parts[1] == "v2" {
		if !ticketHex32.MatchString(parts[4]) || !ticketHex40.MatchString(parts[5]) {
			return ticketDetails{}, false
		}
		details.sessionID = parts[4]
		details.owner = "0x" + parts[5]
		message = "v2:" + parts[2] + ":" + parts[3] + ":" + parts[4] + ":" + parts[5] + ":" + g.sellerAccount + ":" + g.instanceID
		signatureIndex = 6
	}
	signature, err := hex.DecodeString(parts[signatureIndex])
	if err != nil || len(signature) != sha256.Size {
		return ticketDetails{}, false
	}
	mac := hmac.New(sha256.New, g.secret)
	_, _ = io.WriteString(mac, message)
	return details, hmac.Equal(signature, mac.Sum(nil))
}

// consumeTicketLocked reserves a valid ticket while g.mu is held.
func (g *gateway) consumeTicketLocked(candidate string, now time.Time) bool {
	if !g.validTicket(candidate, now) {
		return false
	}
	parts := strings.Split(candidate, ".")
	expiry, _ := strconv.ParseInt(parts[2], 10, 64)
	if g.usedTickets == nil {
		g.usedTickets = make(map[string]int64)
	}
	for nonce, until := range g.usedTickets {
		if until < now.Unix() {
			delete(g.usedTickets, nonce)
		}
	}
	if _, used := g.usedTickets[parts[3]]; used || len(g.usedTickets) >= 1024 {
		return false
	}
	g.usedTickets[parts[3]] = expiry
	return true
}

func (g *gateway) onBytes(chunk []byte) error {
	if len(chunk) == 0 {
		return nil
	}
	if len(chunk) > 32*1024 {
		return errors.New("seller chunk exceeds receiver buffer limit")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.bytes += uint64(len(chunk))
	g.chunks++
	g.lastDataAt = time.Now()
	if g.subscriber == nil || g.subscriber.failed {
		return nil
	}
	select {
	case g.subscriber.frames <- append([]byte(nil), chunk...):
		return nil
	default:
		// A slow browser must not tear down the seller's QUIC stream. End only
		// this subscriber and require a fresh ticket for a later reconnect.
		g.subscriber.failed = true
		select {
		case g.subscriber.failure <- struct{}{}:
		default:
		}
		return nil
	}
}

// validateSessionCheckURL limits the gateway's authenticated call to a local
// app endpoint. Numeric loopback addresses avoid DNS and proxy redirection.
func validateSessionCheckURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Opaque != "" ||
		u.Path != "/api/gateway-session" || u.RawPath != "" || u.RawQuery != "" ||
		u.ForceQuery || u.Fragment != "" || u.String() != raw {
		return errors.New("NEURON_GATEWAY_SESSION_CHECK_URL must be an exact loopback HTTP /api/gateway-session URL")
	}
	ip := net.ParseIP(u.Hostname())
	port, err := strconv.ParseUint(u.Port(), 10, 16)
	if ip == nil || !ip.IsLoopback() || err != nil || port == 0 {
		return errors.New("NEURON_GATEWAY_SESSION_CHECK_URL must use a numeric loopback address and port")
	}
	return nil
}

func (g *gateway) customerSessionActive(ctx context.Context, identity ticketDetails) bool {
	if g.sessionCheckURL == "" || !ticketHex32.MatchString(g.instanceID) ||
		!ticketHex32.MatchString(identity.sessionID) || !ownerAddressPattern.MatchString(identity.owner) {
		return false
	}
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return false
	}
	nonce := hex.EncodeToString(nonceBytes)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, g.secret)
	_, _ = io.WriteString(mac, "session-live:"+g.instanceID+":"+timestamp+":"+nonce+":"+identity.sessionID+":"+identity.owner)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.sessionCheckURL, nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Neuron-Session-ID", identity.sessionID)
	req.Header.Set("X-Neuron-Owner", identity.owner)
	req.Header.Set("X-Neuron-Instance-ID", g.instanceID)
	req.Header.Set("X-Neuron-Timestamp", timestamp)
	req.Header.Set("X-Neuron-Nonce", nonce)
	req.Header.Set("X-Neuron-Auth", hex.EncodeToString(mac.Sum(nil)))
	client := g.sessionCheckHTTP
	if client == nil {
		client = newSessionCheckClient()
	}
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1025))
	if err != nil || len(body) > 1024 {
		return false
	}
	var result struct {
		Active     *bool  `json:"active"`
		InstanceID string `json:"instanceId"`
		Nonce      string `json:"nonce"`
		Proof      string `json:"proof"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || result.Active == nil ||
		result.InstanceID != g.instanceID || result.Nonce != nonce {
		return false
	}
	// A second decode rejects trailing values.
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || len(result.Proof) != sha256.Size*2 ||
		strings.ToLower(result.Proof) != result.Proof {
		return false
	}
	proof, err := hex.DecodeString(result.Proof)
	if err != nil || len(proof) != sha256.Size {
		return false
	}
	activeBit := "0"
	if *result.Active {
		activeBit = "1"
	}
	proofMAC := hmac.New(sha256.New, g.secret)
	_, _ = io.WriteString(proofMAC, "session-live-response:"+g.instanceID+":"+timestamp+":"+nonce+":"+identity.sessionID+":"+identity.owner+":"+activeBit)
	return hmac.Equal(proof, proofMAC.Sum(nil)) && *result.Active
}

func newSessionCheckClient() *http.Client {
	return &http.Client{
		Timeout:       2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{Proxy: nil, MaxResponseHeaderBytes: 4096},
	}
}

func (g *gateway) watchCustomerSession(ctx context.Context, sub *subscriber, identity ticketDetails, terminate func()) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if g.customerSessionActive(ctx, identity) {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			g.mu.Lock()
			shouldTerminate := false
			if g.subscriber == sub && !sub.failed {
				sub.failed = true
				shouldTerminate = true
				select {
				case sub.revoked <- struct{}{}:
				default:
				}
			}
			g.mu.Unlock()
			if shouldTerminate {
				terminate()
			}
			return
		}
	}
}

func (g *gateway) serveStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.Header.Get("Origin") != g.origin {
		http.Error(w, "origin rejected", http.StatusForbidden)
		return
	}
	validToken := false
	ticket := ""
	var identity ticketDetails
	remoteHost, _, _ := net.SplitHostPort(r.RemoteAddr)
	remoteIP := net.ParseIP(remoteHost)
	for _, part := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		candidate := strings.TrimSpace(part)
		localStatic := !g.requiresCustomerSession() && remoteIP != nil && remoteIP.IsLoopback() &&
			len(candidate) == len(g.token)+5 && subtle.ConstantTimeCompare([]byte(candidate), []byte("auth."+g.token)) == 1
		if localStatic {
			validToken = true
			break
		}
		if details, valid := g.parseTicket(candidate, time.Now()); valid {
			validToken = true
			ticket = candidate
			identity = details
			break
		}
	}
	if !validToken {
		http.Error(w, "session token rejected", http.StatusUnauthorized)
		return
	}
	if identity.sessionID != "" && !g.customerSessionActive(r.Context(), identity) {
		http.Error(w, "customer session unavailable", http.StatusUnauthorized)
		return
	}
	g.mu.Lock()
	if g.subscriber != nil {
		g.mu.Unlock()
		http.Error(w, "session already has a browser subscriber", http.StatusConflict)
		return
	}
	if ticket != "" && !g.consumeTicketLocked(ticket, time.Now()) {
		g.mu.Unlock()
		http.Error(w, "session token rejected", http.StatusUnauthorized)
		return
	}
	sub := &subscriber{frames: make(chan []byte, 64), failure: make(chan struct{}, 1), revoked: make(chan struct{}, 1), sessionID: identity.sessionID, owner: identity.owner}
	g.subscriber = sub
	g.mu.Unlock()
	accepted := false
	defer func() {
		g.mu.Lock()
		if g.subscriber == sub {
			g.subscriber = nil
		}
		if !accepted && ticket != "" {
			delete(g.usedTickets, identity.nonce)
		}
		g.mu.Unlock()
	}()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{g.origin}, Subprotocols: []string{"neuron.v1"}})
	if err != nil {
		return
	}
	accepted = true
	defer conn.Close(websocket.StatusNormalClosure, "session ended")
	connectionID := ""
	if ticket != "" {
		connectionID = identity.nonce
	} else {
		idBytes := make([]byte, 16)
		if _, err := rand.Read(idBytes); err != nil {
			_ = conn.Close(websocket.StatusInternalError, "cannot create connection ID")
			return
		}
		connectionID = hex.EncodeToString(idBytes)
	}
	var sentBytes uint64
	if g.journal != nil {
		if err := g.journal.recordOwned("opened", connectionID, 0, identity.owner, identity.sessionID); err != nil {
			_ = conn.Close(websocket.StatusInternalError, "session journal unavailable")
			return
		}
		defer func() {
			if err := g.journal.recordOwned("closed", connectionID, sentBytes, identity.owner, identity.sessionID); err != nil {
				fmt.Fprintf(os.Stderr, "session journal close failed: %v\n", err)
			}
		}()
	}
	ctx, stopStream := context.WithCancel(conn.CloseRead(r.Context()))
	defer stopStream()
	if identity.sessionID != "" {
		watchCtx, stopWatch := context.WithCancel(ctx)
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			g.watchCustomerSession(watchCtx, sub, identity, func() {
				stopStream()
				_ = conn.CloseNow()
			})
		}()
		defer func() { stopWatch(); <-watchDone }()
	}
	for {
		// Prefer the failure signal over queued data once backpressure occurs.
		select {
		case <-sub.revoked:
			_ = conn.Close(websocket.StatusPolicyViolation, "customer session inactive")
			return
		case <-sub.failure:
			_ = conn.Close(websocket.StatusInternalError, "stream backpressure")
			return
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-sub.revoked:
			_ = conn.Close(websocket.StatusPolicyViolation, "customer session inactive")
			return
		case <-sub.failure:
			_ = conn.Close(websocket.StatusInternalError, "stream backpressure")
			return
		case chunk := <-sub.frames:
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(writeCtx, websocket.MessageBinary, chunk)
			cancel()
			if err != nil {
				return
			}
			sentBytes += uint64(len(chunk))
		}
	}
}

func (g *gateway) serveHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method rejected", http.StatusMethodNotAllowed)
		return
	}
	streamSince := time.Time{}
	if g.stream != nil {
		streamSince = g.stream.ActiveSince()
	}
	now := time.Now()
	g.mu.Lock()
	response := struct {
		Network               string `json:"network"`
		SellerAccount         string `json:"sellerAccount"`
		InstanceID            string `json:"instanceId"`
		SellerStreamConnected bool   `json:"sellerStreamConnected"`
		SellerDataFresh       bool   `json:"sellerDataFresh"`
		SellerStreamSince     string `json:"sellerStreamSince,omitempty"`
		BrowserConnected      bool   `json:"browserConnected"`
		ReceivedChunks        uint64 `json:"receivedChunks"`
		ReceivedBytes         uint64 `json:"receivedBytes"`
		LastDataAt            string `json:"lastDataAt,omitempty"`
	}{Network: "testnet", SellerAccount: g.sellerAccount, InstanceID: g.instanceID, BrowserConnected: g.subscriber != nil && !g.subscriber.failed, ReceivedChunks: g.chunks, ReceivedBytes: g.bytes}
	if !g.lastDataAt.IsZero() {
		response.LastDataAt = g.lastDataAt.UTC().Format(time.RFC3339Nano)
		age := now.Sub(g.lastDataAt)
		response.SellerDataFresh = !streamSince.IsZero() && g.lastDataAt.After(streamSince) && age >= 0 && age <= 15*time.Second
	}
	g.mu.Unlock()
	if !streamSince.IsZero() && g.stream.ActiveSince() == streamSince {
		response.SellerStreamConnected = true
		response.SellerStreamSince = streamSince.UTC().Format(time.RFC3339Nano)
	} else {
		response.SellerDataFresh = false
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

func (g *gateway) serveSessionCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method rejected", http.StatusMethodNotAllowed)
		return
	}
	sessionID := r.Header.Get("X-Neuron-Session-ID")
	owner := r.Header.Get("X-Neuron-Owner")
	if !ticketHex32.MatchString(sessionID) || !strings.HasPrefix(owner, "0x") || !ticketHex40.MatchString(strings.TrimPrefix(owner, "0x")) {
		http.Error(w, "session check rejected", http.StatusUnauthorized)
		return
	}
	signature, err := hex.DecodeString(r.Header.Get("X-Neuron-Auth"))
	if err != nil || len(signature) != sha256.Size {
		http.Error(w, "session check rejected", http.StatusUnauthorized)
		return
	}
	mac := hmac.New(sha256.New, g.secret)
	_, _ = io.WriteString(mac, "session-check:"+sessionID+":"+owner+":"+g.sellerAccount)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		http.Error(w, "session check rejected", http.StatusUnauthorized)
		return
	}
	g.mu.Lock()
	connected := g.subscriber != nil && !g.subscriber.failed && g.subscriber.sessionID == sessionID && g.subscriber.owner == owner
	g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Connected bool `json:"connected"`
	}{Connected: connected})
}

// serveTransportEvidence is for the colocated app server only. The journal
// counts successful server WebSocket writes, not browser receipt or delivery
// quality. Its HMAC has a separate domain from ticket and session-check MACs.
func (g *gateway) serveTransportEvidence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.ContentLength != 0 {
		http.Error(w, "transport evidence request rejected", http.StatusForbidden)
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	peer := net.ParseIP(host)
	if err != nil || peer == nil || !peer.IsLoopback() {
		http.Error(w, "transport evidence is internal only", http.StatusForbidden)
		return
	}
	sessionID := r.Header.Get("X-Neuron-Session-ID")
	owner := r.Header.Get("X-Neuron-Owner")
	if !ticketHex32.MatchString(sessionID) || !ownerAddressPattern.MatchString(owner) {
		http.Error(w, "transport evidence authorization rejected", http.StatusUnauthorized)
		return
	}
	signature, err := hex.DecodeString(r.Header.Get("X-Neuron-Auth"))
	if err != nil || len(signature) != sha256.Size {
		http.Error(w, "transport evidence authorization rejected", http.StatusUnauthorized)
		return
	}
	mac := hmac.New(sha256.New, g.secret)
	_, _ = io.WriteString(mac, "transport-evidence:"+sessionID+":"+owner+":"+g.sellerAccount)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		http.Error(w, "transport evidence authorization rejected", http.StatusUnauthorized)
		return
	}
	if g.journal == nil {
		http.Error(w, "transport evidence journal unavailable", http.StatusServiceUnavailable)
		return
	}
	if !sellerPublicKeyPattern.MatchString(g.sellerPublicKey) {
		http.Error(w, "seller public key unavailable", http.StatusServiceUnavailable)
		return
	}
	evidence, err := g.journal.summarize(owner, sessionID)
	if err != nil {
		http.Error(w, "transport evidence journal unavailable", http.StatusServiceUnavailable)
		return
	}
	evidence.SellerPublicKey = g.sellerPublicKey
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(evidence)
}

func getSellerPublicKey(id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", errors.New("NEURON_SELLER_ACCOUNT_ID must be numeric")
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get("https://testnet.mirrornode.hedera.com/api/v1/accounts/" + id)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("seller Mirror returned HTTP %d", response.StatusCode)
	}
	var record struct {
		Account string `json:"account"`
		Deleted bool   `json:"deleted"`
		Key     struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"key"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&record); err != nil {
		return "", err
	}
	if record.Account != id || record.Deleted || record.Key.Type != "ECDSA_SECP256K1" {
		return "", errors.New("seller key is not active secp256k1 on testnet")
	}
	if _, err := legacy.SellerPeerID(record.Key.Key); err != nil {
		return "", err
	}
	return strings.ToLower(record.Key.Key), nil
}

func run() error {
	if os.Getenv("HEDERA_NETWORK") != "testnet" {
		return errors.New("legacy gateway is testnet-only until a mainnet legacy seller directory is verified")
	}
	sellerID := os.Getenv("NEURON_SELLER_ACCOUNT_ID")
	direct, err := directseller.LoadFromEnv()
	if err != nil {
		return err
	}
	if direct != nil {
		if direct.AccountID != sellerID {
			return errors.New("gateway seller differs from direct profile")
		}
		if err := directseller.CheckMirror(context.Background(), *direct); err != nil {
			return err
		}
	}
	sellerKey, err := getSellerPublicKey(sellerID)
	if err != nil {
		return err
	}
	if direct != nil && sellerKey != direct.PublicKey {
		return errors.New("gateway seller key differs from direct profile")
	}
	keyPath := os.Getenv("HEDERA_BUYER_KEY_FILE")
	keyInfo, err := os.Stat(keyPath)
	if err != nil || !keyInfo.Mode().IsRegular() || keyInfo.Mode().Perm()&0077 != 0 {
		return errors.New("HEDERA_BUYER_KEY_FILE must be owner-only")
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	privateKey, err := hedera.PrivateKeyFromStringDer(strings.TrimSpace(string(keyBytes)))
	if err != nil || len(privateKey.BytesRaw()) != 32 {
		return errors.New("buyer key must be ECDSA secp256k1 DER")
	}
	p2pKey, err := crypto.UnmarshalSecp256k1PrivateKey(privateKey.BytesRaw())
	if err != nil {
		return err
	}
	portValue, err := strconv.ParseUint(os.Getenv("NEURON_UDP_PORT"), 10, 16)
	if err != nil || portValue == 0 {
		return errors.New("NEURON_UDP_PORT must be a nonzero UDP port")
	}
	listen := os.Getenv("NEURON_GATEWAY_LISTEN")
	hostName, _, err := net.SplitHostPort(listen)
	if err != nil {
		return errors.New("NEURON_GATEWAY_LISTEN must be host:port")
	}
	parsedHost := net.ParseIP(hostName)
	loopback := hostName == "localhost" || (parsedHost != nil && parsedHost.IsLoopback())
	if direct != nil && direct.Transport == "loopback" && !loopback {
		return errors.New("loopback seller profile requires a loopback gateway listener")
	}
	cert, keyCert := os.Getenv("NEURON_TLS_CERT_FILE"), os.Getenv("NEURON_TLS_KEY_FILE")
	if !loopback && (cert == "" || keyCert == "") {
		return errors.New("non-loopback gateway listener requires TLS certificate and key")
	}
	origin := os.Getenv("NEURON_APP_ORIGIN")
	parsedOrigin, err := url.Parse(origin)
	if err != nil || parsedOrigin.Host == "" || parsedOrigin.User != nil ||
		parsedOrigin.Path != "" || parsedOrigin.RawQuery != "" || parsedOrigin.Fragment != "" ||
		parsedOrigin.ForceQuery || parsedOrigin.Opaque != "" || parsedOrigin.String() != origin ||
		(parsedOrigin.Scheme != "https" &&
			!(parsedOrigin.Scheme == "http" &&
				(parsedOrigin.Hostname() == "localhost" || parsedOrigin.Hostname() == "127.0.0.1") &&
				parsedOrigin.Port() != "")) {
		return errors.New("NEURON_APP_ORIGIN must be an exact HTTP(S) origin")
	}
	tokenPath := os.Getenv("NEURON_SESSION_TOKEN_FILE")
	tokenInfo, err := os.Stat(tokenPath)
	if err != nil || !tokenInfo.Mode().IsRegular() || tokenInfo.Mode().Perm()&0077 != 0 {
		return errors.New("session token file must be owner-only")
	}
	tokenBytes, err := os.ReadFile(tokenPath)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(string(tokenBytes))
	if matched, _ := regexp.MatchString(`^[0-9a-fA-F]{64}$`, token); !matched {
		return errors.New("session token must be 32 random hex bytes")
	}
	secret, _ := hex.DecodeString(token)
	instanceBytes := make([]byte, 16)
	if _, err := rand.Read(instanceBytes); err != nil {
		return errors.New("cannot create gateway instance ID")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	g := &gateway{sellerAccount: sellerID, sellerPublicKey: sellerKey, origin: origin,
		token: token, secret: secret, instanceID: hex.EncodeToString(instanceBytes), publicListener: !loopback}
	if checkURL := os.Getenv("NEURON_GATEWAY_SESSION_CHECK_URL"); checkURL != "" {
		if err := validateSessionCheckURL(checkURL); err != nil {
			return err
		}
		g.sessionCheckURL = checkURL
		g.sessionCheckHTTP = newSessionCheckClient()
	}
	if g.requiresCustomerSession() && g.sessionCheckURL == "" {
		return errors.New("public gateway requires NEURON_GATEWAY_SESSION_CHECK_URL for customer-bound streams")
	}
	journalPath := os.Getenv("NEURON_SESSION_JOURNAL_FILE")
	if journalPath == "" && !loopback {
		return errors.New("non-loopback gateway requires NEURON_SESSION_JOURNAL_FILE")
	}
	if journalPath != "" {
		g.journal, err = openSessionJournal(journalPath, sellerID, g.instanceID)
		if err != nil {
			return err
		}
		defer g.journal.Close()
	}
	newReceiver := legacy.NewReceiver
	if direct != nil && direct.Transport == "loopback" {
		newReceiver = legacy.NewLoopbackReceiver
	}
	receiver, err := newReceiver(ctx, p2pKey, sellerKey, uint16(portValue), g.onBytes)
	if err != nil {
		return err
	}
	defer receiver.Close()
	g.stream = receiver
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", g.serveStream)
	mux.HandleFunc("/health", g.serveHealth)
	mux.HandleFunc("/session-check", g.serveSessionCheck)
	mux.HandleFunc("/transport-evidence", g.serveTransportEvidence)
	server := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	fmt.Fprintf(os.Stderr, "testnet legacy gateway ready: seller=%s peer=%s UDP=%d HTTP=%s\n", sellerID, receiver.PeerID(), portValue, listen)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if cert != "" && keyCert != "" {
		err = server.ServeTLS(listener, cert, keyCert)
	} else {
		err = server.Serve(listener)
	}
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
