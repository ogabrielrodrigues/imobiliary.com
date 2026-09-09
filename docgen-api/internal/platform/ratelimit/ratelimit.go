// Package ratelimit implements an in-memory token bucket limiter.
//
// It is deliberately process-local: the service is a single binary backed by an
// embedded database, so introducing a shared store such as Redis purely to
// count requests would add an infrastructure dependency that buys nothing at
// this scale.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

// bucket is one key's allowance. Tokens are refilled lazily on access rather
// than by a background ticker, so an idle key costs nothing.
type bucket struct {
	mu       sync.Mutex
	tokens   float64
	lastSeen time.Time
}

// Limiter hands out tokens per key at a fixed rate, up to a burst ceiling.
// It is safe for concurrent use.
type Limiter struct {
	rate  float64 // tokens per second
	burst float64
	now   func() time.Time

	buckets sync.Map // string -> *bucket

	stopOnce sync.Once
	stop     chan struct{}
}

// Option customises a Limiter.
type Option func(*Limiter)

// WithClock replaces the time source. Tests use it to advance time explicitly
// instead of sleeping.
func WithClock(now func() time.Time) Option {
	return func(l *Limiter) { l.now = now }
}

// New returns a limiter granting rate tokens per second per key, allowing a
// burst of at most burst requests. It starts a janitor goroutine that evicts
// idle keys; call Close to stop it.
func New(rate float64, burst int, opts ...Option) *Limiter {
	l := &Limiter{
		rate:  rate,
		burst: float64(burst),
		now:   time.Now,
		stop:  make(chan struct{}),
	}
	for _, opt := range opts {
		opt(l)
	}
	go l.janitor(idleEviction)
	return l
}

// idleEviction is how long a key must go untouched before its bucket is
// dropped. A dropped bucket is recreated full, which is harmless: a key idle
// this long would have refilled to the burst ceiling anyway.
const idleEviction = 10 * time.Minute

// Allow consumes one token for key. It reports whether the request may proceed
// and, when it may not, how long the caller should wait before retrying.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	return l.AllowN(key, 1)
}

// AllowN consumes n tokens, letting an expensive endpoint draw more of a
// client's allowance than a cheap one.
func (l *Limiter) AllowN(key string, n float64) (bool, time.Duration) {
	now := l.now()

	v, _ := l.buckets.LoadOrStore(key, &bucket{tokens: l.burst, lastSeen: now})
	b := v.(*bucket)

	b.mu.Lock()
	defer b.mu.Unlock()

	if elapsed := now.Sub(b.lastSeen); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed.Seconds()*l.rate)
	}
	b.lastSeen = now

	if b.tokens >= n {
		b.tokens -= n
		return true, 0
	}

	deficit := n - b.tokens
	return false, time.Duration(deficit / l.rate * float64(time.Second))
}

// Close stops the janitor. It is safe to call more than once.
func (l *Limiter) Close() {
	l.stopOnce.Do(func() { close(l.stop) })
}

func (l *Limiter) janitor(every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-ticker.C:
			l.evictIdle(every)
		}
	}
}

func (l *Limiter) evictIdle(olderThan time.Duration) {
	cutoff := l.now().Add(-olderThan)
	l.buckets.Range(func(key, value any) bool {
		b := value.(*bucket)
		b.mu.Lock()
		idle := b.lastSeen.Before(cutoff)
		b.mu.Unlock()
		if idle {
			l.buckets.Delete(key)
		}
		return true
	})
}
