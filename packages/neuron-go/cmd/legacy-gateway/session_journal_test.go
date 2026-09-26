package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const testInstanceOne = "0123456789abcdef0123456789abcdef"
const testInstanceTwo = "fedcba9876543210fedcba9876543210"
const testConnection = "00112233445566778899aabbccddeeff"
const testOwner = "0x1234567890123456789012345678901234567890"
const testSession = "abcdefabcdefabcdefabcdefabcdefab"

func readJournalEvents(t *testing.T, path string) []sessionEvent {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var events []sessionEvent
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var event sessionEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

func TestJournalRecoversInterruptedSessionAfterRestart(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sessions.ndjson")
	first, err := openSessionJournal(path, "0.0.4318411", testInstanceOne)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.record("opened", testConnection, 0); err != nil {
		t.Fatal(err)
	}
	if competing, err := openSessionJournal(path, "0.0.4318411", testInstanceTwo); err == nil {
		_ = competing.Close()
		t.Fatal("second process acquired the active session journal")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := openSessionJournal(path, "0.0.4318411", testInstanceTwo)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.active) != 0 {
		t.Fatal("interrupted browser remained active after restart")
	}
	if err := second.record("opened", testConnection, 0); err != nil {
		t.Fatal(err)
	}
	if err := second.record("closed", testConnection, 9876); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	events := readJournalEvents(t, path)
	if len(events) != 4 || events[0].Event != "opened" || events[1].Event != "interrupted" ||
		events[1].InstanceID != testInstanceTwo || events[2].Event != "opened" ||
		events[3].Event != "closed" || events[3].Bytes != 9876 {
		t.Fatalf("unexpected durable session lifecycle: %+v", events)
	}
}

func TestJournalFailsClosedForPermissionsSellerAndCorruption(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sessions.ndjson")
	if err := os.WriteFile(path, []byte("invalid\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if journal, err := openSessionJournal(path, "0.0.4318411", testInstanceOne); err == nil {
		_ = journal.Close()
		t.Fatal("corrupt journal accepted")
	}
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if journal, err := openSessionJournal(path, "0.0.4318411", testInstanceOne); err == nil {
		_ = journal.Close()
		t.Fatal("world-readable journal accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	journal, err := openSessionJournal(path, "0.0.4318411", testInstanceOne)
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.record("opened", testConnection, 0); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	if other, err := openSessionJournal(path, "0.0.6340259", testInstanceTwo); err == nil {
		_ = other.Close()
		t.Fatal("journal was reused for another seller")
	}
}

func TestJournalPreservesCustomerBindingAndRejectsChangedOwner(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sessions.ndjson")
	first, err := openSessionJournal(path, "0.0.4318411", testInstanceOne)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.recordOwned("opened", testConnection, 0, testOwner, testSession); err != nil {
		t.Fatal(err)
	}
	if err := first.recordOwned("closed", testConnection, 5, "", ""); err == nil {
		t.Fatal("customer-owned connection closed without owner binding")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := openSessionJournal(path, "0.0.4318411", testInstanceTwo)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	events := readJournalEvents(t, path)
	if len(events) != 2 || events[0].OwnerAddress != testOwner || events[0].SessionID != testSession ||
		events[1].Event != "interrupted" || events[1].OwnerAddress != testOwner || events[1].SessionID != testSession {
		t.Fatalf("customer identity was lost during restart recovery: %+v", events)
	}
}
