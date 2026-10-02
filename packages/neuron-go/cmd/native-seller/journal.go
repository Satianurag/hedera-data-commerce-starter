package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type deliveryRecord struct {
	State           string `json:"state"`
	ConfigSHA256    string `json:"configSHA256"`
	RequestTopic    string `json:"requestTopic"`
	RequestSequence uint64 `json:"requestSequence"`
	RequestSHA256   string `json:"requestSHA256"`
	Contract        string `json:"contract"`
	EscrowID        string `json:"escrowId"`
	SourceSHA256    string `json:"sourceSHA256"`
	BytesWritten    int64  `json:"bytesWritten"`
	At              string `json:"at"`
	BlockNumber     string `json:"verifiedBlockNumber"`
}

type deliveryJournal struct {
	file   *os.File
	record deliveryRecord
}

// Claim precedes any network delivery. A crash therefore preserves an unknown
// attempt and never silently replays bytes. This bounded operator command has
// no automatic retry: reconcile a failed/unknown attempt before preparing a new
// service request. Changing or deleting the journal is not recovery.
func claimDelivery(c config, snapshot escrowSnapshot) (*deliveryJournal, error) {
	parent, err := os.Lstat(filepath.Dir(c.JournalFile))
	if err != nil || !parent.IsDir() || parent.Mode().Perm()&0077 != 0 || !ownedFile(parent) {
		return nil, errors.New("delivery journal needs an existing owner-only directory")
	}
	fd, err := syscall.Open(c.JournalFile, syscall.O_CREAT|syscall.O_RDWR|syscall.O_APPEND|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, errors.New("cannot open delivery journal")
	}
	file := os.NewFile(uintptr(fd), c.JournalFile)
	fail := func(e error) (*deliveryJournal, error) { _ = file.Close(); return nil, e }
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(errors.New("another seller process owns this delivery journal"))
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ownedFile(info) || info.Size() > 1<<20 {
		return fail(errors.New("invalid delivery journal permissions, type, or size"))
	}
	if info.Size() > 0 {
		last := make([]byte, 1)
		if _, err = file.ReadAt(last, info.Size()-1); err != nil || last[0] != '\n' {
			return fail(errors.New("delivery journal contains an incomplete write"))
		}
	}
	scanner := bufio.NewScanner(io.NewSectionReader(file, 0, info.Size()))
	scanner.Buffer(make([]byte, 4096), 4096)
	active := map[string]deliveryRecord{}
	for scanner.Scan() {
		var r deliveryRecord
		if err = strictJSON(scanner.Bytes(), &r); err != nil || !shaPattern.MatchString(r.ConfigSHA256) || !shaPattern.MatchString(r.RequestSHA256) || !shaPattern.MatchString(r.SourceSHA256) || r.RequestSequence == 0 || !numericID.MatchString(r.RequestTopic) || !addressPattern.MatchString(r.Contract) {
			return fail(errors.New("invalid delivery journal record"))
		}
		if _, err = positiveUint(r.EscrowID); err != nil {
			return fail(err)
		}
		if _, err = time.Parse(time.RFC3339Nano, r.At); err != nil {
			return fail(errors.New("invalid journal timestamp"))
		}
		if _, err = quantity(r.BlockNumber); err != nil {
			return fail(err)
		}
		if r.BytesWritten < 0 || r.BytesWritten > maxSourceBytes {
			return fail(errors.New("invalid journal byte count"))
		}
		prior, exists := active[r.ConfigSHA256]
		if r.State == "claimed" {
			if exists || r.BytesWritten != 0 {
				return fail(errors.New("duplicate journal claim"))
			}
			active[r.ConfigSHA256] = r
		} else if r.State == "completed" || r.State == "failed" {
			if !exists || prior.State != "claimed" || prior.RequestTopic != r.RequestTopic || prior.RequestSequence != r.RequestSequence || prior.Contract != r.Contract || prior.EscrowID != r.EscrowID || prior.SourceSHA256 != r.SourceSHA256 || prior.RequestSHA256 != r.RequestSHA256 || prior.BlockNumber != r.BlockNumber {
				return fail(errors.New("unmatched journal completion"))
			}
			active[r.ConfigSHA256] = r
		} else {
			return fail(errors.New("unknown delivery journal state"))
		}
		if (r.Contract == c.EscrowContractAddress && r.EscrowID == c.EscrowID) || (r.RequestTopic == c.SellerStdinTopicID && r.RequestSequence == c.RequestSequence) {
			return fail(errors.New("request or escrow has a prior delivery attempt; inspect its preserved journal before any operator recovery"))
		}
	}
	if err = scanner.Err(); err != nil {
		return fail(err)
	}
	configBytes, _ := json.Marshal(c)
	j := &deliveryJournal{file, deliveryRecord{State: "claimed", ConfigSHA256: digest(configBytes), RequestTopic: c.SellerStdinTopicID, RequestSequence: c.RequestSequence, RequestSHA256: c.RequestSHA256, Contract: c.EscrowContractAddress, EscrowID: c.EscrowID, SourceSHA256: c.SourceSHA256, At: time.Now().UTC().Format(time.RFC3339Nano), BlockNumber: snapshot.BlockNumber}}
	if err = j.append(j.record); err != nil {
		return fail(err)
	}
	dir, err := os.Open(filepath.Dir(c.JournalFile))
	if err != nil {
		return fail(err)
	}
	err = dir.Sync()
	_ = dir.Close()
	if err != nil {
		return fail(err)
	}
	return j, nil
}

func (j *deliveryJournal) append(record deliveryRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	info, err := j.file.Stat()
	if err != nil || info.Size()+int64(len(encoded))+1 > 1<<20 {
		return errors.New("delivery journal has reached its size limit")
	}
	data := append(encoded, '\n')
	n, err := j.file.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return j.file.Sync()
}

func (j *deliveryJournal) finish(success bool, written int64) error {
	if j.record.State != "claimed" || written < 0 || written > maxSourceBytes {
		return errors.New("invalid delivery journal completion")
	}
	r := j.record
	r.State = "failed"
	if success {
		r.State = "completed"
	}
	r.BytesWritten = written
	r.At = time.Now().UTC().Format(time.RFC3339Nano)
	if err := j.append(r); err != nil {
		return err
	}
	j.record = r
	return nil
}
