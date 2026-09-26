package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

func TestWriterConfigRequiresExplicitNetworkAndPrivateKeyFile(t *testing.T) {
	key, err := hedera.PrivateKeyGenerateEcdsa()
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "operator.key")
	if err := os.WriteFile(keyPath, []byte(key.StringDer()), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HEDERA_OPERATOR_ACCOUNT_ID", "0.0.123")
	t.Setenv("HEDERA_TOPIC_ID", "0.0.456")
	t.Setenv("HEDERA_OPERATOR_KEY_FILE", keyPath)
	t.Setenv("HEDERA_MAX_FEE_TINYBAR", "1000000")
	t.Setenv("HEDERA_NETWORK", "")
	if _, err := fromEnv(); err == nil || !strings.Contains(err.Error(), "explicitly") {
		t.Fatalf("missing network accepted: %v", err)
	}
	t.Setenv("HEDERA_NETWORK", "mainnet")
	t.Setenv("HEDERA_ALLOW_MAINNET_WRITES", "")
	if _, err := fromEnv(); err == nil || !strings.Contains(err.Error(), "mainnet writes") {
		t.Fatalf("mainnet write gate bypassed: %v", err)
	}
	t.Setenv("HEDERA_NETWORK", "testnet")
	if err := os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := fromEnv(); err == nil || !strings.Contains(err.Error(), "readable only by its owner") {
		t.Fatalf("public key file accepted: %v", err)
	}
	if err := os.Chmod(keyPath, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := fromEnv()
	if err != nil || c.network != "testnet" || c.mirror != "https://testnet.mirrornode.hedera.com" {
		t.Fatalf("safe testnet config rejected: %v", err)
	}
	t.Setenv("HEDERA_TOPIC_ACCESS", "open")
	c, err = fromEnv()
	if err != nil || !c.openTopic {
		t.Fatalf("explicit open-topic config rejected: %v", err)
	}
	t.Setenv("HEDERA_TOPIC_ACCESS", "unknown")
	if _, err := fromEnv(); err == nil || !strings.Contains(err.Error(), "controlled or open") {
		t.Fatalf("unknown topic access accepted: %v", err)
	}
	t.Setenv("HEDERA_TOPIC_ACCESS", "")
	t.Setenv("HEDERA_MAX_FEE_TINYBAR", "0")
	if _, err := fromEnv(); err == nil || !strings.Contains(err.Error(), "positive") {
		t.Fatalf("zero fee cap accepted: %v", err)
	}
}

func TestMirrorReconciliationRequiresOperatorTransactionID(t *testing.T) {
	if _, err := findMirrorMessage(context.Background(), config{account: "0.0.123"}, hedera.TransactionID{}, nil); err == nil || !strings.Contains(err.Error(), "operator") {
		t.Fatalf("missing transaction identity accepted: %v", err)
	}
}
