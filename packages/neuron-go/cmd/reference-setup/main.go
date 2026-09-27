// reference-setup creates one isolated pair of open testnet HCS topics.
// A saved transaction is reconciled on rerun, never submitted a second time.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

const mirror = "https://testnet.mirrornode.hedera.com/api/v1"
const maxFeeTinybar int64 = 100_000_000

var accountPattern = regexp.MustCompile(`^0\.0\.[1-9][0-9]*$`)
var transactionPattern = regexp.MustCompile(`^(0\.0\.[1-9][0-9]*)@([0-9]+)\.([0-9]{9})$`)

type topicRecord struct {
	Role               string `json:"role"`
	TransactionID      string `json:"transactionId,omitempty"`
	ReceiptStatus      string `json:"receiptStatus,omitempty"`
	TopicID            string `json:"topicId,omitempty"`
	ConsensusTimestamp string `json:"consensusTimestamp,omitempty"`
	ChargedFeeTinybar  int64  `json:"chargedFeeTinybar,omitempty"`
	MirrorConfirmed    bool   `json:"mirrorConfirmed"`
	MirrorResult       string `json:"mirrorResult,omitempty"`
}

type state struct {
	Version           int           `json:"version"`
	Network           string        `json:"network"`
	OperatorAccountID string        `json:"operatorAccountId"`
	OperatorPublicKey string        `json:"operatorPublicKey"`
	MaxFeeTinybar     int64         `json:"maxFeeTinybar"`
	Topics            []topicRecord `json:"topics"`
}

func owned(info os.FileInfo) bool {
	value, ok := info.Sys().(*syscall.Stat_t)
	return ok && value.Uid == uint32(os.Geteuid())
}

func privateFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("credential and state file paths must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || !owned(info) {
		return nil, errors.New("credential or state file must be an owner-owned regular 0600 file")
	}
	if info.Size() > 32*1024 {
		return nil, errors.New("credential or state file exceeds size limit")
	}
	return os.ReadFile(path)
}

func save(path string, value *state) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".topics-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func get(ctx context.Context, path string, out any) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mirror+path, nil)
	if err != nil {
		return false, err
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("Mirror returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(data) > 256*1024 {
		return false, errors.New("Mirror response unavailable or oversized")
	}
	return true, json.Unmarshal(data, out)
}

func memo(role string) string { return "Neuron reference testnet " + role + " topic" }

func verifyTopic(ctx context.Context, record *topicRecord, publicKey string) error {
	var topic struct {
		ID        string          `json:"topic_id"`
		Deleted   *bool           `json:"deleted"`
		Memo      string          `json:"memo"`
		SubmitKey json.RawMessage `json:"submit_key"`
		AdminKey  struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"admin_key"`
		CustomFees struct {
			FixedFees []json.RawMessage `json:"fixed_fees"`
		} `json:"custom_fees"`
	}
	found, err := get(ctx, "/topics/"+record.TopicID, &topic)
	if err != nil {
		return err
	}
	if !found || topic.ID != record.TopicID || topic.Deleted == nil || *topic.Deleted ||
		topic.Memo != memo(record.Role) || string(topic.SubmitKey) != "null" ||
		topic.AdminKey.Type != "ECDSA_SECP256K1" || !strings.EqualFold(topic.AdminKey.Key, publicKey) ||
		topic.CustomFees.FixedFees == nil || len(topic.CustomFees.FixedFees) != 0 {
		return errors.New("created topic metadata does not match open access, operator admin, role memo and no-fee policy")
	}
	return nil
}

func reconcile(ctx context.Context, record *topicRecord, operator, publicKey string) error {
	parts := transactionPattern.FindStringSubmatch(record.TransactionID)
	if parts == nil || parts[1] != operator {
		return errors.New("saved transaction is not owned by the configured operator")
	}
	id := parts[1] + "-" + parts[2] + "-" + parts[3]
	var lastErr error
	for {
		var response struct {
			Transactions []struct {
				ID        string `json:"transaction_id"`
				Name      string `json:"name"`
				Result    string `json:"result"`
				EntityID  string `json:"entity_id"`
				Memo      string `json:"memo_base64"`
				Consensus string `json:"consensus_timestamp"`
				Fee       int64  `json:"charged_tx_fee"`
				Scheduled bool   `json:"scheduled"`
				Nonce     int    `json:"nonce"`
			} `json:"transactions"`
		}
		found, err := get(ctx, "/transactions/"+id, &response)
		lastErr = err
		if err == nil && found {
			matches := 0
			for _, row := range response.Transactions {
				if row.ID != id || row.Scheduled || row.Nonce != 0 || row.Result == "DUPLICATE_TRANSACTION" {
					continue
				}
				matches++
				if row.Name != "CONSENSUSCREATETOPIC" || row.Result != "SUCCESS" ||
					!accountPattern.MatchString(row.EntityID) || row.Consensus == "" ||
					row.Fee < 0 || row.Fee > maxFeeTinybar {
					return fmt.Errorf("saved topic transaction has unexpected type, status, ID or fee (%s/%s); no replacement will be submitted", row.Name, row.Result)
				}
				decodedMemo, decodeErr := base64.StdEncoding.Strict().DecodeString(row.Memo)
				if decodeErr != nil || string(decodedMemo) != memo(record.Role) ||
					(record.TopicID != "" && record.TopicID != row.EntityID) {
					return errors.New("Mirror topic transaction does not match the saved role or receipt")
				}
				record.TopicID = row.EntityID
				record.ConsensusTimestamp = row.Consensus
				record.ChargedFeeTinybar = row.Fee
			}
			if matches > 1 {
				return errors.New("Mirror returned ambiguous topic creation records")
			}
			if matches == 1 {
				lastErr = verifyTopic(ctx, record, publicKey)
				if lastErr == nil {
					record.MirrorConfirmed = true
					record.MirrorResult = "SUCCESS"
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("topic transaction %s remains unresolved; retain this state and rerun to reconcile, never delete it to retry: %v", record.TransactionID, lastErr)
		case <-time.After(2 * time.Second):
		}
	}
}

func run() error {
	if os.Getenv("HEDERA_NETWORK") != "testnet" {
		return errors.New("HEDERA_NETWORK must explicitly be testnet")
	}
	operator := os.Getenv("HEDERA_OPERATOR_ACCOUNT_ID")
	if !accountPattern.MatchString(operator) {
		return errors.New("HEDERA_OPERATOR_ACCOUNT_ID must be numeric")
	}
	keyData, err := privateFile(os.Getenv("HEDERA_OPERATOR_KEY_FILE"))
	if err != nil {
		return err
	}
	key, err := hedera.PrivateKeyFromStringDer(strings.TrimSpace(string(keyData)))
	if err != nil || len(key.BytesRaw()) != 32 || len(key.PublicKey().BytesRaw()) != 33 {
		return errors.New("operator key must be ECDSA secp256k1 DER")
	}
	publicKey := key.PublicKey().StringRaw()
	dir := os.Getenv("NEURON_REFERENCE_STATE_DIR")
	info, err := os.Lstat(dir)
	if err != nil || !filepath.IsAbs(dir) || !info.IsDir() || info.Mode().Perm() != 0700 || !owned(info) {
		return errors.New("NEURON_REFERENCE_STATE_DIR must be a pre-existing owner-owned absolute 0700 directory")
	}
	lock, err := os.OpenFile(filepath.Join(dir, "setup.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	lockInfo, err := lock.Stat()
	if err != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm() != 0600 || !owned(lockInfo) {
		return errors.New("setup lock is not a private regular file")
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("another reference setup process owns this directory")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	path := filepath.Join(dir, "topics.json")
	s := state{Version: 1, Network: "testnet", OperatorAccountID: operator, OperatorPublicKey: publicKey,
		MaxFeeTinybar: maxFeeTinybar, Topics: []topicRecord{{Role: "buyer"}, {Role: "seller"}}}
	if _, err := os.Lstat(path); err == nil {
		data, err := privateFile(path)
		if err != nil {
			return err
		}
		var loaded state
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&loaded); err != nil {
			return errors.New("saved topic state is invalid")
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return errors.New("saved topic state contains trailing data")
		}
		s = loaded
	} else if !os.IsNotExist(err) {
		return err
	}
	if s.Version != 1 || s.Network != "testnet" || s.OperatorAccountID != operator ||
		s.OperatorPublicKey != publicKey || s.MaxFeeTinybar != maxFeeTinybar || len(s.Topics) != 2 ||
		s.Topics[0].Role != "buyer" || s.Topics[1].Role != "seller" {
		return errors.New("saved setup state belongs to another configuration")
	}
	if s.Topics[1].TransactionID != "" && (s.Topics[0].TransactionID == "" ||
		s.Topics[0].TransactionID == s.Topics[1].TransactionID) {
		return errors.New("saved setup transaction sequence is invalid")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	var account struct {
		ID      string `json:"account"`
		Deleted *bool  `json:"deleted"`
		Key     struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"key"`
	}
	found, err := get(ctx, "/accounts/"+operator, &account)
	cancel()
	if err != nil || !found || account.ID != operator || account.Deleted == nil || *account.Deleted ||
		account.Key.Type != "ECDSA_SECP256K1" || !strings.EqualFold(account.Key.Key, publicKey) {
		return errors.New("operator account/key does not match current testnet Mirror")
	}
	accountID, _ := hedera.AccountIDFromString(operator)
	client := hedera.ClientForTestnet()
	defer client.Close()
	client.SetOperator(accountID, key)
	client.SetMaxAttempts(1)
	client.SetRequestTimeout(20 * time.Second)
	for i := range s.Topics {
		record := &s.Topics[i]
		if record.TransactionID == "" {
			if record.TopicID != "" || record.MirrorConfirmed || record.ReceiptStatus != "" {
				return errors.New("saved topic record has no transaction identity")
			}
			txID := hedera.TransactionIDGenerate(accountID)
			record.TransactionID = txID.String()
			record.ReceiptStatus = "UNKNOWN"
			if err := save(path, &s); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Creating %s topic, saved transaction %s; fee ceiling %d tinybar\n", record.Role, record.TransactionID, maxFeeTinybar)
			response, executeErr := hedera.NewTopicCreateTransaction().SetAdminKey(key.PublicKey()).
				SetAutoRenewAccountID(accountID).SetTopicMemo(memo(record.Role)).SetTransactionMemo(memo(record.Role)).
				SetMaxTransactionFee(hedera.HbarFromTinybar(maxFeeTinybar)).SetTransactionID(txID).
				SetRegenerateTransactionID(false).Execute(client)
			if executeErr == nil && response.TransactionID.String() == record.TransactionID {
				receipt, receiptErr := response.GetReceipt(client)
				if receiptErr == nil {
					record.ReceiptStatus = receipt.Status.String()
					if receipt.Status == hedera.StatusSuccess && receipt.TopicID != nil {
						record.TopicID = receipt.TopicID.String()
					}
				}
			}
			if err := save(path, &s); err != nil {
				return err
			}
		}
		fmt.Fprintf(os.Stderr, "Reconciling saved %s topic transaction %s\n", record.Role, record.TransactionID)
		confirmCtx, confirmCancel := context.WithTimeout(context.Background(), 60*time.Second)
		err := reconcile(confirmCtx, record, operator, publicKey)
		confirmCancel()
		if err != nil {
			return err
		}
		if err := save(path, &s); err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(s)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
