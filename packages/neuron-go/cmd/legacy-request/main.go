package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"neuron-customer-app/neuron-go/directseller"
	"neuron-customer-app/neuron-go/legacy"
)

var hederaID = regexp.MustCompile(`^0\.0\.[1-9]\d*$`)
var ecPublicKeyOID = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}
var secp256k1OID = asn1.ObjectIdentifier{1, 3, 132, 0, 10}

type publicKeyInfo struct {
	Algorithm pkix.AlgorithmIdentifier
	PublicKey asn1.BitString
}

type device struct {
	AccountID string `json:"hederaaccountnumber"`
	PublicKey string `json:"publickey"`
	Stdin     string `json:"topic_stdin"`
	Stdout    string `json:"topic_stdout"`
	Services  []struct {
		ID uint64 `json:"service_id"`
	} `json:"services"`
}

func getJSON(address string, out any) error {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(address)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("resource returned HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out)
}

func publicKeyFromDER(value string) ([]byte, error) {
	der, err := hex.DecodeString(value)
	if err != nil {
		return nil, errors.New("invalid seller DER public key")
	}
	var info publicKeyInfo
	rest, err := asn1.Unmarshal(der, &info)
	if err != nil || len(rest) != 0 || !info.Algorithm.Algorithm.Equal(ecPublicKeyOID) {
		return nil, errors.New("invalid seller SPKI")
	}
	var curve asn1.ObjectIdentifier
	if rest, err = asn1.Unmarshal(info.Algorithm.Parameters.FullBytes, &curve); err != nil || len(rest) != 0 || !curve.Equal(secp256k1OID) {
		return nil, errors.New("seller key is not secp256k1")
	}
	key := info.PublicKey.Bytes
	if info.PublicKey.BitLength != 264 || len(key) != 33 {
		return nil, errors.New("seller key is not compressed secp256k1")
	}
	if _, err := secp256k1.ParsePubKey(key); err != nil {
		return nil, err
	}
	return key, nil
}

func parseID(value string) (uint64, error) {
	if !hederaID.MatchString(value) {
		return 0, errors.New("invalid Hedera ID")
	}
	return strconv.ParseUint(strings.TrimPrefix(value, "0.0."), 10, 64)
}

func run() error {
	if os.Getenv("HEDERA_NETWORK") != "testnet" {
		return errors.New("legacy request is testnet-only; no mainnet seller directory is verified")
	}
	direct, err := directseller.LoadFromEnv()
	if err != nil {
		return err
	}
	sellerID := os.Getenv("NEURON_SELLER_ACCOUNT_ID")
	buyerID := os.Getenv("HEDERA_BUYER_ACCOUNT_ID")
	stdinID := os.Getenv("HEDERA_BUYER_STDIN_TOPIC_ID")
	sharedID := os.Getenv("HEDERA_SHARED_ACCOUNT_ID")
	for _, id := range []string{sellerID, buyerID, stdinID, sharedID} {
		if !hederaID.MatchString(id) {
			return errors.New("seller, buyer, stdin and shared account IDs must be numeric")
		}
	}
	address := os.Getenv("NEURON_PUBLIC_UDP_MULTIADDR")
	if err := requireRequestUDPAddress(address, direct); err != nil {
		return err
	}
	keyPath := os.Getenv("HEDERA_BUYER_KEY_FILE")
	info, err := os.Stat(keyPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("buyer key file must be owner-only")
	}
	keyFile, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	buyerKey, err := hedera.PrivateKeyFromStringDer(strings.TrimSpace(string(keyFile)))
	if err != nil || len(buyerKey.BytesRaw()) != 32 {
		return errors.New("buyer key must be ECDSA secp256k1 DER")
	}
	seller, sellerPublic, err := selectedSeller(sellerID, direct)
	if err != nil {
		return err
	}
	if _, err := legacy.SellerPeerID(hex.EncodeToString(sellerPublic)); err != nil {
		return err
	}
	const mirror = "https://testnet.mirrornode.hedera.com/api/v1"
	var sellerAccount, buyerAccount, sharedAccount struct {
		Account string `json:"account"`
		Deleted bool   `json:"deleted"`
		Key     struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"key"`
		EVMAddress string `json:"evm_address"`
		Balance    struct {
			Balance int64 `json:"balance"`
		} `json:"balance"`
	}
	for _, item := range []struct {
		id     string
		target any
	}{{sellerID, &sellerAccount}, {buyerID, &buyerAccount}, {sharedID, &sharedAccount}} {
		if err := getJSON(mirror+"/accounts/"+item.id, item.target); err != nil {
			return err
		}
	}
	if sellerAccount.Deleted || sellerAccount.Account != sellerID || sellerAccount.Key.Type != "ECDSA_SECP256K1" || !strings.EqualFold(sellerAccount.Key.Key, hex.EncodeToString(sellerPublic)) {
		return errors.New("seller directory key differs from testnet Mirror")
	}
	buyerPublic := buyerKey.PublicKey().StringRaw()
	if buyerAccount.Deleted || buyerAccount.Account != buyerID || buyerAccount.Key.Type != "ECDSA_SECP256K1" || !strings.EqualFold(buyerAccount.Key.Key, buyerPublic) || !strings.EqualFold(strings.TrimPrefix(buyerAccount.EVMAddress, "0x"), buyerKey.PublicKey().ToEvmAddress()) {
		return errors.New("buyer identity differs from testnet Mirror")
	}
	if sharedAccount.Deleted || sharedAccount.Account != sharedID || sharedAccount.Key.Type != "ECDSA_SECP256K1" || !strings.EqualFold(sharedAccount.Key.Key, buyerPublic) || sharedAccount.Balance.Balance < 0 || sharedAccount.Balance.Balance >= 100 {
		return errors.New("shared account must be buyer-controlled and hold fewer than 100 tinybar")
	}
	var sellerTopic, buyerTopic struct {
		ID         string `json:"topic_id"`
		Deleted    bool   `json:"deleted"`
		SubmitKey  any    `json:"submit_key"`
		CustomFees struct {
			FixedFees []json.RawMessage `json:"fixed_fees"`
		} `json:"custom_fees"`
	}
	if err := getJSON(mirror+"/topics/"+seller.Stdin, &sellerTopic); err != nil {
		return err
	}
	if err := getJSON(mirror+"/topics/"+stdinID, &buyerTopic); err != nil {
		return err
	}
	if sellerTopic.Deleted || sellerTopic.ID != seller.Stdin || sellerTopic.SubmitKey != nil || sellerTopic.CustomFees.FixedFees == nil || len(sellerTopic.CustomFees.FixedFees) != 0 || buyerTopic.Deleted || buyerTopic.ID != stdinID || buyerTopic.SubmitKey != nil || buyerTopic.CustomFees.FixedFees == nil || len(buyerTopic.CustomFees.FixedFees) != 0 {
		return errors.New("seller or buyer stdin topic is not open and active without custom fees")
	}
	otherKey, err := secp256k1.ParsePubKey(sellerPublic)
	if err != nil {
		return err
	}
	secret := secp256k1.GenerateSharedSecret(secp256k1.PrivKeyFromBytes(buyerKey.BytesRaw()), otherKey)
	if secret[0] == 0 {
		return errors.New("legacy ECDH drops a leading zero byte; select another buyer key")
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return err
	}
	legacyIV := []byte("yakfOMkPmf13a75EhWE795l9+be6/xcB+Duba5kvRfBHHqtCnUFYvKZlxLWFtVJQ")
	iv := legacyIV[len(legacyIV)-16:]
	plain := []byte("[" + address + "]")
	encrypted := make([]byte, len(plain))
	cipher.NewCFBEncrypter(block, iv).XORKeyStream(encrypted, plain)
	stdinNumber, err := parseID(stdinID)
	if err != nil {
		return err
	}
	sharedNumber, err := parseID(sharedID)
	if err != nil {
		return err
	}
	request := struct {
		MessageType      string `json:"messageType"`
		EncryptedAddress []byte `json:"i"`
		StdinTopic       uint64 `json:"o"`
		EVMAddress       string `json:"e"`
		PublicKey        string `json:"k"`
		ServiceType      string `json:"t"`
		SLAAgreed        uint64 `json:"s"`
		SharedAccount    uint64 `json:"a"`
		Version          string `json:"v"`
	}{"serviceRequest", encrypted, stdinNumber, buyerKey.PublicKey().ToEvmAddress(), buyerPublic, legacy.ADSBProtocol, 1, sharedNumber, "0.4"}
	payload, err := json.Marshal(request)
	if err != nil || len(payload) > 1024 {
		return errors.New("legacy request exceeds HCS one-message limit")
	}
	_, err = os.Stdout.Write(payload)
	return err
}

func requireRequestUDPAddress(value string, direct *directseller.Profile) error {
	return directseller.ValidateQUICAddress(value, direct != nil && direct.Transport == "loopback")
}

func selectedSeller(sellerID string, direct *directseller.Profile) (*device, []byte, error) {
	if direct != nil {
		if direct.AccountID != sellerID {
			return nil, nil, errors.New("direct seller identity mismatch")
		}
		if err := directseller.CheckMirror(context.Background(), *direct); err != nil {
			return nil, nil, err
		}
		key, _ := hex.DecodeString(direct.PublicKey)
		return &device{AccountID: direct.AccountID, Stdin: direct.StdinTopicID, Stdout: direct.StdoutTopicID}, key, nil
	}
	var directory []device
	if err := getJSON("https://explorer.neuron.world/api/v1/device/wip-all", &directory); err != nil {
		return nil, nil, err
	}
	for _, seller := range directory {
		if seller.AccountID != sellerID {
			continue
		}
		if topic := os.Getenv("NEURON_SELLER_STDIN_TOPIC_ID"); topic != "" && topic != seller.Stdin {
			return nil, nil, errors.New("seller directory topic differs from configured request topic")
		}
		for _, service := range seller.Services {
			if service.ID == 1 {
				key, err := publicKeyFromDER(seller.PublicKey)
				return &seller, key, err
			}
		}
		return nil, nil, errors.New("seller does not advertise legacy service 1")
	}
	return nil, nil, errors.New("seller is absent from live legacy directory")
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
