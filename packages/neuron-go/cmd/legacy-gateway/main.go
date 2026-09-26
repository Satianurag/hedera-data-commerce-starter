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
	"neuron-customer-app/neuron-go/legacy"
)

var idPattern = regexp.MustCompile(`^0\.0\.[1-9]\d*$`)
var ticketHex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)
var ticketHex40 = regexp.MustCompile(`^[0-9a-f]{40}$`)

type ticketDetails struct {
	nonce     string
	sessionID string
	owner     string
}

type subscriber struct {
	frames  chan []byte
	failure chan struct{}
}

type gateway struct {
	mu            sync.Mutex
	subscriber    *subscriber
	sellerAccount string
	origin        string
	token         string
	secret        []byte
	instanceID    string
	journal       *sessionJournal
	usedTickets   map[string]int64
	bytes         uint64
	chunks        uint64
	lastDataAt    time.Time
}

func (g *gateway) validTicket(candidate string, now time.Time) bool {
	_, valid := g.parseTicket(candidate, now)
	return valid
}

func (g *gateway) parseTicket(candidate string, now time.Time) (ticketDetails, bool) {
	if len(g.instanceID) != 32 {
		return ticketDetails{}, false
	}
	parts := strings.Split(candidate, ".")
	if len(parts) < 5 || parts[0] != "auth" || !ticketHex32.MatchString(parts[3]) ||
		(parts[1] == "v1" && len(parts) != 5) || (parts[1] == "v2" && len(parts) != 7) ||
		(parts[1] != "v1" && parts[1] != "v2") {
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
	g.mu.Lock()
	defer g.mu.Unlock()
	g.bytes += uint64(len(chunk))
	g.chunks++
	g.lastDataAt = time.Now()
	if g.subscriber == nil {
		return nil
	}
	select {
	case g.subscriber.frames <- chunk:
		return nil
	default:
		select {
		case g.subscriber.failure <- struct{}{}:
		default:
		}
		return errors.New("browser subscriber cannot keep up with seller stream")
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
		localStatic := remoteIP != nil && remoteIP.IsLoopback() && len(candidate) == len(g.token)+5 && subtle.ConstantTimeCompare([]byte(candidate), []byte("auth."+g.token)) == 1
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
	sub := &subscriber{frames: make(chan []byte, 64), failure: make(chan struct{}, 1)}
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
	ctx := conn.CloseRead(r.Context())
	for {
		select {
		case <-ctx.Done():
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
	g.mu.Lock()
	response := struct {
		Network          string `json:"network"`
		SellerAccount    string `json:"sellerAccount"`
		InstanceID       string `json:"instanceId"`
		BrowserConnected bool   `json:"browserConnected"`
		ReceivedChunks   uint64 `json:"receivedChunks"`
		ReceivedBytes    uint64 `json:"receivedBytes"`
		LastDataAt       string `json:"lastDataAt,omitempty"`
	}{Network: "testnet", SellerAccount: g.sellerAccount, InstanceID: g.instanceID, BrowserConnected: g.subscriber != nil, ReceivedChunks: g.chunks, ReceivedBytes: g.bytes}
	if !g.lastDataAt.IsZero() {
		response.LastDataAt = g.lastDataAt.UTC().Format(time.RFC3339Nano)
	}
	g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
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
	return record.Key.Key, nil
}

func run() error {
	if os.Getenv("HEDERA_NETWORK") != "testnet" {
		return errors.New("legacy gateway is testnet-only until a mainnet legacy seller directory is verified")
	}
	sellerID := os.Getenv("NEURON_SELLER_ACCOUNT_ID")
	sellerKey, err := getSellerPublicKey(sellerID)
	if err != nil {
		return err
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
	cert, keyCert := os.Getenv("NEURON_TLS_CERT_FILE"), os.Getenv("NEURON_TLS_KEY_FILE")
	if !loopback && (cert == "" || keyCert == "") {
		return errors.New("non-loopback gateway listener requires TLS certificate and key")
	}
	origin := os.Getenv("NEURON_APP_ORIGIN")
	if !strings.HasPrefix(origin, "http://localhost:") && !strings.HasPrefix(origin, "http://127.0.0.1:") && !strings.HasPrefix(origin, "https://") {
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
	g := &gateway{sellerAccount: sellerID, origin: origin, token: token, secret: secret, instanceID: hex.EncodeToString(instanceBytes)}
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
	receiver, err := legacy.NewReceiver(ctx, p2pKey, sellerKey, uint16(portValue), g.onBytes)
	if err != nil {
		return err
	}
	defer receiver.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", g.serveStream)
	mux.HandleFunc("/health", g.serveHealth)
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
