import type { WrappedKeyRecord } from "../types.js";

export interface ScheduledRevocation {
  keyId: string;
  revokeAtIso: string;
}

export class KeyRevocationScheduler {
  private readonly schedule = new Map<string, ScheduledRevocation>();

  scheduleRevocation(record: WrappedKeyRecord, revokeAtIso: string) {
    this.schedule.set(record.keyId, {
      keyId: record.keyId,
      revokeAtIso
    });
  }

  due(nowIso: string): ScheduledRevocation[] {
    return [...this.schedule.values()].filter((entry) => entry.revokeAtIso <= nowIso);
  }
}
