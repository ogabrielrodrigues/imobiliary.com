package usecase

import (
	"container/list"
	"sync"
	"uuid"

	"docgen/internal/adapter/docx"
)

// TemplateCache keeps compiled templates in memory, keyed by template version.
//
// Caching is safe precisely because a version is immutable: the bytes behind a
// version identifier never change, so an entry can never go stale. Without the
// cache, every generation would re-read the archive from disk and re-parse its
// XML; with it, rendering is a template execution and a ZIP rewrite.
//
// Eviction is least-recently-used and bounded by entry count rather than by
// bytes, which is a deliberate simplification: uploads are already capped, so
// entry count is a reasonable proxy for memory.
type TemplateCache struct {
	mu       sync.Mutex
	capacity int
	entries  map[uuid.UUID]*list.Element
	order    *list.List // front is most recently used
}

// cacheEntry is what the LRU list holds.
type cacheEntry struct {
	key      uuid.UUID
	template *docx.Template
}

// NewTemplateCache returns a cache holding at most capacity templates.
func NewTemplateCache(capacity int) *TemplateCache {
	if capacity < 1 {
		capacity = 1
	}
	return &TemplateCache{
		capacity: capacity,
		entries:  make(map[uuid.UUID]*list.Element, capacity),
		order:    list.New(),
	}
}

// Get returns the cached template for a version, if present.
func (c *TemplateCache) Get(versionID uuid.UUID) (*docx.Template, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	element, ok := c.entries[versionID]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(element)
	return element.Value.(*cacheEntry).template, true
}

// Put stores a compiled template, evicting the least recently used entry when
// the cache is full.
func (c *TemplateCache) Put(versionID uuid.UUID, t *docx.Template) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if element, ok := c.entries[versionID]; ok {
		c.order.MoveToFront(element)
		element.Value.(*cacheEntry).template = t
		return
	}

	c.entries[versionID] = c.order.PushFront(&cacheEntry{key: versionID, template: t})

	if c.order.Len() > c.capacity {
		oldest := c.order.Back()
		if oldest != nil {
			c.order.Remove(oldest)
			delete(c.entries, oldest.Value.(*cacheEntry).key)
		}
	}
}

// Len reports how many templates are cached. It exists for tests and metrics.
func (c *TemplateCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}
