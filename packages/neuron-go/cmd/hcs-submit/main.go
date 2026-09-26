package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	hedera "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

const chunkSize = 1024
const maxChunks = 8
const maxMessageBytes = chunkSize * maxChunks

var hederaID = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

type config struct {
	network, mirror, account, topic string
	key                             hedera.PrivateKey
	maxFee                          hedera.Hbar
	openTopic                       bool
}

func chunkCount(size int) (int, error) {
	if size < 1 || size > maxMessageBytes {
		return 0, fmt.Errorf("stdin must contain 1 to %d message bytes", maxMessageBytes)
	}
	return (size + chunkSize - 1) / chunkSize, nil
}

func fromEnv() (config, error) {
	c := config{network: os.Getenv("HEDERA_NETWORK"), account: os.Getenv("HEDERA_OPERATOR_ACCOUNT_ID"), topic: os.Getenv("HEDERA_TOPIC_ID")}
	switch c.network {
	case "testnet":
		c.mirror = "https://testnet.mirrornode.hedera.com"
	case "mainnet":
		if os.Getenv("HEDERA_ALLOW_MAINNET_WRITES") != "true" {
			return c, errors.New("mainnet writes require HEDERA_ALLOW_MAINNET_WRITES=true")
		}
		c.mirror = "https://mainnet.mirrornode.hedera.com"
	default:
		return c, errors.New("HEDERA_NETWORK must be explicitly set to testnet or mainnet")
	}
	if !hederaID.MatchString(c.account) || !hederaID.MatchString(c.topic) {
		return c, errors.New("operator account and topic must be numeric Hedera IDs")
	}
	switch os.Getenv("HEDERA_TOPIC_ACCESS") {
	case "", "controlled":
	case "open":
		c.openTopic = true
	default:
		return c, errors.New("HEDERA_TOPIC_ACCESS must be controlled or open")
	}
	keyPath := os.Getenv("HEDERA_OPERATOR_KEY_FILE")
	keyInfo, err := os.Stat(keyPath)
	if err != nil || !keyInfo.Mode().IsRegular() || keyInfo.Mode().Perm()&0077 != 0 {
		return c, errors.New("HEDERA_OPERATOR_KEY_FILE must name a private file readable only by its owner")
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return c, errors.New("cannot read HEDERA_OPERATOR_KEY_FILE")
	}
	c.key, err = hedera.PrivateKeyFromStringDer(strings.TrimSpace(string(keyBytes)))
	if err != nil {
		return c, errors.New("HEDERA_OPERATOR_KEY_FILE contains an invalid DER private key")
	}
	fee, err := strconv.ParseInt(os.Getenv("HEDERA_MAX_FEE_TINYBAR"), 10, 64)
	if err != nil || fee <= 0 {
		return c, errors.New("HEDERA_MAX_FEE_TINYBAR must be a positive integer")
	}
	c.maxFee = hedera.HbarFromTinybar(fee)
	return c, nil
}

func getJSON(ctx context.Context, url string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Mirror returned HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(target)
}

func checkResources(ctx context.Context, c config) error {
	var account struct {
		ID      string `json:"account"`
		Deleted *bool  `json:"deleted"`
		Key     *struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"key"`
	}
	if err := getJSON(ctx, c.mirror+"/api/v1/accounts/"+c.account, &account); err != nil {
		return err
	}
	publicKey := c.key.PublicKey().StringRaw()
	if account.ID != c.account || account.Deleted == nil || *account.Deleted ||
		account.Key == nil || account.Key.Type == "" || !strings.EqualFold(account.Key.Key, publicKey) {
		return errors.New("operator key does not match an active account on the selected network")
	}
	var topic struct {
		ID        string `json:"topic_id"`
		Deleted   *bool  `json:"deleted"`
		SubmitKey *struct {
			Type string `json:"_type"`
			Key  string `json:"key"`
		} `json:"submit_key"`
		CustomFees struct {
			FixedFees []json.RawMessage `json:"fixed_fees"`
		} `json:"custom_fees"`
	}
	if err := getJSON(ctx, c.mirror+"/api/v1/topics/"+c.topic, &topic); err != nil {
		return err
	}
	if topic.ID != c.topic || topic.Deleted == nil || *topic.Deleted ||
		topic.CustomFees.FixedFees == nil || len(topic.CustomFees.FixedFees) != 0 {
		return errors.New("topic is missing, deleted or charges custom fees")
	}
	if c.openTopic {
		if topic.SubmitKey != nil {
			return errors.New("requested open topic has a submit key")
		}
	} else if topic.SubmitKey == nil || topic.SubmitKey.Type == "" || !strings.EqualFold(topic.SubmitKey.Key, publicKey) {
		return errors.New("topic submit key is not controlled by the operator")
	}
	return nil
}

type mirrorMessage struct {
	TopicID        string `json:"topic_id"`
	PayerAccountID string `json:"payer_account_id"`
	Message        string `json:"message"`
	ConsensusTime  string `json:"consensus_timestamp"`
	SequenceNumber int64  `json:"sequence_number"`
	ChunkInfo      *struct {
		InitialTransactionID struct {
			AccountID             string `json:"account_id"`
			TransactionValidStart string `json:"transaction_valid_start"`
			Nonce                 int    `json:"nonce"`
			Scheduled             bool   `json:"scheduled"`
		} `json:"initial_transaction_id"`
		Number int `json:"number"`
		Total  int `json:"total"`
	} `json:"chunk_info"`
}

func matchMirrorRows(c config, transactionID hedera.TransactionID, payload []byte, rows []mirrorMessage) (mirrorMessage, bool, bool, error) {
	if transactionID.AccountID == nil || transactionID.ValidStart == nil || transactionID.AccountID.String() != c.account {
		return mirrorMessage{}, false, false, errors.New("transaction ID does not match the configured operator")
	}
	count, err := chunkCount(len(payload))
	if err != nil {
		return mirrorMessage{}, false, false, err
	}
	validStart := fmt.Sprintf("%d.%09d", transactionID.ValidStart.Unix(), transactionID.ValidStart.Nanosecond())
	chunks := make(map[int]mirrorMessage, count)
	for _, row := range rows {
		info := row.ChunkInfo
		if info == nil || info.InitialTransactionID.AccountID != c.account ||
			info.InitialTransactionID.TransactionValidStart != validStart ||
			info.InitialTransactionID.Nonce != 0 || info.InitialTransactionID.Scheduled {
			continue
		}
		if info.Total != count || info.Number < 1 || info.Number > count ||
			row.TopicID != c.topic || row.PayerAccountID != c.account ||
			row.SequenceNumber < 1 || row.ConsensusTime == "" {
			return mirrorMessage{}, false, true, errors.New("Mirror indexed the transaction with mismatched chunk evidence")
		}
		if _, duplicate := chunks[info.Number]; duplicate {
			return mirrorMessage{}, false, true, errors.New("Mirror returned a duplicate selected chunk")
		}
		decoded, decodeErr := base64.StdEncoding.Strict().DecodeString(row.Message)
		start := (info.Number - 1) * chunkSize
		end := start + chunkSize
		if end > len(payload) {
			end = len(payload)
		}
		if decodeErr != nil || !bytes.Equal(decoded, payload[start:end]) {
			return mirrorMessage{}, false, true, errors.New("Mirror indexed the transaction with mismatched message bytes")
		}
		chunks[info.Number] = row
	}
	if len(chunks) < count {
		return mirrorMessage{}, false, len(chunks) > 0, nil
	}
	for number := 2; number <= count; number++ {
		if chunks[number].SequenceNumber <= chunks[number-1].SequenceNumber {
			return mirrorMessage{}, false, true, errors.New("Mirror chunk sequence is out of order")
		}
	}
	return chunks[count], true, true, nil
}

func findMirrorMessage(ctx context.Context, c config, transactionID hedera.TransactionID, payload []byte) (mirrorMessage, error) {
	if transactionID.AccountID == nil || transactionID.ValidStart == nil || transactionID.AccountID.String() != c.account {
		return mirrorMessage{}, errors.New("transaction ID does not match the configured operator")
	}
	partialSeen := false
	for {
		pageURL := c.mirror + "/api/v1/topics/" + c.topic + "/messages?limit=25&order=desc"
		rows := make([]mirrorMessage, 0, 125)
		for pageNumber := 0; pageNumber < 5; pageNumber++ {
			var page struct {
				Messages []mirrorMessage `json:"messages"`
				Links    struct {
					Next string `json:"next"`
				} `json:"links"`
			}
			if err := getJSON(ctx, pageURL, &page); err != nil {
				break
			}
			if len(page.Messages) > 25 {
				return mirrorMessage{}, errors.New("Mirror returned an oversized message page")
			}
			rows = append(rows, page.Messages...)
			matched, complete, partial, matchErr := matchMirrorRows(c, transactionID, payload, rows)
			if matchErr != nil {
				return mirrorMessage{}, matchErr
			}
			partialSeen = partialSeen || partial
			if complete {
				return matched, nil
			}
			if page.Links.Next == "" {
				break
			}
			next, err := url.Parse(page.Links.Next)
			if err != nil {
				return mirrorMessage{}, errors.New("Mirror returned an invalid pagination link")
			}
			resolved := (&url.URL{Scheme: "https", Host: strings.TrimPrefix(c.mirror, "https://")}).ResolveReference(next)
			if resolved.Scheme != "https" || "https://"+resolved.Host != c.mirror ||
				resolved.Path != "/api/v1/topics/"+c.topic+"/messages" {
				return mirrorMessage{}, errors.New("Mirror pagination escaped the selected topic")
			}
			pageURL = resolved.String()
		}
		if ctx.Err() != nil {
			if partialSeen {
				return mirrorMessage{}, errors.New("Mirror confirmation timed out with partial chunks; reconcile every chunk before any retry")
			}
			return mirrorMessage{}, errors.New("Mirror confirmation timed out; retain the consensus transaction ID for reconciliation")
		}
		select {
		case <-ctx.Done():
			if partialSeen {
				return mirrorMessage{}, errors.New("Mirror confirmation timed out with partial chunks; reconcile every chunk before any retry")
			}
			return mirrorMessage{}, errors.New("Mirror confirmation timed out; retain the consensus transaction ID for reconciliation")
		case <-time.After(2 * time.Second):
		}
	}
}

func run() error {
	c, err := fromEnv()
	if err != nil {
		return err
	}
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxMessageBytes+1))
	if err != nil {
		return fmt.Errorf("cannot read stdin: %w", err)
	}
	count, err := chunkCount(len(payload))
	if err != nil {
		return err
	}
	perChunkFee := c.maxFee.AsTinybar() / int64(count)
	if perChunkFee < 1 {
		return errors.New("HEDERA_MAX_FEE_TINYBAR is too small for the number of chunks")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := checkResources(ctx, c); err != nil {
		return fmt.Errorf("network resource preflight: %w", err)
	}
	accountID, _ := hedera.AccountIDFromString(c.account)
	topicID, _ := hedera.TopicIDFromString(c.topic)
	var client *hedera.Client
	if c.network == "testnet" {
		client = hedera.ClientForTestnet()
	} else {
		client = hedera.ClientForMainnet()
	}
	defer client.Close()
	client.SetOperator(accountID, c.key)
	transactionID := hedera.TransactionIDGenerate(accountID)
	digest := sha256.Sum256(payload)
	// Dividing the configured amount gives a nominal sum of per-chunk fee
	// ceilings for one attempt per chunk. The SDK may retry a known throttled
	// transaction internally, so this is not a hard aggregate spend cap.
	fmt.Fprintf(os.Stderr, "submitting HCS transaction %s, %d chunk(s), SHA-256 %x; nominal sum of per-chunk fee ceilings %d tinybar (%d each); reconcile this ID and every chunk before any retry if the outcome is uncertain\n", transactionID, count, digest, perChunkFee*int64(count), perChunkFee)
	responses, err := hedera.NewTopicMessageSubmitTransaction().
		SetTopicID(topicID).
		SetMessage(payload).
		SetChunkSize(chunkSize).
		SetMaxChunks(maxChunks).
		SetMaxTransactionFee(hedera.HbarFromTinybar(perChunkFee)).
		SetTransactionID(transactionID).
		ExecuteAll(client)
	receiptStatus := "UNKNOWN"
	executeErr := err
	for number, response := range responses {
		if response.TransactionID.AccountID != nil && response.TransactionID.ValidStart != nil {
			fmt.Fprintf(os.Stderr, "HCS chunk %d transaction response: %s\n", number+1, response.TransactionID)
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "chunk submission returned an error for %s; checking Mirror before reporting the outcome: %v\n", transactionID, err)
	} else {
		if len(responses) != count || responses[0].TransactionID.String() != transactionID.String() {
			executeErr = errors.New("SDK returned a different initial transaction ID or chunk count")
			fmt.Fprintf(os.Stderr, "chunk response identity changed for %s; checking Mirror before reporting the outcome\n", transactionID)
		} else {
			// ExecuteAll checks each chunk's receipt before returning success.
			receiptStatus = "SUCCESS"
			fmt.Fprintf(os.Stderr, "consensus SUCCESS for %s across %d chunk(s); awaiting Mirror confirmation\n", transactionID, count)
		}
	}
	confirmCtx, confirmCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer confirmCancel()
	message, err := findMirrorMessage(confirmCtx, c, transactionID, payload)
	if err != nil {
		if executeErr != nil {
			return fmt.Errorf("HCS outcome unresolved for %s; reconcile this ID before retrying: submission/receipt error: %v; Mirror: %w", transactionID, executeErr, err)
		}
		return fmt.Errorf("transaction %s: %w", transactionID, err)
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Network            string `json:"network"`
		TopicID            string `json:"topicId"`
		PayerAccountID     string `json:"payerAccountId"`
		TransactionID      string `json:"transactionId"`
		ReceiptStatus      string `json:"receiptStatus"`
		ConsensusTimestamp string `json:"consensusTimestamp"`
		SHA256             string `json:"sha256"`
		SequenceNumber     int64  `json:"sequenceNumber"`
		ChunkCount         int    `json:"chunkCount"`
	}{c.network, c.topic, c.account, transactionID.String(), receiptStatus, message.ConsensusTime, hex.EncodeToString(digest[:]), message.SequenceNumber, count})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
