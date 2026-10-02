package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/neuron-sdk/neuron-go-sdk/internal/topic"
)

// RawMessage is for the public API only. MarshalIndent reformats RawMessage;
// []byte in the durable format is base64 and preserves every signed byte.
type journalMessage struct {
	hcsMessage
	Payload  []byte `json:"payload"`
	Envelope []byte `json:"envelope"`
}
type sessionJournal struct {
	*session
	JournalVersion int              `json:"journalVersion"`
	Messages       []journalMessage `json:"messages"`
}

func journalFor(v *session) sessionJournal {
	messages := make([]journalMessage, len(v.Messages))
	for i, m := range v.Messages {
		messages[i] = journalMessage{m, m.Payload, m.Envelope}
	}
	return sessionJournal{v, 2, messages}
}

func validateSignedMessage(m *hcsMessage) error {
	digest := sha256.Sum256(m.Envelope)
	if hex.EncodeToString(digest[:]) != m.SHA256 {
		return errors.New("signed envelope SHA256 mismatch")
	}
	signed, err := topic.TopicMessageFromJSON(m.Envelope)
	if err != nil {
		return err
	}
	if err = topic.ValidateTopicMessage(signed); err != nil {
		return err
	}
	if signed.SenderAddress() != m.SenderAddress || !bytes.Equal(signed.Payload(), m.Payload) {
		return errors.New("signed sender/payload mismatch")
	}
	return nil
}

func decodeJournal(raw []byte, v *session) (bool, error) {
	var header struct {
		JournalVersion int `json:"journalVersion"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return false, err
	}
	switch header.JournalVersion {
	case 0:
		if err := json.Unmarshal(raw, v); err != nil {
			return false, err
		}
		for i := range v.Messages {
			m := &v.Messages[i]
			// Only undo the old writer's indentation. The original digest must match;
			// no re-signing, re-hashing or blind JSON semantic equivalence is allowed.
			var compact bytes.Buffer
			if err := json.Compact(&compact, m.Envelope); err != nil {
				return false, err
			}
			m.Envelope = append([]byte(nil), compact.Bytes()...)
			signed, err := topic.TopicMessageFromJSON(m.Envelope)
			if err != nil {
				return false, err
			}
			var storedPayload, signedPayload bytes.Buffer
			if err = json.Compact(&storedPayload, m.Payload); err != nil {
				return false, err
			}
			rewritten, err := json.Marshal(json.RawMessage(signed.Payload()))
			if err != nil {
				return false, err
			}
			if err = json.Compact(&signedPayload, rewritten); err != nil {
				return false, err
			}
			if !bytes.Equal(storedPayload.Bytes(), signedPayload.Bytes()) {
				return false, errors.New("legacy payload differs from signed payload")
			}
			m.Payload = signed.Payload()
		}
	case 2:
		disk := sessionJournal{session: v}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&disk); err != nil {
			return false, err
		}
		v.Messages = make([]hcsMessage, len(disk.Messages))
		for i, m := range disk.Messages {
			v.Messages[i] = m.hcsMessage
			v.Messages[i].Payload, v.Messages[i].Envelope = m.Payload, m.Envelope
		}
	default:
		return false, errors.New("unsupported session journal version")
	}
	for i := range v.Messages {
		if err := validateSignedMessage(&v.Messages[i]); err != nil {
			return false, fmt.Errorf("message %d: %w", i, err)
		}
	}
	return header.JournalVersion == 0, nil
}

func migrateJournal(path string, original []byte, v *session) error {
	// Keep the exact pre-migration bytes in an owner-only durable backup. A
	// crash before replacement can safely retry only with that same original.
	backup := path + ".v1.bak"
	old, err := privateFile(backup)
	if err == nil {
		if !bytes.Equal(old, original) {
			return errors.New("legacy migration backup mismatch")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err = writeAtomicBytes(backup, original); err != nil {
		return err
	}
	return writeAtomic(path, journalFor(v))
}
