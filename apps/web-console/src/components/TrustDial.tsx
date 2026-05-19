import { startTransition } from "react";

import type { TrustModeCard, TrustModeId } from "@clawz/protocol";

interface TrustDialProps {
  modes: TrustModeCard[];
  activeMode: TrustModeId;
  onChange: (nextMode: TrustModeId) => void;
}

export function TrustDial({ modes, activeMode, onChange }: TrustDialProps) {
  const current = modes.find((mode) => mode.id === activeMode)!;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Execution Control</p>
          <h2>Trust Dial</h2>
        </div>
        <span className="proof-pill">{current.proofLevel}</span>
      </div>

      <div className="dial-row" role="tablist" aria-label="Trust mode">
        {modes.map((mode) => (
          <button
            key={mode.id}
            className={mode.id === activeMode ? "dial-chip active" : "dial-chip"}
            onClick={() => {
              startTransition(() => onChange(mode.id));
            }}
            role="tab"
            aria-selected={mode.id === activeMode}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <p className="panel-copy">{current.blurb}</p>

      <div className="dial-metrics">
        <div>
          <span>Operator visibility</span>
          <strong>{current.operatorVisible ? "Visible" : "Blind"}</strong>
        </div>
        <div>
          <span>Provider visibility</span>
          <strong>{current.providerVisible ? "Provider sees payload" : "Sealed local route"}</strong>
        </div>
        <div>
          <span>Spend ceiling</span>
          <strong>{current.maxSpendMina} MINA</strong>
        </div>
        <div>
          <span>Retention</span>
          <strong>{current.retention}</strong>
        </div>
      </div>
    </section>
  );
}
