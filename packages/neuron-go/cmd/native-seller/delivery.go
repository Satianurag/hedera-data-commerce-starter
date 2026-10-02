package main

import (
	"context"
	"errors"
	"io"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	quic "github.com/libp2p/go-libp2p/p2p/transport/quic"
	"github.com/multiformats/go-multiaddr"
	"neuron-customer-app/neuron-go/legacy"
)

// Send a single immutable snapshot exactly once, with its final byte no earlier
// than duration. This is paced file delivery, not generated or live sensor data.
func pacedWrite(ctx context.Context, w io.Writer, source []byte, duration time.Duration) (int64, error) {
	if len(source) == 0 || len(source) > maxSourceBytes || duration <= 0 {
		return 0, errors.New("invalid source or duration")
	}
	chunkSize := (len(source) + 19) / 20
	if chunkSize > 32<<10 {
		chunkSize = 32 << 10
	}
	chunks := (len(source) + chunkSize - 1) / chunkSize
	start := time.Now()
	var written int64
	for i, offset := 0, 0; offset < len(source); i, offset = i+1, offset+chunkSize {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		delay := duration
		if chunks > 1 {
			delay = time.Duration(int64(duration) * int64(i) / int64(chunks-1))
		}
		timer := time.NewTimer(time.Until(start.Add(delay)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return written, ctx.Err()
		case <-timer.C:
		}
		if err := ctx.Err(); err != nil {
			return written, err
		}
		end := offset + chunkSize
		if end > len(source) {
			end = len(source)
		}
		n, err := w.Write(source[offset:end])
		written += int64(n)
		if err != nil {
			return written, err
		}
		if n != end-offset {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func deliver(ctx context.Context, sellerKey []byte, buyerPublic string, target multiaddr.Multiaddr, source []byte, duration time.Duration) (int64, error) {
	identity, err := crypto.UnmarshalSecp256k1PrivateKey(sellerKey)
	if err != nil {
		return 0, err
	}
	buyer, err := legacy.SellerPeerID(buyerPublic)
	if err != nil {
		return 0, err
	}
	h, err := libp2p.New(libp2p.Identity(identity), libp2p.NoListenAddrs, libp2p.DisableRelay(), libp2p.NoTransports, libp2p.Transport(quic.NewTransport))
	if err != nil {
		return 0, err
	}
	defer h.Close()
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err = h.Connect(dialCtx, peer.AddrInfo{ID: buyer, Addrs: []multiaddr.Multiaddr{target}}); err != nil {
		return 0, errors.New("could not authenticate and connect to the pinned buyer QUIC peer")
	}
	stream, err := h.NewStream(dialCtx, buyer, protocol.ID(legacy.ADSBProtocol))
	if err != nil {
		return 0, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = stream.Reset()
		}
	}()
	if stream.Conn().RemotePeer() != buyer {
		return 0, errors.New("connected peer differs from request buyer")
	}
	if err = stream.SetWriteDeadline(time.Now().Add(duration + 10*time.Second)); err != nil {
		return 0, err
	}
	written, err := pacedWrite(ctx, stream, source, duration)
	if err != nil {
		return written, err
	}
	if err = stream.CloseWrite(); err != nil {
		return written, err
	}
	// Wait for the receiving handler to close after consuming our EOF. Closing
	// the host immediately after Write could discard QUIC's queued final bytes.
	if err = stream.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return written, err
	}
	var unexpected [1]byte
	if n, readErr := stream.Read(unexpected[:]); n != 0 || readErr != io.EOF {
		return written, errors.New("buyer did not close the completed one-way stream")
	}
	if err = stream.Close(); err != nil {
		return written, err
	}
	closed = true
	return written, nil
}
