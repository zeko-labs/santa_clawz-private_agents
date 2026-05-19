import type { GhostRunPlan } from "@clawz/protocol";

interface GhostRunCardProps {
  plan: GhostRunPlan;
  sessionEventCount: number;
}

export function GhostRunCard({ plan, sessionEventCount }: GhostRunCardProps) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Preflight</p>
          <h2>Ghost Run</h2>
        </div>
        <span className="subtle-pill">No execution yet</span>
      </div>

      <ul className="clean-list">
        {plan.steps.map((step) => (
          <li key={step.id}>
            {step.summary}
            {step.externalHost ? ` (${step.externalHost})` : ""}
          </li>
        ))}
      </ul>

      <div className="ghost-summary">
        <div>
          <span>Estimated spend</span>
          <strong>{plan.estimatedSpendMina} MINA</strong>
        </div>
        <div>
          <span>Privacy exceptions</span>
          <strong>{plan.privacyExceptionsRequired ? "Approval required" : "None predicted"}</strong>
        </div>
        <div>
          <span>Visibility</span>
          <strong>{plan.visibilitySummary.join(" / ")}</strong>
        </div>
        <div>
          <span>Session events</span>
          <strong>{sessionEventCount}</strong>
        </div>
      </div>
    </section>
  );
}
