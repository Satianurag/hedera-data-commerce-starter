package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

const maxJournalBytes = 64 << 20

var connectionIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

type sessionEvent struct {
	Event         string `json:"event"`
	ConnectionID  string `json:"connectionId"`
	SellerAccount string `json:"sellerAccount"`
	InstanceID    string `json:"instanceId"`
	At            string `json:"at"`
	Bytes         uint64 `json:"bytes"`
}

// The gateway has one browser subscriber. This journal records its connection
// lifecycle durably; it does not establish an authenticated customer identity.
type sessionJournal struct {
	mu            sync.Mutex
	file          *os.File
	sellerAccount string
	instanceID    string
	active        map[string]bool
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
	j := &sessionJournal{file: file, sellerAccount: sellerAccount, instanceID: instanceID, active: make(map[string]bool)}
	if _, err := file.Seek(0, 0); err != nil {
		return closeOnError(err)
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4096)
	for scanner.Scan() {
		var event sessionEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil ||
			event.SellerAccount != sellerAccount || !connectionIDPattern.MatchString(event.ConnectionID) ||
			!connectionIDPattern.MatchString(event.InstanceID) || event.At == "" {
			return closeOnError(errors.New("session journal has an invalid record or seller mismatch"))
		}
		if _, err := time.Parse(time.RFC3339Nano, event.At); err != nil {
			return closeOnError(errors.New("session journal has an invalid timestamp"))
		}
		switch event.Event {
		case "opened":
			if j.active[event.ConnectionID] || event.Bytes != 0 {
				return closeOnError(errors.New("session journal has a duplicate connection"))
			}
			j.active[event.ConnectionID] = true
		case "closed", "interrupted":
			if !j.active[event.ConnectionID] {
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
	for id := range j.active {
		if err := j.record("interrupted", id, 0); err != nil {
			return closeOnError(fmt.Errorf("cannot reconcile interrupted session: %w", err))
		}
	}
	return j, nil
}

func (j *sessionJournal) record(event, id string, bytes uint64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !connectionIDPattern.MatchString(id) {
		return errors.New("invalid connection ID")
	}
	if event == "opened" {
		if j.active[id] || bytes != 0 {
			return errors.New("connection is already open")
		}
	} else if event != "closed" && event != "interrupted" || !j.active[id] {
		return errors.New("connection is not open")
	}
	line, err := json.Marshal(sessionEvent{event, id, j.sellerAccount, j.instanceID, time.Now().UTC().Format(time.RFC3339Nano), bytes})
	if err != nil {
		return err
	}
	if _, err := j.file.Write(append(line, '\n')); err != nil {
		return err
	}
	if err := j.file.Sync(); err != nil {
		return err
	}
	if event == "opened" {
		j.active[id] = true
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
