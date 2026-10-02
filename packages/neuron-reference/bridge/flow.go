package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/neuron-sdk/neuron-go-sdk/internal/delivery"
	"github.com/neuron-sdk/neuron-go-sdk/internal/payment"
)

const documentProtocol = "/neuron/file-delivery/1.0.0"

func (s *server) negotiate(v *session) error {
	if v.State != "negotiating" {
		return nil
	}
	request := payment.ServiceRequest{Type: "serviceRequest", Version: "1.0.0", RequestID: v.ID, ServiceRef: "owner-document", SettlementBinding: "evm-escrow", ProposedAmount: s.cfg.PriceBaseUnits, ProposedCurrency: s.currency(), ProposedInterval: "0", NegotiationDeadline: uint64(v.CreatedAt + 120), BuyerStdIn: s.cfg.BuyerTopicID, ServiceParams: map[string]any{"buyerWallet": v.BuyerAddress, "chainId": "296", "escrowAddress": hexAddress(s.cfg.EscrowAddress).Hex(), "fileSha256": s.sourceHash, "fileBytes": strconv.FormatInt(s.sourceSize, 10), "fileName": s.sourceName, "refundDeadline": strconv.FormatUint(v.Deadline, 10)}}
	if e := s.publish(v, "serviceRequest", request, false); e != nil {
		return e
	}
	// The seller consumes the independently Mirror-retrieved, verified payload.
	var received payment.ServiceRequest
	for _, m := range v.Messages {
		if m.Kind == "serviceRequest" && m.MirrorVerified {
			if e := json.Unmarshal(m.Payload, &received); e != nil {
				return e
			}
		}
	}
	if received.RequestID != v.ID || received.ProposedAmount != s.cfg.PriceBaseUnits || received.ProposedCurrency != s.currency() || received.SettlementBinding != "evm-escrow" || received.ServiceParams["buyerWallet"] != v.BuyerAddress || received.ServiceParams["fileSha256"] != s.sourceHash {
		return errors.New("seller rejected mismatching service request")
	}
	response := payment.ServiceResponse{Type: "serviceResponse", Version: "1.0.0", RequestID: v.ID, Action: "accept"}
	if e := s.publish(v, "serviceResponse", response, true); e != nil {
		return e
	}
	for _, m := range v.Messages {
		if m.Kind == "serviceResponse" && m.MirrorVerified {
			var accepted payment.ServiceResponse
			if e := json.Unmarshal(m.Payload, &accepted); e != nil {
				return e
			}
			if accepted.RequestID != v.ID || accepted.Action != "accept" || m.SenderAddress != s.seller.Hex() {
				return errors.New("buyer rejected unexpected acceptance")
			}
			hash := payment.ComputeAgreementHash(m.Payload)
			v.AgreementHash = "0x" + hex.EncodeToString(hash[:])
		}
	}
	if v.AgreementHash == "" {
		return errors.New("missing verified seller response")
	}
	v.State = "agreed"
	v.Message = "Seller acceptance verified from Hedera testnet. Review the document and exact test token price before funding."
	return s.save(v)
}
func (s *server) deliver(v *session) error {
	if v.State != "funded" && v.State != "delivered" && v.State != "invoiced" {
		return errors.New("delivery requires a funded escrow")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if e := s.verifyEscrow(ctx, v); e != nil {
		return e
	}
	esc, e := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
	if e != nil {
		return e
	}
	if esc.Balance.Cmp(integer(s.cfg.PriceBaseUnits)) < 0 || esc.State != 1 {
		return errors.New("escrow does not cover the negotiated amount")
	}
	if uint64(time.Now().Unix()+30) >= v.Deadline {
		return errors.New("delivery window expired; claim the timeout refund")
	}
	if e = s.publish(v, "escrowCreated", payment.EscrowCreated{Type: "escrowCreated", Version: "1.0.0", RequestID: v.ID, EscrowRef: s.escrowRef(v), DepositAmount: s.cfg.PriceBaseUnits, DepositCurrency: s.currency()}, false); e != nil {
		return e
	}
	if v.Delivery == nil {
		if e = s.transferDocument(v); e != nil {
			return e
		}
	}
	if v.ReleaseID == "" {
		receipt, e := s.sellerTransaction(v, "request-release")
		if e != nil {
			return e
		}
		for _, log := range receipt.Logs {
			if log.Address != hexAddress(s.cfg.EscrowAddress) {
				continue
			}
			release, err := s.escrow.ParseReleaseRequested(*log)
			if err == nil && release.EscrowId.String() == v.EscrowID {
				if release.Recipient != s.seller || release.Amount.Cmp(integer(s.cfg.PriceBaseUnits)) != 0 || release.EvidenceHash != hash32(v.EvidenceHash) {
					return errors.New("seller release event mismatch")
				}
				v.ReleaseID = release.ReleaseId.String()
			}
		}
		if v.ReleaseID == "" {
			return errors.New("seller release event missing")
		}
		if e = s.save(v); e != nil {
			return e
		}
	}
	invoice := payment.Invoice{Type: "invoice", Version: "1.0.0", RequestID: v.ID, ReleaseRequestRef: s.releaseRef(v), EscrowRef: s.escrowRef(v), Amount: s.cfg.PriceBaseUnits, Currency: s.currency(), Period: ""}
	if e = s.publish(v, "invoice", invoice, true); e != nil {
		return e
	}
	releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer releaseCancel()
	if _, e = s.verifyRelease(releaseCtx, v); e != nil {
		return e
	}
	v.State = "invoiced"
	v.Message = "Document received with matching SHA-256. Signed invoice verified; inspect/download the document and explicitly approve seller payment, or wait for a refund."
	return s.save(v)
}
func (s *server) transferDocument(v *session) error {
	if v.DeliveryAttempts >= 3 {
		return errors.New("three delivery attempts used; wait for the buyer timeout refund")
	}
	v.DeliveryAttempts++
	if e := s.save(v); e != nil {
		return e
	}
	dir := filepath.Join(s.stateDir, v.ID)
	if e := os.MkdirAll(filepath.Join(dir, "received"), 0700); e != nil {
		return e
	}
	source := filepath.Join(dir, s.sourceName)
	if e := os.WriteFile(source, s.sourceBytes, 0600); e != nil {
		return e
	}
	buyerECDSA, e := s.buyerKey.ToBlockchainKey()
	if e != nil {
		return e
	}
	sellerHost, e := delivery.NewLibp2pHost(s.sellerECDSA, "/ip4/127.0.0.1/udp/0/quic-v1")
	if e != nil {
		return e
	}
	defer sellerHost.Close()
	buyerHost, e := delivery.NewLibp2pHost(buyerECDSA, "/ip4/127.0.0.1/udp/0/quic-v1")
	if e != nil {
		return e
	}
	defer buyerHost.Close()
	sellerAdapter := delivery.NewLibp2pAdapter(sellerHost)
	buyerAdapter := delivery.NewLibp2pAdapter(buyerHost)
	incoming := make(chan *delivery.DeliveryChannel, 1)
	sellerAdapter.HandleIncoming(protocol.ID(documentProtocol), func(ch *delivery.DeliveryChannel) {
		if ch.PeerID != buyerHost.ID().String() {
			_ = sellerAdapter.Disconnect(ch)
			return
		}
		select {
		case incoming <- ch:
		default:
			_ = sellerAdapter.Disconnect(ch)
		}
	})
	setup, e := delivery.BuildConnectionSetup(v.ID, sellerHost, documentProtocol, &buyerECDSA.PublicKey)
	if e != nil {
		return e
	}
	kind := fmt.Sprintf("connectionSetup-%d", v.DeliveryAttempts)
	if e = s.publish(v, kind, setup, true); e != nil {
		return e
	}
	// Parse the signed payload that was independently matched through Mirror.
	var observed payment.ConnectionSetup
	for _, m := range v.Messages {
		if m.Kind == kind && m.MirrorVerified {
			if e = json.Unmarshal(m.Payload, &observed); e != nil {
				return e
			}
		}
	}
	if observed.PeerID != sellerHost.ID().String() || observed.RequestID != v.ID || observed.Protocol != documentProtocol {
		return errors.New("connection setup peer/session mismatch")
	}
	buyerChannel, e := delivery.ConnectFromSetup(buyerAdapter, &observed, buyerECDSA)
	if e != nil {
		return e
	}
	defer buyerAdapter.Disconnect(buyerChannel)
	if _, e = buyerAdapter.Send(buyerChannel, []byte{}); e != nil {
		return e
	}
	var sellerChannel *delivery.DeliveryChannel
	select {
	case sellerChannel = <-incoming:
	case <-time.After(15 * time.Second):
		return errors.New("seller did not accept the expected buyer peer")
	}
	defer sellerAdapter.Disconnect(sellerChannel)
	// Bound the upstream blocking stream operations by closing both hosts.
	timer := time.AfterFunc(30*time.Second, func() { _ = sellerHost.Close(); _ = buyerHost.Close() })
	defer timer.Stop()
	sent := make(chan error, 1)
	go func() { _, err := delivery.SendFile(sellerAdapter, sellerChannel, source); sent <- err }()
	received, e := delivery.ReceiveFile(buyerAdapter, buyerChannel, filepath.Join(dir, "received"))
	if e != nil {
		return e
	}
	if e = <-sent; e != nil {
		return e
	}
	path := filepath.Join(dir, "received", received.Filename)
	if e = os.Chmod(path, 0600); e != nil {
		return e
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	digest := sha256.Sum256(raw)
	actual := hex.EncodeToString(digest[:])
	if actual != s.sourceHash || int64(len(raw)) != s.sourceSize || received.SHA256 != actual || received.Filename != s.sourceName {
		return errors.New("received document differs from negotiated exact bytes")
	}
	proof, e := json.Marshal(struct {
		RequestID string `json:"requestId"`
		File      string `json:"file"`
		SHA256    string `json:"sha256"`
		Bytes     int64  `json:"bytes"`
	}{v.ID, received.Filename, actual, int64(len(raw))})
	if e != nil {
		return e
	}
	v.EvidenceHash = crypto.Keccak256Hash(proof).Hex()
	if e = os.WriteFile(filepath.Join(dir, "delivery-proof.json"), proof, 0600); e != nil {
		return e
	}
	v.Delivery = &deliveredFile{Filename: received.Filename, Bytes: int64(len(raw)), SHA256: actual, ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano), DownloadPath: "/v1/sessions/" + v.ID + "/file"}
	v.State = "delivered"
	v.Message = "Exact owner-provided document transferred between authenticated reference libp2p peers."
	return s.save(v)
}
func (s *server) settle(v *session) error {
	if v.State == "paid" || v.State == "paid-with-remainder" {
		return nil
	}
	if v.State != "approved" {
		return errors.New("buyer must explicitly approve the invoice in their wallet first")
	}
	if e := s.publish(v, "invoiceAck", payment.InvoiceAck{Type: "invoiceAck", Version: "1.0.0", RequestID: v.ID, ReleaseRequestRef: s.releaseRef(v), Action: "approved"}, false); e != nil {
		return e
	}
	receipt, e := s.sellerTransaction(v, "withdraw")
	if e != nil {
		return e
	}
	matched := false
	for _, log := range receipt.Logs {
		if log.Address != hexAddress(s.cfg.EscrowAddress) {
			continue
		}
		withdraw, err := s.escrow.ParseWithdrawn(*log)
		if err == nil && withdraw.EscrowId.String() == v.EscrowID && withdraw.ReleaseId.String() == v.ReleaseID && withdraw.Recipient == s.seller && withdraw.Amount.Cmp(integer(s.cfg.PriceBaseUnits)) == 0 {
			matched = true
		}
	}
	if !matched {
		return errors.New("exact seller withdrawal event missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	state, e := s.verifyRelease(ctx, v)
	if e != nil {
		return e
	}
	esc, e := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
	if e != nil {
		return e
	}
	if state != 2 || (esc.State != 1 && esc.State != 2 && esc.State != 3) {
		return errors.New("settled escrow state mismatch")
	}
	v.State = "paid"
	v.PaidAmountBaseUnits = s.cfg.PriceBaseUnits
	v.RemainingBalanceBaseUnits = esc.Balance.String()
	v.Message = "Seller received the exact negotiated test ERC20 amount; escrow is empty."
	if esc.Balance.Sign() > 0 {
		v.State = "paid-with-remainder"
		v.Message = "Seller received only the negotiated amount. Remaining tokens can be refunded by the buyer after the deadline."
	}
	return s.save(v)
}
