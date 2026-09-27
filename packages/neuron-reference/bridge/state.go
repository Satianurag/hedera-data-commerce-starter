package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/google/uuid"
	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"github.com/neuron-sdk/neuron-go-sdk/internal/keylib"
	bindings "github.com/neuron-sdk/neuron-go-sdk/internal/payment/bindings"
)

const revision = "13ab01d70ac42531065094a52cd595ef7b6d3223"
const mirror = "https://testnet.mirrornode.hedera.com"

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var idPattern = regexp.MustCompile(`^0\.0\.[1-9][0-9]*$`)
var decimalPattern = regexp.MustCompile(`^[1-9][0-9]{0,76}$`)

type config struct {
	Network               string `json:"network"`
	OperatorAccountID     string `json:"operatorAccountId"`
	OperatorKeyFile       string `json:"operatorKeyFile"`
	BuyerProtocolKeyFile  string `json:"buyerProtocolKeyFile"`
	SellerAccountID       string `json:"sellerAccountId"`
	SellerKeyFile         string `json:"sellerKeyFile"`
	BuyerTopicID          string `json:"buyerTopicId"`
	SellerTopicID         string `json:"sellerTopicId"`
	EscrowAddress         string `json:"escrowAddress"`
	EscrowRuntimeCodeHash string `json:"escrowRuntimeCodeHash"`
	TokenAddress          string `json:"tokenAddress"`
	TokenRuntimeCodeHash  string `json:"tokenRuntimeCodeHash"`
	TokenDecimals         uint8  `json:"tokenDecimals"`
	TokenSymbol           string `json:"tokenSymbol"`
	PriceBaseUnits        string `json:"priceBaseUnits"`
	SourceFile            string `json:"sourceFile"`
	RefundAfterSeconds    uint64 `json:"refundAfterSeconds"`
	RPCURL                string `json:"rpcUrl"`
	MaxSessions           int    `json:"maxSessions"`
	MaxHCSFeeTinybar      int64  `json:"maxHcsFeeTinybar"`
	MaxSellerGasPriceWei  string `json:"maxSellerGasPriceWei"`
}
type walletAction struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	ChainID int    `json:"chainId"`
	To      string `json:"to"`
	Data    string `json:"data"`
	Value   string `json:"value"`
}
type intent struct {
	ID              string       `json:"id"`
	Kind            string       `json:"kind"`
	Status          string       `json:"status"`
	TransactionHash string       `json:"transactionHash,omitempty"`
	Transaction     walletAction `json:"transaction"`
	CandidateHashes []string     `json:"candidateHashes,omitempty"`
}
type hcsMessage struct {
	Kind           string          `json:"kind"`
	TopicID        string          `json:"topicId"`
	SequenceNumber string          `json:"sequenceNumber"`
	TransactionID  string          `json:"transactionId"`
	SHA256         string          `json:"sha256"`
	MirrorVerified bool            `json:"mirrorVerified"`
	SenderAddress  string          `json:"senderAddress"`
	Payload        json.RawMessage `json:"payload"`
	Envelope       json.RawMessage `json:"envelope"`
}
type transaction struct {
	Kind            string `json:"kind"`
	TransactionHash string `json:"transactionHash"`
	Status          string `json:"status"`
}
type deliveredFile struct {
	Filename     string `json:"filename"`
	Bytes        int64  `json:"bytes"`
	SHA256       string `json:"sha256"`
	ReceivedAt   string `json:"receivedAt"`
	DownloadPath string `json:"downloadPath"`
}
type session struct {
	ID                string         `json:"id"`
	BuyerAddress      string         `json:"buyerAddress"`
	CustomerSessionID string         `json:"customerSessionId"`
	State             string         `json:"state"`
	Message           string         `json:"message"`
	CreatedAt         int64          `json:"createdAt"`
	UpdatedAt         string         `json:"updatedAt"`
	Deadline          uint64         `json:"deadline"`
	EscrowID          string         `json:"escrowId,omitempty"`
	ReleaseID         string         `json:"releaseId,omitempty"`
	AgreementHash     string         `json:"agreementHash"`
	EvidenceHash      string         `json:"evidenceHash,omitempty"`
	Delivery          *deliveredFile `json:"delivery,omitempty"`
	Messages          []hcsMessage   `json:"messages"`
	Transactions      []transaction  `json:"transactions"`
	WalletActions     []walletAction `json:"walletActions"`
	PendingIntent     *intent        `json:"pendingIntent,omitempty"`
	// Seller raw transaction is saved BEFORE broadcast; recovery rebroadcasts no
	// new transaction and uses the already assigned hash. Never returned by API.
	SellerRawTx      string `json:"sellerRawTx,omitempty"`
	SellerTxKind     string `json:"sellerTxKind,omitempty"`
	SellerTxHash     string `json:"sellerTxHash,omitempty"`
	ConfigHash       string `json:"configHash"`
	DeliveryAttempts int    `json:"deliveryAttempts"`
}
type server struct {
	mu            sync.Mutex
	cfg           config
	stateDir      string
	token         string
	lock          *os.File
	sessions      map[string]*session
	operatorKey   hiero.PrivateKey
	buyerKey      keylib.NeuronPrivateKey
	sellerKey     keylib.NeuronPrivateKey
	sellerECDSA   *ecdsa.PrivateKey
	seller        common.Address
	hcs           *hiero.Client
	rpc           *ethclient.Client
	escrow        *bindings.NeuronEscrow
	tokenContract *bindings.TestToken
	sourceHash    string
	sourceSize    int64
	sourceName    string
	configHash    string
	sourceBytes   []byte
	http          *http.Client
}

func privateFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("owner-only file requires absolute path")
	}
	for _, p := range []string{path, filepath.Dir(path)} {
		st, e := os.Lstat(p)
		if e != nil {
			return nil, e
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("private file and parent cannot be symlinks")
		}
	}
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1048576 {
		return nil, errors.New("private file must be regular, <=1 MiB and owner-only")
	}
	if meta, ok := st.Sys().(*syscall.Stat_t); ok && meta.Uid != uint32(os.Getuid()) {
		return nil, errors.New("private file has different owner")
	}
	parent, e := os.Stat(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	if parent.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private file parent must be owner-only")
	}
	return io.ReadAll(io.LimitReader(f, 1048577))
}
func writeAtomic(path string, value any) error {
	b, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (s *server) save(v *session) error {
	v.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return writeAtomic(filepath.Join(s.stateDir, v.ID+".json"), v)
}
func (s *server) publicSession(v *session) any {
	copy := *v
	copy.SellerRawTx = ""
	copy.SellerTxKind = ""
	copy.SellerTxHash = ""
	return copy
}
func readKey(path string) (keylib.NeuronPrivateKey, error) {
	b, e := privateFile(path)
	if e != nil {
		return keylib.NeuronPrivateKey{}, e
	}
	raw := strings.TrimPrefix(strings.TrimSpace(string(b)), "0x")
	if len(raw) != 64 {
		key, err := hiero.PrivateKeyFromStringECDSA(raw)
		if err != nil {
			return keylib.NeuronPrivateKey{}, errors.New("invalid ECDSA private-key file")
		}
		raw = key.StringRaw()
	}
	return keylib.NeuronPrivateKeyFromHex(raw)
}
func newID() string { return uuid.NewString() }
func newServer() (*server, error) {
	raw, e := privateFile(os.Getenv("NEURON_REFERENCE_CONFIG_FILE"))
	if e != nil {
		return nil, e
	}
	var c config
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return nil, e
	}
	if c.Network != "testnet" || c.RPCURL != "https://testnet.hashio.io/api" {
		return nil, errors.New("only official testnet Hashio configured path is supported")
	}
	for _, id := range []string{c.OperatorAccountID, c.SellerAccountID, c.BuyerTopicID, c.SellerTopicID} {
		if !idPattern.MatchString(id) {
			return nil, errors.New("invalid testnet account/topic ID")
		}
	}
	if c.BuyerTopicID == c.SellerTopicID {
		return nil, errors.New("separate buyer and seller inbox topics required")
	}
	for _, a := range []string{c.EscrowAddress, c.TokenAddress} {
		if !common.IsHexAddress(a) || common.HexToAddress(a) == (common.Address{}) {
			return nil, errors.New("invalid nonzero contract address")
		}
	}
	if !decimalPattern.MatchString(c.PriceBaseUnits) || c.TokenDecimals > 36 || c.RefundAfterSeconds < 120 || c.RefundAfterSeconds > 86400 || c.MaxSessions < 1 || c.MaxSessions > 100 || c.MaxHCSFeeTinybar < 1 || c.MaxHCSFeeTinybar > 100000000 {
		return nil, errors.New("invalid price, limits or fee budget")
	}
	price, _ := new(big.Int).SetString(c.PriceBaseUnits, 10)
	if price.BitLen() > 256 {
		return nil, errors.New("price exceeds uint256")
	}
	if !decimalPattern.MatchString(c.MaxSellerGasPriceWei) {
		return nil, errors.New("max seller gas price required")
	}
	maxGas, _ := new(big.Int).SetString(c.MaxSellerGasPriceWei, 10)
	if maxGas.Cmp(big.NewInt(10000000000000)) > 0 {
		return nil, errors.New("seller gas-price cap exceeds testnet bridge hard cap")
	}
	for _, h := range []string{c.EscrowRuntimeCodeHash, c.TokenRuntimeCodeHash} {
		if len(h) != 66 || !strings.HasPrefix(h, "0x") {
			return nil, errors.New("runtime bytecode hashes required")
		}
		if _, e := hex.DecodeString(h[2:]); e != nil {
			return nil, e
		}
	}
	if !filepath.IsAbs(c.SourceFile) {
		return nil, errors.New("sourceFile must be absolute")
	}
	st, e := os.Stat(c.SourceFile)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Size() < 1 || st.Size() > 4*1024*1024 {
		return nil, errors.New("permitted source file must be 1 byte to 4 MiB")
	}
	data, e := os.ReadFile(c.SourceFile)
	if e != nil {
		return nil, e
	}
	hash := sha256.Sum256(data)
	token, e := privateFile(os.Getenv("NEURON_REFERENCE_API_TOKEN_FILE"))
	if e != nil {
		return nil, e
	}
	secret := strings.TrimSpace(string(token))
	if len(secret) < 32 {
		return nil, errors.New("API bearer token must have at least 32 characters")
	}
	dir := os.Getenv("NEURON_REFERENCE_STATE_DIR")
	if !filepath.IsAbs(dir) {
		return nil, errors.New("state directory absolute path required")
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	di, e := os.Stat(dir)
	if e != nil {
		return nil, e
	}
	if di.Mode().Perm()&0077 != 0 {
		return nil, errors.New("state directory must be 0700")
	}
	lock, e := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		lock.Close()
		return nil, errors.New("reference bridge state is already locked")
	}
	ready := false
	defer func() {
		if !ready {
			_ = lock.Close()
		}
	}()
	op, e := privateFile(c.OperatorKeyFile)
	if e != nil {
		return nil, e
	}
	operator, e := hiero.PrivateKeyFromStringECDSA(strings.TrimSpace(string(op)))
	if e != nil {
		return nil, errors.New("operator key is not ECDSA")
	}
	buyer, e := readKey(c.BuyerProtocolKeyFile)
	if e != nil {
		return nil, e
	}
	seller, e := readKey(c.SellerKeyFile)
	if e != nil {
		return nil, e
	}
	sellerECDSA, e := seller.ToBlockchainKey()
	if e != nil {
		return nil, e
	}
	if strings.EqualFold(buyer.PublicKey().EVMAddress().Hex(), seller.PublicKey().EVMAddress().Hex()) {
		return nil, errors.New("buyer delegate and seller require different keys")
	}
	id, _ := hiero.AccountIDFromString(c.OperatorAccountID)
	client := hiero.ClientForTestnet()
	client.SetOperator(id, operator)
	client.SetMaxAttempts(2)
	rpc, e := ethclient.Dial(c.RPCURL)
	if e != nil {
		return nil, e
	}
	esc, e := bindings.NewNeuronEscrow(common.HexToAddress(c.EscrowAddress), rpc)
	if e != nil {
		return nil, e
	}
	tok, e := bindings.NewTestToken(common.HexToAddress(c.TokenAddress), rpc)
	if e != nil {
		return nil, e
	}
	configDigest := sha256.Sum256(append(append([]byte{}, raw...), hash[:]...))
	s := &server{cfg: c, stateDir: dir, token: secret, lock: lock, sessions: map[string]*session{}, operatorKey: operator, buyerKey: buyer, sellerKey: seller, sellerECDSA: sellerECDSA, seller: crypto.PubkeyToAddress(sellerECDSA.PublicKey), hcs: client, rpc: rpc, escrow: esc, tokenContract: tok, sourceHash: hex.EncodeToString(hash[:]), sourceSize: st.Size(), sourceName: filepath.Base(c.SourceFile), sourceBytes: data, configHash: hex.EncodeToString(configDigest[:]), http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
	files, e := filepath.Glob(filepath.Join(dir, "*.json"))
	if e != nil {
		return nil, e
	}
	for _, p := range files {
		b, e := privateFile(p)
		if e != nil {
			return nil, e
		}
		var v session
		if e = json.Unmarshal(b, &v); e != nil {
			return nil, e
		}
		if !uuidPattern.MatchString(v.ID) || filepath.Base(p) != v.ID+".json" || v.ConfigHash != s.configHash {
			return nil, errors.New("session journal configuration/source mismatch; restore original configuration to reconcile funded sessions")
		}
		s.sessions[v.ID] = &v
	}
	if len(s.sessions) > c.MaxSessions {
		return nil, fmt.Errorf("journal exceeds configured session limit")
	}
	ready = true
	return s, nil
}
