// native-seller delivers one reviewed file over the legacy data protocol for
// one verified native-HBAR escrow. It never signs scheduled legacy payments,
// sends HCS messages, approves a buyer payment, or withdraws seller funds.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"neuron-customer-app/neuron-go/directseller"
)

func run(ctx context.Context) error {
	c, err := loadConfig(os.Getenv("NEURON_NATIVE_SELLER_CONFIG_FILE"))
	if err != nil {
		return err
	}
	profile, err := directseller.LoadFromEnv()
	if err != nil {
		return err
	}
	if profile == nil || profile.AccountID != c.SellerAccountID || profile.StdinTopicID != c.SellerStdinTopicID || (profile.Transport == "loopback") != (c.LoopbackTarget != "") {
		return errors.New("native seller requires the same explicit direct seller profile and transport policy")
	}
	if err = directseller.CheckMirror(ctx, *profile); err != nil {
		return err
	}
	keyBytes, err := readFile(c.SellerKeyFile, 1024, true)
	if err != nil {
		return err
	}
	key, err := hedera.PrivateKeyFromStringDer(strings.TrimSpace(string(keyBytes)))
	if err != nil || len(key.BytesRaw()) != 32 || key.PublicKey().StringRaw() != profile.PublicKey {
		return errors.New("seller ECDSA key differs from the pinned direct profile")
	}
	source, err := readFile(c.SourceFile, maxSourceBytes, false)
	if err != nil {
		return err
	}
	if digest(source) != c.SourceSHA256 {
		return errors.New("source bytes differ from the reviewed SHA-256")
	}
	n := newNetworkReader()
	buyer, err := n.account(ctx, c.BuyerTransportAccountID)
	if err != nil {
		return err
	}
	shared, err := n.account(ctx, c.BuyerSharedAccountID)
	if err != nil {
		return err
	}
	if !strings.EqualFold(shared.Key.Key, buyer.Key.Key) {
		return errors.New("shared account is not controlled by the configured transport buyer")
	}
	if err = n.openTopic(ctx, c.BuyerStdinTopicID); err != nil {
		return err
	}
	message, payload, err := n.readRequest(ctx, c, time.Now())
	if err != nil {
		return err
	}
	_, target, err := verifyRequest(payload, c, buyer, key.BytesRaw())
	if err != nil {
		return err
	}
	sellerAddress := strings.ToLower("0x" + key.PublicKey().ToEvmAddress())
	if sellerAddress == c.BuyerWalletAddress {
		return errors.New("funded buyer cannot be the seller")
	}
	snapshot, err := n.verifyEscrow(ctx, c, sellerAddress, time.Now())
	if err != nil {
		return err
	}
	// Network verification can take time. Reserve a fresh delivery and dial
	// window immediately before committing the attempt, not only at RPC start.
	if c.RefundAfter <= time.Now().Unix()+int64(c.DurationSeconds)+30 {
		return errors.New("escrow refund deadline became too close during verification")
	}
	journal, err := claimDelivery(c, snapshot)
	if err != nil {
		return err
	}
	defer journal.file.Close()
	deliveryCtx, cancel := context.WithTimeout(ctx, time.Duration(c.DurationSeconds+30)*time.Second)
	defer cancel()
	written, deliveryErr := deliver(deliveryCtx, key.BytesRaw(), buyer.Key.Key, target, source, time.Duration(c.DurationSeconds)*time.Second)
	if err = journal.finish(deliveryErr == nil, written); err != nil {
		return fmt.Errorf("delivery journal completion failed; do not retry automatically: %w", err)
	}
	if deliveryErr != nil {
		return fmt.Errorf("delivery attempt failed and remains journaled: %w", deliveryErr)
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"network": "testnet", "paymentProtocol": "neuronCustomerQuote/v1", "delivery": "paced-file", "transport": profile.Transport,
		"sellerAccountId": c.SellerAccountID, "buyerTransportAccountId": c.BuyerTransportAccountID,
		"requestTopicId": c.SellerStdinTopicID, "requestSequence": message.Sequence, "requestSHA256": digest(payload),
		"escrowId": c.EscrowID, "termsHash": c.TermsHash, "fundingTransactionHash": c.FundingTransactionHash,
		"verifiedBlockNumber": snapshot.BlockNumber, "sourceSHA256": digest(source),
		"bytesWritten": written, "durationSeconds": c.DurationSeconds,
		"meaning": "seller stream writes completed; buyer receipt and payment require separate reconciliation",
	})
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
