package ratelimit

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is a manually advanced time source. Driving the limiter with it
// keeps these tests instant and deterministic; sleeping for real would make
// them both slow and flaky.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestAllowSpendsBurstThenRefuses(t *testing.T) {
	clock := newFakeClock()
	limiter := New(1, 3, WithClock(clock.Now))
	defer limiter.Close()

	for i := range 3 {
		if allowed, _ := limiter.Allow("client"); !allowed {
			t.Fatalf("request %d was refused while burst was still available", i+1)
		}
	}

	allowed, retryAfter := limiter.Allow("client")
	if allowed {
		t.Fatal("a fourth request was allowed with an empty bucket")
	}
	if retryAfter <= 0 {
		t.Errorf("Retry-After hint = %v, want a positive duration", retryAfter)
	}
}

func TestAllowRefillsOverTime(t *testing.T) {
	clock := newFakeClock()
	limiter := New(2, 2, WithClock(clock.Now))
	defer limiter.Close()

	limiter.Allow("client")
	limiter.Allow("client")
	if allowed, _ := limiter.Allow("client"); allowed {
		t.Fatal("bucket was not exhausted as expected")
	}

	// At two tokens per second, half a second buys exactly one token.
	clock.Advance(500 * time.Millisecond)
	if allowed, _ := limiter.Allow("client"); !allowed {
		t.Error("request was refused after the bucket should have refilled by one token")
	}
	if allowed, _ := limiter.Allow("client"); allowed {
		t.Error("two tokens were granted where only one had been earned")
	}
}

func TestAllowNeverExceedsBurst(t *testing.T) {
	clock := newFakeClock()
	limiter := New(10, 2, WithClock(clock.Now))
	defer limiter.Close()

	// Idling for far longer than it takes to refill must not accumulate credit
	// beyond the ceiling.
	clock.Advance(time.Hour)

	for i := range 2 {
		if allowed, _ := limiter.Allow("client"); !allowed {
			t.Fatalf("request %d was refused with a full bucket", i+1)
		}
	}
	if allowed, _ := limiter.Allow("client"); allowed {
		t.Error("bucket held more than the burst ceiling after a long idle period")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	clock := newFakeClock()
	limiter := New(1, 1, WithClock(clock.Now))
	defer limiter.Close()

	if allowed, _ := limiter.Allow("first"); !allowed {
		t.Fatal("first client was refused its only token")
	}
	if allowed, _ := limiter.Allow("second"); !allowed {
		t.Error("second client was charged for the first client's usage")
	}
}

// TestAllowNChargesByCost covers the weighted variant used to make an expensive
// endpoint draw more of a client's allowance than a cheap one.
func TestAllowNChargesByCost(t *testing.T) {
	clock := newFakeClock()
	limiter := New(1, 10, WithClock(clock.Now))
	defer limiter.Close()

	if allowed, _ := limiter.AllowN("client", 8); !allowed {
		t.Fatal("a request costing 8 tokens was refused by a bucket of 10")
	}
	if allowed, _ := limiter.AllowN("client", 8); allowed {
		t.Error("a second request costing 8 tokens was allowed with only 2 left")
	}
	if allowed, _ := limiter.AllowN("client", 2); !allowed {
		t.Error("a request costing exactly the remaining tokens was refused")
	}
}

func TestEvictIdleDropsUntouchedKeys(t *testing.T) {
	clock := newFakeClock()
	limiter := New(1, 1, WithClock(clock.Now))
	defer limiter.Close()

	limiter.Allow("client")
	clock.Advance(2 * idleEviction)
	limiter.evictIdle(idleEviction)

	// The key was forgotten, so it starts again with a full bucket.
	if allowed, _ := limiter.Allow("client"); !allowed {
		t.Error("an evicted key did not start from a full bucket")
	}
}

// TestAllowIsSafeForConcurrentUse asserts the limiter never hands out more than
// the burst. Run under -race, it also covers the locking.
func TestAllowIsSafeForConcurrentUse(t *testing.T) {
	clock := newFakeClock()
	const burst = 50
	limiter := New(0, burst, WithClock(clock.Now))
	defer limiter.Close()

	var granted atomic.Int64
	var wg sync.WaitGroup

	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if allowed, _ := limiter.Allow("shared"); allowed {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := granted.Load(); got != burst {
		t.Errorf("granted %d requests, want exactly %d", got, burst)
	}
}

// TestLimiterSweepsIdleKeysUnderPressure covers the memory guard: once the
// map passes its ceiling, idle buckets go immediately instead of waiting
// out the janitor.
func TestLimiterSweepsIdleKeysUnderPressure(t *testing.T) {
	now := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	l := New(1, 1, WithClock(func() time.Time { return now }), WithMaxKeys(3))
	defer l.Close()

	for _, key := range []string{"a", "b", "c"} {
		l.Allow(key)
	}
	if got := l.keys.Load(); got != 3 {
		t.Fatalf("holding %d keys, want 3", got)
	}

	// The first three go idle; a fourth key tips the map over the ceiling.
	now = now.Add(2 * pressureEviction)
	l.Allow("d")

	if got := l.keys.Load(); got != 1 {
		t.Errorf("holding %d keys after the sweep, want only the fresh one", got)
	}
}
