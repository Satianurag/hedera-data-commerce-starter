package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

const maxSourceBytes = 4 << 20

var numericID = regexp.MustCompile(`^0\.0\.[1-9][0-9]*$`)
var addressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
var shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var hashPattern = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
var decimalPattern = regexp.MustCompile(`^[1-9][0-9]*$`)

// A single, operator-reviewed request is bound to a single funded escrow.
// The transport account and HCS payer can differ from the customer's wallet.
type config struct {
	Schema                  string `json:"schema"`
	Network                 string `json:"network"`
	SellerAccountID         string `json:"sellerAccountId"`
	SellerKeyFile           string `json:"sellerKeyFile"`
	SellerStdinTopicID      string `json:"sellerStdinTopicId"`
	BuyerTransportAccountID string `json:"buyerTransportAccountId"`
	BuyerStdinTopicID       string `json:"buyerStdinTopicId"`
	BuyerSharedAccountID    string `json:"buyerSharedAccountId"`
	PayerAccountID          string `json:"payerAccountId"`
	RequestSequence         uint64 `json:"requestSequence"`
	RequestSHA256           string `json:"requestSHA256"`
	BuyerWalletAddress      string `json:"buyerWalletAddress"`
	EscrowContractID        string `json:"escrowContractId"`
	EscrowContractAddress   string `json:"escrowContractAddress"`
	RuntimeSHA256           string `json:"runtimeSHA256"`
	FundingTransactionHash  string `json:"fundingTransactionHash"`
	EscrowID                string `json:"escrowId"`
	TermsHash               string `json:"termsHash"`
	AmountTinybar           string `json:"amountTinybar"`
	QuoteExpiresAt          int64  `json:"quoteExpiresAt"`
	RefundAfter             int64  `json:"refundAfter"`
	SourceFile              string `json:"sourceFile"`
	SourceSHA256            string `json:"sourceSHA256"`
	DurationSeconds         int    `json:"durationSeconds"`
	JournalFile             string `json:"journalFile"`
	// Only the exact loopback address is allowed by this development override.
	// It does not permit private networks, names, relay paths, or peer-ID changes.
	LoopbackTarget string `json:"loopbackTarget,omitempty"`
}

func strictJSON(data []byte, value any) error {
	if !utf8.Valid(data) {
		return errors.New("JSON must be valid UTF-8")
	}
	// encoding/json accepts duplicate names and case-insensitive field aliases.
	// Only the exact, explicitly tagged flat schemas in this command are valid.
	target := reflect.TypeOf(value)
	if target == nil || target.Kind() != reflect.Pointer || target.Elem().Kind() != reflect.Struct {
		return errors.New("strict JSON target must be a tagged struct pointer")
	}
	target = target.Elem()
	allowed := make(map[string]bool)
	required := make(map[string]bool)
	for index := 0; index < target.NumField(); index++ {
		tag := strings.Split(target.Field(index).Tag.Get("json"), ",")
		if tag[0] == "" || tag[0] == "-" {
			return errors.New("strict JSON schema requires explicit field names")
		}
		allowed[tag[0]] = true
		required[tag[0]] = !strings.Contains(target.Field(index).Tag.Get("json"), ",omitempty")
	}
	keys := json.NewDecoder(bytes.NewReader(data))
	first, err := keys.Token()
	if err != nil || first != json.Delim('{') {
		return errors.New("expected JSON object")
	}
	seen := make(map[string]bool)
	for keys.More() {
		key, err := keys.Token()
		if err != nil {
			return err
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return errors.New("duplicate JSON field")
		}
		if !allowed[name] {
			return errors.New("unsupported JSON field name or casing")
		}
		seen[name] = true
		var raw json.RawMessage
		if err = keys.Decode(&raw); err != nil {
			return err
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return errors.New("null JSON field is not supported")
		}
	}
	if _, err = keys.Token(); err != nil {
		return err
	}
	for name, mandatory := range required {
		if mandatory && !seen[name] {
			return errors.New("missing required JSON field")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON content")
	}
	return nil
}

func readFile(path string, max int64, private bool) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("file path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > max || (private && (info.Mode().Perm()&0077 != 0 || !ownedFile(info))) {
		return nil, errors.New("file must be regular, within its size bound, and owner-only when private")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || (private && (opened.Mode().Perm()&0077 != 0 || !ownedFile(opened))) {
		return nil, errors.New("file changed during open")
	}
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil || int64(len(data)) > max {
		return nil, errors.New("file exceeds size bound")
	}
	return data, nil
}

func ownedFile(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

func positiveUint(value string) (*big.Int, error) {
	if len(value) > 78 || !decimalPattern.MatchString(value) {
		return nil, errors.New("expected positive decimal uint256")
	}
	n, ok := new(big.Int).SetString(value, 10)
	if !ok || n.BitLen() > 256 {
		return nil, errors.New("integer exceeds uint256")
	}
	return n, nil
}

func (c config) validate() error {
	if c.Schema != "neuronNativeSeller/v1" || c.Network != "testnet" {
		return errors.New("native seller requires schema neuronNativeSeller/v1 on testnet")
	}
	for _, value := range []string{c.SellerAccountID, c.SellerStdinTopicID, c.BuyerTransportAccountID, c.BuyerStdinTopicID, c.BuyerSharedAccountID, c.PayerAccountID, c.EscrowContractID} {
		if !numericID.MatchString(value) {
			return errors.New("invalid numeric Hedera ID")
		}
		if _, err := strconv.ParseUint(value[4:], 10, 64); err != nil {
			return errors.New("Hedera entity number exceeds uint64")
		}
	}
	if c.SellerAccountID == c.BuyerTransportAccountID || c.RequestSequence == 0 {
		return errors.New("distinct seller/buyer and exact request sequence required")
	}
	for _, value := range []string{c.RequestSHA256, c.RuntimeSHA256, c.SourceSHA256} {
		if !shaPattern.MatchString(value) {
			return errors.New("invalid lowercase SHA-256")
		}
	}
	for _, value := range []string{c.TermsHash, c.FundingTransactionHash} {
		if !hashPattern.MatchString(value) || value == "0x"+strings.Repeat("0", 64) {
			return errors.New("invalid transaction or terms hash")
		}
	}
	for _, value := range []string{c.BuyerWalletAddress, c.EscrowContractAddress} {
		if !addressPattern.MatchString(value) || value == "0x"+strings.Repeat("0", 40) {
			return errors.New("invalid lowercase EVM address")
		}
	}
	for _, value := range []string{c.EscrowID, c.AmountTinybar} {
		if _, err := positiveUint(value); err != nil {
			return err
		}
	}
	if c.QuoteExpiresAt < 1 || c.RefundAfter <= c.QuoteExpiresAt || c.DurationSeconds < 1 || c.DurationSeconds > 120 {
		return errors.New("invalid quote deadline or delivery duration (1–120 seconds)")
	}
	for _, path := range []string{c.SellerKeyFile, c.SourceFile, c.JournalFile} {
		if !filepath.IsAbs(path) {
			return errors.New("key, source, and journal paths must be absolute")
		}
	}
	if c.LoopbackTarget != "" {
		if _, err := targetAddress(c.LoopbackTarget, c.LoopbackTarget); err != nil {
			return fmt.Errorf("invalid loopback target: %w", err)
		}
	}
	return nil
}

func loadConfig(path string) (config, error) {
	var c config
	data, err := readFile(path, 16<<10, true)
	if err != nil {
		return c, err
	}
	if err = strictJSON(data, &c); err != nil {
		return c, err
	}
	return c, c.validate()
}
