// This original command is compiled as an overlay in the pinned upstream Go
// module. Upstream canonical serializers, signatures and real libp2p transport
// are imported unchanged; wallet authorization and durable orchestration live here.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

func (s *server) publicConfig() any {
	return map[string]any{
		"enabled": true, "network": "testnet", "chainId": 296, "sourceRevision": revision, "escrowAddress": hexAddress(s.cfg.EscrowAddress).Hex(),
		"service":              map[string]any{"name": "Owner document delivery", "filename": s.sourceName, "bytes": s.sourceSize, "sha256": s.sourceHash, "priceBaseUnits": s.cfg.PriceBaseUnits, "currency": s.currency(), "tokenAddress": hexAddress(s.cfg.TokenAddress).Hex(), "tokenDecimals": s.cfg.TokenDecimals, "tokenSymbol": s.cfg.TokenSymbol, "sellerAddress": s.seller.Hex(), "sellerAccountId": s.cfg.SellerAccountID},
		"limits":               map[string]any{"refundAfterSeconds": s.cfg.RefundAfterSeconds, "maxSessions": s.cfg.MaxSessions},
		"identityNote":         "Configured owner-operated reference service. Buyer HCS messages are signed by a server protocol delegate and paid by the HCS operator. Your signed-in EVM wallet is bound in the signed request and exclusively authorizes its escrow funding, approval and refund. Both real P2P peers run on this host; delivery evidence proves exact file bytes received by the buyer bridge, not browser receipt or an independent sensor feed.",
		"buyerProtocolAddress": canonicalKeyAddress(&s.buyerKey), "hcsOperatorAccountId": s.cfg.OperatorAccountID,
	}
}
func response(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func publicFailure(id string, e error) string {
	log.Printf("reference session %s: %v", id, e)
	safe := map[string]bool{
		"transaction not indexed/confirmed yet; use refresh with the saved hash":                                                            true,
		"receipt not indexed yet; retain saved hash and refresh":                                                                            true,
		"submitted transaction does not match authorized buyer intent":                                                                      true,
		"wallet has insufficient test ERC20 token balance":                                                                                  true,
		"delivery window expired; claim the timeout refund":                                                                                 true,
		"three delivery attempts used; wait for the buyer timeout refund":                                                                   true,
		"HCS indexing unconfirmed; reconcile saved transaction before retry":                                                                true,
		"seller transaction receipt pending; retry only reconciliation":                                                                     true,
		"seller gas price exceeds configured budget":                                                                                        true,
		"a wallet intent already exists; reconcile its hash before another transaction":                                                     true,
		"wallet action unavailable for current state":                                                                                       true,
		"buyer must explicitly approve the invoice in their wallet first":                                                                   true,
		"received document differs from negotiated exact bytes":                                                                             true,
		"seller release payee, amount or evidence mismatch":                                                                                 true,
		"escrow does not match signed negotiation and wallet":                                                                               true,
		"only a wallet rejection before broadcasting can be cancelled":                                                                      true,
		"only an explicit wallet rejection before broadcast can clear this intent":                                                          true,
		"only a prepared intent can open a wallet":                                                                                          true,
		"historical intent has no recorded nonce; reconcile its transaction hash before continuing":                                         true,
		"recorded wallet nonce is already used; recover the transaction hash from wallet history":                                           true,
		"this wallet nonce is reserved by another unresolved reference purchase":                                                            true,
		"wallet retry limit reached; reconcile the recorded nonce and transaction history":                                                  true,
		"submitted transaction nonce does not match the recorded wallet intent":                                                             true,
		"this wallet has an unresolved historical intent without a nonce; use its transaction history to reconcile before another purchase": true,
	}
	if safe[e.Error()] {
		return e.Error()
	}
	return "Reference operation is incomplete. Refresh to reconcile its recorded status; server diagnostics contain the details."
}
func readBody(r *http.Request, v any) error {
	if r.Header.Get("Content-Type") != "application/json" {
		return errors.New("application/json required")
	}
	d := json.NewDecoder(io.LimitReader(r.Body, 8193))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("single JSON body required")
	}
	return nil
}
func (s *server) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		response(w, 403, map[string]string{"error": "browser access must use the authenticated application proxy"})
		return
	}
	auth := r.Header.Get("Authorization")
	want := "Bearer " + s.token
	if len(auth) != len(want) || subtle.ConstantTimeCompare([]byte(auth), []byte(want)) != 1 {
		response(w, 401, map[string]string{"error": "bridge authorization required"})
		return
	}
	host, _, e := net.SplitHostPort(r.Host)
	if e != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		response(w, 403, map[string]string{"error": "loopback Host required"})
		return
	}
	if r.URL.RawQuery != "" {
		response(w, 400, map[string]string{"error": "query parameters unsupported"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == "GET" && r.URL.Path == "/v1/config" {
		response(w, 200, s.publicConfig())
		return
	}
	wallet := r.Header.Get("X-Customer-Wallet")
	customerSession := r.Header.Get("X-Customer-Session")
	if !common.IsHexAddress(wallet) || hexAddress(wallet) == (common.Address{}) || len(customerSession) < 8 || len(customerSession) > 256 {
		response(w, 401, map[string]string{"error": "authenticated customer wallet and session required"})
		return
	}
	wallet = hexAddress(wallet).Hex()
	if r.URL.Path == "/v1/sessions" {
		if r.Method == "GET" {
			sessions := []any{}
			for _, v := range s.sessions {
				if v.BuyerAddress == wallet {
					if e = s.available(v); e != nil {
						v.Message = publicFailure(v.ID, e)
					}
					sessions = append(sessions, s.publicSession(v))
				}
			}
			response(w, 200, map[string]any{"sessions": sessions})
			return
		}
		if r.Method != "POST" {
			response(w, 405, map[string]string{"error": "method unsupported"})
			return
		}
		var input struct {
			BuyerAddress      string `json:"buyerAddress"`
			CustomerSessionID string `json:"customerSessionId"`
			RequestID         string `json:"requestId"`
		}
		if e = readBody(r, &input); e != nil || !uuidPattern.MatchString(input.RequestID) || input.BuyerAddress != wallet || input.CustomerSessionID != customerSession {
			response(w, 400, map[string]string{"error": "request identity or identifier mismatch"})
			return
		}
		if wallet == s.seller.Hex() {
			response(w, 400, map[string]string{"error": "buyer and seller must use distinct wallets"})
			return
		}
		v := s.sessions[input.RequestID]
		if v != nil && v.BuyerAddress != wallet {
			response(w, 404, map[string]string{"error": "session not found"})
			return
		}
		if v == nil {
			if len(s.sessions) >= s.cfg.MaxSessions {
				response(w, 429, map[string]string{"error": "configured lifetime session cap reached"})
				return
			}
			v = &session{ID: input.RequestID, BuyerAddress: wallet, CustomerSessionID: customerSession, State: "negotiating", CreatedAt: time.Now().Unix(), Deadline: uint64(time.Now().Unix()) + s.cfg.RefundAfterSeconds, ConfigHash: s.configHash, Messages: []hcsMessage{}, Transactions: []transaction{}, WalletActions: []walletAction{}}
			s.sessions[v.ID] = v
			if e = s.save(v); e != nil {
				delete(s.sessions, v.ID)
				response(w, 500, map[string]string{"error": "could not durably record new session"})
				return
			}
		}
		if e = s.negotiate(v); e != nil {
			v.Message = publicFailure(v.ID, e)
			_ = s.save(v)
		}
		if availableErr := s.available(v); availableErr != nil {
			v.Message = publicFailure(v.ID, availableErr)
		}
		response(w, 200, s.publicSession(v))
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || len(parts) > 4 || parts[0] != "v1" || parts[1] != "sessions" || !uuidPattern.MatchString(parts[2]) {
		response(w, 404, map[string]string{"error": "route not found"})
		return
	}
	v := s.sessions[parts[2]]
	if v == nil || v.BuyerAddress != wallet {
		response(w, 404, map[string]string{"error": "session not found"})
		return
	}
	if v.CustomerSessionID != customerSession {
		v.CustomerSessionID = customerSession
		if e = s.save(v); e != nil {
			response(w, 500, map[string]string{"error": "could not persist customer session rebind"})
			return
		}
	}
	if len(parts) == 3 && r.Method == "GET" {
		if e = s.available(v); e != nil {
			v.Message = publicFailure(v.ID, e)
		}
		response(w, 200, s.publicSession(v))
		return
	}
	if len(parts) == 4 && parts[3] == "file" && r.Method == "GET" {
		if v.Delivery == nil || v.Delivery.Filename != s.sourceName {
			response(w, 404, map[string]string{"error": "delivered file not available"})
			return
		}
		path := filepath.Join(s.stateDir, v.ID, "received", v.Delivery.Filename)
		raw, e := os.ReadFile(path)
		if e != nil {
			response(w, 503, map[string]string{"error": "received file unavailable"})
			return
		}
		digest := sha256.Sum256(raw)
		if hex.EncodeToString(digest[:]) != v.Delivery.SHA256 || int64(len(raw)) != v.Delivery.Bytes {
			response(w, 409, map[string]string{"error": "received file integrity changed"})
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": v.Delivery.Filename}))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(raw)
		return
	}
	if len(parts) != 4 || parts[3] != "actions" || r.Method != "POST" {
		response(w, 405, map[string]string{"error": "method unsupported"})
		return
	}
	var input struct {
		Action          string `json:"action"`
		Kind            string `json:"kind"`
		IntentID        string `json:"intentId"`
		TransactionHash string `json:"transactionHash"`
	}
	if e = readBody(r, &input); e != nil {
		response(w, 400, map[string]string{"error": "invalid action JSON"})
		return
	}
	switch input.Action {
	case "prepare":
		e = s.prepare(v, input.Kind)
	case "submitted":
		if v.PendingIntent == nil || input.IntentID != v.PendingIntent.ID {
			e = errors.New("wallet intent mismatch")
		} else {
			e = s.confirmWallet(v, input.TransactionHash)
		}
	case "open-wallet":
		e = s.openWallet(v, input.IntentID)
	case "wallet-rejected":
		if v.PendingIntent == nil || input.IntentID != v.PendingIntent.ID || v.PendingIntent.Status != "wallet-open" || v.PendingIntent.TransactionHash != "" || v.PendingIntent.OpenAttempts != 1 {
			e = errors.New("only an explicit wallet rejection before broadcast can clear this intent")
		} else {
			v.PendingIntent = nil
			v.Message = "Wallet rejected the request before broadcast."
			e = s.save(v)
		}
	case "cancel":
		if v.PendingIntent == nil || input.IntentID != v.PendingIntent.ID || v.PendingIntent.Status != "prepared" || v.PendingIntent.TransactionHash != "" {
			e = errors.New("only a wallet rejection before broadcasting can be cancelled")
		} else {
			v.PendingIntent = nil
			v.Message = "Wallet request cancelled before broadcast."
			e = s.save(v)
		}
	case "refresh":
		if v.PendingIntent != nil && v.PendingIntent.TransactionHash != "" {
			e = s.confirmWallet(v, v.PendingIntent.TransactionHash)
		} else if v.State == "negotiating" {
			e = s.negotiate(v)
		} else if v.State == "delivered" || v.SellerTxKind == "request-release" {
			e = s.deliver(v)
		} else if v.SellerTxKind == "withdraw" {
			e = s.settle(v)
		}
	case "deliver":
		e = s.deliver(v)
	case "settle":
		e = s.settle(v)
	default:
		e = errors.New("unsupported action")
	}
	if e != nil {
		v.Message = publicFailure(v.ID, e)
		_ = s.save(v)
		// An already opened intent retains that state when retry is refused.
		// Return non-2xx so that old status cannot authorize a new wallet call.
		if input.Action == "open-wallet" {
			response(w, 409, map[string]any{"error": v.Message, "session": s.publicSession(v)})
			return
		}
	}
	if availableErr := s.available(v); availableErr != nil {
		v.Message = publicFailure(v.ID, availableErr)
	}
	response(w, 200, s.publicSession(v))
}
func main() {
	s, e := newServer()
	if e != nil {
		log.Fatal(e)
	}
	defer s.lock.Close()
	defer s.rpc.Close()
	defer s.hcs.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	e = s.preflight(ctx)
	cancel()
	if e != nil {
		log.Fatal("testnet preflight failed: ", e)
	}
	if len(os.Args) == 2 && os.Args[1] == "--check" {
		_ = json.NewEncoder(os.Stdout).Encode(s.publicConfig())
		return
	}
	addr := os.Getenv("NEURON_REFERENCE_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8098"
	}
	host, _, e := net.SplitHostPort(addr)
	if e != nil || host != "127.0.0.1" {
		log.Fatal("NEURON_REFERENCE_LISTEN must be an IPv4 loopback address")
	}
	fmt.Println("Reference bridge ready on " + addr + " (testnet only; buyer transactions require wallet authorization)")
	server := &http.Server{Addr: addr, Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 240 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Fatal(server.ListenAndServe())
}
