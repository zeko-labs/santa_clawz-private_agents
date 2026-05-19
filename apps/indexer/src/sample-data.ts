import type { ClawzEvent } from "@clawz/protocol";

export const sampleEvents: ClawzEvent[] = [
  {
    id: "evt_001",
    type: "SessionCreated",
    occurredAtIso: "2026-04-19T08:00:00.000Z",
    payload: {
      sessionId: "session_demo_enterprise",
      tenantId: "tenant_acme",
      trustMode: "private"
    }
  },
  {
    id: "evt_002",
    type: "TurnBegan",
    occurredAtIso: "2026-04-19T08:01:00.000Z",
    payload: {
      turnId: "turn_0011",
      sessionId: "session_demo_enterprise",
      workerId: "worker_alpha"
    }
  },
  {
    id: "evt_003",
    type: "PrivacyExceptionRequested",
    occurredAtIso: "2026-04-19T08:01:06.000Z",
    payload: {
      exceptionId: "privacy_exception_001",
      turnId: "turn_0011",
      summary: "Reveal one artifact to compliance reviewer for 24h"
    }
  },
  {
    id: "evt_004",
    type: "PrivacyExceptionGranted",
    occurredAtIso: "2026-04-19T08:01:22.000Z",
    payload: {
      exceptionId: "privacy_exception_001",
      audience: "compliance-reviewer"
    }
  },
  {
    id: "evt_005",
    type: "ToolBatchCommitted",
    occurredAtIso: "2026-04-19T08:01:35.000Z",
    payload: {
      turnId: "turn_0011",
      toolReceiptRoot: "tool_receipt_root_hash_v1"
    }
  },
  {
    id: "evt_006",
    type: "OutputCommitted",
    occurredAtIso: "2026-04-19T08:01:39.000Z",
    payload: {
      turnId: "turn_0011",
      outputRoot: "output_root_hash_v1",
      originProofRoot: "origin_proof_root_hash_v1"
    }
  },
  {
    id: "evt_007",
    type: "TurnSettled",
    occurredAtIso: "2026-04-19T08:01:41.000Z",
    payload: {
      turnId: "turn_0011",
      reservedMina: "0.25",
      spentMina: "0.13",
      refundedMina: "0.12"
    }
  },
  {
    id: "evt_008",
    type: "TurnFinalized",
    occurredAtIso: "2026-04-19T08:01:43.000Z",
    payload: {
      turnId: "turn_0011",
      finalTurnRoot: "final_turn_root_hash_v1"
    }
  }
];
