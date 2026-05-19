import type { AgentFeePreview, AgentPaymentRail, AgentX402Plan } from "@clawz/protocol";

export const CLAWZ_PROTOCOL_OWNER_FEE_BPS_ENV = "CLAWZ_PROTOCOL_OWNER_FEE_BPS";
export const CLAWZ_PROTOCOL_FEE_DEFAULT_FLOOR_BPS = 0;
export const CLAWZ_DEPLOYER_FEE_MAX_BPS = 300;
export const CLAWZ_TOTAL_FEE_MAX_BPS = 400;

const USD_SCALE = 1_000_000n;

export interface ClawzDeployerFeeConfig {
  enabled: boolean;
  feeBps: number;
  label?: string;
  recipientByRail?: Partial<Record<AgentPaymentRail, string>>;
}

export interface ClawzFeeCompatibilityReport {
  protocolFeeFloorSatisfied: boolean;
  protocolFeeFloorBps: number;
  deployerFeeCapSatisfied: boolean;
  totalFeeCapSatisfied: boolean;
  compatible: boolean;
}

export interface ClawzFeeStackPreview extends AgentFeePreview {
  protocolFeeBps: number;
  deployerFeeBps: number;
  totalFeeBps: number;
  deployerFeeApplies: boolean;
  deployerFeeRecipient?: string;
  deployerFeeLabel?: string;
  totalFeeAmountUsd?: string;
  compatibility: ClawzFeeCompatibilityReport;
}

function normalizeFeeBps(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : 0;
}

function parseUsdAtomic(value: string | undefined): bigint | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) {
    return null;
  }

  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * USD_SCALE + BigInt(fraction || "0");
}

function formatUsdAtomic(value: bigint): string {
  const whole = value / USD_SCALE;
  const fraction = value % USD_SCALE;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

// Runtime protocol fee bps comes from x402 plan previews, which the indexer builds from
// CLAWZ_PROTOCOL_OWNER_FEE_BPS. SDK callers can pass a stricter floor for their own fork policy.
export function validateClawzFeeCompatibility(input: {
  protocolFeeBps: number;
  deployerFeeBps?: number;
  minimumProtocolFeeBps?: number;
}): ClawzFeeCompatibilityReport {
  const protocolFeeBps = normalizeFeeBps(input.protocolFeeBps);
  const deployerFeeBps = normalizeFeeBps(input.deployerFeeBps);
  const protocolFeeFloorBps = normalizeFeeBps(input.minimumProtocolFeeBps);
  const totalFeeBps = protocolFeeBps + deployerFeeBps;
  const protocolFeeFloorSatisfied = protocolFeeBps >= protocolFeeFloorBps;
  const deployerFeeCapSatisfied = deployerFeeBps <= CLAWZ_DEPLOYER_FEE_MAX_BPS;
  const totalFeeCapSatisfied = totalFeeBps <= CLAWZ_TOTAL_FEE_MAX_BPS;

  return {
    protocolFeeFloorSatisfied,
    protocolFeeFloorBps,
    deployerFeeCapSatisfied,
    totalFeeCapSatisfied,
    compatible: protocolFeeFloorSatisfied && deployerFeeCapSatisfied && totalFeeCapSatisfied
  };
}

export function buildClawzFeeStackPreview(input: {
  plan: Pick<AgentX402Plan, "protocolOwnerFeePolicy" | "feePreviewByRail">;
  deployerFee?: ClawzDeployerFeeConfig;
}): ClawzFeeStackPreview[] {
  const previews = input.plan.feePreviewByRail ?? [];
  const protocolFeeBps = normalizeFeeBps(input.plan.protocolOwnerFeePolicy?.feeBps);
  const deployerFeeEnabled = Boolean(input.deployerFee?.enabled);
  const deployerFeeBps = deployerFeeEnabled ? normalizeFeeBps(input.deployerFee?.feeBps) : 0;

  return previews.map((preview) => {
    const deployerFeeRecipient = input.deployerFee?.recipientByRail?.[preview.rail];
    const deployerFeeApplies = Boolean(deployerFeeEnabled && deployerFeeBps > 0 && deployerFeeRecipient);
    const compatibility = validateClawzFeeCompatibility({
      protocolFeeBps,
      ...(deployerFeeApplies ? { deployerFeeBps } : {})
    });
    const grossAtomic = parseUsdAtomic(preview.grossAmountUsd);
    const deployerFeeAtomic =
      grossAtomic !== null && deployerFeeApplies ? (grossAtomic * BigInt(deployerFeeBps)) / 10_000n : null;
    const protocolFeeAtomic = parseUsdAtomic(preview.protocolFeeAmountUsd);
    const sellerNetAtomic =
      grossAtomic !== null
        ? grossAtomic - (protocolFeeAtomic ?? 0n) - (deployerFeeAtomic ?? 0n)
        : parseUsdAtomic(preview.sellerNetAmountUsd);
    const totalFeeAtomic =
      (protocolFeeAtomic ?? 0n) + (deployerFeeAtomic ?? 0n) > 0n ? (protocolFeeAtomic ?? 0n) + (deployerFeeAtomic ?? 0n) : null;

    return {
      ...preview,
      ...(sellerNetAtomic !== null ? { sellerNetAmountUsd: formatUsdAtomic(sellerNetAtomic) } : {}),
      ...(deployerFeeAtomic !== null ? { deployerFeeAmountUsd: formatUsdAtomic(deployerFeeAtomic) } : {}),
      ...(totalFeeAtomic !== null ? { totalFeeAmountUsd: formatUsdAtomic(totalFeeAtomic) } : {}),
      protocolFeeBps,
      deployerFeeBps: deployerFeeApplies ? deployerFeeBps : 0,
      totalFeeBps: protocolFeeBps + (deployerFeeApplies ? deployerFeeBps : 0),
      deployerFeeApplies,
      ...(deployerFeeRecipient ? { deployerFeeRecipient } : {}),
      ...(input.deployerFee?.label ? { deployerFeeLabel: input.deployerFee.label } : {}),
      compatibility
    } satisfies ClawzFeeStackPreview;
  });
}
