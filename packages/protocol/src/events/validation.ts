import type { ClawzEvent } from "./event-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClawzEvent(value: unknown): value is ClawzEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.occurredAtIso === "string" &&
    isRecord(value.payload)
  );
}

export function assertClawzEvent(value: unknown): ClawzEvent {
  if (!isClawzEvent(value)) {
    throw new Error("Invalid ClawZ event payload.");
  }

  return value;
}
