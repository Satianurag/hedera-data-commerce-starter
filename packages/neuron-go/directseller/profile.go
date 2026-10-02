// Package directseller implements explicit operator-pinned discovery. It does
// not impersonate a public directory record or assert that data was delivered.
package directseller

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/crypto/sha3"
)

type Profile struct {
	Schema          string `json:"schema"`
	Network         string `json:"network"`
	ChainID         uint64 `json:"chainId"`
	AccountID       string `json:"accountId"`
	PublicKey       string `json:"publicKey"`
	StdinTopicID    string `json:"stdinTopicId"`
	StdoutTopicID   string `json:"stdoutTopicId"`
	QuoteTopicID    string `json:"quoteTopicId"`
	ServiceID       string `json:"serviceId"`
	Protocol        string `json:"protocol"`
	PaymentProtocol string `json:"paymentProtocol"`
	Transport       string `json:"transport"`
}

var entityID = regexp.MustCompile(`^0\.0\.[1-9][0-9]{0,19}$`)
var compressedKey = regexp.MustCompile(`^0[23][0-9a-f]{64}$`)

func Validate(p Profile) error {
	if p.Schema != "neuronDirectSeller/v1" || p.Network != "testnet" || p.ChainID != 296 ||
		p.ServiceID != "1" || p.Protocol != "neuron/ADSB/0.0.2" || p.PaymentProtocol != "neuronCustomerQuote/v1" ||
		(p.Transport != "public" && p.Transport != "loopback") {
		return errors.New("unsupported direct seller profile, network or protocol")
	}
	for _, id := range []string{p.AccountID, p.StdinTopicID, p.StdoutTopicID, p.QuoteTopicID} {
		if !entityID.MatchString(id) {
			return errors.New("invalid direct seller Hedera ID")
		}
		if _, err := strconv.ParseUint(id[4:], 10, 64); err != nil {
			return errors.New("invalid direct seller Hedera ID")
		}
	}
	key, err := hex.DecodeString(p.PublicKey)
	if err != nil || !compressedKey.MatchString(p.PublicKey) {
		return errors.New("invalid direct seller key")
	}
	if _, err := secp256k1.ParsePubKey(key); err != nil {
		return errors.New("invalid direct seller key")
	}
	if p.StdinTopicID == p.StdoutTopicID || p.StdinTopicID == p.QuoteTopicID || p.StdoutTopicID == p.QuoteTopicID {
		return errors.New("direct seller topics must be distinct")
	}
	return nil
}

func Parse(raw []byte) (*Profile, error) {
	if len(raw) > 16384 {
		return nil, errors.New("direct seller profile exceeds size limit")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var p Profile
	if err := dec.Decode(&p); err != nil {
		return nil, errors.New("invalid direct seller profile JSON")
	}
	if dec.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing direct seller profile data")
	}
	// JSON duplicate fields must not change the meaning across implementations.
	fields := json.NewDecoder(bytes.NewReader(raw))
	if start, err := fields.Token(); err != nil || start != json.Delim('{') {
		return nil, errors.New("invalid direct seller profile object")
	}
	seen := map[string]bool{}
	allowed := map[string]bool{"schema": true, "network": true, "chainId": true, "accountId": true,
		"publicKey": true, "stdinTopicId": true, "stdoutTopicId": true, "quoteTopicId": true,
		"serviceId": true, "protocol": true, "paymentProtocol": true, "transport": true}
	for fields.More() {
		key, err := fields.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok || seen[name] || !allowed[name] {
			return nil, errors.New("duplicate or unknown direct seller profile field")
		}
		seen[name] = true
		if err := fields.Decode(new(json.RawMessage)); err != nil {
			return nil, err
		}
	}
	if len(seen) != 12 {
		return nil, errors.New("missing direct seller profile field")
	}
	if err := Validate(p); err != nil {
		return nil, err
	}
	return &p, nil
}

func owned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

// LoadFromEnv does not fall back when direct configuration is invalid.
func LoadFromEnv() (*Profile, error) {
	mode, path := os.Getenv("NEURON_SELLER_DISCOVERY"), os.Getenv("NEURON_DIRECT_SELLER_PROFILE_FILE")
	if (mode == "" || mode == "canonical") && path == "" {
		return nil, nil
	}
	if mode != "direct" || !filepath.IsAbs(path) || os.Getenv("HEDERA_NETWORK") != "testnet" ||
		(os.Getenv("HEDERA_CHAIN_ID") != "" && os.Getenv("HEDERA_CHAIN_ID") != "296") {
		return nil, errors.New("direct discovery requires explicit testnet and private profile file")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 || parent.Mode().Perm()&0077 != 0 || !owned(parent) ||
		!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !owned(info) || info.Size() > 16384 {
		return nil, errors.New("direct seller profile and parent must be owner-only regular paths")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() || opened.Mode().Perm()&0077 != 0 || !owned(opened) {
		return nil, errors.New("direct seller profile changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil {
		return nil, err
	}
	p, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	if p.Transport == "loopback" {
		origin, err := url.Parse(os.Getenv("NEURON_APP_ORIGIN"))
		if err != nil {
			return nil, err
		}
		gateway, err := url.Parse(os.Getenv("NEURON_GATEWAY_WS_URL"))
		if err != nil {
			return nil, err
		}
		local := func(u *url.URL) bool {
			return (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") && u.User == nil && u.RawQuery == "" && u.Fragment == ""
		}
		if os.Getenv("NEURON_ENABLE_LOCAL_STREAM") != "true" || os.Getenv("NEURON_ENABLE_REMOTE_STREAM") == "true" ||
			!local(origin) || origin.Scheme != "http" || (origin.Path != "" && origin.Path != "/") ||
			!local(gateway) || gateway.Scheme != "ws" || gateway.Port() == "" || gateway.Path != "/stream" {
			return nil, errors.New("loopback seller requires explicitly local browser and gateway")
		}
	}
	for name, expected := range map[string]string{"NEURON_SELLER_ACCOUNT_ID": p.AccountID,
		"NEURON_SELLER_STDIN_TOPIC_ID": p.StdinTopicID, "NEURON_COMMERCE_SELLER_ACCOUNT_ID": p.AccountID,
		"NEURON_COMMERCE_QUOTE_TOPIC_ID": p.QuoteTopicID, "NEURON_COMMERCE_SERVICE_ID": p.ServiceID} {
		if actual, present := os.LookupEnv(name); present && actual != expected {
			return nil, fmt.Errorf("direct seller profile conflicts with %s", name)
		}
	}
	return p, nil
}

func EVMAddress(p Profile) string {
	key, _ := hex.DecodeString(p.PublicKey)
	parsed, err := secp256k1.ParsePubKey(key)
	if err != nil {
		return ""
	}
	hash := sha3.NewLegacyKeccak256()
	hash.Write(parsed.SerializeUncompressed()[1:])
	return "0x" + hex.EncodeToString(hash.Sum(nil)[12:])
}

// CheckMirror verifies the pinned key, EVM alias and all topics using the official testnet endpoint.
func CheckMirror(ctx context.Context, p Profile) error {
	if err := Validate(p); err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return checkMirror(ctx, p, client)
}

func checkMirror(ctx context.Context, p Profile, client *http.Client) error {
	read := func(path string, target any) error {
		req, err := http.NewRequestWithContext(ctx, "GET", "https://testnet.mirrornode.hedera.com/api/v1/"+path, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("direct seller Mirror returned HTTP %d", resp.StatusCode)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
		if err != nil {
			return err
		}
		if len(raw) > 65536 {
			return errors.New("direct seller Mirror response too large")
		}
		return json.Unmarshal(raw, target)
	}
	var account struct {
		Account string `json:"account"`
		Deleted *bool  `json:"deleted"`
		EVM     string `json:"evm_address"`
		Key     struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"key"`
	}
	if err := read("accounts/"+p.AccountID, &account); err != nil {
		return err
	}
	if account.Account != p.AccountID || account.Deleted == nil || *account.Deleted || account.Key.Type != "ECDSA_SECP256K1" ||
		strings.ToLower(account.Key.Key) != p.PublicKey || !strings.EqualFold(account.EVM, EVMAddress(p)) {
		return errors.New("direct seller Mirror key or EVM alias differs from pinned identity")
	}
	for _, id := range []string{p.StdinTopicID, p.StdoutTopicID, p.QuoteTopicID} {
		var topic struct {
			ID        string          `json:"topic_id"`
			Deleted   *bool           `json:"deleted"`
			SubmitKey json.RawMessage `json:"submit_key"`
			Fees      struct {
				Fixed []json.RawMessage `json:"fixed_fees"`
			} `json:"custom_fees"`
		}
		if err := read("topics/"+id, &topic); err != nil {
			return err
		}
		if topic.ID != id || topic.Deleted == nil || *topic.Deleted || string(topic.SubmitKey) != "null" || topic.Fees.Fixed == nil || len(topic.Fees.Fixed) != 0 {
			return errors.New("direct seller topics must be open, active and without custom fees")
		}
	}
	return nil
}
