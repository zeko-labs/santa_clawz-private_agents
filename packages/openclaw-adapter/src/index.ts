import {
  buildSantaClawzCompletedReturn,
  normalizeSantaClawzCompletedReturn,
  santaClawzReturnDigest,
  type BuildSantaClawzCompletedReturnInput,
  type PrivacyProvingLocation
} from "@clawz/protocol";

export interface OpenClawSessionReference {
  sessionId: string;
  gatewayBaseUrl: string;
  mcpBaseUrl?: string;
  sessionToolName?: string;
}

export interface SantaClawzOpenClawBinding {
  runtime: "openclaw";
  sessionId: string;
  lineageId: string;
  verifierBaseUrl: string;
  provingLocation: PrivacyProvingLocation;
  endpoints: {
    discovery: string;
    proofBundle: string;
    verify: string;
    mcp: string;
  };
}

export interface OpenClawInstallPlan {
  runtimePackage: "openclaw";
  adapterPackage: "@clawz/openclaw-adapter";
  docs: {
    install: string;
    sessions: string;
    sessionTool: string;
    mcp: string;
    gatewayProtocol: string;
  };
  steps: string[];
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildOpenClawLineageId(sessionId: string): string {
  return `openclaw:${sessionId}`;
}

export function buildSantaClawzOpenClawBinding(input: {
  openClaw: OpenClawSessionReference;
  verifierBaseUrl: string;
  provingLocation?: PrivacyProvingLocation;
}): SantaClawzOpenClawBinding {
  const verifierBaseUrl = normalizeBaseUrl(input.verifierBaseUrl);
  return {
    runtime: "openclaw",
    sessionId: input.openClaw.sessionId,
    lineageId: buildOpenClawLineageId(input.openClaw.sessionId),
    verifierBaseUrl,
    provingLocation: input.provingLocation ?? "client",
    endpoints: {
      discovery: `${verifierBaseUrl}/.well-known/agent-interop.json?sessionId=${encodeURIComponent(input.openClaw.sessionId)}`,
      proofBundle: `${verifierBaseUrl}/api/interop/agent-proof?sessionId=${encodeURIComponent(input.openClaw.sessionId)}`,
      verify: `${verifierBaseUrl}/api/interop/verify?sessionId=${encodeURIComponent(input.openClaw.sessionId)}`,
      mcp: `${verifierBaseUrl}/mcp`
    }
  };
}

export function buildOpenClawInstallPlan(): OpenClawInstallPlan {
  return {
    runtimePackage: "openclaw",
    adapterPackage: "@clawz/openclaw-adapter",
    docs: {
      install: "https://docs.openclaw.ai/install",
      sessions: "https://docs.openclaw.ai/sessions",
      sessionTool: "https://docs.openclaw.ai/concepts/session-tool",
      mcp: "https://docs.openclaw.ai/cli/mcp",
      gatewayProtocol: "https://docs.openclaw.ai/gateway/protocol"
    },
    steps: [
      "Install or keep the existing OpenClaw runtime.",
      "Add @clawz/openclaw-adapter to the same workspace as the OpenClaw agent.",
      "Point the OpenClaw runtime at the SantaClawz indexer, privacy gateway, and verifier surface.",
      "Map each OpenClaw session id to a SantaClawz lineage id and publish the proof endpoints.",
      "Choose the proving location: client, server, or sovereign-rollup."
    ]
  };
}

export function buildOpenClawSantaClawzCompletedReturn(input: BuildSantaClawzCompletedReturnInput) {
  return buildSantaClawzCompletedReturn(input);
}

export function normalizeOpenClawSantaClawzCompletedReturn(
  value: unknown,
  fallback: { requestId: string; inputDigestSha256: string }
) {
  return normalizeSantaClawzCompletedReturn(value, fallback);
}

export function digestOpenClawSantaClawzReturn(value: unknown) {
  return santaClawzReturnDigest(value);
}
