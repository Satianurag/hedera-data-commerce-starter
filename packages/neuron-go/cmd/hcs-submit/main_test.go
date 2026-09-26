package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
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

func TestChunkBoundaries(t *testing.T) {
	for size, expected := range map[int]int{0: 0, 1: 1, 1024: 1, 1025: 2, 2048: 2, 8192: 8, 8193: 0} {
		count, err := chunkCount(size)
		if count != expected || (expected == 0) != (err != nil) {
			t.Fatalf("size %d: count=%d err=%v", size, count, err)
		}
	}
}

func selectedRow(t *testing.T, transactionID hedera.TransactionID, payload []byte, number, total int, sequence int64) mirrorMessage {
	t.Helper()
	if transactionID.ValidStart == nil {
		t.Fatal("test transaction has no valid start")
	}
	row := mirrorMessage{TopicID: "0.0.456", PayerAccountID: "0.0.123",
		ConsensusTime: "1790409084.123456789", SequenceNumber: sequence}
	row.ChunkInfo = &struct {
		InitialTransactionID struct {
			AccountID             string `json:"account_id"`
			TransactionValidStart string `json:"transaction_valid_start"`
			Nonce                 int    `json:"nonce"`
			Scheduled             bool   `json:"scheduled"`
		} `json:"initial_transaction_id"`
		Number int `json:"number"`
		Total  int `json:"total"`
	}{}
	row.ChunkInfo.InitialTransactionID.AccountID = "0.0.123"
	row.ChunkInfo.InitialTransactionID.TransactionValidStart =
		strconv.FormatInt(transactionID.ValidStart.Unix(), 10) + "." +
			fmt.Sprintf("%09d", transactionID.ValidStart.Nanosecond())
	row.ChunkInfo.Number = number
	row.ChunkInfo.Total = total
	start := (number - 1) * chunkSize
	end := start + chunkSize
	if end > len(payload) {
		end = len(payload)
	}
	row.Message = base64.StdEncoding.EncodeToString(payload[start:end])
	return row
}

func TestMirrorChunkReconciliation(t *testing.T) {
	id, err := hedera.TransactionIdFromString("0.0.123@1790409084.123456789")
	if err != nil {
		t.Fatal(err)
	}
	c := config{account: "0.0.123", topic: "0.0.456"}
	payload := make([]byte, 1025)
	for i := range payload {
		payload[i] = byte(i)
	}
	first := selectedRow(t, id, payload, 1, 2, 100)
	last := selectedRow(t, id, payload, 2, 2, 101)
	unrelated := selectedRow(t, id, payload, 1, 2, 102)
	unrelated.ChunkInfo.InitialTransactionID.TransactionValidStart = "1790409083.000000000"
	if _, complete, partial, err := matchMirrorRows(c, id, payload, []mirrorMessage{last, unrelated}); err != nil || complete || !partial {
		t.Fatalf("partial chunk set was not recognized: complete=%v partial=%v err=%v", complete, partial, err)
	}
	matched, complete, partial, err := matchMirrorRows(c, id, payload, []mirrorMessage{last, unrelated, first})
	if err != nil || !complete || !partial || !reflect.DeepEqual(matched, last) {
		t.Fatalf("interleaved chunk set did not reconcile exactly: complete=%v partial=%v err=%v", complete, partial, err)
	}
	for name, mutate := range map[string]func(*mirrorMessage){
		"wrong payer":    func(row *mirrorMessage) { row.PayerAccountID = "0.0.999" },
		"wrong total":    func(row *mirrorMessage) { row.ChunkInfo.Total = 3 },
		"wrong bytes":    func(row *mirrorMessage) { row.Message = base64.StdEncoding.EncodeToString([]byte{0xff}) },
		"invalid base64": func(row *mirrorMessage) { row.Message = "%%%" },
		"wrong topic":    func(row *mirrorMessage) { row.TopicID = "0.0.999" },
		"wrong order":    func(row *mirrorMessage) { row.SequenceNumber = 99 },
	} {
		t.Run(name, func(t *testing.T) {
			changed := selectedRow(t, id, payload, 2, 2, 101)
			mutate(&changed)
			if _, _, _, err := matchMirrorRows(c, id, payload, []mirrorMessage{first, changed}); err == nil {
				t.Fatal("mismatched selected chunk accepted")
			}
		})
	}
	if _, _, _, err := matchMirrorRows(c, id, payload, []mirrorMessage{first, first}); err == nil {
		t.Fatal("duplicate selected chunk accepted")
	}
	for _, size := range []int{1, 1024, 2048, 8192} {
		body := make([]byte, size)
		count, _ := chunkCount(size)
		rows := make([]mirrorMessage, count)
		for number := 1; number <= count; number++ {
			rows[count-number] = selectedRow(t, id, body, number, count, int64(100+number))
		}
		if _, complete, _, err := matchMirrorRows(c, id, body, rows); err != nil || !complete {
			t.Fatalf("size %d did not reconcile: %v", size, err)
		}
	}
}
