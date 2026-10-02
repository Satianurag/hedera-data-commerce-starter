package directseller

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture() Profile {
	return Profile{Schema: "neuronDirectSeller/v1", Network: "testnet", ChainID: 296, AccountID: "0.0.100",
		PublicKey:    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
		StdinTopicID: "0.0.101", StdoutTopicID: "0.0.102", QuoteTopicID: "0.0.103", ServiceID: "1",
		Protocol: "neuron/ADSB/0.0.2", PaymentProtocol: "neuronCustomerQuote/v1", Transport: "public"}
}

func TestStrictProfile(t *testing.T) {
	p := fixture()
	raw, _ := json.Marshal(p)
	if got, err := Parse(raw); err != nil || *got != p {
		t.Fatalf("valid profile rejected: %v", err)
	}
	for _, alter := range []func(*Profile){func(p *Profile) { p.Network = "mainnet" }, func(p *Profile) { p.ChainID = 295 },
		func(p *Profile) { p.ServiceID = "2" }, func(p *Profile) { p.Protocol = "other" }, func(p *Profile) { p.Transport = "private" },
		func(p *Profile) { p.QuoteTopicID = p.StdinTopicID }, func(p *Profile) { p.AccountID = "0.0.18446744073709551616" },
		func(p *Profile) { p.PublicKey = "02" + strings.Repeat("ff", 32) }, func(p *Profile) { p.PaymentProtocol = "Draft-008" }} {
		bad := p
		alter(&bad)
		raw, _ := json.Marshal(bad)
		if _, err := Parse(raw); err == nil {
			t.Fatalf("accepted invalid profile %+v", bad)
		}
	}
	for _, raw := range []string{`null`, string(raw) + ` {}`, strings.Replace(string(raw), `{`, `{"network":"mainnet",`, 1),
		strings.Replace(string(raw), `"accountId"`, `"AccountId"`, 1),
		strings.Replace(string(raw), `{`, `{"AccountId":"0.0.200",`, 1),
		strings.Replace(string(raw), `{`, `{"unknown":true,`, 1), strings.Repeat(" ", 16385)} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Fatalf("accepted malformed profile %s", raw)
		}
	}
}

func TestPrivateProfileAndNoFallback(t *testing.T) {
	for _, key := range []string{"NEURON_SELLER_DISCOVERY", "NEURON_DIRECT_SELLER_PROFILE_FILE", "HEDERA_CHAIN_ID",
		"NEURON_SELLER_ACCOUNT_ID", "NEURON_SELLER_STDIN_TOPIC_ID", "NEURON_COMMERCE_SELLER_ACCOUNT_ID",
		"NEURON_COMMERCE_QUOTE_TOPIC_ID", "NEURON_COMMERCE_SERVICE_ID"} {
		t.Setenv(key, "")
	}
	// Empty optional binding values are deliberately conflicting when provided.
	for _, key := range []string{"NEURON_SELLER_ACCOUNT_ID", "NEURON_SELLER_STDIN_TOPIC_ID", "NEURON_COMMERCE_SELLER_ACCOUNT_ID", "NEURON_COMMERCE_QUOTE_TOPIC_ID", "NEURON_COMMERCE_SERVICE_ID"} {
		os.Unsetenv(key)
	}
	if p, err := LoadFromEnv(); err != nil || p != nil {
		t.Fatalf("canonical default: %v", err)
	}
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	path := filepath.Join(dir, "seller.json")
	raw, _ := json.Marshal(fixture())
	os.WriteFile(path, raw, 0600)
	t.Setenv("HEDERA_NETWORK", "testnet")
	t.Setenv("NEURON_SELLER_DISCOVERY", "direct")
	t.Setenv("NEURON_DIRECT_SELLER_PROFILE_FILE", path)
	if _, err := LoadFromEnv(); err != nil {
		t.Fatal(err)
	}
	for _, patch := range [][2]string{{"HEDERA_NETWORK", "mainnet"}, {"NEURON_SELLER_DISCOVERY", "canonical"}, {"NEURON_SELLER_DISCOVERY", "typo"}, {"NEURON_SELLER_ACCOUNT_ID", "0.0.200"}} {
		t.Run(patch[0]+patch[1], func(t *testing.T) {
			t.Setenv(patch[0], patch[1])
			if _, err := LoadFromEnv(); err == nil {
				t.Fatal("accepted conflicting configuration")
			}
		})
	}
	os.Chmod(path, 0644)
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("accepted public profile")
	}
	os.Chmod(path, 0600)
	link := filepath.Join(dir, "link.json")
	os.Symlink(path, link)
	t.Setenv("NEURON_DIRECT_SELLER_PROFILE_FILE", link)
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("accepted profile symlink")
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMirrorBindingRejectsRotationFeesAndMissingMetadata(t *testing.T) {
	p := fixture()
	accountPatch := map[string]any{}
	topicPatch := map[string]any{}
	calls := 0
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "testnet.mirrornode.hedera.com" {
			t.Fatal("unexpected discovery provider")
		}
		var row map[string]any
		if strings.Contains(r.URL.Path, "/accounts/") {
			row = map[string]any{"account": p.AccountID, "deleted": false, "evm_address": EVMAddress(p), "key": map[string]any{"_type": "ECDSA_SECP256K1", "key": p.PublicKey}}
			for k, v := range accountPatch {
				row[k] = v
			}
		} else {
			parts := strings.Split(r.URL.Path, "/")
			row = map[string]any{"topic_id": parts[len(parts)-1], "deleted": false, "submit_key": nil, "custom_fees": map[string]any{"fixed_fees": []any{}}}
			for k, v := range topicPatch {
				row[k] = v
			}
		}
		raw, _ := json.Marshal(row)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{}}, nil
	})}
	if err := checkMirror(context.Background(), p, client); err != nil {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatalf("expected 4 Mirror reads, got%d", calls)
	}
	for _, patch := range []map[string]any{{"deleted": true}, {"deleted": nil}, {"evm_address": "0x0000000000000000000000000000000000000001"}, {"key": map[string]any{"_type": "ECDSA_SECP256K1", "key": "03" + p.PublicKey[2:]}}} {
		accountPatch = patch
		if err := checkMirror(context.Background(), p, client); err == nil {
			t.Fatalf("accepted mismatched account: %v", patch)
		}
	}
	accountPatch = map[string]any{}
	for _, patch := range []map[string]any{{"deleted": true}, {"deleted": nil}, {"submit_key": map[string]any{}}, {"custom_fees": map[string]any{}}, {"custom_fees": map[string]any{"fixed_fees": []any{map[string]any{}}}}, {"topic_id": "0.0.999"}} {
		topicPatch = patch
		if err := checkMirror(context.Background(), p, client); err == nil {
			t.Fatalf("accepted mismatched topic: %v", patch)
		}
	}
}
