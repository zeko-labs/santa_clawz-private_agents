import { useDeferredValue, useMemo, useState } from "react";

import type { TimeMachineEntry } from "@clawz/protocol";

interface TimeMachinePanelProps {
  entries: TimeMachineEntry[];
}

export function TimeMachinePanel({ entries }: TimeMachinePanelProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const filteredEntries = useMemo(() => {
    const term = deferredQuery.trim().toLowerCase();
    if (!term) {
      return entries;
    }

    return entries.filter((entry) =>
      `${entry.label} ${entry.outcome} ${entry.note}`.toLowerCase().includes(term)
    );
  }, [deferredQuery, entries]);

  return (
    <section className="panel wide-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Replay</p>
          <h2>Time Machine</h2>
        </div>
        <input
          className="search"
          value={query}
          onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
          placeholder="Filter by turn, outcome, or note"
        />
      </div>

      <div className="timeline">
        {filteredEntries.map((entry) => (
          <article key={entry.id} className="timeline-item">
            <div className="timeline-badge">{entry.label}</div>
            <div>
              <strong>{entry.outcome}</strong>
              <p>{entry.note}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
