package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/neuron-sdk/neuron-go-sdk/internal/payment"
	bindings "github.com/neuron-sdk/neuron-go-sdk/internal/payment/bindings"
)

func hexAddress(a string) common.Address { return common.HexToAddress(a) }
func integer(s string) *big.Int {
	v, _ := new(big.Int).SetString(s, 10)
	if v == nil {
		return new(big.Int)
	}
	return v
}
func hash32(s string) [32]byte { return [32]byte(common.HexToHash(s)) }
func exactNonce(raw string) (uint64, error) {
	n, e := hexutil.DecodeUint64(raw)
	if e != nil || hexutil.EncodeUint64(n) != raw {
		return 0, errors.New("wallet nonce must be a canonical uint64 hex quantity")
	}
	return n, nil
}
func (s *server) unsigned(kind string, v *session) (walletAction, error) {
	abi, e := bindings.NeuronEscrowMetaData.GetAbi()
	if e != nil {
		return walletAction{}, e
	}
	tokenABI, e := bindings.TestTokenMetaData.GetAbi()
	if e != nil {
		return walletAction{}, e
	}
	var data []byte
	to := s.cfg.EscrowAddress
	label := ""
	switch kind {
	case "create":
		data, e = abi.Pack("createEscrow", hexAddress(v.BuyerAddress), s.seller, common.Address{}, hexAddress(s.cfg.TokenAddress), uint64(1), hash32(v.AgreementHash), v.Deadline)
		label = "Create testnet ERC20 escrow with timeout refund"
	case "token-approve":
		to = s.cfg.TokenAddress
		data, e = tokenABI.Pack("approve", hexAddress(s.cfg.EscrowAddress), integer(s.cfg.PriceBaseUnits))
		label = "Approve only the exact test token amount"
	case "deposit":
		data, e = abi.Pack("deposit", integer(v.EscrowID), integer(s.cfg.PriceBaseUnits))
		label = "Deposit the agreed test token amount"
	case "approve-release":
		data, e = abi.Pack("approveRelease", integer(v.EscrowID), integer(v.ReleaseID))
		label = "Approve seller payment after reviewing the received file"
	case "refund":
		data, e = abi.Pack("claimRefund", integer(v.EscrowID))
		label = "Refund remaining tokens after the escrow deadline"
	default:
		return walletAction{}, errors.New("unsupported wallet action")
	}
	if e != nil {
		return walletAction{}, e
	}
	return walletAction{Kind: kind, Label: label, ChainID: 296, To: hexAddress(to).Hex(), Data: "0x" + hex.EncodeToString(data), Value: "0x0"}, nil
}
func (s *server) verifyEscrow(ctx context.Context, v *session) error {
	if v.EscrowID == "" {
		return errors.New("escrow has not been created")
	}
	e, err := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
	if err != nil {
		return err
	}
	if e.Buyer != hexAddress(v.BuyerAddress) || e.Seller != s.seller || e.Arbiter != (common.Address{}) || e.Token != hexAddress(s.cfg.TokenAddress) || e.Threshold != 1 || e.AgreementHash != hash32(v.AgreementHash) || e.Timeout != v.Deadline {
		return errors.New("escrow does not match signed negotiation and wallet")
	}
	return nil
}
func (s *server) verifyRelease(ctx context.Context, v *session) (uint8, error) {
	if err := s.verifyEscrow(ctx, v); err != nil {
		return 0, err
	}
	if v.ReleaseID == "" || v.EvidenceHash == "" || v.Delivery == nil {
		return 0, errors.New("verified delivery and release reference required")
	}
	r, err := s.escrow.GetRelease(&bind.CallOpts{Context: ctx}, integer(v.EscrowID), integer(v.ReleaseID))
	if err != nil {
		return 0, err
	}
	if r.Recipient != s.seller || r.Amount.Cmp(integer(s.cfg.PriceBaseUnits)) != 0 || r.EvidenceHash != hash32(v.EvidenceHash) {
		return 0, errors.New("seller release payee, amount or evidence mismatch")
	}
	return r.State, nil
}
func (s *server) available(v *session) error {
	v.WalletActions = []walletAction{}
	if v.PendingIntent != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	kind := ""
	switch v.State {
	case "agreed":
		kind = "create"
	case "escrow-created":
		kind = "token-approve"
	case "token-approved":
		kind = "deposit"
	case "invoiced":
		kind = "approve-release"
	}
	if kind != "" && uint64(time.Now().Unix()+30) < v.Deadline {
		if kind == "approve-release" {
			if _, e := s.verifyRelease(ctx, v); e != nil {
				return e
			}
		}
		a, e := s.unsigned(kind, v)
		if e != nil {
			return e
		}
		v.WalletActions = append(v.WalletActions, a)
	}
	if v.EscrowID != "" && v.State != "paid" && v.State != "refunded" && uint64(time.Now().Unix()) >= v.Deadline {
		if e := s.verifyEscrow(ctx, v); e != nil {
			return e
		}
		es, e := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
		if e != nil {
			return e
		}
		if es.Balance.Sign() > 0 {
			a, e := s.unsigned("refund", v)
			if e != nil {
				return e
			}
			v.WalletActions = append(v.WalletActions, a)
		}
	}
	return nil
}
func (s *server) prepare(v *session, kind string) error {
	if v.PendingIntent != nil {
		return errors.New("a wallet intent already exists; reconcile its hash before another transaction")
	}
	if e := s.available(v); e != nil {
		return e
	}
	var action *walletAction
	for i := range v.WalletActions {
		if v.WalletActions[i].Kind == kind {
			action = &v.WalletActions[i]
		}
	}
	if action == nil {
		return errors.New("wallet action unavailable for current state")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if e := s.preflight(ctx); e != nil {
		return e
	}
	if kind == "deposit" {
		if e := s.verifyEscrow(ctx, v); e != nil {
			return e
		}
		balance, e := s.tokenContract.BalanceOf(&bind.CallOpts{Context: ctx}, hexAddress(v.BuyerAddress))
		if e != nil {
			return e
		}
		if balance.Cmp(integer(s.cfg.PriceBaseUnits)) < 0 {
			return errors.New("wallet has insufficient test ERC20 token balance")
		}
		es, e := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
		if e != nil {
			return e
		}
		if es.Balance.Sign() != 0 || es.State != 0 {
			return errors.New("escrow is already funded or closed; duplicate deposit refused")
		}
	}
	// Persist the chain nonce before any wallet request. A later explicit retry
	// may change gas pricing, but nonce and operation remain identical, so the
	// network can execute at most one of those signed transactions.
	nonce, e := s.rpc.PendingNonceAt(ctx, hexAddress(v.BuyerAddress))
	if e != nil {
		return e
	}
	for _, other := range s.sessions {
		if other.ID == v.ID || other.BuyerAddress != v.BuyerAddress || other.PendingIntent == nil {
			continue
		}
		if other.PendingIntent.Transaction.Nonce == "" {
			return errors.New("this wallet has an unresolved historical intent without a nonce; use its transaction history to reconcile before another purchase")
		}
		reserved, parseErr := exactNonce(other.PendingIntent.Transaction.Nonce)
		if parseErr != nil {
			return parseErr
		}
		if reserved == nonce {
			return errors.New("this wallet nonce is reserved by another unresolved reference purchase")
		}
	}
	action.Nonce = hexutil.EncodeUint64(nonce)
	v.PendingIntent = &intent{ID: newID(), Kind: kind, Status: "prepared", Transaction: *action}
	v.WalletActions = []walletAction{}
	return s.save(v)
}
func (s *server) confirmWallet(v *session, hash string) error {
	in := v.PendingIntent
	if in == nil {
		return errors.New("no outstanding wallet intent")
	}
	if len(hash) != 66 || !strings.HasPrefix(hash, "0x") {
		return errors.New("full transaction hash required")
	}
	if _, e := hex.DecodeString(hash[2:]); e != nil {
		return e
	}
	known := false
	for _, candidate := range in.CandidateHashes {
		if strings.EqualFold(candidate, hash) {
			known = true
		}
	}
	if !known {
		if len(in.CandidateHashes) >= 8 {
			return errors.New("transaction hash correction limit reached; operator reconciliation required")
		}
		in.CandidateHashes = append(in.CandidateHashes, hash)
	}
	in.TransactionHash = hash
	in.Status = "submitted"
	if e := s.save(v); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, pending, e := s.rpc.TransactionByHash(ctx, common.HexToHash(hash))
	if e != nil || pending {
		return errors.New("transaction not indexed/confirmed yet; use refresh with the saved hash")
	}
	sender, e := types.Sender(types.LatestSignerForChainID(big.NewInt(296)), tx)
	if e != nil {
		return e
	}
	data, e := hex.DecodeString(strings.TrimPrefix(in.Transaction.Data, "0x"))
	if e != nil {
		return e
	}
	if tx.ChainId().Cmp(big.NewInt(296)) != 0 || sender != hexAddress(v.BuyerAddress) || tx.To() == nil || *tx.To() != hexAddress(in.Transaction.To) || tx.Value().Sign() != 0 || !bytes.Equal(data, tx.Data()) {
		in.TransactionHash = ""
		in.Status = "wallet-open"
		_ = s.save(v)
		return errors.New("submitted transaction does not match authorized buyer intent")
	}
	if in.Transaction.Nonce != "" {
		nonce, nonceErr := exactNonce(in.Transaction.Nonce)
		if nonceErr != nil {
			return nonceErr
		}
		if tx.Nonce() != nonce {
			in.TransactionHash = ""
			in.Status = "wallet-open"
			_ = s.save(v)
			return errors.New("submitted transaction nonce does not match the recorded wallet intent")
		}
	}
	receipt, e := s.rpc.TransactionReceipt(ctx, tx.Hash())
	if e != nil {
		return errors.New("receipt not indexed yet; retain saved hash and refresh")
	}
	if receipt.Status != 1 {
		v.Transactions = append(v.Transactions, transaction{Kind: in.Kind, TransactionHash: hash, Status: "failed"})
		v.PendingIntent = nil
		v.Message = "Transaction reverted without advancing the purchase."
		return s.save(v)
	}
	kind := in.Kind
	switch kind {
	case "create":
		found := false
		for _, log := range receipt.Logs {
			if log.Address != hexAddress(s.cfg.EscrowAddress) {
				continue
			}
			created, err := s.escrow.ParseEscrowCreated(*log)
			if err == nil {
				if found || (v.EscrowID != "" && v.EscrowID != created.EscrowId.String()) {
					return errors.New("multiple escrow creation events")
				}
				found = true
				if created.Buyer != hexAddress(v.BuyerAddress) || created.Seller != s.seller || created.Token != hexAddress(s.cfg.TokenAddress) || created.AgreementHash != hash32(v.AgreementHash) || created.Timeout != v.Deadline {
					return errors.New("created escrow event differs from signed terms")
				}
				v.EscrowID = created.EscrowId.String()
			}
		}
		if !found {
			return errors.New("EscrowCreated event missing")
		}
		if e = s.verifyEscrow(ctx, v); e != nil {
			return e
		}
		v.State = "escrow-created"
	case "token-approve":
		allowance, err := s.tokenContract.Allowance(&bind.CallOpts{Context: ctx}, hexAddress(v.BuyerAddress), hexAddress(s.cfg.EscrowAddress))
		if err != nil {
			return err
		}
		if allowance.Cmp(integer(s.cfg.PriceBaseUnits)) != 0 {
			return errors.New("token allowance differs from exact authorized amount")
		}
		v.State = "token-approved"
	case "deposit":
		if e = s.verifyEscrow(ctx, v); e != nil {
			return e
		}
		matched := false
		for _, log := range receipt.Logs {
			if log.Address != hexAddress(s.cfg.EscrowAddress) {
				continue
			}
			dep, err := s.escrow.ParseDeposited(*log)
			if err == nil && dep.EscrowId.String() == v.EscrowID && dep.Depositor == hexAddress(v.BuyerAddress) && dep.Amount.Cmp(integer(s.cfg.PriceBaseUnits)) == 0 && dep.NewBalance.Cmp(integer(s.cfg.PriceBaseUnits)) == 0 {
				matched = true
			}
		}
		if !matched {
			return errors.New("matching exact deposit event missing")
		}
		v.State = "funded"
	case "approve-release":
		state, err := s.verifyRelease(ctx, v)
		if err != nil {
			return err
		}
		if state != 1 {
			return errors.New("release is not buyer-approved")
		}
		v.State = "approved"
	case "refund":
		if e = s.verifyEscrow(ctx, v); e != nil {
			return e
		}
		es, err := s.escrow.GetEscrow(&bind.CallOpts{Context: ctx}, integer(v.EscrowID))
		if err != nil {
			return err
		}
		if es.State != 3 || es.Balance.Sign() != 0 {
			return errors.New("refund state not confirmed")
		}
		matched := false
		for _, log := range receipt.Logs {
			if log.Address != hexAddress(s.cfg.EscrowAddress) {
				continue
			}
			refund, err := s.escrow.ParseRefundClaimed(*log)
			if err == nil && refund.EscrowId.String() == v.EscrowID && refund.Buyer == hexAddress(v.BuyerAddress) && refund.Amount.Cmp(integer(s.cfg.PriceBaseUnits)) == 0 {
				matched = true
			}
		}
		if !matched {
			return errors.New("exact refund event missing")
		}
		v.State = "refunded"
	}
	v.Transactions = append(v.Transactions, transaction{Kind: kind, TransactionHash: hash, Status: "confirmed"})
	v.PendingIntent = nil
	v.Message = "Wallet transaction verified against the exact negotiated operation."
	if e = s.save(v); e != nil {
		return e
	}
	if kind == "deposit" {
		return s.publish(v, "escrowCreated", payment.EscrowCreated{Type: "escrowCreated", Version: "1.0.0", RequestID: v.ID, EscrowRef: s.escrowRef(v), DepositAmount: s.cfg.PriceBaseUnits, DepositCurrency: s.currency()}, false)
	}
	if kind == "approve-release" {
		return s.publish(v, "invoiceAck", payment.InvoiceAck{Type: "invoiceAck", Version: "1.0.0", RequestID: v.ID, ReleaseRequestRef: s.releaseRef(v), Action: "approved"}, false)
	}
	return nil
}
func (s *server) openWallet(v *session, intentID string) error {
	in := v.PendingIntent
	if in == nil || intentID != in.ID {
		return errors.New("wallet intent mismatch")
	}
	if in.Transaction.Nonce == "" {
		return errors.New("historical intent has no recorded nonce; reconcile its transaction hash before continuing")
	}
	if in.Status != "prepared" && (in.Status != "wallet-open" || in.TransactionHash != "") {
		return errors.New("only a prepared intent or an identical nonce-bound retry can open a wallet")
	}
	if in.OpenAttempts >= 3 {
		return errors.New("wallet retry limit reached; reconcile the recorded nonce and transaction history")
	}
	nonce, e := exactNonce(in.Transaction.Nonce)
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	chain, e := s.rpc.ChainID(ctx)
	if e != nil {
		return e
	}
	if chain.Cmp(big.NewInt(296)) != 0 {
		return errors.New("RPC is not Hedera testnet")
	}
	latest, e := s.rpc.NonceAt(ctx, hexAddress(v.BuyerAddress), nil)
	if e != nil {
		return e
	}
	if latest > nonce {
		return errors.New("recorded wallet nonce is already used; recover the transaction hash from wallet history")
	}
	in.Status = "wallet-open"
	in.OpenAttempts++
	return s.save(v)
}
func (s *server) escrowRef(v *session) string {
	return hexAddress(s.cfg.EscrowAddress).Hex() + ":" + v.EscrowID
}
func (s *server) releaseRef(v *session) string { return s.escrowRef(v) + ":" + v.ReleaseID }
func (s *server) currency() string             { return "eip155:296/erc20:" + hexAddress(s.cfg.TokenAddress).Hex() }
func (s *server) sellerTransaction(v *session, kind string) (*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, old := range v.Transactions {
		if old.Kind == kind && old.Status == "confirmed" {
			return s.rpc.TransactionReceipt(ctx, common.HexToHash(old.TransactionHash))
		}
	}
	if v.SellerRawTx == "" {
		if err := s.preflight(ctx); err != nil {
			return nil, err
		}
		auth, e := bind.NewKeyedTransactorWithChainID(s.sellerECDSA, big.NewInt(296))
		if e != nil {
			return nil, e
		}
		auth.Context = ctx
		auth.NoSend = true
		auth.GasLimit = 250000
		auth.GasPrice, e = s.rpc.SuggestGasPrice(ctx)
		if e != nil {
			return nil, e
		}
		if auth.GasPrice.Cmp(integer(s.cfg.MaxSellerGasPriceWei)) > 0 {
			return nil, errors.New("seller gas price exceeds configured budget")
		}
		auth.Nonce, e = s.rpcNonce(ctx)
		if e != nil {
			return nil, e
		}
		var tx *types.Transaction
		switch kind {
		case "request-release":
			if err := s.verifyEscrow(ctx, v); err != nil {
				return nil, err
			}
			tx, e = s.escrow.RequestRelease(auth, integer(v.EscrowID), integer(s.cfg.PriceBaseUnits), s.seller, hash32(v.EvidenceHash))
		case "withdraw":
			state, err := s.verifyRelease(ctx, v)
			if err != nil {
				return nil, err
			}
			if state != 1 {
				return nil, errors.New("buyer has not approved this exact release")
			}
			tx, e = s.escrow.Withdraw(auth, integer(v.EscrowID), integer(v.ReleaseID))
		default:
			return nil, errors.New("unsupported seller operation")
		}
		if e != nil {
			return nil, e
		}
		raw, e := tx.MarshalBinary()
		if e != nil {
			return nil, e
		}
		v.SellerRawTx = hex.EncodeToString(raw)
		v.SellerTxHash = tx.Hash().Hex()
		v.SellerTxKind = kind
		if e = s.save(v); e != nil {
			return nil, e
		}
		// The transaction is already durably assigned its nonce and hash.
		if e = s.rpc.SendTransaction(ctx, tx); e != nil {
			v.Message = "Seller broadcast is uncertain; retain saved transaction and refresh."
			_ = s.save(v)
		}
	}
	if v.SellerTxKind != kind {
		return nil, errors.New("another seller transaction requires reconciliation")
	}
	// A crash may happen after fsync and before broadcast. Reuse only the exact
	// persisted transaction (same bytes, nonce and hash), never a fresh nonce.
	if _, _, lookupErr := s.rpc.TransactionByHash(ctx, common.HexToHash(v.SellerTxHash)); errors.Is(lookupErr, ethereum.NotFound) {
		raw, decodeErr := hex.DecodeString(v.SellerRawTx)
		if decodeErr != nil {
			return nil, decodeErr
		}
		var saved types.Transaction
		if decodeErr = saved.UnmarshalBinary(raw); decodeErr != nil {
			return nil, decodeErr
		}
		sender, decodeErr := types.Sender(types.LatestSignerForChainID(big.NewInt(296)), &saved)
		if decodeErr != nil {
			return nil, decodeErr
		}
		abi, decodeErr := bindings.NeuronEscrowMetaData.GetAbi()
		if decodeErr != nil {
			return nil, decodeErr
		}
		var expected []byte
		if kind == "request-release" {
			expected, decodeErr = abi.Pack("requestRelease", integer(v.EscrowID), integer(s.cfg.PriceBaseUnits), s.seller, hash32(v.EvidenceHash))
		} else {
			expected, decodeErr = abi.Pack("withdraw", integer(v.EscrowID), integer(v.ReleaseID))
		}
		if decodeErr != nil {
			return nil, decodeErr
		}
		if saved.Hash().Hex() != v.SellerTxHash || saved.ChainId().Cmp(big.NewInt(296)) != 0 || sender != s.seller || saved.To() == nil || *saved.To() != hexAddress(s.cfg.EscrowAddress) || saved.Value().Sign() != 0 || !bytes.Equal(saved.Data(), expected) || saved.Gas() > 250000 || saved.GasPrice().Cmp(integer(s.cfg.MaxSellerGasPriceWei)) > 0 {
			return nil, errors.New("persisted seller transaction failed recovery validation")
		}
		if e := s.save(v); e != nil {
			return nil, e
		}
		_ = s.rpc.SendTransaction(ctx, &saved)
	}
	for {
		receipt, e := s.rpc.TransactionReceipt(ctx, common.HexToHash(v.SellerTxHash))
		if e == nil {
			if receipt.Status != 1 {
				return nil, errors.New("seller transaction reverted; saved hash requires operator investigation")
			}
			v.Transactions = append(v.Transactions, transaction{Kind: kind, TransactionHash: v.SellerTxHash, Status: "confirmed"})
			v.SellerRawTx = ""
			v.SellerTxHash = ""
			v.SellerTxKind = ""
			if e = s.save(v); e != nil {
				return nil, e
			}
			return receipt, nil
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("seller transaction receipt pending; retry only reconciliation")
		case <-time.After(2 * time.Second):
		}
	}
}
func (s *server) rpcNonce(ctx context.Context) (*big.Int, error) {
	n, e := s.rpc.PendingNonceAt(ctx, s.seller)
	return new(big.Int).SetUint64(n), e
}
