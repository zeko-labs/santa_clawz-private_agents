import type { PrivacyExceptionQueueItem } from "@clawz/protocol";

interface PrivacyExceptionsQueueProps {
  items: readonly PrivacyExceptionQueueItem[];
  onApprove: (exceptionId: string) => void;
  pendingId?: string;
}

export function PrivacyExceptionsQueue({ items, onApprove, pendingId }: PrivacyExceptionsQueueProps) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Scoped Disclosure</p>
          <h2>Privacy Exceptions</h2>
        </div>
        <span className="subtle-pill">Separate from run approvals</span>
      </div>

      <div className="exception-list">
        {items.map((item) => (
          <article key={item.id} className="exception-card">
            <div className="exception-head">
              <strong>{item.title}</strong>
              <span className={`severity severity-${item.severity}`}>{item.severity}</span>
            </div>
            <p>{item.reason}</p>
            <dl className="exception-meta">
              <div>
                <dt>Audience</dt>
                <dd>{item.audience}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{item.duration}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{item.scope}</dd>
              </div>
            </dl>
            <div className="exception-footer">
              <span className="subtle-pill">
                {item.status} • {item.approvals.length}/{item.requiredApprovals} approvals
              </span>
              {item.status === "pending" ? (
                <button
                  className="action-button"
                  onClick={() => onApprove(item.id)}
                  disabled={pendingId === item.id}
                >
                  {pendingId === item.id ? "Approving..." : "Approve"}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
