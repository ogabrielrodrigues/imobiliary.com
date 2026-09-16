package usecase

import (
	"context"
	"log/slog"
	"net/netip"
	"uuid"

	"imobiliary/internal/domain"
)

// RequestInfo is what the transport knows about a request and the use cases
// need for their records: which request it was, and where it came from.
//
// It travels in the context rather than through every signature, because
// almost every use case needs it for one line of audit and none of them make a
// decision with it.
type RequestInfo struct {
	RequestID string
	IP        *netip.Addr
	Port      int
}

type requestInfoKey struct{}

// WithRequestInfo attaches the request's identity to a context.
func WithRequestInfo(ctx context.Context, info RequestInfo) context.Context {
	return context.WithValue(ctx, requestInfoKey{}, info)
}

// RequestInfoFrom reads it back, empty outside a request.
func RequestInfoFrom(ctx context.Context) RequestInfo {
	info, _ := ctx.Value(requestInfoKey{}).(RequestInfo)
	return info
}

// AuditEntry is one thing worth remembering.
type AuditEntry struct {
	OrganizationID *uuid.UUID
	ActorID        *uuid.UUID
	Action         domain.AuditAction
	EntityType     string
	EntityID       *uuid.UUID
	// Fields names what changed, never the values.
	Fields []string
}

// Auditor writes the trail and the access records.
type Auditor struct {
	repo   AuditRepository
	now    Clock
	logger *slog.Logger
}

// NewAuditor builds an auditor over a repository.
func NewAuditor(repo AuditRepository, now Clock, logger *slog.Logger) *Auditor {
	return &Auditor{repo: repo, now: now, logger: logger}
}

// Record appends to the trail outside a transaction. Use recordWith inside
// one: a change and its record belong to the same commit.
func (a *Auditor) Record(ctx context.Context, entry AuditEntry) error {
	return a.recordWith(ctx, a.repo, entry)
}

func (a *Auditor) recordWith(ctx context.Context, repo AuditRepository, entry AuditEntry) error {
	info := RequestInfoFrom(ctx)
	return repo.Record(ctx, &domain.AuditEvent{
		ID:             uuid.NewV7(),
		OrganizationID: entry.OrganizationID,
		ActorID:        entry.ActorID,
		Action:         entry.Action,
		EntityType:     entry.EntityType,
		EntityID:       entry.EntityID,
		Fields:         entry.Fields,
		RequestID:      info.RequestID,
		IP:             info.IP,
		OccurredAt:     a.now().UTC(),
	})
}

// Access writes the record the Marco Civil asks for.
//
// A failure is logged and not returned: the record is an obligation of the
// provider, not a condition of the person's sign-in, and refusing to let
// someone in because a log row could not be written would be the wrong trade.
// The failure is loud in the operational log, where it is somebody's problem.
func (a *Auditor) Access(ctx context.Context, userID *uuid.UUID, event domain.AccessEvent) {
	info := RequestInfoFrom(ctx)
	err := a.repo.RecordAccess(ctx, &domain.AccessRecord{
		ID:         uuid.NewV7(),
		UserID:     userID,
		Event:      event,
		IP:         info.IP,
		Port:       info.Port,
		OccurredAt: a.now().UTC(),
	})
	if err != nil {
		a.logger.Error("could not write the access record required by the Marco Civil",
			slog.Any("error", err), slog.String("request_id", info.RequestID))
	}
}
