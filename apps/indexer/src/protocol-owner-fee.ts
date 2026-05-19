import type {
  AgentFeePreview,
  AgentPaymentRail,
  AgentProfileState,
  ProtocolOwnerFeeApplicability,
  ProtocolOwnerFeePolicy
} from "@clawz/protocol";

const USD_SCALE = 1_000_000n;
// Production pricing is configured with CLAWZ_PROTOCOL_OWNER_FEE_BPS.
// This fallback only keeps local/dev boots deterministic when the env var is absent.
const FALLBACK_FEE_BPS = 100;
const DEFAULT_APPLIES_TO: ProtocolOwnerFeeApplicability[] = ["santaclawz-marketplace"];

export interface NetworkFacilitationFeeEstimate {
  amountUsd: string;
  gasEstimate?: NonNullable<AgentFeePreview["gasEstimate"]>;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parseFeeBps(value: string | undefined): number {
  const parsed = Number(value?.trim() ?? "");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    return FALLBACK_FEE_BPS;
  }
  return parsed;
}

function parseAppliesTo(value: string | undefined): ProtocolOwnerFeeApplicability[] {
  const rawValues = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const appliesTo = (rawValues?.filter(
    (entry): entry is ProtocolOwnerFeeApplicability => entry === "santaclawz-marketplace"
  ) ?? []) as ProtocolOwnerFeeApplicability[];
  return appliesTo.length > 0 ? appliesTo : [...DEFAULT_APPLIES_TO];
}

function normalizeRecipient(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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

function payoutWalletForRail(profile: AgentProfileState, rail: AgentPaymentRail): string | undefined {
  if (rail === "base-usdc") {
    return profile.payoutWallets.base?.trim() || undefined;
  }
  if (rail === "ethereum-usdc") {
    return profile.payoutWallets.ethereum?.trim() || undefined;
  }
  return profile.payoutWallets.zeko?.trim() || undefined;
}

function previewAmountForPricingMode(profile: AgentProfileState): string | undefined {
  if (profile.paymentProfile.pricingMode === "fixed-exact") {
    return profile.paymentProfile.fixedAmountUsd?.trim() || undefined;
  }
  return undefined;
}

export function buildProtocolOwnerFeePolicyFromEnv(): ProtocolOwnerFeePolicy {
  const baseRecipient = normalizeRecipient(process.env.CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT);
  const ethereumRecipient = normalizeRecipient(process.env.CLAWZ_PROTOCOL_FEE_ETHEREUM_RECIPIENT);
  const zekoRecipient = normalizeRecipient(process.env.CLAWZ_PROTOCOL_FEE_ZEKO_RECIPIENT);

  return {
    enabled: truthy(process.env.CLAWZ_PROTOCOL_OWNER_FEE_ENABLED),
    feeBps: parseFeeBps(process.env.CLAWZ_PROTOCOL_OWNER_FEE_BPS),
    settlementModel: "fee-on-reserve-v1",
    appliesTo: parseAppliesTo(process.env.CLAWZ_PROTOCOL_OWNER_FEE_APPLIES_TO),
    recipientByRail: {
      ...(baseRecipient ? { "base-usdc": baseRecipient } : {}),
      ...(ethereumRecipient ? { "ethereum-usdc": ethereumRecipient } : {}),
      ...(zekoRecipient ? { "zeko-native": zekoRecipient } : {})
    }
  };
}

export function protocolOwnerFeeAppliesToRail(policy: ProtocolOwnerFeePolicy, rail: AgentPaymentRail): boolean {
  return Boolean(policy.enabled && policy.appliesTo.includes("santaclawz-marketplace") && policy.recipientByRail[rail]);
}

export function buildProtocolOwnerFeePreviews(input: {
  policy: ProtocolOwnerFeePolicy;
  profile: AgentProfileState;
  networkFacilitationFeeByRail?: Partial<Record<AgentPaymentRail, NetworkFacilitationFeeEstimate>>;
}): AgentFeePreview[] {
  const { policy, profile } = input;
  if (!policy.appliesTo.includes("santaclawz-marketplace")) {
    return [];
  }

  const grossAmountUsd = previewAmountForPricingMode(profile);
  const grossAtomic = parseUsdAtomic(grossAmountUsd);

  return profile.paymentProfile.supportedRails.flatMap((rail) => {
    const recipient = policy.recipientByRail[rail];
    if (!recipient) {
      return [];
    }

    const sellerPayTo = payoutWalletForRail(profile, rail);
    if (!sellerPayTo) {
      return [];
    }

    if (grossAtomic === null) {
      return [
        {
          rail,
          sellerPayTo,
          protocolFeeRecipient: recipient,
          feeBps: policy.feeBps
        } satisfies AgentFeePreview
      ];
    }

    const networkFacilitationEstimate = input.networkFacilitationFeeByRail?.[rail];
    const networkFacilitationAtomic = parseUsdAtomic(networkFacilitationEstimate?.amountUsd);
    const protocolFeeAtomic = (grossAtomic * BigInt(policy.feeBps)) / 10_000n;
    const effectiveFeeAtomic =
      networkFacilitationAtomic !== null && networkFacilitationAtomic > protocolFeeAtomic
        ? networkFacilitationAtomic
        : protocolFeeAtomic;
    const sellerNetAtomic = grossAtomic > effectiveFeeAtomic ? grossAtomic - effectiveFeeAtomic : 0n;
    const feeBasis: AgentFeePreview["feeBasis"] =
      effectiveFeeAtomic > protocolFeeAtomic ? "network-facilitation-minimum" : "protocol-bps";

    return [
      {
        rail,
        grossAmountUsd: grossAmountUsd!,
        sellerNetAmountUsd: formatUsdAtomic(sellerNetAtomic),
        protocolFeeAmountUsd: formatUsdAtomic(effectiveFeeAtomic),
        nominalProtocolFeeAmountUsd: formatUsdAtomic(protocolFeeAtomic),
        ...(networkFacilitationAtomic !== null
          ? { networkFacilitationFeeAmountUsd: formatUsdAtomic(networkFacilitationAtomic) }
          : {}),
        feeBasis,
        ...(networkFacilitationEstimate?.gasEstimate
          ? { gasEstimate: networkFacilitationEstimate.gasEstimate }
          : {}),
        sellerPayTo,
        protocolFeeRecipient: recipient,
        feeBps: policy.feeBps
      } satisfies AgentFeePreview
    ];
  });
}
