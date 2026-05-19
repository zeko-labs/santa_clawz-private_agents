import type { GhostRunPlan, TrustModeId } from "@clawz/protocol";

export function buildGhostRunPlan(mode: TrustModeId): GhostRunPlan {
  return {
    mode,
    estimatedSpendMina: mode === "team-governed" ? "0.25" : mode === "fast" ? "0.08" : mode === "verified" ? "0.25" : "0.18",
    steps: [
      {
        id: "shell_1",
        summary: "Run two sandboxed shell commands against the sealed workspace",
        capabilityClass: "shell-execution",
        requiresApproval: true,
        expandsVisibility: false
      },
      {
        id: "browser_1",
        summary: "Open one approved host in browser mode for citation extraction",
        capabilityClass: "browser-automation",
        externalHost: "docs.openclaw.ai",
        requiresApproval: mode !== "fast",
        expandsVisibility: false
      }
    ],
    visibilitySummary:
      mode === "fast"
        ? ["Workspace visible", "Approved provider path", "Short retention"]
        : mode === "team-governed"
          ? ["Workspace sealed", "Guardian approvals", "Scoped disclosure only"]
          : ["Operator blind", "Sealed local route", "Scoped disclosure only"],
    privacyExceptionsRequired: mode === "team-governed"
  };
}
