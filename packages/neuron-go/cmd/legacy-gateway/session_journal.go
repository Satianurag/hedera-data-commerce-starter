package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

const maxJournalBytes = 64 << 20
const maxTransportEvidenceConnections = 32

var connectionIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var ownerAddressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)

type sessionIdentity struct {
	ownerAddress string
	sessionID    string
}

func validSessionIdentity(identity sessionIdentity) bool {
	return identity.ownerAddress == "" && identity.sessionID == "" ||
		ownerAddressPattern.MatchString(identity.ownerAddress) && connectionIDPattern.MatchString(identity.sessionID)
}

type sessionEvent struct {
	Event         string `json:"event"`
	ConnectionID  string `json:"connectionId"`
	SellerAccount string `json:"sellerAccount"`
	InstanceID    string `json:"instanceId"`
	At            string `json:"at"`
	Bytes         uint64 `json:"bytes"`
	OwnerAddress  string `json:"ownerAddress,omitempty"`
	SessionID     string `json:"customerSessionId,omitempty"`
}

// The gateway has one browser subscriber. Version 2 tickets carry a customer
// identity authenticated by the app; this journal preserves that binding.
type sessionJournal struct {
	mu            sync.Mutex
	file          *os.File
	sellerAccount string
	instanceID    string
	active        map[string]sessionIdentity
}

// transportConnection records a completed server WebSocket write interval.
// It does not establish that a browser consumed or understood the bytes.
type transportConnection struct {
	OpenedAt     string `json:"openedAt"`
	ClosedAt     string `json:"closedAt"`
	WrittenBytes uint64 `json:"writtenBytes"`
}

type transportEvidence struct {
	Network                string                `json:"network"`
	SellerAccount          string                `json:"sellerAccount"`
	SellerPublicKey        string                `json:"sellerPublicKey"`
	OwnerAddress           string                `json:"ownerAddress"`
	CustomerSessionID      string                `json:"customerSessionId"`
	TransportEvidenceOnly  bool                  `json:"transportEvidenceOnly"`
	ClosedConnections      uint64                `json:"closedConnections"`
	InterruptedConnections uint64                `json:"interruptedConnections"`
	OpenConnections        uint64                `json:"openConnections"`
	TotalWrittenBytes      uint64                `json:"totalWrittenBytes"`
	Truncated              bool                  `json:"truncated"`
	Connections            []transportConnection `json:"connections"`
}

// summarize reads a bounded, locked snapshot of the durable journal. An
// interrupted connection has an unknown byte count and is never included in
// the completed-write total. Only exact owner/session matches are returned.
func (j *sessionJournal) summarize(ownerAddress, sessionID string) (transportEvidence, error) {
	identity := sessionIdentity{ownerAddress, sessionID}
	if !ownerAddressPattern.MatchString(ownerAddress) || !connectionIDPattern.MatchString(sessionID) ||
		!validSessionIdentity(identity) {
		return transportEvidence{}, errors.New("invalid customer identity")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	info, err := j.file.Stat()
	if err != nil || info.Size() < 0 || info.Size() > maxJournalBytes {
		return transportEvidence{}, errors.New("session journal is unavailable or exceeds its read bound")
	}
	result := transportEvidence{Network: "testnet", SellerAccount: j.sellerAccount,
		OwnerAddress: ownerAddress, CustomerSessionID: sessionID, TransportEvidenceOnly: true,
		Connections: make([]transportConnection, 0)}
	opened := make(map[string]sessionEvent)
	scanner := bufio.NewScanner(io.NewSectionReader(j.file, 0, info.Size()))
	scanner.Buffer(make([]byte, 4096), 4096)
	for scanner.Scan() {
		var event sessionEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil ||
			event.SellerAccount != j.sellerAccount || !connectionIDPattern.MatchString(event.ConnectionID) ||
			!connectionIDPattern.MatchString(event.InstanceID) || !validSessionIdentity(sessionIdentity{event.OwnerAddress, event.SessionID}) {
			return transportEvidence{}, errors.New("session journal has an invalid record")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.At); err != nil {
			return transportEvidence{}, errors.New("session journal has an invalid timestamp")
		}
		switch event.Event {
		case "opened":
			if _, exists := opened[event.ConnectionID]; exists || event.Bytes != 0 {
				return transportEvidence{}, errors.New("session journal has a duplicate connection")
			}
			opened[event.ConnectionID] = event
		case "closed", "interrupted":
			started, exists := opened[event.ConnectionID]
			if !exists || started.OwnerAddress != event.OwnerAddress || started.SessionID != event.SessionID {
				return transportEvidence{}, errors.New("session journal has an unmatched close")
			}
			delete(opened, event.ConnectionID)
			if event.OwnerAddress != ownerAddress || event.SessionID != sessionID {
				continue
			}
			if event.Event == "interrupted" {
				result.InterruptedConnections++
				continue
			}
			if ^uint64(0)-result.TotalWrittenBytes < event.Bytes {
				return transportEvidence{}, errors.New("session journal byte total overflows")
			}
			result.ClosedConnections++
			result.TotalWrittenBytes += event.Bytes
			if len(result.Connections) < maxTransportEvidenceConnections {
				result.Connections = append(result.Connections, transportConnection{
					OpenedAt: started.At, ClosedAt: event.At, WrittenBytes: event.Bytes})
			} else {
				result.Truncated = true
			}
		default:
			return transportEvidence{}, errors.New("session journal has an unknown event")
		}
	}
	if err := scanner.Err(); err != nil {
		return transportEvidence{}, err
	}
	for _, event := range opened {
		if event.OwnerAddress == ownerAddress && event.SessionID == sessionID {
			result.OpenConnections++
		}
	}
	return result, nil
}

func openSessionJournal(path, sellerAccount, instanceID string) (*sessionJournal, error) {
	if !filepath.IsAbs(path) || !connectionIDPattern.MatchString(instanceID) {
		return nil, errors.New("session journal requires an absolute path and gateway instance ID")
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil || !parent.IsDir() || parent.Mode().Perm()&0077 != 0 {
		return nil, errors.New("session journal directory must be owner-only")
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return nil, errors.New("session journal must be an owner-only regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	closeOnError := func(err error) (*sessionJournal, error) { _ = file.Close(); return nil, err }
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return closeOnError(errors.New("session journal is already owned by another gateway process"))
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return closeOnError(errors.New("session journal must be an owner-only regular file"))
	}
	if info.Size() > maxJournalBytes {
		return closeOnError(errors.New("session journal exceeds the 64 MiB recovery bound"))
	}
	j := &sessionJournal{file: file, sellerAccount: sellerAccount, instanceID: instanceID, active: make(map[string]sessionIdentity)}
	if _, err := file.Seek(0, 0); err != nil {
		return closeOnError(err)
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4096)
	for scanner.Scan() {
		var event sessionEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return closeOnError(errors.New("session journal has an invalid record"))
		}
		identity := sessionIdentity{event.OwnerAddress, event.SessionID}
		if event.SellerAccount != sellerAccount || !connectionIDPattern.MatchString(event.ConnectionID) ||
			!connectionIDPattern.MatchString(event.InstanceID) || event.At == "" || !validSessionIdentity(identity) {
			return closeOnError(errors.New("session journal has an invalid record or seller mismatch"))
		}
		if _, err := time.Parse(time.RFC3339Nano, event.At); err != nil {
			return closeOnError(errors.New("session journal has an invalid timestamp"))
		}
		switch event.Event {
		case "opened":
			if _, exists := j.active[event.ConnectionID]; exists || event.Bytes != 0 {
				return closeOnError(errors.New("session journal has a duplicate connection"))
			}
			j.active[event.ConnectionID] = identity
		case "closed", "interrupted":
			if prior, exists := j.active[event.ConnectionID]; !exists || prior != identity {
				return closeOnError(errors.New("session journal has a terminal record without an open connection"))
			}
			delete(j.active, event.ConnectionID)
		default:
			return closeOnError(errors.New("session journal has an unknown event"))
		}
	}
	if err := scanner.Err(); err != nil {
		return closeOnError(err)
	}
	if _, err := file.Seek(0, 2); err != nil {
		return closeOnError(err)
	}
	for id, identity := range j.active {
		if err := j.recordOwned("interrupted", id, 0, identity.ownerAddress, identity.sessionID); err != nil {
			return closeOnError(fmt.Errorf("cannot reconcile interrupted session: %w", err))
		}
	}
	return j, nil
}

func (j *sessionJournal) record(event, id string, bytes uint64) error {
	return j.recordOwned(event, id, bytes, "", "")
}

func (j *sessionJournal) recordOwned(event, id string, bytes uint64, ownerAddress, sessionID string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	identity := sessionIdentity{ownerAddress, sessionID}
	if !connectionIDPattern.MatchString(id) || !validSessionIdentity(identity) {
		return errors.New("invalid connection or customer identity")
	}
	if event == "opened" {
		if _, exists := j.active[id]; exists || bytes != 0 {
			return errors.New("connection is already open")
		}
	} else if prior, exists := j.active[id]; event != "closed" && event != "interrupted" || !exists || prior != identity {
		return errors.New("connection is not open")
	}
	line, err := json.Marshal(sessionEvent{Event: event, ConnectionID: id, SellerAccount: j.sellerAccount,
		InstanceID: j.instanceID, At: time.Now().UTC().Format(time.RFC3339Nano), Bytes: bytes,
		OwnerAddress: ownerAddress, SessionID: sessionID})
	if err != nil {
		return err
	}
	info, err := j.file.Stat()
	if err != nil || info.Size() < 0 || info.Size()+int64(len(line))+1 > maxJournalBytes {
		return errors.New("session journal has reached its 64 MiB write bound")
	}
	if _, err := j.file.Write(append(line, '\n')); err != nil {
		return err
	}
	if err := j.file.Sync(); err != nil {
		return err
	}
	if event == "opened" {
		j.active[id] = identity
	} else {
		delete(j.active, id)
	}
	return nil
}

func (j *sessionJournal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.file.Close()
}
