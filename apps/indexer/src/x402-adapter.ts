import type {
  AgentPaymentRail,
  AgentPricingMode,
  AgentX402Plan,
  AgentX402RailPlan,
  ConsoleStateResponse
} from "@clawz/protocol";
import {
  buildProtocolOwnerFeePreviews,
  protocolOwnerFeeAppliesToRail
} from "./protocol-owner-fee.js";

export const X402_CATALOG_ROUTE = "/.well-known/x402.json";
export const X402_RESOURCE_ROUTE = "/api/x402/proof";
export const X402_VERIFY_ROUTE = "/api/x402/verify";
export const X402_SETTLE_ROUTE = "/api/x402/settle";

const X402_PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const X402_PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
const X402_PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const USD_SCALE = 1_000_000n;
const DEV_MIN_NETWORK_FACILITATION_FEE_USD = "0.001";

const BASE_MAINNET = {
  networkId: "eip155:8453",
  assetSymbol: "USDC",
  assetDecimals: 6,
  assetStandard: "erc20" as const,
  assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

const ETHEREUM_MAINNET = {
  networkId: "eip155:1",
  assetSymbol: "USDC",
  assetDecimals: 6,
  assetStandard: "erc20" as const,
  assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
};

type JsonRecord = Record<string, unknown>;
type FacilitatorClient = {
  verify(input: { paymentPayload: JsonRecord; paymentRequirements: JsonRecord }): Promise<unknown>;
  settle(input: { paymentPayload: JsonRecord; paymentRequirements: JsonRecord }): Promise<unknown>;
};
type SettlementLedger = {
  settle(input: JsonRecord): unknown;
};
type ZekoX402Module = {
  buildBaseMainnetUsdcRail(input: { payTo: string; amount: string; facilitatorUrl?: string }): unknown;
  buildBaseMainnetUsdcReserveReleaseFeeRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    protocolFeePayTo: string;
    feeBps: number;
    facilitatorUrl?: string;
  }): unknown;
  buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    protocolFeePayTo: string;
    feeBps: number;
    facilitatorUrl?: string;
  }): unknown;
  buildBaseMainnetUsdcReserveReleaseRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    facilitatorUrl?: string;
  }): unknown;
  buildCatalog(input: JsonRecord): unknown;
  buildEthereumMainnetUsdcRail(input: { payTo: string; amount: string; facilitatorUrl?: string }): unknown;
  buildEthereumMainnetUsdcReserveReleaseFeeRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    protocolFeePayTo: string;
    feeBps: number;
    facilitatorUrl?: string;
  }): unknown;
  buildEthereumMainnetUsdcReserveReleaseFeeOnReserveRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    protocolFeePayTo: string;
    feeBps: number;
    facilitatorUrl?: string;
  }): unknown;
  buildEthereumMainnetUsdcReserveReleaseRail(input: {
    payTo: string;
    amount: string;
    escrowContract: string;
    facilitatorUrl?: string;
  }): unknown;
  buildPaymentRequired(input: JsonRecord): unknown;
  buildSettlementResponse(input: JsonRecord): unknown;
  CDPFacilitatorClient: new (input: { bearerToken: string }) => FacilitatorClient;
  HostedX402FacilitatorClient: new (input: {
    baseUrl: string;
    bearerToken?: string | undefined;
    requireAuth?: boolean;
  }) => FacilitatorClient;
  InMemorySettlementLedger: new (input: {
    sponsoredBudget: string;
    budgetAsset: JsonRecord;
  }) => SettlementLedger;
  verifyPayment(input: { requirements: JsonRecord; payload: JsonRecord }): unknown;
};

function isMissingZekoX402(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes("zeko-x402")
  );
}

async function loadZekoX402Module(): Promise<ZekoX402Module | null> {
  try {
    return (await import("zeko-x402")) as ZekoX402Module;
  } catch (error) {
    if (isMissingZekoX402(error)) {
      return null;
    }
    throw error;
  }
}

const zekoX402Module = await loadZekoX402Module();

function requireZekoX402Module(): ZekoX402Module {
  if (!zekoX402Module) {
    throw new Error("zeko-x402 is not installed on this deployment. Live x402 execution is unavailable.");
  }
  return zekoX402Module;
}

interface AgentX402RuntimeContext {
  plan: AgentX402Plan;
  serviceNetworkId: string;
  paymentContext: JsonRecord;
  paymentRequired: JsonRecord;
  catalog: JsonRecord;
  runtimeRails: AgentX402RailPlan[];
}

interface AgentX402VerificationResult {
  ok: boolean;
  paymentRequired: JsonRecord;
  paymentPayload: JsonRecord;
  rail: AgentX402RailPlan;
  localVerification: JsonRecord;
  remoteVerification?: JsonRecord;
  headers: Record<string, string>;
  error?: string;
}

interface AgentX402SettlementResult extends AgentX402VerificationResult {
  remoteSettlement: JsonRecord;
  paymentResponse: JsonRecord;
}

const settlementLedgers = new Map<string, SettlementLedger>();

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toQueryString(sessionId: string): string {
  return new URLSearchParams({ sessionId }).toString();
}

function defaultZekoAssetSymbol(networkId: string): string {
  return networkId.toLowerCase().endsWith(":testnet") ? "tMINA" : "MINA";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Json(value: JsonRecord): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function assertPaymentPayload(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid x402 payment payload.");
  }
  return value;
}

function isQuotedPricing(mode: AgentPricingMode): boolean {
  return mode === "quote-required" || mode === "agent-negotiated";
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
  return BigInt(match[1] ?? "0") * USD_SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function formatUsdAtomic(value: bigint, minFractionDigits = 0): string {
  const whole = value / USD_SCALE;
  const fraction = value % USD_SCALE;
  if (fraction === 0n && minFractionDigits === 0) {
    return whole.toString();
  }
  const fractionText = fraction
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(minFractionDigits, "0");
  return `${whole}.${fractionText}`;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive.");
  }

  return (numerator + denominator - 1n) / denominator;
}

function minHostedFacilitatorPaymentUsd(rail: AgentPaymentRail): string | undefined {
  if (rail === "ethereum-usdc") {
    return (
      process.env.CLAWZ_X402_ETHEREUM_MIN_PAYMENT_USD?.trim() ||
      process.env.CLAWZ_X402_HOSTED_FACILITATOR_MIN_PAYMENT_USD?.trim() ||
      undefined
    );
  }

  return (
    process.env.CLAWZ_X402_BASE_MIN_PAYMENT_USD?.trim() ||
    process.env.CLAWZ_X402_HOSTED_FACILITATOR_MIN_PAYMENT_USD?.trim() ||
    undefined
  );
}

function minNetworkFacilitationFeeUsd(): string {
  const configured = process.env.CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD?.trim();
  if (configured) {
    return configured;
  }

  return process.env.NODE_ENV === "production" ? "" : DEV_MIN_NETWORK_FACILITATION_FEE_USD;
}

function hasBaseCdpFacilitatorCredentials(): boolean {
  return Boolean(
    process.env.CLAWZ_X402_BASE_FACILITATOR_BEARER_TOKEN?.trim() ||
      process.env.CLAWZ_X402_CDP_BEARER_TOKEN?.trim() ||
      process.env.COINBASE_CDP_API_BEARER_TOKEN?.trim()
  );
}

function pushHostedFacilitatorFloor(input: {
  rail: AgentPaymentRail;
  profile: ConsoleStateResponse["profile"];
  policy: ConsoleStateResponse["protocolOwnerFeePolicy"];
  hostedFacilitator: boolean;
  missing: string[];
  notes: string[];
}) {
  if (!input.hostedFacilitator || input.profile.paymentProfile.pricingMode !== "fixed-exact") {
    return;
  }

  const minFeeUsd = minNetworkFacilitationFeeUsd();
  const minFeeAtomic = parseUsdAtomic(minFeeUsd);
  const configuredMinAtomic = parseUsdAtomic(minHostedFacilitatorPaymentUsd(input.rail));
  const amountAtomic = parseUsdAtomic(input.profile.paymentProfile.fixedAmountUsd);
  const feeApplies = protocolOwnerFeeAppliesToRail(input.policy, input.rail);
  if (!minFeeUsd.trim() || minFeeAtomic === null) {
    input.missing.push("Set CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD for hosted facilitator settlement.");
    input.notes.push("Hosted facilitator settlement needs an operator-configured network facilitation floor.");
    return;
  }

  if (amountAtomic === null) {
    return;
  }

  if (!feeApplies || input.policy.feeBps <= 0) {
    input.missing.push(
      `Enable the SantaClawz protocol owner fee for ${input.rail === "ethereum-usdc" ? "Ethereum" : "Base"} hosted facilitation.`
    );
    input.notes.push(
      `SantaClawz hosted facilitation needs at least $${formatUsdAtomic(minFeeAtomic)} in network facilitation value per transaction.`
    );
    return;
  }

  const feeDerivedMinAtomic = ceilDiv(minFeeAtomic * 10_000n, BigInt(input.policy.feeBps));
  const minAtomic =
    configuredMinAtomic !== null && configuredMinAtomic > feeDerivedMinAtomic
      ? configuredMinAtomic
      : feeDerivedMinAtomic;
  const generatedFeeAtomic = (amountAtomic * BigInt(input.policy.feeBps)) / 10_000n;

  input.notes.push(
    `SantaClawz hosted facilitation requires at least $${formatUsdAtomic(minFeeAtomic)} in network facilitation value; at ${input.policy.feeBps / 100}% the minimum fixed price is $${formatUsdAtomic(minAtomic, 2)}.`
  );
  if (amountAtomic < minAtomic || generatedFeeAtomic < minFeeAtomic) {
    input.missing.push(`Set the fixed price to at least $${formatUsdAtomic(minAtomic, 2)} for hosted facilitator settlement.`);
  }
}

function executionMode(trigger: ConsoleStateResponse["profile"]["paymentProfile"]["settlementTrigger"]): AgentX402RailPlan["executionMode"] {
  return trigger === "on-proof" ? "reserve-release" : "settle-first";
}

function serviceIdFor(agentId: string): string {
  const base = process.env.CLAWZ_X402_SERVICE_ID?.trim();
  return base && base.length > 0 ? `${base}:${agentId}` : `santaclawz-agent:${agentId}`;
}

function pushPricingReadiness(
  profile: ConsoleStateResponse["profile"],
  missing: string[],
  notes: string[]
): Pick<AgentX402RailPlan, "amountUsd" | "maxAmountUsd"> {
  if (profile.paymentProfile.pricingMode === "fixed-exact") {
    if (!profile.paymentProfile.fixedAmountUsd?.trim()) {
      missing.push("Set a fixed USD amount.");
      return {};
    }
    return { amountUsd: profile.paymentProfile.fixedAmountUsd };
  }

  if (profile.paymentProfile.pricingMode === "capped-exact") {
    if (!profile.paymentProfile.maxAmountUsd?.trim()) {
      missing.push("Set a max USD amount.");
      return {};
    }
    notes.push("Capped exact pricing still needs SantaClawz release policy before live settlement.");
    return { maxAmountUsd: profile.paymentProfile.maxAmountUsd };
  }

  if (isQuotedPricing(profile.paymentProfile.pricingMode)) {
    if (!profile.paymentProfile.quoteUrl?.trim()) {
      missing.push("Provide a quote URL for negotiated pricing.");
    } else {
      notes.push("Quoted or agent-negotiated pricing needs a quote step before emitting an exact x402 challenge.");
    }
    return {};
  }

  return {};
}

function buildBaseRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const missing: string[] = [];
  const notes: string[] = [];
  const payTo = profile.payoutWallets.base?.trim();
  const settlementTrigger = profile.paymentProfile.settlementTrigger;
  const protocolFeeApplies = protocolOwnerFeeAppliesToRail(consoleState.protocolOwnerFeePolicy, "base-usdc");
  const settleOnProof = settlementTrigger === "on-proof";
  const operatorFacilitatorUrl = profile.paymentProfile.baseFacilitatorUrl?.trim();
  const facilitatorUrl =
    operatorFacilitatorUrl || process.env.CLAWZ_X402_BASE_FACILITATOR_URL?.trim();
  const baseCdpFacilitatorConfigured = hasBaseCdpFacilitatorCredentials();
  const baseHostedFacilitatorConfigured = Boolean(facilitatorUrl || baseCdpFacilitatorConfigured);
  const hostedFacilitator = Boolean(!operatorFacilitatorUrl && baseHostedFacilitatorConfigured && !settleOnProof);
  const sellerEscrowContract = profile.paymentProfile.baseEscrowContract?.trim();
  const sharedEscrowContract = process.env.CLAWZ_X402_BASE_ESCROW_CONTRACT?.trim();
  const escrowContract = sellerEscrowContract || sharedEscrowContract;

  if (profile.availability === "archived") {
    missing.push("Restore this archived agent before accepting new SantaClawz work.");
  }

  if (!payTo) {
    missing.push("Add a Base payout wallet.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);

  if (!baseHostedFacilitatorConfigured) {
    missing.push("Set CLAWZ_X402_BASE_FACILITATOR_URL, configure CDP x402 credentials, or add a Base facilitator URL for this agent.");
  }
  pushHostedFacilitatorFloor({
    rail: "base-usdc",
    profile,
    policy: consoleState.protocolOwnerFeePolicy,
    hostedFacilitator,
    missing,
    notes
  });

  if (settleOnProof && !escrowContract) {
    missing.push("Provision a Base seller escrow or set CLAWZ_X402_BASE_ESCROW_CONTRACT for the shared reserve-release path.");
  }

  if (operatorFacilitatorUrl && !settleOnProof) {
    notes.push("Base exact-price flows use the operator-hosted x402 facilitator for this agent.");
  }
  if (protocolFeeApplies) {
    notes.push(`SantaClawz marketplace routing applies a ${consoleState.protocolOwnerFeePolicy.feeBps / 100}% protocol owner fee on Base.`);
    notes.push(
      settleOnProof
        ? "Buyers see the gross price. SantaClawz keeps the protocol fee at reservation time, and only the seller net stays in escrow."
        : "Upfront payments settle directly to the seller wallet. SantaClawz hosted facilitation and gas recovery are handled outside escrow."
    );
  }

  if (facilitatorUrl && settleOnProof) {
    notes.push("Base reserve-release is expected to use a self-hosted or dedicated facilitator path.");
  }
  if (settleOnProof && sellerEscrowContract) {
    notes.push("This agent is using its own dedicated Base escrow for balance isolation.");
  } else if (settleOnProof && sharedEscrowContract) {
    notes.push("This agent is currently using the shared Base escrow. Provision a seller-specific escrow to isolate balances further.");
  }
  if (!operatorFacilitatorUrl && baseHostedFacilitatorConfigured) {
    notes.push(
      facilitatorUrl
        ? "SantaClawz is using the hosted Base x402 facilitator for upfront payment settlement."
        : "SantaClawz is using the CDP x402 facilitator for upfront Base payment settlement."
    );
  }

  return {
    rail: "base-usdc",
    settlementRail: "evm",
    networkId: BASE_MAINNET.networkId,
    assetSymbol: BASE_MAINNET.assetSymbol,
    assetDecimals: BASE_MAINNET.assetDecimals,
    assetStandard: BASE_MAINNET.assetStandard,
    assetAddress: BASE_MAINNET.assetAddress,
    builderHint:
      settleOnProof && protocolFeeApplies
        ? "buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail"
        : settleOnProof
          ? "buildBaseMainnetUsdcReserveReleaseRail"
          : "buildBaseMainnetUsdcRail",
    facilitatorMode: settleOnProof ? "evm-reserve-release" : "x402-http",
    settlementModel:
      settleOnProof && protocolFeeApplies
        ? "x402-base-usdc-reserve-release-v4"
        : settleOnProof
          ? "x402-base-usdc-reserve-release-v2"
          : "x402-exact-evm-v1",
    executionMode: settleOnProof ? "reserve-release" : executionMode(settlementTrigger),
    ...(payTo ? { payTo } : {}),
    ...(escrowContract ? { settlementContractAddress: escrowContract } : {}),
    ...(facilitatorUrl ? { facilitatorUrl } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

function buildEthereumRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const missing: string[] = [];
  const notes: string[] = [];
  const payTo = profile.payoutWallets.ethereum?.trim();
  const settlementTrigger = profile.paymentProfile.settlementTrigger;
  const protocolFeeApplies = protocolOwnerFeeAppliesToRail(consoleState.protocolOwnerFeePolicy, "ethereum-usdc");
  const settleOnProof = settlementTrigger === "on-proof";
  const operatorFacilitatorUrl = profile.paymentProfile.ethereumFacilitatorUrl?.trim();
  const facilitatorUrl =
    operatorFacilitatorUrl || process.env.CLAWZ_X402_ETHEREUM_FACILITATOR_URL?.trim();
  const hostedFacilitator = Boolean(!operatorFacilitatorUrl && facilitatorUrl && !settleOnProof);
  const sellerEscrowContract = profile.paymentProfile.ethereumEscrowContract?.trim();
  const sharedEscrowContract = process.env.CLAWZ_X402_ETHEREUM_ESCROW_CONTRACT?.trim();
  const escrowContract = sellerEscrowContract || sharedEscrowContract;

  if (profile.availability === "archived") {
    missing.push("Restore this archived agent before accepting new SantaClawz work.");
  }

  if (!payTo) {
    missing.push("Add an Ethereum payout wallet.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);

  if (!facilitatorUrl) {
    missing.push("Set CLAWZ_X402_ETHEREUM_FACILITATOR_URL or add an Ethereum facilitator URL for this agent.");
  }
  pushHostedFacilitatorFloor({
    rail: "ethereum-usdc",
    profile,
    policy: consoleState.protocolOwnerFeePolicy,
    hostedFacilitator,
    missing,
    notes
  });

  if (settleOnProof && !escrowContract) {
    missing.push(
      "Provision an Ethereum seller escrow or set CLAWZ_X402_ETHEREUM_ESCROW_CONTRACT for the shared reserve-release path."
    );
  }

  if (operatorFacilitatorUrl) {
    notes.push(
      settleOnProof
        ? "Ethereum reserve-release is expected to use an operator-hosted facilitator for this rail."
        : "Ethereum mainnet uses the operator-hosted facilitator for this rail."
    );
  }
  if (settleOnProof && sellerEscrowContract) {
    notes.push("This agent is using its own dedicated Ethereum escrow for balance isolation.");
  } else if (settleOnProof && sharedEscrowContract) {
    notes.push("This agent is currently using the shared Ethereum escrow. Provision a seller-specific escrow to isolate balances further.");
  }
  if (!operatorFacilitatorUrl && facilitatorUrl) {
    notes.push("SantaClawz is using the hosted Ethereum x402 facilitator for upfront payment settlement.");
  }
  if (protocolFeeApplies) {
    notes.push(`SantaClawz marketplace routing applies a ${consoleState.protocolOwnerFeePolicy.feeBps / 100}% protocol owner fee on Ethereum.`);
    notes.push(
      settleOnProof
        ? "Buyers see the gross price. SantaClawz keeps the protocol fee at reservation time, and only the seller net stays in escrow."
        : "Upfront payments settle directly to the seller wallet. SantaClawz hosted facilitation and gas recovery are handled outside escrow."
    );
  }

  return {
    rail: "ethereum-usdc",
    settlementRail: "evm",
    networkId: ETHEREUM_MAINNET.networkId,
    assetSymbol: ETHEREUM_MAINNET.assetSymbol,
    assetDecimals: ETHEREUM_MAINNET.assetDecimals,
    assetStandard: ETHEREUM_MAINNET.assetStandard,
    assetAddress: ETHEREUM_MAINNET.assetAddress,
    builderHint:
      settleOnProof && protocolFeeApplies
        ? "buildEthereumMainnetUsdcReserveReleaseFeeOnReserveRail"
        : settleOnProof
          ? "buildEthereumMainnetUsdcReserveReleaseRail"
          : "buildEthereumMainnetUsdcRail",
    facilitatorMode: settleOnProof ? "evm-reserve-release" : "x402-http",
    settlementModel:
      settleOnProof && protocolFeeApplies
        ? "x402-ethereum-mainnet-usdc-reserve-release-v4"
        : settleOnProof
          ? "x402-ethereum-mainnet-usdc-reserve-release-v2"
          : "x402-exact-evm-v1",
    executionMode: settleOnProof ? "reserve-release" : executionMode(settlementTrigger),
    ...(payTo ? { payTo } : {}),
    ...(escrowContract ? { settlementContractAddress: escrowContract } : {}),
    ...(facilitatorUrl ? { facilitatorUrl } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

function buildZekoRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const deployment = consoleState.deployment;
  const missing: string[] = [];
  const notes: string[] = [];
  const beneficiaryAddress = profile.payoutWallets.zeko?.trim();
  const settlementContractAddress = process.env.CLAWZ_X402_ZEKO_SETTLEMENT_CONTRACT?.trim();

  if (profile.availability === "archived") {
    missing.push("Restore this archived agent before accepting new SantaClawz work.");
  }

  if (!beneficiaryAddress) {
    missing.push("Add a Zeko payout wallet to use as the settlement beneficiary.");
  }
  if (!settlementContractAddress) {
    missing.push("Set CLAWZ_X402_ZEKO_SETTLEMENT_CONTRACT for the Zeko settlement rail.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);
  notes.push("The Zeko rail should use buildZekoSettlementContractRail plus a witness-backed settlement update.");

  return {
    rail: "zeko-native",
    settlementRail: "zeko",
    networkId: deployment.networkId,
    assetSymbol: defaultZekoAssetSymbol(deployment.networkId),
    assetDecimals: 9,
    assetStandard: "native",
    builderHint: "buildZekoSettlementContractRail",
    facilitatorMode: "zeko-settlement-contract",
    settlementModel: "x402-exact-settlement-zkapp-v1",
    executionMode: executionMode(profile.paymentProfile.settlementTrigger),
    ...(settlementContractAddress ? { payTo: settlementContractAddress, settlementContractAddress } : {}),
    ...(beneficiaryAddress ? { beneficiaryAddress } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

export function buildAgentX402Plan(input: {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
}): AgentX402Plan {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const consoleState = input.consoleState;
  const sessionId = consoleState.session.sessionId;
  const agentId = consoleState.agentId;
  const profile = consoleState.profile;
  const protocolOwnerFeePolicy = consoleState.protocolOwnerFeePolicy;
  const feePreviewByRail = buildProtocolOwnerFeePreviews({
    policy: protocolOwnerFeePolicy,
    profile
  });
  const query = toQueryString(sessionId);
  const rails = profile.paymentProfile.supportedRails.map((rail) => {
    if (rail === "base-usdc") {
      return buildBaseRailPlan(consoleState);
    }
    if (rail === "ethereum-usdc") {
      return buildEthereumRailPlan(consoleState);
    }
    return buildZekoRailPlan(consoleState);
  });
  const published = consoleState.liveFlowTargets.turns.some((target) => target.sessionId === sessionId);

  return {
    serviceId: serviceIdFor(agentId),
    agentId,
    sessionId,
    published,
    paymentsEnabled: consoleState.paymentsEnabled,
    paymentProfileReady: consoleState.paymentProfileReady,
    payoutAddressConfigured: consoleState.payoutAddressConfigured,
    pricingMode: profile.paymentProfile.pricingMode,
    settlementTrigger: profile.paymentProfile.settlementTrigger,
    ...(profile.paymentProfile.defaultRail ? { defaultRail: profile.paymentProfile.defaultRail } : {}),
    ...(profile.paymentProfile.quoteUrl ? { quoteUrl: profile.paymentProfile.quoteUrl } : {}),
    ...(profile.paymentProfile.paymentNotes ? { paymentNotes: profile.paymentProfile.paymentNotes } : {}),
    ...(protocolOwnerFeePolicy.enabled ? { protocolOwnerFeePolicy } : {}),
    ...(feePreviewByRail.length > 0 ? { feePreviewByRail } : {}),
    proofBundleUrl: `${baseUrl}/api/interop/agent-proof?${query}`,
    verifyProofUrl: `${baseUrl}/api/interop/verify?${query}`,
    catalogPreviewUrl: `${baseUrl}${X402_CATALOG_ROUTE}?${query}`,
    resourcePreviewUrl: `${baseUrl}${X402_RESOURCE_ROUTE}?${query}`,
    verifyPaymentUrl: `${baseUrl}${X402_VERIFY_ROUTE}?${query}`,
    settlePaymentUrl: `${baseUrl}${X402_SETTLE_ROUTE}?${query}`,
    rails
  };
}

function railDescription(rail: AgentX402RailPlan): string {
  if (rail.rail === "base-usdc") {
    return rail.executionMode === "reserve-release"
      ? "Base mainnet USDC rail using reserve-now, release-on-proof settlement."
      : "Base mainnet USDC rail using exact-price x402 settlement.";
  }

  if (rail.rail === "ethereum-usdc") {
    return rail.executionMode === "reserve-release"
      ? "Ethereum mainnet USDC rail using reserve-now, release-on-proof settlement."
      : "Ethereum mainnet USDC rail using exact-price x402 settlement.";
  }

  return "Zeko settlement-contract rail using a proof-aware zkApp settlement path.";
}

function railAcceptPreview(plan: AgentX402Plan, rail: AgentX402RailPlan) {
  const amount = rail.amountUsd ?? rail.maxAmountUsd;
  if (!amount) {
    return undefined;
  }
  const feePreview = plan.feePreviewByRail?.find((preview) => preview.rail === rail.rail);

  return {
    scheme: "exact",
    settlementRail: rail.settlementRail,
    network: rail.networkId,
    asset: {
      symbol: rail.assetSymbol,
      decimals: rail.assetDecimals,
      standard: rail.assetStandard,
      ...(rail.assetAddress ? { address: rail.assetAddress } : {})
    },
    price: amount,
    amount,
    ...(rail.payTo ? { payTo: rail.payTo } : {}),
    settlementModel: rail.settlementModel,
    description: railDescription(rail),
    mimeType: "application/json",
    outputSchema: {
      type: "clawz-agent-proof-bundle",
      proofBundleUrl: plan.proofBundleUrl,
      verifyUrl: plan.verifyProofUrl
    },
    extensions: {
      santaclawz: {
        previewOnly: true,
        ready: rail.ready,
        builderHint: rail.builderHint,
        executionMode: rail.executionMode,
        pricingMode: plan.pricingMode,
        settlementTrigger: plan.settlementTrigger,
        ...(feePreview ? { feePreview } : {}),
        missing: rail.missing,
        notes: rail.notes
      },
      ...(rail.settlementRail === "evm"
        ? {
            evm: {
              ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {}),
              ...(rail.settlementContractAddress ? { escrowContract: rail.settlementContractAddress } : {}),
              ...(feePreview
                ? {
                    feeSplit: {
                      version: "protocol-owner-fee-v1",
                      feeBps: feePreview.feeBps,
                      ...(feePreview.protocolFeeRecipient ? { protocolFeePayTo: feePreview.protocolFeeRecipient } : {}),
                      ...(feePreview.sellerPayTo ? { sellerPayTo: feePreview.sellerPayTo } : {}),
                      feeSettlementMode: plan.protocolOwnerFeePolicy?.settlementModel ?? "fee-on-reserve-v1"
                    }
                  }
                : {})
            }
          }
        : {
            zeko: {
              ...(rail.settlementContractAddress ? { contractAddress: rail.settlementContractAddress } : {}),
              ...(rail.beneficiaryAddress ? { beneficiaryAddress: rail.beneficiaryAddress } : {})
            }
          })
    }
  };
}

function incompleteRailPreview(rail: AgentX402RailPlan) {
  return {
    rail: rail.rail,
    ready: rail.ready,
    builderHint: rail.builderHint,
    executionMode: rail.executionMode,
    settlementModel: rail.settlementModel,
    missing: rail.missing,
    notes: rail.notes
  };
}

export function buildAgentX402CatalogPreview(input: {
  serviceNetworkId: string;
  plan: AgentX402Plan;
}) {
  const accepts = input.plan.rails
    .filter((rail) => rail.ready)
    .map((rail) => railAcceptPreview(input.plan, rail))
    .filter((rail): rail is NonNullable<ReturnType<typeof railAcceptPreview>> => Boolean(rail));

  return {
    protocol: "x402",
    version: "2",
    previewOnly: true,
    serviceId: input.plan.serviceId,
    resource: {
      chain: "zeko-service",
      serviceNetworkId: input.serviceNetworkId
    },
    facilitator: {
      mode: "multi-rail-preview",
      verifyUrl: input.plan.verifyPaymentUrl,
      settleUrl: input.plan.settlePaymentUrl
    },
    routes: [
      {
        method: "GET",
        resource: input.plan.resourcePreviewUrl,
        description: "Preview the rails SantaClawz would advertise for this agent once zeko-x402 execution is enabled.",
        mimeType: "application/json",
        accepts
      }
    ],
    features: [
      "multi-rail",
      "proof-aware-settlement-planning",
      "santaclawz-payment-profile"
    ],
    extensions: {
      santaclawz: {
        previewOnly: true,
        agentId: input.plan.agentId,
        sessionId: input.plan.sessionId,
        published: input.plan.published,
        paymentsEnabled: input.plan.paymentsEnabled,
        paymentProfileReady: input.plan.paymentProfileReady,
        payoutAddressConfigured: input.plan.payoutAddressConfigured,
        pricingMode: input.plan.pricingMode,
        settlementTrigger: input.plan.settlementTrigger,
        ...(input.plan.protocolOwnerFeePolicy ? { protocolOwnerFeePolicy: input.plan.protocolOwnerFeePolicy } : {}),
        ...(input.plan.feePreviewByRail ? { feePreviewByRail: input.plan.feePreviewByRail } : {}),
        ...(input.plan.defaultRail ? { defaultRail: input.plan.defaultRail } : {}),
        ...(input.plan.quoteUrl ? { quoteUrl: input.plan.quoteUrl } : {}),
        ...(input.plan.paymentNotes ? { paymentNotes: input.plan.paymentNotes } : {}),
        incompleteRails: input.plan.rails.filter((rail) => !rail.ready).map(incompleteRailPreview)
      }
    }
  };
}

export function buildAgentX402PaymentRequiredPreview(input: {
  serviceNetworkId: string;
  plan: AgentX402Plan;
}) {
  const catalog = buildAgentX402CatalogPreview(input);
  const accepts = catalog.routes[0]?.accepts ?? [];

  return {
    protocol: "x402",
    version: "2",
    previewOnly: true,
    requestId: `preview_${input.plan.agentId}`,
    resource: input.plan.resourcePreviewUrl,
    description:
      "Preview x402 payment requirement generated from the stored SantaClawz payment profile. Live verification and settlement are not enabled yet.",
    mimeType: "application/json",
    seller: {
      serviceId: input.plan.serviceId
    },
    accepts,
    extensions: {
      santaclawz: {
        previewOnly: true,
        agentId: input.plan.agentId,
        sessionId: input.plan.sessionId,
        serviceNetworkId: input.serviceNetworkId,
        proofBundleUrl: input.plan.proofBundleUrl,
        verifyProofUrl: input.plan.verifyProofUrl,
        verifyPaymentUrl: input.plan.verifyPaymentUrl,
        settlePaymentUrl: input.plan.settlePaymentUrl,
        ...(input.plan.protocolOwnerFeePolicy ? { protocolOwnerFeePolicy: input.plan.protocolOwnerFeePolicy } : {}),
        ...(input.plan.feePreviewByRail ? { feePreviewByRail: input.plan.feePreviewByRail } : {}),
        pricingMode: input.plan.pricingMode,
        settlementTrigger: input.plan.settlementTrigger
      }
    }
  };
}

function facilitatorTokenForBase(): string | undefined {
  return (
    process.env.CLAWZ_X402_BASE_FACILITATOR_BEARER_TOKEN?.trim() ||
    process.env.CLAWZ_X402_CDP_BEARER_TOKEN?.trim() ||
    process.env.COINBASE_CDP_API_BEARER_TOKEN?.trim() ||
    undefined
  );
}

function facilitatorTokenForEthereum(): string | undefined {
  return process.env.CLAWZ_X402_ETHEREUM_FACILITATOR_BEARER_TOKEN?.trim() || undefined;
}

function facilitatorClientForRail(rail: AgentX402RailPlan) {
  if (!zekoX402Module) {
    return null;
  }

  if (rail.rail === "base-usdc") {
    const baseToken = facilitatorTokenForBase();
    if (rail.facilitatorUrl) {
      return new zekoX402Module.HostedX402FacilitatorClient({
        baseUrl: rail.facilitatorUrl,
        ...(baseToken ? { bearerToken: baseToken } : {}),
        requireAuth: false
      });
    }

    if (baseToken) {
      return new zekoX402Module.CDPFacilitatorClient({
        bearerToken: baseToken
      });
    }

    return null;
  }

  if (rail.rail === "ethereum-usdc" && rail.facilitatorUrl) {
    const ethereumToken = facilitatorTokenForEthereum();
    return new zekoX402Module.HostedX402FacilitatorClient({
      baseUrl: rail.facilitatorUrl,
      ...(ethereumToken ? { bearerToken: ethereumToken } : {}),
      requireAuth: false
    });
  }

  return null;
}

function isLiveRuntimeRail(plan: AgentX402Plan, rail: AgentX402RailPlan): boolean {
  return (
    rail.ready &&
    rail.settlementRail === "evm" &&
    plan.pricingMode === "fixed-exact" &&
    typeof rail.amountUsd === "string" &&
    rail.amountUsd.trim().length > 0 &&
    (rail.executionMode === "settle-first" || rail.executionMode === "reserve-release")
  );
}

function buildLiveRail(plan: AgentX402Plan, rail: AgentX402RailPlan): JsonRecord | null {
  if (!zekoX402Module) {
    return null;
  }

  if (!rail.payTo || !rail.amountUsd) {
    return null;
  }

  const feePreview = plan.feePreviewByRail?.find((preview) => preview.rail === rail.rail);
  const escrowContract = rail.settlementContractAddress;

  if (rail.executionMode === "reserve-release" && !escrowContract) {
    return null;
  }

  if (rail.rail === "base-usdc") {
    if (rail.executionMode === "reserve-release") {
      if (feePreview?.protocolFeeRecipient && feePreview.feeBps > 0) {
        return zekoX402Module.buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail({
          payTo: rail.payTo,
          amount: rail.amountUsd,
          escrowContract: escrowContract!,
          protocolFeePayTo: feePreview.protocolFeeRecipient,
          feeBps: feePreview.feeBps,
          ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
        }) as JsonRecord;
      }

      return zekoX402Module.buildBaseMainnetUsdcReserveReleaseRail({
        payTo: rail.payTo,
        amount: rail.amountUsd,
        escrowContract: escrowContract!,
        ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
      }) as JsonRecord;
    }

    return zekoX402Module.buildBaseMainnetUsdcRail({
      payTo: rail.payTo,
      amount: rail.amountUsd,
      ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
    }) as JsonRecord;
  }

  if (rail.rail === "ethereum-usdc") {
    if (rail.executionMode === "reserve-release") {
      if (feePreview?.protocolFeeRecipient && feePreview.feeBps > 0) {
        return zekoX402Module.buildEthereumMainnetUsdcReserveReleaseFeeOnReserveRail({
          payTo: rail.payTo,
          amount: rail.amountUsd,
          escrowContract: escrowContract!,
          protocolFeePayTo: feePreview.protocolFeeRecipient,
          feeBps: feePreview.feeBps,
          ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
        }) as JsonRecord;
      }

      return zekoX402Module.buildEthereumMainnetUsdcReserveReleaseRail({
        payTo: rail.payTo,
        amount: rail.amountUsd,
        escrowContract: escrowContract!,
        ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
      }) as JsonRecord;
    }

    return zekoX402Module.buildEthereumMainnetUsdcRail({
      payTo: rail.payTo,
      amount: rail.amountUsd,
      ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
    }) as JsonRecord;
  }

  return null;
}

export function buildAgentX402RuntimeContext(input: {
  baseUrl: string;
  plan: AgentX402Plan;
  serviceNetworkId: string;
}): AgentX402RuntimeContext | null {
  if (!zekoX402Module) {
    return null;
  }

  const runtimeRails = input.plan.rails.filter((rail) => isLiveRuntimeRail(input.plan, rail));
  const rails = runtimeRails
    .map((rail) => buildLiveRail(input.plan, rail))
    .filter((rail): rail is JsonRecord => Boolean(rail));

  if (rails.length === 0) {
    return null;
  }

  const paymentContext = {
    serviceId: input.plan.serviceId,
    serviceNetworkId: input.serviceNetworkId,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    proofBundleUrl: input.plan.proofBundleUrl,
    verifyUrl: input.plan.verifyProofUrl,
    sessionId: input.plan.sessionId,
    rails,
    description: "Paid SantaClawz proof bundle access for a registered OpenClaw agent."
  } satisfies JsonRecord;

  return {
    plan: input.plan,
    serviceNetworkId: input.serviceNetworkId,
    paymentContext,
    paymentRequired: zekoX402Module.buildPaymentRequired(paymentContext) as JsonRecord,
    catalog: zekoX402Module.buildCatalog(paymentContext) as JsonRecord,
    runtimeRails
  };
}

export function buildAgentX402Catalog(runtime: AgentX402RuntimeContext) {
  return runtime.catalog;
}

function paymentHeaders(input: {
  paymentRequired?: JsonRecord;
  paymentPayload?: JsonRecord;
  paymentResponse?: JsonRecord;
}) {
  return {
    ...(input.paymentRequired ? { [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(input.paymentRequired) } : {}),
    ...(input.paymentPayload ? { [X402_PAYMENT_SIGNATURE_HEADER]: encodeBase64Json(input.paymentPayload) } : {}),
    ...(input.paymentResponse ? { [X402_PAYMENT_RESPONSE_HEADER]: encodeBase64Json(input.paymentResponse) } : {})
  };
}

export function parseAgentX402PaymentPayload(input: {
  headerValue?: string;
  body?: unknown;
}): JsonRecord | null {
  if (typeof input.headerValue === "string" && input.headerValue.trim().length > 0) {
    return assertPaymentPayload(decodeBase64Json(input.headerValue.trim()));
  }

  if (isRecord(input.body) && isRecord(input.body.paymentPayload)) {
    return assertPaymentPayload(input.body.paymentPayload);
  }

  if (isRecord(input.body) && input.body.protocol === "x402") {
    return assertPaymentPayload(input.body);
  }

  return null;
}

function matchingRuntimeRail(context: AgentX402RuntimeContext, paymentPayload: JsonRecord): AgentX402RailPlan | null {
  return (
    context.runtimeRails.find(
      (rail) =>
        rail.networkId === paymentPayload.networkId &&
        rail.settlementRail === paymentPayload.settlementRail &&
        rail.payTo === paymentPayload.payTo
    ) ?? null
  );
}

function localVerificationOk(verification: JsonRecord): boolean {
  return verification.ok === true;
}

function remoteVerificationOk(verification: JsonRecord | undefined): boolean {
  if (!verification) {
    return false;
  }

  return verification.isValid !== false && verification.ok !== false;
}

function resultError(result: JsonRecord | undefined): string | undefined {
  if (!result) {
    return undefined;
  }

  const candidate = result.reason ?? result.invalidReason ?? result.error ?? result.errorReason ?? result.errorMessage;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function ledgerKeyFor(rail: AgentX402RailPlan): string {
  return `${rail.networkId}:${rail.assetSymbol}:${rail.assetAddress ?? rail.assetStandard}`;
}

function sponsoredBudgetForRail(rail: AgentX402RailPlan): string {
  if (rail.rail === "ethereum-usdc") {
    return process.env.CLAWZ_X402_ETHEREUM_SPONSORED_BUDGET_USDC?.trim() || process.env.CLAWZ_X402_SPONSORED_BUDGET_USDC?.trim() || "10";
  }

  return process.env.CLAWZ_X402_BASE_SPONSORED_BUDGET_USDC?.trim() || process.env.CLAWZ_X402_SPONSORED_BUDGET_USDC?.trim() || "10";
}

function settlementLedgerForRail(rail: AgentX402RailPlan) {
  const key = ledgerKeyFor(rail);
  const existing = settlementLedgers.get(key);
  if (existing) {
    return existing;
  }

  const ledger = new (requireZekoX402Module().InMemorySettlementLedger)({
    sponsoredBudget: sponsoredBudgetForRail(rail),
    budgetAsset: {
      symbol: rail.assetSymbol,
      decimals: rail.assetDecimals,
      standard: rail.assetStandard,
      ...(rail.assetAddress ? { address: rail.assetAddress } : {})
    }
  });
  settlementLedgers.set(key, ledger);
  return ledger;
}

function buildRemoteFacilitatorNote(rail: AgentX402RailPlan) {
  if (rail.rail === "base-usdc" && !rail.facilitatorUrl) {
    return "cdp";
  }

  return rail.facilitatorUrl ?? rail.facilitatorMode;
}

export function buildAgentX402Headers(input: {
  paymentRequired?: JsonRecord;
  paymentPayload?: JsonRecord;
  paymentResponse?: JsonRecord;
}) {
  return paymentHeaders(input);
}

function verifyAgentX402PaymentLocally(input: {
  runtime: AgentX402RuntimeContext;
  paymentPayload: JsonRecord;
}): AgentX402VerificationResult {
  const rail = matchingRuntimeRail(input.runtime, input.paymentPayload);
  if (!rail) {
    return {
      ok: false,
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      rail: input.runtime.runtimeRails[0]!,
      localVerification: { ok: false, reason: "Payment payload does not match any live SantaClawz x402 rail." },
      headers: paymentHeaders({
        paymentRequired: input.runtime.paymentRequired,
        paymentPayload: input.paymentPayload
      }),
      error: "Payment payload does not match any live SantaClawz x402 rail."
    };
  }

  const localVerification = requireZekoX402Module().verifyPayment({
    requirements: input.runtime.paymentRequired,
    payload: input.paymentPayload
  }) as JsonRecord;
  const headers = paymentHeaders({
    paymentRequired: input.runtime.paymentRequired,
    paymentPayload: input.paymentPayload
  });

  if (!localVerificationOk(localVerification)) {
    return {
      ok: false,
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      rail,
      localVerification,
      headers,
      ...(resultError(localVerification) ? { error: resultError(localVerification)! } : {})
    };
  }

  return {
    ok: true,
    paymentRequired: input.runtime.paymentRequired,
    paymentPayload: input.paymentPayload,
    rail,
    localVerification,
    headers
  };
}

export async function verifyAgentX402Payment(input: {
  runtime: AgentX402RuntimeContext;
  paymentPayload: JsonRecord;
}): Promise<AgentX402VerificationResult> {
  const verification = verifyAgentX402PaymentLocally(input);
  if (!verification.ok) {
    return verification;
  }

  const facilitator = facilitatorClientForRail(verification.rail);
  if (!facilitator) {
    return {
      ...verification,
      ok: false,
      error: `No live facilitator is configured for ${verification.rail.rail}.`
    };
  }

  const remoteVerification = (await facilitator.verify({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  })) as JsonRecord;

  return {
    ok: remoteVerificationOk(remoteVerification),
    paymentRequired: verification.paymentRequired,
    paymentPayload: verification.paymentPayload,
    rail: verification.rail,
    localVerification: verification.localVerification,
    remoteVerification,
    headers: verification.headers,
    ...(!remoteVerificationOk(remoteVerification) && resultError(remoteVerification)
      ? { error: resultError(remoteVerification)! }
      : {})
  };
}

export async function settleAgentX402Payment(input: {
  runtime: AgentX402RuntimeContext;
  paymentPayload: JsonRecord;
}): Promise<AgentX402SettlementResult> {
  const verification = verifyAgentX402PaymentLocally(input);
  if (!verification.ok) {
    throw new Error(verification.error ?? "Unable to verify x402 payment.");
  }

  const facilitator = facilitatorClientForRail(verification.rail);
  if (!facilitator) {
    throw new Error(`No live facilitator is configured for ${verification.rail.rail}.`);
  }

  const remoteSettlement = (await facilitator.settle({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  })) as JsonRecord;

  if (remoteSettlement.success === false || remoteSettlement.ok === false) {
    throw new Error(resultError(remoteSettlement) ?? "Facilitator failed to settle the x402 payment.");
  }

  const remoteVerification = isRecord(remoteSettlement.verification)
    ? remoteSettlement.verification
    : {
        ok: true,
        isValid: true,
        source: "facilitator-settle",
        note: "The hosted facilitator settle path verifies the payment before broadcasting."
      };
  const settlementReference = [
    remoteSettlement.transaction,
    remoteSettlement.txHash,
    remoteSettlement.transactionHash,
    remoteSettlement.id
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  const ledger = settlementLedgerForRail(verification.rail);
  const ledgerResult = ledger.settle({
    ...input.paymentPayload,
    resource: input.runtime.paymentRequired.resource,
    ...(settlementReference ? { settlementReference } : {})
  }) as JsonRecord;

  const paymentResponse = requireZekoX402Module().buildSettlementResponse({
    payload: input.paymentPayload,
    duplicate: ledgerResult.duplicate,
    eventIds: ledgerResult.settlement && isRecord(ledgerResult.settlement) && Array.isArray(ledgerResult.settlement.eventIds)
      ? ledgerResult.settlement.eventIds
      : [],
    settledAtIso:
      ledgerResult.settlement && isRecord(ledgerResult.settlement) && typeof ledgerResult.settlement.settledAtIso === "string"
        ? ledgerResult.settlement.settledAtIso
        : new Date().toISOString(),
    remainingBudget: ledgerResult.remainingBudget,
    sponsoredBudget: ledgerResult.sponsoredBudget,
    budgetAsset: ledgerResult.budgetAsset,
    proofBundleUrl: input.runtime.plan.proofBundleUrl,
    verifyUrl: input.runtime.plan.verifyProofUrl,
    settlementModel: verification.rail.settlementModel,
    ...(settlementReference ? { settlementReference } : {}),
    evm: {
      networkId: verification.rail.networkId,
      facilitatorUrl: buildRemoteFacilitatorNote(verification.rail),
      verification: remoteVerification,
      settlement: remoteSettlement
    }
  }) as JsonRecord;

  return {
    ...verification,
    remoteVerification,
    remoteSettlement,
    paymentResponse,
    headers: paymentHeaders({
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      paymentResponse
    })
  };
}
