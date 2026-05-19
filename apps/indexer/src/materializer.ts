import type { ClawzEvent, TimeMachineEntry } from "@clawz/protocol";

export interface SessionView {
  sessionId: string;
  events: ClawzEvent[];
  turns: string[];
  privacyExceptions: string[];
}

export interface TurnReplay {
  turnId: string;
  timeline: ClawzEvent[];
}

export class ReplayMaterializer {
  constructor(private readonly events: ClawzEvent[]) {}

  listEvents(): ClawzEvent[] {
    return this.events;
  }

  getSession(sessionId: string): SessionView {
    const timeline = this.events.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.sessionId === sessionId;
    });

    return {
      sessionId,
      events: timeline,
      turns: [
        ...new Set(
          timeline
            .map((event) => (event.payload as Record<string, unknown>).turnId)
            .filter((turnId): turnId is string => typeof turnId === "string")
        )
      ],
      privacyExceptions: [
        ...new Set(
          timeline
            .map((event) => (event.payload as Record<string, unknown>).exceptionId)
            .filter((exceptionId): exceptionId is string => typeof exceptionId === "string")
        )
      ]
    };
  }

  getTurnReplay(turnId: string): TurnReplay {
    return {
      turnId,
      timeline: this.events.filter((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.turnId === turnId;
      })
    };
  }

  listPrivacyExceptions() {
    return this.events
      .filter(
        (event) => event.type === "PrivacyExceptionRequested" || event.type === "PrivacyExceptionGranted"
      )
      .map((event) => ({
        id: event.id,
        type: event.type,
        occurredAtIso: event.occurredAtIso,
        ...event.payload
      }));
  }

  buildTimeMachineEntries(): TimeMachineEntry[] {
    return [...this.events]
      .sort((left, right) => right.occurredAtIso.localeCompare(left.occurredAtIso))
      .map((event, index) => {
        const payload = event.payload as Record<string, unknown>;
        const turnId = typeof payload.turnId === "string" ? payload.turnId : `session_${index + 1}`;

        return {
          id: event.id,
          label: turnId.startsWith("turn_") ? `Turn ${turnId.replace("turn_", "")}` : `Checkpoint ${index + 1}`,
          outcome: event.type,
          note: Object.entries(payload)
            .slice(0, 3)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" • "),
          occurredAtIso: event.occurredAtIso
        };
      });
  }
}
