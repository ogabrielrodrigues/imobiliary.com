package usecase

import (
	"context"
	"fmt"
	"slices"
	"uuid"

	"imobiliary/internal/domain"
)

// Anonymisation at the end of the legal retention (PLANO-PENDENCIAS.md §4).
// The platform suggests; the office, the controller of this data, confirms
// each person. Nothing is anonymised on its own.
//
// A person is suggested when they own no property, are party to no contract
// still running, have nothing waiting for a payout, had some link to the
// office, and their last contract end, ledger line and payout are all past the
// tax retention. Someone linked as a spouse or a representative to a person
// who is not suggested stays too: that other record still needs them.

// RetentionCandidate is a person the database finds past the retention,
// before the links between people are considered.
type RetentionCandidate struct {
	ID           uuid.UUID
	Name         string
	Kind         domain.PersonKind
	LastActivity domain.Date
}

// PersonEdge is a link between two people: a marriage, or a company and its
// representative.
type PersonEdge struct{ A, B uuid.UUID }

// PartyContract is a contract and every person party to it.
type PartyContract struct {
	ID       uuid.UUID
	Registry string
	Parties  []uuid.UUID
}

// AnonymizationCandidate is a person the office may anonymise, with what the
// confirmation screen needs to clear the documents generated about them.
type AnonymizationCandidate struct {
	Person         PersonLink
	LastActivity   domain.Date
	RetentionEnded domain.Date
	Contracts      []CandidateContract
	Payouts        []CandidatePayout
}

// CandidateContract is a contract the person was party to. Its documents in
// the document service carry every party's name, so they can go only when
// every other party is anonymised too, or is being.
type CandidateContract struct {
	ID             uuid.UUID
	Registry       string
	DocumentsCanGo bool
}

// CandidatePayout is a payout made to the person.
type CandidatePayout struct {
	ID     uuid.UUID
	Number string
}

// keepLinked removes, until nothing changes, every candidate linked to a
// person who is not one: a spouse or a representative whose record another
// still needs.
func keepLinked(candidates map[uuid.UUID]bool, edges []PersonEdge) {
	for changed := true; changed; {
		changed = false
		for _, e := range edges {
			for _, pair := range [][2]uuid.UUID{{e.A, e.B}, {e.B, e.A}} {
				if candidates[pair[0]] && !candidates[pair[1]] {
					delete(candidates, pair[0])
					changed = true
				}
			}
		}
	}
}

func (p *People) candidates(ctx context.Context, repos ScopedRepositories) ([]AnonymizationCandidate, error) {
	today := domain.DateOf(p.now(), p.location)
	found, err := repos.People.RetentionCandidates(ctx, today)
	if err != nil {
		return nil, err
	}
	set := map[uuid.UUID]bool{}
	for _, c := range found {
		if domain.PastRetention(c.LastActivity, today) {
			set[c.ID] = true
		}
	}
	edges, err := repos.People.Edges(ctx)
	if err != nil {
		return nil, err
	}
	keepLinked(set, edges)

	ids := make([]uuid.UUID, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	contracts, err := repos.People.PartyContracts(ctx, ids)
	if err != nil {
		return nil, err
	}

	var out []AnonymizationCandidate
	for _, c := range found {
		if !set[c.ID] {
			continue
		}
		candidate := AnonymizationCandidate{
			Person:       PersonLink{ID: c.ID, Name: c.Name, Kind: c.Kind},
			LastActivity: c.LastActivity, RetentionEnded: domain.RetentionEnds(c.LastActivity),
			Contracts: []CandidateContract{}, Payouts: []CandidatePayout{},
		}
		for _, k := range contracts {
			if !slices.Contains(k.Parties, c.ID) {
				continue
			}
			canGo := !slices.ContainsFunc(k.Parties, func(id uuid.UUID) bool { return !set[id] })
			candidate.Contracts = append(candidate.Contracts, CandidateContract{ID: k.ID, Registry: k.Registry, DocumentsCanGo: canGo})
		}
		payouts, err := repos.Ledger.Payouts(ctx, PayoutQuery{PersonID: &c.ID, Limit: 1000})
		if err != nil {
			return nil, err
		}
		for _, po := range payouts {
			candidate.Payouts = append(candidate.Payouts, CandidatePayout{ID: po.ID, Number: po.Number()})
		}
		out = append(out, candidate)
	}
	return out, nil
}

// AnonymizationCandidates lists who is past the retention. Every member may
// see it; only an administrator confirms.
func (p *People) AnonymizationCandidates(ctx context.Context, caller *Caller) ([]AnonymizationCandidate, error) {
	var out []AnonymizationCandidate
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		out, err = p.candidates(ctx, repos)
		return err
	})
	return out, err
}

// Anonymize replaces what identifies a person who is still a candidate:
// the name, the documents, the contacts, the addresses and the personal
// details go; the record stays, so contracts, rents and the ledger still
// point at it. Administrators only. Audited without values.
func (p *People) Anonymize(ctx context.Context, caller *Caller, id uuid.UUID) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("anonymize person: %w", domain.ErrPermissionDenied)
	}
	return p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if _, err := repos.People.Get(ctx, id); err != nil {
			return err
		}
		candidates, err := p.candidates(ctx, repos)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(candidates, func(c AnonymizationCandidate) bool { return c.Person.ID == id }) {
			v := &domain.ValidationError{}
			v.Add("person", "is not due for anonymization")
			return v
		}
		if err := repos.People.Anonymize(ctx, id, p.now().UTC()); err != nil {
			return err
		}
		return p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionPersonAnonymized, EntityType: "person", EntityID: &id,
		})
	})
}
