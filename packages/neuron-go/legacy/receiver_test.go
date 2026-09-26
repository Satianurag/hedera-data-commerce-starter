package legacy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"testing"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
)

func TestReceiverPreservesBytesFromExpectedSeller(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	buyerKey, _, err := crypto.GenerateSecp256k1Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sellerKey, sellerPublic, err := crypto.GenerateSecp256k1Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sellerPublicBytes, err := sellerPublic.Raw()
	if err != nil {
		t.Fatal(err)
	}
	chunks := make(chan []byte, 8)
	receiver, err := NewReceiver(ctx, buyerKey, hex.EncodeToString(sellerPublicBytes), 0, func(value []byte) error {
		chunks <- value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	seller, err := libp2p.New(libp2p.Identity(sellerKey), libp2p.ListenAddrStrings("/ip4/127.0.0.1/udp/0/quic-v1"))
	if err != nil {
		t.Fatal(err)
	}
	defer seller.Close()
	if err := seller.Connect(ctx, peer.AddrInfo{ID: receiver.PeerID(), Addrs: receiver.Addresses()}); err != nil {
		t.Fatal(err)
	}
	stream, err := seller.NewStream(ctx, receiver.PeerID(), protocol.ID(ADSBProtocol))
	if err != nil {
		t.Fatal(err)
	}
	// Published, CRC-valid DF17 frame from pyModeS documentation.
	payload, _ := hex.DecodeString("8D406B902015A678D4D220AA4BDA")
	if _, err := stream.Write(payload[:3]); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write(payload[3:]); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	var received []byte
	for len(received) < len(payload) {
		select {
		case chunk := <-chunks:
			received = append(received, chunk...)
		case <-ctx.Done():
			t.Fatal("timed out awaiting seller bytes")
		}
	}
	if !bytes.Equal(received, payload) {
		t.Fatalf("binary bytes changed: %x", received)
	}
}

func TestReceiverRejectsDifferentPeer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	buyerKey, _, err := crypto.GenerateSecp256k1Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, sellerPublic, err := crypto.GenerateSecp256k1Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sellerPublicBytes, err := sellerPublic.Raw()
	if err != nil {
		t.Fatal(err)
	}
	attackerKey, _, err := crypto.GenerateSecp256k1Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	chunks := make(chan []byte, 1)
	receiver, err := NewReceiver(ctx, buyerKey, hex.EncodeToString(sellerPublicBytes), 0, func(value []byte) error {
		chunks <- value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	attacker, err := libp2p.New(libp2p.Identity(attackerKey), libp2p.ListenAddrStrings("/ip4/127.0.0.1/udp/0/quic-v1"))
	if err != nil {
		t.Fatal(err)
	}
	defer attacker.Close()
	if err := attacker.Connect(ctx, peer.AddrInfo{ID: receiver.PeerID(), Addrs: receiver.Addresses()}); err != nil {
		t.Fatal(err)
	}
	stream, err := attacker.NewStream(ctx, receiver.PeerID(), protocol.ID(ADSBProtocol))
	if err == nil {
		_, _ = stream.Write([]byte("untrusted"))
		_ = stream.Close()
	}
	select {
	case <-chunks:
		t.Fatal("receiver accepted bytes from another peer")
	case <-time.After(300 * time.Millisecond):
	}
}
