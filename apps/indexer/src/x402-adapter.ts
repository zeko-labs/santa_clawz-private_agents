import type {
  AgentPaymentRail,
  AgentPricingMode,
  AgentX402Plan,
  AgentX402RailPlan,
  ConsoleStateResponse
} from "@clawz/protocol";
import {
  buildProtocolOwnerFeePreviews,
  type NetworkFacilitationFeeEstimate,
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
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const DEV_MIN_NETWORK_FACILITATION_FEE_USD = "0.001";
const DEFAULT_BASE_SETTLEMENT_GAS_UNITS = 90_000n;
const DEFAULT_ETHEREUM_SETTLEMENT_GAS_UNITS = 110_000n;
const BASE_ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const ETHEREUM_ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const ETH_USD_FEED_LATEST_ROUND_DATA = "0xfeaf968c";

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
  buildBaseMainnetUsdcRail(input: {
    payTo: string;
    amount: string;
    facilitatorUrl?: string;
    protocolFeePayTo?: string;
    feeBps?: number;
    grossAmount?: string;
    sellerAmount?: string;
    protocolFeeAmount?: string;
    feeSettlementMode?: string;
  }): unknown;
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
  buildEthereumMainnetUsdcRail(input: {
    payTo: string;
    amount: string;
    facilitatorUrl?: string;
    protocolFeePayTo?: string;
    feeBps?: number;
    grossAmount?: string;
    sellerAmount?: string;
    protocolFeeAmount?: string;
    feeSettlementMode?: string;
  }): unknown;
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
  errorCode?: string;
}

interface AgentX402SettlementResult extends AgentX402VerificationResult {
  remoteSettlement: JsonRecord;
  paymentResponse: JsonRecord;
  settlementEvents: {
    settlementReference?: string;
    transactionHashes: string[];
    sellerSettlementTxHash?: string;
    protocolFeeTxHash?: string;
  };
}

const settlementLedgers = new Map<string, SettlementLedger>();
const ZERO_EVM_HASH = `0x${"0".repeat(64)}`;

function extractSettlementTransactionHashes(value: unknown): string[] {
  const hashes = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      if (/^0x[a-fA-F0-9]{64}$/.test(item) && item.toLowerCase() !== ZERO_EVM_HASH) {
        hashes.add(item);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const next of item) {
        visit(next);
      }
      return;
    }
    if (isRecord(item)) {
      for (const next of Object.values(item)) {
        visit(next);
      }
    }
  };
  visit(value);
  return [...hashes];
}

function normalizedSettlementEvents(remoteSettlement: JsonRecord) {
  const transactionHashes = extractSettlementTransactionHashes(remoteSettlement);
  const sellerSettlementTxHash = [
    remoteSettlement.transaction,
    remoteSettlement.txHash,
    remoteSettlement.transactionHash,
    remoteSettlement.sellerTransactionHash,
    isRecord(remoteSettlement.transactionHashes) ? remoteSettlement.transactionHashes.seller : undefined
  ].find((value): value is string =>
    typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) && value.toLowerCase() !== ZERO_EVM_HASH
  );
  const protocolFeeTxHash = [
    remoteSettlement.protocolFeeTransaction,
    remoteSettlement.protocolFeeTxHash,
    remoteSettlement.protocolFeeTransactionHash,
    isRecord(remoteSettlement.transactionHashes) ? remoteSettlement.transactionHashes.protocolFee : undefined
  ].find((value): value is string =>
    typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) && value.toLowerCase() !== ZERO_EVM_HASH
  );
  const settlementReference = [
    sellerSettlementTxHash,
    remoteSettlement.transaction,
    remoteSettlement.txHash,
    remoteSettlement.transactionHash,
    remoteSettlement.id
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  return {
    ...(settlementReference ? { settlementReference } : {}),
    transactionHashes,
    ...(sellerSettlementTxHash ? { sellerSettlementTxHash } : {}),
    ...(protocolFeeTxHash ? { protocolFeeTxHash } : {})
  };
}

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function x402SettlementIdentifier(paymentPayload: JsonRecord): string | undefined {
  return optionalString(paymentPayload.idempotencyKey) ?? optionalString(paymentPayload.paymentId);
}

function hostedEvmSettlementIsCanonical(rail: AgentX402RailPlan): boolean {
  return (
    rail.settlementRail === "evm" &&
    Boolean(rail.facilitatorUrl) &&
    (rail.rail === "base-usdc" || rail.rail === "ethereum-usdc")
  );
}

function budgetAssetForRail(rail: AgentX402RailPlan): JsonRecord {
  return {
    symbol: rail.assetSymbol,
    decimals: rail.assetDecimals,
    standard: rail.assetStandard,
    ...(rail.assetAddress ? { address: rail.assetAddress } : {})
  };
}

function hostedEvmCanonicalLedgerResult(input: {
  rail: AgentX402RailPlan;
  paymentPayload: JsonRecord;
  remoteSettlement: JsonRecord;
  remoteVerification: JsonRecord;
  settlementEvents: ReturnType<typeof normalizedSettlementEvents>;
}) {
  const settledAtIso =
    optionalString(input.remoteSettlement.settledAtIso) ??
    (isRecord(input.remoteSettlement.receipt) ? optionalString(input.remoteSettlement.receipt.settledAtIso) : undefined) ??
    new Date().toISOString();
  const eventIds = input.settlementEvents.transactionHashes.length > 0
    ? input.settlementEvents.transactionHashes
    : input.settlementEvents.settlementReference
      ? [input.settlementEvents.settlementReference]
      : [];
  return {
    duplicate:
      input.remoteSettlement.duplicate === true ||
      input.remoteSettlement.settlementState === "already_settled" ||
      input.remoteVerification.duplicate === true,
    settlement: {
      eventIds,
      settledAtIso
    },
    remainingBudget: optionalString(input.remoteSettlement.remainingBudget),
    sponsoredBudget: optionalString(input.remoteSettlement.sponsoredBudget),
    budgetAsset: isRecord(input.paymentPayload.asset) ? input.paymentPayload.asset : budgetAssetForRail(input.rail)
  };
}

function encodeBase64Json(value: JsonRecord): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function normalizePaymentRequiredEvmAmounts(value: JsonRecord): JsonRecord {
  const normalized: JsonRecord = { ...value };
  const accepts = Array.isArray(normalized.accepts) ? normalized.accepts : [];
  normalized.accepts = accepts.map((accept) => {
    if (!isRecord(accept)) {
      return accept;
    }

    const extensions = isRecord(accept.extensions) ? accept.extensions : undefined;
    const evm = extensions && isRecord(extensions.evm) ? extensions.evm : undefined;
    const feeSplit = evm && isRecord(evm.feeSplit) ? evm.feeSplit : undefined;
    const grossAmount = typeof feeSplit?.grossAmount === "string" ? feeSplit.grossAmount.trim() : "";
    if (!grossAmount || !/^\d+$/.test(grossAmount)) {
      return accept;
    }

    // The SantaClawz x402 contract treats EVM payment amount fields as token
    // minor units. Keep decimal display values in price/amountUsd, but force
    // accepts[].amount to the atomic gross amount when an exact fee split exists.
    const normalizedExtensions = isRecord(extensions)
      ? {
          ...extensions,
          evm: {
            ...(evm ?? {}),
            amountUnit: "atomic"
          }
        }
      : extensions;
    return {
      ...accept,
      amount: grossAmount,
      extensions: normalizedExtensions
    };
  });
  return normalized;
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
  return mode === "quote-required";
}

function isFreeTestPricing(mode: AgentPricingMode): boolean {
  return mode === "free-test";
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function reserveReleaseEscrowEnabled(rail: Extract<AgentPaymentRail, "base-usdc" | "ethereum-usdc">): boolean {
  if (rail === "base-usdc" && envFlagEnabled("CLAWZ_X402_BASE_RESERVE_RELEASE_ESCROW_ENABLED")) {
    return true;
  }
  if (rail === "ethereum-usdc" && envFlagEnabled("CLAWZ_X402_ETHEREUM_RESERVE_RELEASE_ESCROW_ENABLED")) {
    return true;
  }
  return envFlagEnabled("CLAWZ_X402_RESERVE_RELEASE_ESCROW_ENABLED");
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

function usdAmountToAssetAtomicAmount(amountUsd: string | undefined, assetDecimals: number): string | null {
  const usdAtomic = parseUsdAtomic(amountUsd);
  if (usdAtomic === null || assetDecimals < 0 || assetDecimals > 36) {
    return null;
  }
  if (assetDecimals === 6) {
    return usdAtomic.toString();
  }
  if (assetDecimals > 6) {
    return (usdAtomic * decimalScale(BigInt(assetDecimals - 6))).toString();
  }
  return (usdAtomic / decimalScale(BigInt(6 - assetDecimals))).toString();
}

function requireAssetAtomicAmount(rail: AgentX402RailPlan): string {
  const amount = usdAmountToAssetAtomicAmount(rail.amountUsd, rail.assetDecimals);
  if (!amount || BigInt(amount) <= 0n) {
    throw new Error(
      `Unable to convert ${rail.rail} amountUsd='${rail.amountUsd ?? ""}' into atomic ${rail.assetSymbol} units.`
    );
  }
  return amount;
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

function envList(names: string[]): string[] {
  return names.flatMap((name) =>
    (process.env[name]?.trim() ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function rpcUrlsForRail(rail: AgentPaymentRail): string[] {
  if (rail === "ethereum-usdc") {
    return envList([
      "CLAWZ_X402_ETHEREUM_RPC_URLS",
      "CLAWZ_X402_ETHEREUM_RPC_URL",
      "X402_ETHEREUM_RPC_URLS",
      "X402_ETHEREUM_RPC_URL",
      "ETHEREUM_RPC_URL",
      "ETHEREUM_MAINNET_RPC_URL"
    ]);
  }

  if (rail === "base-usdc") {
    return envList([
      "CLAWZ_X402_BASE_RPC_URLS",
      "CLAWZ_X402_BASE_RPC_URL",
      "X402_BASE_RPC_URLS",
      "X402_BASE_RPC_URL",
      "BASE_RPC_URL",
      "BASE_MAINNET_RPC_URL"
    ]);
  }

  return [];
}

async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) {
    throw new Error(`RPC request failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as JsonRecord;
  if (payload.error) {
    throw new Error("RPC request returned an error.");
  }
  return payload.result;
}

function parseRpcHex(value: unknown): bigint | null {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    return null;
  }
  return BigInt(value);
}

async function firstRpcResult<T>(urls: string[], request: (url: string) => Promise<T | null>): Promise<T | null> {
  for (const url of urls) {
    try {
      const result = await request(url);
      if (result !== null) {
        return result;
      }
    } catch {
      // Try the next configured RPC. The plan will fall back to the static floor if every RPC fails.
    }
  }
  return null;
}

function gasUnitsForRail(rail: AgentPaymentRail): bigint {
  const configured =
    rail === "ethereum-usdc"
      ? process.env.CLAWZ_X402_ETHEREUM_SETTLEMENT_GAS_UNITS?.trim()
      : process.env.CLAWZ_X402_BASE_SETTLEMENT_GAS_UNITS?.trim();
  try {
    const parsed = configured ? BigInt(configured) : null;
    if (parsed !== null && parsed > 0n) {
      return parsed;
    }
  } catch {
    // Ignore malformed overrides and use the measured default.
  }
  return rail === "ethereum-usdc" ? DEFAULT_ETHEREUM_SETTLEMENT_GAS_UNITS : DEFAULT_BASE_SETTLEMENT_GAS_UNITS;
}

function chainlinkEthUsdFeedForRail(rail: AgentPaymentRail): string | null {
  if (rail === "ethereum-usdc") {
    return process.env.CLAWZ_X402_ETHEREUM_ETH_USD_FEED?.trim() || ETHEREUM_ETH_USD_FEED;
  }
  if (rail === "base-usdc") {
    return process.env.CLAWZ_X402_BASE_ETH_USD_FEED?.trim() || BASE_ETH_USD_FEED;
  }
  return null;
}

function decimalScale(decimals: bigint): bigint {
  let scale = 1n;
  for (let index = 0n; index < decimals; index += 1n) {
    scale *= 10n;
  }
  return scale;
}

function scalePriceToUsdAtomic(value: bigint, decimals: bigint): bigint {
  if (decimals === 6n) {
    return value;
  }
  if (decimals > 6n) {
    return value / decimalScale(decimals - 6n);
  }
  return value * decimalScale(6n - decimals);
}

function signedInt256FromWord(word: string): bigint {
  const value = BigInt(`0x${word}`);
  const signBit = 1n << 255n;
  return value >= signBit ? value - (1n << 256n) : value;
}

async function readEthUsdAtomicFromChainlink(urls: string[], rail: AgentPaymentRail): Promise<{
  priceAtomic: bigint;
  source: string;
} | null> {
  const feedAddress = chainlinkEthUsdFeedForRail(rail);
  if (!feedAddress) {
    return null;
  }

  return firstRpcResult(urls, async (url) => {
    const [decimalsResult, latestRoundResult] = await Promise.all([
      jsonRpc(url, "eth_call", [{ to: feedAddress, data: "0x313ce567" }, "latest"]),
      jsonRpc(url, "eth_call", [{ to: feedAddress, data: ETH_USD_FEED_LATEST_ROUND_DATA }, "latest"])
    ]);
    const decimals = parseRpcHex(decimalsResult);
    if (decimals === null || decimals < 0n || decimals > 36n) {
      return null;
    }
    if (typeof latestRoundResult !== "string" || !latestRoundResult.startsWith("0x")) {
      return null;
    }

    const encoded = latestRoundResult.slice(2).padStart(64 * 5, "0");
    const answerWord = encoded.slice(64, 128);
    const answer = signedInt256FromWord(answerWord);
    if (answer <= 0n) {
      return null;
    }

    return {
      priceAtomic: scalePriceToUsdAtomic(answer, decimals),
      source: `chainlink:${feedAddress}`
    };
  });
}

function formatEthFromWei(value: bigint): string {
  const whole = value / WEI_PER_ETH;
  const fraction = value % WEI_PER_ETH;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole}.${fraction.toString().padStart(18, "0").replace(/0+$/, "")}`;
}

const networkFacilitationFeeCache = new Map<string, {
  expiresAt: number;
  value: NetworkFacilitationFeeEstimate | undefined;
}>();

async function estimateNetworkFacilitationFee(rail: AgentPaymentRail): Promise<NetworkFacilitationFeeEstimate | undefined> {
  if (rail !== "base-usdc" && rail !== "ethereum-usdc") {
    return undefined;
  }

  const cacheKey = rail;
  const cached = networkFacilitationFeeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const configuredFloorAtomic = parseUsdAtomic(minNetworkFacilitationFeeUsd());
  const rpcUrls = rpcUrlsForRail(rail);
  const gasUnits = gasUnitsForRail(rail);
  const gasPriceWei = await firstRpcResult(rpcUrls, async (url) => parseRpcHex(await jsonRpc(url, "eth_gasPrice")));
  const ethUsd = gasPriceWei !== null ? await readEthUsdAtomicFromChainlink(rpcUrls, rail) : null;
  const nativeAmountWei = gasPriceWei !== null ? gasPriceWei * gasUnits : null;
  const gasUsdAtomic =
    nativeAmountWei !== null && ethUsd !== null
      ? ceilDiv(nativeAmountWei * ethUsd.priceAtomic, WEI_PER_ETH)
      : null;
  const amountAtomic =
    gasUsdAtomic !== null && (configuredFloorAtomic === null || gasUsdAtomic > configuredFloorAtomic)
      ? gasUsdAtomic
      : configuredFloorAtomic;

  const value =
    amountAtomic !== null
      ? {
          amountUsd: formatUsdAtomic(amountAtomic),
          ...(gasPriceWei !== null && nativeAmountWei !== null
            ? {
                gasEstimate: {
                  gasUnits: gasUnits.toString(),
                  gasPriceWei: gasPriceWei.toString(),
                  nativeAmount: formatEthFromWei(nativeAmountWei),
                  nativeSymbol: "ETH" as const,
                  ...(ethUsd ? { nativeUsdPrice: formatUsdAtomic(ethUsd.priceAtomic), source: ethUsd.source } : { source: "rpc-gas-price" })
                }
              }
            : {})
        }
      : undefined;

  networkFacilitationFeeCache.set(cacheKey, {
    expiresAt: Date.now() + 10_000,
    value
  });
  return value;
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
  networkFacilitationFee?: NetworkFacilitationFeeEstimate;
  hostedFacilitator: boolean;
  missing: string[];
  notes: string[];
}) {
  if (!input.hostedFacilitator || input.profile.paymentProfile.pricingMode !== "fixed-exact") {
    return;
  }

  const minFeeAtomic = parseUsdAtomic(input.networkFacilitationFee?.amountUsd);
  const configuredMinAtomic = parseUsdAtomic(minHostedFacilitatorPaymentUsd(input.rail));
  const amountAtomic = parseUsdAtomic(input.profile.paymentProfile.fixedAmountUsd);
  const feeApplies = protocolOwnerFeeAppliesToRail(input.policy, input.rail);
  if (minFeeAtomic === null) {
    input.missing.push("Set CLAWZ_X402_MIN_NETWORK_FACILITATION_FEE_USD for hosted facilitator settlement.");
    input.notes.push("Hosted facilitator settlement needs an operator-configured network facilitation floor or a live RPC gas estimate.");
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

  const generatedFeeAtomic = (amountAtomic * BigInt(input.policy.feeBps)) / 10_000n;
  const effectiveFeeAtomic = minFeeAtomic > generatedFeeAtomic ? minFeeAtomic : generatedFeeAtomic;

  input.notes.push(
    `SantaClawz hosted facilitation uses the higher of ${input.policy.feeBps / 100}% or the current $${formatUsdAtomic(minFeeAtomic)} network facilitation estimate.`
  );
  if (generatedFeeAtomic < minFeeAtomic) {
    input.notes.push(
      `At this price, the network facilitation minimum is deducted from the payment before agent net proceeds.`
    );
  }
  if (amountAtomic <= effectiveFeeAtomic) {
    input.missing.push(`Set the fixed price above $${formatUsdAtomic(effectiveFeeAtomic, 2)} so the payment can cover hosted facilitation and leave agent proceeds.`);
  }
  if (configuredMinAtomic !== null && amountAtomic < configuredMinAtomic) {
    input.missing.push(`Set the fixed price to at least $${formatUsdAtomic(configuredMinAtomic, 2)} for hosted facilitator settlement.`);
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

  if (isQuotedPricing(profile.paymentProfile.pricingMode)) {
    if (!profile.paymentProfile.referencePriceUsd?.trim()) {
      missing.push("Set a reference price for discovery.");
    } else {
      notes.push("Request quote pricing starts with quote intake before emitting an exact x402 challenge.");
    }
    return {};
  }

  if (profile.paymentProfile.pricingMode === "free-test") {
    notes.push("Free-test mode does not emit an x402 payment challenge.");
    return {};
  }

  return {};
}

function buildBaseRailPlan(
  consoleState: ConsoleStateResponse,
  networkFacilitationFee?: NetworkFacilitationFeeEstimate
): AgentX402RailPlan {
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
  const baseCdpFacilitatorAllowed = !protocolFeeApplies || settleOnProof;
  const baseHostedFacilitatorConfigured = Boolean(
    facilitatorUrl || (baseCdpFacilitatorConfigured && baseCdpFacilitatorAllowed)
  );
  const hostedFacilitator = Boolean(!operatorFacilitatorUrl && baseHostedFacilitatorConfigured && !settleOnProof);
  const sellerEscrowContract = profile.paymentProfile.baseEscrowContract?.trim();
  const sharedEscrowContract = process.env.CLAWZ_X402_BASE_ESCROW_CONTRACT?.trim();
  const escrowContract = sellerEscrowContract || sharedEscrowContract;

  if (profile.availability !== "active") {
    missing.push("Restore this inactive agent before accepting new SantaClawz work.");
  }
  if (isFreeTestPricing(profile.paymentProfile.pricingMode)) {
    notes.push("Free-test mode does not emit an x402 payment challenge.");
    return {
      rail: "base-usdc",
      settlementRail: "evm",
      networkId: BASE_MAINNET.networkId,
      assetSymbol: BASE_MAINNET.assetSymbol,
      assetDecimals: BASE_MAINNET.assetDecimals,
      assetStandard: BASE_MAINNET.assetStandard,
      assetAddress: BASE_MAINNET.assetAddress,
      builderHint: "free-test",
      facilitatorMode: "free-test",
      settlementModel: "none",
      executionMode: executionMode(settlementTrigger),
      ready: false,
      missing,
      notes
    };
  }

  if (!payTo) {
    missing.push("Add a Base payout wallet.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);

  if (!baseHostedFacilitatorConfigured) {
    missing.push(
      protocolFeeApplies && !settleOnProof
        ? "Set CLAWZ_X402_BASE_FACILITATOR_URL to the SantaClawz hosted facilitator so exact Base payments can enforce the protocol fee split."
        : "Set CLAWZ_X402_BASE_FACILITATOR_URL, configure CDP x402 credentials, or add a Base facilitator URL for this agent."
    );
  }
  pushHostedFacilitatorFloor({
    rail: "base-usdc",
    profile,
    policy: consoleState.protocolOwnerFeePolicy,
    ...(networkFacilitationFee ? { networkFacilitationFee } : {}),
    hostedFacilitator,
    missing,
    notes
  });

  if (settleOnProof && !escrowContract) {
    missing.push("Provision a Base seller escrow or set CLAWZ_X402_BASE_ESCROW_CONTRACT for the shared reserve-release path.");
  }
  if (settleOnProof && !reserveReleaseEscrowEnabled("base-usdc")) {
    missing.push("Base reserve-release escrow is backend-only until CLAWZ_X402_BASE_RESERVE_RELEASE_ESCROW_ENABLED=true.");
  }

  if (operatorFacilitatorUrl && !settleOnProof) {
    notes.push("Base exact-price flows use the operator-hosted x402 facilitator for this agent.");
  }
  if (protocolFeeApplies) {
    notes.push(`SantaClawz marketplace routing applies a ${consoleState.protocolOwnerFeePolicy.feeBps / 100}% protocol owner fee on Base.`);
    notes.push(
      settleOnProof
        ? "Buyers see the gross price. SantaClawz keeps the protocol fee at reservation time, and only the seller net stays in escrow."
        : "Buyers sign seller-net and protocol-fee authorizations. The hosted facilitator settles both before SantaClawz sends work to the agent."
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
          : protocolFeeApplies
            ? "x402-exact-evm-fee-split-v1"
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

function buildEthereumRailPlan(
  consoleState: ConsoleStateResponse,
  networkFacilitationFee?: NetworkFacilitationFeeEstimate
): AgentX402RailPlan {
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

  if (profile.availability !== "active") {
    missing.push("Restore this inactive agent before accepting new SantaClawz work.");
  }
  if (isFreeTestPricing(profile.paymentProfile.pricingMode)) {
    notes.push("Free-test mode does not emit an x402 payment challenge.");
    return {
      rail: "ethereum-usdc",
      settlementRail: "evm",
      networkId: ETHEREUM_MAINNET.networkId,
      assetSymbol: ETHEREUM_MAINNET.assetSymbol,
      assetDecimals: ETHEREUM_MAINNET.assetDecimals,
      assetStandard: ETHEREUM_MAINNET.assetStandard,
      assetAddress: ETHEREUM_MAINNET.assetAddress,
      builderHint: "free-test",
      facilitatorMode: "free-test",
      settlementModel: "none",
      executionMode: executionMode(settlementTrigger),
      ready: false,
      missing,
      notes
    };
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
    ...(networkFacilitationFee ? { networkFacilitationFee } : {}),
    hostedFacilitator,
    missing,
    notes
  });

  if (settleOnProof && !escrowContract) {
    missing.push(
      "Provision an Ethereum seller escrow or set CLAWZ_X402_ETHEREUM_ESCROW_CONTRACT for the shared reserve-release path."
    );
  }
  if (settleOnProof && !reserveReleaseEscrowEnabled("ethereum-usdc")) {
    missing.push("Ethereum reserve-release escrow is backend-only until CLAWZ_X402_ETHEREUM_RESERVE_RELEASE_ESCROW_ENABLED=true.");
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
        : "Buyers sign seller-net and protocol-fee authorizations. The hosted facilitator settles both before SantaClawz sends work to the agent."
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
          : protocolFeeApplies
            ? "x402-exact-evm-fee-split-v1"
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

  if (profile.availability !== "active") {
    missing.push("Restore this inactive agent before accepting new SantaClawz work.");
  }
  if (isFreeTestPricing(profile.paymentProfile.pricingMode)) {
    notes.push("Free-test mode does not emit an x402 payment challenge.");
    return {
      rail: "zeko-native",
      settlementRail: "zeko",
      networkId: deployment.networkId,
      assetSymbol: defaultZekoAssetSymbol(deployment.networkId),
      assetDecimals: 9,
      assetStandard: "native",
      builderHint: "free-test",
      facilitatorMode: "free-test",
      settlementModel: "none",
      executionMode: executionMode(profile.paymentProfile.settlementTrigger),
      ready: false,
      missing,
      notes
    };
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
  networkFacilitationFeeByRail?: Partial<Record<AgentPaymentRail, NetworkFacilitationFeeEstimate>>;
}): AgentX402Plan {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const consoleState = input.consoleState;
  const sessionId = consoleState.session.sessionId;
  const agentId = consoleState.agentId;
  const profile = consoleState.profile;
  const protocolOwnerFeePolicy = consoleState.protocolOwnerFeePolicy;
  const feePreviewByRail = buildProtocolOwnerFeePreviews({
    policy: protocolOwnerFeePolicy,
    profile,
    ...(input.networkFacilitationFeeByRail ? { networkFacilitationFeeByRail: input.networkFacilitationFeeByRail } : {})
  });
  const query = toQueryString(sessionId);
  const rails = profile.paymentProfile.supportedRails.map((rail) => {
    if (rail === "base-usdc") {
      return buildBaseRailPlan(consoleState, input.networkFacilitationFeeByRail?.[rail]);
    }
    if (rail === "ethereum-usdc") {
      return buildEthereumRailPlan(consoleState, input.networkFacilitationFeeByRail?.[rail]);
    }
    return buildZekoRailPlan(consoleState);
  });
  const published = consoleState.published;

  return {
    serviceId: serviceIdFor(agentId),
    agentId,
    sessionId,
    published,
    ...(consoleState.readiness ? { readiness: consoleState.readiness } : {}),
    paymentsEnabled: consoleState.paymentsEnabled,
    paymentProfileReady: consoleState.paymentProfileReady,
    payoutAddressConfigured: consoleState.payoutAddressConfigured,
    pricingMode: profile.paymentProfile.pricingMode,
    settlementTrigger: profile.paymentProfile.settlementTrigger,
    ...(profile.paymentProfile.defaultRail ? { defaultRail: profile.paymentProfile.defaultRail } : {}),
    ...(profile.paymentProfile.quoteUrl ? { quoteUrl: profile.paymentProfile.quoteUrl } : {}),
    ...(profile.paymentProfile.referencePriceUsd ? { referencePriceUsd: profile.paymentProfile.referencePriceUsd } : {}),
    ...(profile.paymentProfile.referencePriceUnit ? { referencePriceUnit: profile.paymentProfile.referencePriceUnit } : {}),
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

export async function buildAgentX402PlanWithNetworkQuotes(input: {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
}): Promise<AgentX402Plan> {
  const entries = await Promise.all(
    input.consoleState.profile.paymentProfile.supportedRails.map(async (rail) => {
      const estimate = await estimateNetworkFacilitationFee(rail);
      return [rail, estimate] as const;
    })
  );
  const networkFacilitationFeeByRail = Object.fromEntries(
    entries.filter((entry): entry is [AgentPaymentRail, NetworkFacilitationFeeEstimate] => Boolean(entry[1]))
  ) as Partial<Record<AgentPaymentRail, NetworkFacilitationFeeEstimate>>;

  return buildAgentX402Plan({
    ...input,
    ...(Object.keys(networkFacilitationFeeByRail).length > 0 ? { networkFacilitationFeeByRail } : {})
  });
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
  const atomicAmount = rail.settlementRail === "evm" ? usdAmountToAssetAtomicAmount(amount, rail.assetDecimals) : null;
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
    amount: atomicAmount ?? amount,
    amountUsd: amount,
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
        ...(plan.referencePriceUsd ? { referencePriceUsd: plan.referencePriceUsd } : {}),
        ...(plan.referencePriceUnit ? { referencePriceUnit: plan.referencePriceUnit } : {}),
        amountUsd: amount,
        ...(atomicAmount ? { atomicAmount } : {}),
        settlementTrigger: plan.settlementTrigger,
        ...(feePreview ? { feePreview } : {}),
        missing: rail.missing,
        notes: rail.notes
      },
      ...(rail.settlementRail === "evm"
        ? {
            evm: {
              amountUnit: atomicAmount ? "atomic" : "decimal",
              ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {}),
              ...(rail.settlementContractAddress ? { escrowContract: rail.settlementContractAddress } : {}),
              ...(feePreview
                ? {
                    feeSplit: {
                      version: "protocol-owner-fee-v1",
                      feeBps: feePreview.feeBps,
                      ...(feePreview.protocolFeeRecipient ? { protocolFeePayTo: feePreview.protocolFeeRecipient } : {}),
                      ...(feePreview.sellerPayTo ? { sellerPayTo: feePreview.sellerPayTo } : {}),
                      ...(rail.executionMode !== "reserve-release" ? (exactFeeSplitForRail(feePreview) ?? {}) : {}),
                      feeSettlementMode:
                        rail.executionMode === "reserve-release"
                          ? plan.protocolOwnerFeePolicy?.settlementModel ?? "fee-on-reserve-v1"
                          : "exact-eip3009-split-v1"
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
        ...(input.plan.referencePriceUsd ? { referencePriceUsd: input.plan.referencePriceUsd } : {}),
        ...(input.plan.referencePriceUnit ? { referencePriceUnit: input.plan.referencePriceUnit } : {}),
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

    if (rail.settlementModel === "x402-exact-evm-fee-split-v1") {
      return null;
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

function exactFeeSplitForRail(
  feePreview: NonNullable<AgentX402Plan["feePreviewByRail"]>[number] | undefined
) {
  if (
    !feePreview?.protocolFeeRecipient ||
    !feePreview.protocolFeeAmountUsd ||
    !feePreview.sellerNetAmountUsd ||
    !feePreview.grossAmountUsd
  ) {
    return null;
  }

  const grossAmount = parseUsdAtomic(feePreview.grossAmountUsd);
  const sellerAmount = parseUsdAtomic(feePreview.sellerNetAmountUsd);
  const protocolFeeAmount = parseUsdAtomic(feePreview.protocolFeeAmountUsd);

  if (
    grossAmount === null ||
    sellerAmount === null ||
    protocolFeeAmount === null ||
    sellerAmount <= 0n ||
    protocolFeeAmount <= 0n ||
    sellerAmount + protocolFeeAmount !== grossAmount
  ) {
    return null;
  }

  return {
    protocolFeePayTo: feePreview.protocolFeeRecipient,
    feeBps: feePreview.feeBps,
    grossAmount: grossAmount.toString(),
    sellerAmount: sellerAmount.toString(),
    protocolFeeAmount: protocolFeeAmount.toString(),
    feeSettlementMode: "exact-eip3009-split-v1"
  };
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
  const atomicAmount = requireAssetAtomicAmount(rail);

  if (rail.executionMode === "reserve-release" && !escrowContract) {
    return null;
  }

  if (rail.rail === "base-usdc") {
    if (rail.executionMode === "reserve-release") {
      if (feePreview?.protocolFeeRecipient && feePreview.feeBps > 0) {
        return zekoX402Module.buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail({
          payTo: rail.payTo,
          amount: atomicAmount,
          escrowContract: escrowContract!,
          protocolFeePayTo: feePreview.protocolFeeRecipient,
          feeBps: feePreview.feeBps,
          ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
        }) as JsonRecord;
      }

      return zekoX402Module.buildBaseMainnetUsdcReserveReleaseRail({
        payTo: rail.payTo,
        amount: atomicAmount,
        escrowContract: escrowContract!,
        ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
      }) as JsonRecord;
    }

    const exactFeeSplit = exactFeeSplitForRail(feePreview);
    return zekoX402Module.buildBaseMainnetUsdcRail({
      payTo: rail.payTo,
      amount: atomicAmount,
      ...(exactFeeSplit ?? {}),
      ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
    }) as JsonRecord;
  }

  if (rail.rail === "ethereum-usdc") {
    if (rail.executionMode === "reserve-release") {
      if (feePreview?.protocolFeeRecipient && feePreview.feeBps > 0) {
        return zekoX402Module.buildEthereumMainnetUsdcReserveReleaseFeeOnReserveRail({
          payTo: rail.payTo,
          amount: atomicAmount,
          escrowContract: escrowContract!,
          protocolFeePayTo: feePreview.protocolFeeRecipient,
          feeBps: feePreview.feeBps,
          ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
        }) as JsonRecord;
      }

      return zekoX402Module.buildEthereumMainnetUsdcReserveReleaseRail({
        payTo: rail.payTo,
        amount: atomicAmount,
        escrowContract: escrowContract!,
        ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
      }) as JsonRecord;
    }

    const exactFeeSplit = exactFeeSplitForRail(feePreview);
    return zekoX402Module.buildEthereumMainnetUsdcRail({
      payTo: rail.payTo,
      amount: atomicAmount,
      ...(exactFeeSplit ?? {}),
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

  const paymentRequired = normalizePaymentRequiredEvmAmounts(
    zekoX402Module.buildPaymentRequired(paymentContext) as JsonRecord
  );

  return {
    plan: input.plan,
    serviceNetworkId: input.serviceNetworkId,
    paymentContext,
    paymentRequired,
    catalog: zekoX402Module.buildCatalog(paymentContext) as JsonRecord,
    runtimeRails
  };
}

export async function buildQuoteIntentX402RuntimeContext(input: {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
  serviceNetworkId: string;
  intentId: string;
  rail: AgentPaymentRail;
  amountUsd: string;
}): Promise<AgentX402RuntimeContext | null> {
  const quotePaymentProfile: ConsoleStateResponse["profile"]["paymentProfile"] = {
    ...input.consoleState.profile.paymentProfile,
    pricingMode: "fixed-exact",
    fixedAmountUsd: input.amountUsd
  };
  const quoteConsoleState: ConsoleStateResponse = {
    ...input.consoleState,
    profile: {
      ...input.consoleState.profile,
      paymentProfile: quotePaymentProfile
    }
  };
  const quotedPlan = await buildAgentX402PlanWithNetworkQuotes({
    baseUrl: input.baseUrl,
    consoleState: quoteConsoleState
  });
  const quoteResourceUrl = `${normalizeBaseUrl(input.baseUrl)}/api/x402/quote-intent?${new URLSearchParams({
    intentId: input.intentId
  }).toString()}`;
  const runtime = buildAgentX402RuntimeContext({
    baseUrl: input.baseUrl,
    plan: {
      ...quotedPlan,
      resourcePreviewUrl: quoteResourceUrl,
      verifyPaymentUrl: quoteResourceUrl,
      settlePaymentUrl: quoteResourceUrl,
      rails: quotedPlan.rails
        .filter((rail) => rail.rail === input.rail)
        .map((rail) => ({
          ...rail,
          amountUsd: input.amountUsd
        }))
    },
    serviceNetworkId: input.serviceNetworkId
  });

  if (!runtime) {
    return null;
  }

  const paymentContext = {
    ...runtime.paymentContext,
    resource: quoteResourceUrl,
    intentId: input.intentId,
    quoteBound: true,
    description: "Accepted SantaClawz quote payment for paid agent execution."
  } satisfies JsonRecord;

  return {
    ...runtime,
    paymentContext,
    paymentRequired: normalizePaymentRequiredEvmAmounts(
      requireZekoX402Module().buildPaymentRequired(paymentContext) as JsonRecord
    ),
    catalog: requireZekoX402Module().buildCatalog(paymentContext) as JsonRecord
  };
}

export async function buildActivationLaneX402RuntimeContext(input: {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
  serviceNetworkId: string;
  agentId: string;
  amountUsd: string;
}): Promise<AgentX402RuntimeContext | null> {
  const activationPaymentProfile: ConsoleStateResponse["profile"]["paymentProfile"] = {
    ...input.consoleState.profile.paymentProfile,
    pricingMode: "fixed-exact",
    fixedAmountUsd: input.amountUsd
  };
  const activationConsoleState: ConsoleStateResponse = {
    ...input.consoleState,
    profile: {
      ...input.consoleState.profile,
      paymentProfile: activationPaymentProfile
    }
  };
  const activationPlan = await buildAgentX402PlanWithNetworkQuotes({
    baseUrl: input.baseUrl,
    consoleState: activationConsoleState
  });
  const activationResourceUrl = `${normalizeBaseUrl(input.baseUrl)}/api/activation-lane/agents/${encodeURIComponent(input.agentId)}/hire`;
  const runtime = buildAgentX402RuntimeContext({
    baseUrl: input.baseUrl,
    plan: {
      ...activationPlan,
      serviceId: `${activationPlan.serviceId}:activation-lane`,
      resourcePreviewUrl: activationResourceUrl,
      verifyPaymentUrl: activationResourceUrl,
      settlePaymentUrl: activationResourceUrl,
      rails: activationPlan.rails.map((rail) => ({
        ...rail,
        amountUsd: input.amountUsd
      }))
    },
    serviceNetworkId: input.serviceNetworkId
  });

  if (!runtime) {
    return null;
  }

  const paymentContext = {
    ...runtime.paymentContext,
    resource: activationResourceUrl,
    activationLane: true,
    activationBuyer: "agent_job_pack",
    description: "SantaClawz activation lane paid probe for proving seller execution."
  } satisfies JsonRecord;

  return {
    ...runtime,
    paymentContext,
    paymentRequired: normalizePaymentRequiredEvmAmounts(
      requireZekoX402Module().buildPaymentRequired(paymentContext) as JsonRecord
    ),
    catalog: requireZekoX402Module().buildCatalog(paymentContext) as JsonRecord
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

function parseAtomicAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  return BigInt(value.trim());
}

function remoteVerificationFundingError(remoteVerification: JsonRecord): string | undefined {
  const balance = parseAtomicAmount(remoteVerification.balance);
  const feeSplit = isRecord(remoteVerification.feeSplit) ? remoteVerification.feeSplit : undefined;
  const required = parseAtomicAmount(feeSplit?.grossAmount) ?? parseAtomicAmount(remoteVerification.amount);
  if (balance === undefined || required === undefined || balance >= required) {
    return undefined;
  }
  const assetSymbol = typeof remoteVerification.assetSymbol === "string" ? remoteVerification.assetSymbol : "USDC";
  return `Payer does not hold enough ${assetSymbol} for the x402 payment.`;
}

function x402VerificationErrorCode(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (/signature verification failed/i.test(message)) {
    return "x402_signature_verification_failed";
  }
  if (/already used|authorization nonce/i.test(message)) {
    return "x402_authorization_already_used";
  }
  if (/not hold enough|insufficient|balance/i.test(message)) {
    return "x402_insufficient_balance";
  }
  if (/invalid x402 payment payload|missing or malformed|payload/i.test(message)) {
    return "x402_payload_shape_invalid";
  }
  return "x402_facilitator_verification_failed";
}

function assertHostedFacilitatorPayloadShape(paymentPayload: JsonRecord, rail: AgentX402RailPlan): void {
  if (!rail.facilitatorUrl || rail.settlementRail !== "evm") {
    return;
  }
  const missing: string[] = [];
  if (paymentPayload.protocol !== "x402") missing.push("protocol='x402'");
  if (typeof paymentPayload.networkId !== "string") missing.push("networkId");
  if (typeof paymentPayload.settlementRail !== "string") missing.push("settlementRail");
  if (typeof paymentPayload.payTo !== "string") missing.push("payTo");
  if (!x402SettlementIdentifier(paymentPayload)) missing.push("paymentId or idempotencyKey");
  const accepted = isRecord(paymentPayload.accepted) ? paymentPayload.accepted : undefined;
  if (!accepted) {
    missing.push("accepted");
  } else {
    if (typeof accepted.asset !== "string") missing.push("accepted.asset as token address string");
    if (typeof accepted.amount !== "string") missing.push("accepted.amount");
  }
  if (missing.length > 0) {
    throw new Error(
      [
        "Invalid x402 payment payload for the hosted EVM facilitator.",
        `Missing or malformed: ${missing.join(", ")}.`,
        "Pass the raw signed x402 payload emitted by the x402 client, a body shaped as { paymentPayload }, or a service-keyed wrapper unwrapped by pnpm buyer:pay-quote.",
        "Do not post the payment requirements object itself as the payment payload."
      ].join(" ")
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function facilitatorSettleMaxAttempts() {
  const raw = Number(process.env.CLAWZ_X402_FACILITATOR_SETTLE_ATTEMPTS ?? "2");
  return Number.isFinite(raw) ? Math.max(1, Math.min(Math.round(raw), 5)) : 2;
}

function facilitatorSettleRetryDelayMs() {
  const raw = Number(process.env.CLAWZ_X402_FACILITATOR_SETTLE_RETRY_DELAY_MS ?? "1500");
  return Number.isFinite(raw) ? Math.max(0, Math.min(Math.round(raw), 10_000)) : 1500;
}

function isRetryableFacilitatorSettlementError(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /replacement transaction underpriced|nonce too low|nonce expired|already known|transaction underpriced|temporarily unavailable|timeout|rate limit|429|502|503|504/i.test(
    text
  );
}

function facilitatorSettlementErrorMessage(error: unknown, attempt: number, maxAttempts: number) {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableFacilitatorSettlementError(error);
  if (!retryable) {
    return message;
  }
  return [
    message,
    `Facilitator settlement attempt ${attempt}/${maxAttempts} hit a retryable nonce/gas or transient error.`,
    "If this persists, retry the same x402 payment payload; the paymentId/idempotency extension should let the facilitator deduplicate settlement."
  ].join(" ");
}

async function settleWithFacilitatorRetry(input: {
  facilitator: FacilitatorClient;
  paymentPayload: JsonRecord;
  paymentRequirements: JsonRecord;
}) {
  const maxAttempts = facilitatorSettleMaxAttempts();
  const delayMs = facilitatorSettleRetryDelayMs();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return (await input.facilitator.settle({
        paymentPayload: input.paymentPayload,
        paymentRequirements: input.paymentRequirements
      })) as JsonRecord;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFacilitatorSettlementError(error)) {
        break;
      }
      if (delayMs > 0) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw new Error(facilitatorSettlementErrorMessage(lastError, maxAttempts, maxAttempts));
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

  assertHostedFacilitatorPayloadShape(input.paymentPayload, verification.rail);

  const remoteVerification = (await facilitator.verify({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  })) as JsonRecord;
  const remoteError = resultError(remoteVerification);
  const fundingError = remoteError ? undefined : remoteVerificationFundingError(remoteVerification);
  const remoteOk = remoteVerificationOk(remoteVerification) && !fundingError;
  const failureError = remoteError ?? fundingError;
  const failureCode = x402VerificationErrorCode(failureError);

  return {
    ok: remoteOk,
    paymentRequired: verification.paymentRequired,
    paymentPayload: verification.paymentPayload,
    rail: verification.rail,
    localVerification: verification.localVerification,
    remoteVerification,
    headers: verification.headers,
    ...(!remoteOk && failureError
      ? {
          error: failureError,
          ...(failureCode ? { errorCode: failureCode } : {})
        }
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
  assertHostedFacilitatorPayloadShape(input.paymentPayload, verification.rail);

  const remoteSettlement = await settleWithFacilitatorRetry({
    facilitator,
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  });

  if (remoteSettlement.success === false || remoteSettlement.ok === false) {
    const message = resultError(remoteSettlement) ?? "Facilitator failed to settle the x402 payment.";
    throw new Error(
      isRetryableFacilitatorSettlementError(message)
        ? `${message} Wait until service is restored, then retry with the same payment payload so the facilitator can deduplicate by paymentId/idempotency metadata.`
        : message
    );
  }

  const remoteVerification = isRecord(remoteSettlement.verification)
    ? remoteSettlement.verification
    : {
        ok: true,
        isValid: true,
        source: "facilitator-settle",
        note: "The hosted facilitator settle path verifies the payment before broadcasting."
      };
  const settlementEvents = normalizedSettlementEvents(remoteSettlement);
  const ledgerResult = hostedEvmSettlementIsCanonical(verification.rail)
    ? hostedEvmCanonicalLedgerResult({
        rail: verification.rail,
        paymentPayload: input.paymentPayload,
        remoteSettlement,
        remoteVerification,
        settlementEvents
      })
    : settlementLedgerForRail(verification.rail).settle({
        ...input.paymentPayload,
        resource: input.runtime.paymentRequired.resource,
        ...(settlementEvents.settlementReference ? { settlementReference: settlementEvents.settlementReference } : {})
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
    ...(settlementEvents.settlementReference ? { settlementReference: settlementEvents.settlementReference } : {}),
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
    settlementEvents,
    headers: paymentHeaders({
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      paymentResponse
    })
  };
}
