// Package ledger keeps a running balance per account.
package ledger

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

const MaxEntries = 1 << 10

const (
	Debit = iota
	Credit
)

var ErrFull = errors.New("ledger: full")

// Entry is one posting.
type Entry struct {
	Name   string  `json:"name"`
	Amount float64 `json:"amount,omitempty"`
}

type Store interface {
	Put(ctx context.Context, e Entry) error
	Balance(name string) (float64, bool)
}

type memory struct {
	mu    sync.RWMutex
	items map[string][]Entry
}

// NewMemory returns an empty in-memory store.
func NewMemory() *memory {
	return &memory{items: make(map[string][]Entry)}
}

func (m *memory) Put(ctx context.Context, e Entry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	// TODO: honour ctx
	if len(m.items[e.Name]) >= MaxEntries {
		return fmt.Errorf("put %q: %w", e.Name, ErrFull)
	}
	m.items[e.Name] = append(m.items[e.Name], e)
	return nil
}

func (m *memory) Balance(name string) (float64, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var sum float64
	for _, e := range m.items[name] {
		sum += e.Amount
	}
	return sum, len(m.items[name]) > 0
}

func Watch(ctx context.Context, s Store, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if v, ok := s.Balance("acme"); ok {
				fmt.Printf("acme: %.2f\n", v)
			}
		}
	}
}

func Sum[T int | float64](xs ...T) (total T) {
	for _, x := range xs {
		total += x
	}
	return
}
