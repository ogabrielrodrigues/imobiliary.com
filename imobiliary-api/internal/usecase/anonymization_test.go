package usecase

import (
	"testing"
	"uuid"
)

func TestKeepLinkedRemovesWhoAnotherStillNeeds(t *testing.T) {
	a, b, c, d, e := uuid.NewV7(), uuid.NewV7(), uuid.NewV7(), uuid.NewV7(), uuid.NewV7()
	// a is married to b, who is not a candidate; c represents company d, both
	// candidates; e represents d too, and is not one, so d goes, and then c.
	set := map[uuid.UUID]bool{a: true, c: true, d: true}
	keepLinked(set, []PersonEdge{{A: a, B: b}, {A: d, B: c}, {A: d, B: e}})
	if len(set) != 0 {
		t.Errorf("left %v", set)
	}

	// Two candidates linked only to each other both stay.
	set = map[uuid.UUID]bool{a: true, b: true}
	keepLinked(set, []PersonEdge{{A: a, B: b}})
	if !set[a] || !set[b] {
		t.Errorf("a married couple both past retention was split: %v", set)
	}
}
