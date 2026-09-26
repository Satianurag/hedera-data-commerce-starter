package legacy

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/multiformats/go-multiaddr"
)

const ADSBProtocol = "neuron/ADSB/0.0.2"

type Receiver struct {
	host        host.Host
	mu          sync.Mutex
	active      bool
	activeSince time.Time
	closing     bool
}

func SellerPeerID(compressedPublicKeyHex string) (peer.ID, error) {
	keyBytes, err := hex.DecodeString(compressedPublicKeyHex)
	if err != nil || len(keyBytes) != 33 {
		return "", errors.New("seller public key must be 33 compressed secp256k1 bytes")
	}
	key, err := crypto.UnmarshalSecp256k1PublicKey(keyBytes)
	if err != nil {
		return "", fmt.Errorf("invalid seller public key: %w", err)
	}
	return peer.IDFromPublicKey(key)
}

func NewReceiver(ctx context.Context, buyerKey crypto.PrivKey, sellerKeyHex string, port uint16, onBytes func([]byte) error) (*Receiver, error) {
	if buyerKey == nil || onBytes == nil {
		return nil, errors.New("buyer key and byte consumer are required")
	}
	expectedSeller, err := SellerPeerID(sellerKeyHex)
	if err != nil {
		return nil, err
	}
	h, err := libp2p.New(libp2p.Identity(buyerKey), libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", port)))
	if err != nil {
		return nil, err
	}
	receiver := &Receiver{host: h}
	h.SetStreamHandler(protocol.ID(ADSBProtocol), func(stream network.Stream) {
		if stream.Conn().RemotePeer() != expectedSeller {
			_ = stream.Reset()
			return
		}
		receiver.mu.Lock()
		if receiver.active || receiver.closing {
			receiver.mu.Unlock()
			_ = stream.Reset()
			return
		}
		receiver.active = true
		receiver.activeSince = time.Now()
		receiver.mu.Unlock()
		defer func() {
			receiver.mu.Lock()
			receiver.active = false
			receiver.activeSince = time.Time{}
			receiver.mu.Unlock()
		}()
		defer stream.Close()
		buffer := make([]byte, 32*1024)
		for {
			if ctx.Err() != nil {
				_ = stream.Reset()
				return
			}
			if err := stream.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
				_ = stream.Reset()
				return
			}
			n, readErr := stream.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				if err := onBytes(chunk); err != nil {
					_ = stream.Reset()
					return
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					_ = stream.Reset()
				}
				return
			}
		}
	})
	return receiver, nil
}

func (r *Receiver) PeerID() peer.ID { return r.host.ID() }

func (r *Receiver) Addresses() []multiaddr.Multiaddr { return r.host.Addrs() }

// ActiveSince reports the accepted seller's current stream, or zero when the
// stream has ended. It says nothing about whether seller data is still arriving.
func (r *Receiver) ActiveSince() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active || r.closing {
		return time.Time{}
	}
	return r.activeSince
}

func (r *Receiver) Close() error {
	r.mu.Lock()
	r.closing = true
	r.active = false
	r.activeSince = time.Time{}
	r.mu.Unlock()
	return r.host.Close()
}
