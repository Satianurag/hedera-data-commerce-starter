package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/multiformats/go-multiaddr"
	"neuron-customer-app/neuron-go/directseller"
	"neuron-customer-app/neuron-go/legacy"
)

type hcsMessage struct {
	TopicID   string `json:"topic_id"`
	Sequence  uint64 `json:"sequence_number"`
	Payer     string `json:"payer_account_id"`
	Consensus string `json:"consensus_timestamp"`
	Message   string `json:"message"`
	ChunkInfo *struct {
		Number int `json:"number"`
		Total  int `json:"total"`
	} `json:"chunk_info"`
}

type serviceRequest struct {
	MessageType      string `json:"messageType"`
	EncryptedAddress []byte `json:"i"`
	StdinTopic       uint64 `json:"o"`
	EVMAddress       string `json:"e"`
	PublicKey        string `json:"k"`
	ServiceType      string `json:"t"`
	SLAAgreed        uint64 `json:"s"`
	SharedAccount    uint64 `json:"a"`
	Version          string `json:"v"`
}

func requestBytes(message hcsMessage, c config, now time.Time) ([]byte, error) {
	if message.TopicID != c.SellerStdinTopicID || message.Sequence != c.RequestSequence || message.Payer != c.PayerAccountID || (message.ChunkInfo != nil && (message.ChunkInfo.Number != 1 || message.ChunkInfo.Total != 1)) {
		return nil, errors.New("HCS request topic, sequence, payer, or chunk count differs")
	}
	parts := strings.Split(message.Consensus, ".")
	if len(parts) != 2 || len(parts[1]) != 9 {
		return nil, errors.New("invalid consensus timestamp")
	}
	seconds, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, err
	}
	nanos, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || nanos < 0 || nanos >= 1e9 {
		return nil, errors.New("invalid consensus nanoseconds")
	}
	when := time.Unix(seconds, nanos)
	if when.After(now.Add(30*time.Second)) || when.Before(now.Add(-10*time.Minute)) {
		return nil, errors.New("HCS request is stale or from the future")
	}
	if len(message.Message) > 1400 {
		return nil, errors.New("HCS request exceeds one-message bound")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(message.Message)
	if err != nil || len(data) == 0 || len(data) > 1024 || digest(data) != c.RequestSHA256 {
		return nil, errors.New("HCS bytes differ from the reviewed request SHA-256")
	}
	return data, nil
}

func verifyRequest(data []byte, c config, buyer account, sellerKey []byte) (serviceRequest, multiaddr.Multiaddr, error) {
	var request serviceRequest
	if err := strictJSON(data, &request); err != nil {
		return request, nil, errors.New("invalid legacy request encoding")
	}
	if request.MessageType != "serviceRequest" || request.Version != "0.4" || request.ServiceType != legacy.ADSBProtocol || request.SLAAgreed != 1 || fmt.Sprintf("0.0.%d", request.StdinTopic) != c.BuyerStdinTopicID || fmt.Sprintf("0.0.%d", request.SharedAccount) != c.BuyerSharedAccountID || !strings.EqualFold(request.PublicKey, buyer.Key.Key) || !strings.EqualFold("0x"+strings.TrimPrefix(request.EVMAddress, "0x"), buyer.EVMAddress) {
		return request, nil, errors.New("request protocol, service, topics, or buyer identity differs from configuration and Mirror")
	}
	keyBytes, err := hex.DecodeString(request.PublicKey)
	if err != nil {
		return request, nil, errors.New("invalid buyer public key")
	}
	key, err := secp256k1.ParsePubKey(keyBytes)
	if err != nil || len(keyBytes) != 33 {
		return request, nil, errors.New("invalid compressed buyer key")
	}
	derived := "0x" + hex.EncodeToString(keccak(key.SerializeUncompressed()[1:])[12:])
	if !strings.EqualFold(derived, buyer.EVMAddress) {
		return request, nil, errors.New("buyer public key does not derive its Mirror EVM address")
	}
	if len(sellerKey) != 32 || len(request.EncryptedAddress) < 1 || len(request.EncryptedAddress) > 128 {
		return request, nil, errors.New("invalid key or encrypted request address length")
	}
	secret := secp256k1.GenerateSharedSecret(secp256k1.PrivKeyFromBytes(sellerKey), key)
	if secret[0] == 0 {
		return request, nil, errors.New("legacy ECDH leading-zero encoding is unsupported")
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return request, nil, err
	}
	iv := []byte("yakfOMkPmf13a75EhWE795l9+be6/xcB+Duba5kvRfBHHqtCnUFYvKZlxLWFtVJQ")
	plain := make([]byte, len(request.EncryptedAddress))
	cipher.NewCFBDecrypter(block, iv[len(iv)-16:]).XORKeyStream(plain, request.EncryptedAddress)
	text := string(plain)
	if !strings.HasPrefix(text, "[") || !strings.HasSuffix(text, "]") {
		return request, nil, errors.New("invalid decrypted address list")
	}
	address, err := targetAddress(text[1:len(text)-1], c.LoopbackTarget)
	return request, address, err
}

func targetAddress(value, loopbackTarget string) (multiaddr.Multiaddr, error) {
	if err := directseller.ValidateQUICAddress(value, loopbackTarget != ""); err != nil {
		return nil, err
	}
	if loopbackTarget != "" && value != loopbackTarget {
		return nil, errors.New("local delivery must match the explicitly pinned 127.0.0.1 target")
	}
	return multiaddr.NewMultiaddr(value)
}

func (n networkReader) readRequest(ctx context.Context, c config, now time.Time) (hcsMessage, []byte, error) {
	var message hcsMessage
	if err := n.get(ctx, fmt.Sprintf("/topics/%s/messages/%d", c.SellerStdinTopicID, c.RequestSequence), &message); err != nil {
		return message, nil, err
	}
	data, err := requestBytes(message, c, now)
	return message, data, err
}
