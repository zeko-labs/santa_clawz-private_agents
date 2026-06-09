import { canonicalDigest } from "@clawz/protocol";
import {
  Field,
  Mina,
  Poseidon,
  PrivateKey,
  PublicKey,
  fetchAccount
} from "o1js";

import { SocialAnchorKernel } from "../social/SocialAnchorKernel.js";
import { normalizeGraphqlEndpoint } from "./network.js";

const ZERO_FIELD = Field.fromJSON("0");
const NANO_MINA_PER_MINA = 1_000_000_000n;
const DEFAULT_SOCIAL_ANCHOR_FEE_RAW = 100_000_000n;
const DEFAULT_SOCIAL_ANCHOR_MAX_ATTEMPTS = 3;
const DEFAULT_SOCIAL_ANCHOR_RETRY_DELAY_MS = 1_500;
const DEFAULT_SOCIAL_ANCHOR_CONFIRMATION_WAIT_MS = 10_000;
const DEFAULT_SOCIAL_ANCHOR_CONFIRMATION_POLL_MS = 2_000;
const DEFAULT_SOCIAL_ANCHOR_FEE_BUMP_BPS = [10_000, 12_500, 16_000, 20_000, 25_000];
let socialAnchorKernelCompiled = false;

export interface SocialAnchorBatchCommitmentInput {
  batchId: string;
  sessionId: string;
  rootDigestSha256: string;
}

export interface SubmitSocialAnchorBatchOnZekoInput extends SocialAnchorBatchCommitmentInput {
  submitterPrivateKey: string;
  socialAnchorPrivateKey: string;
  socialAnchorPublicKey?: string;
  networkId?: string;
  mina?: string;
  archive?: string;
  fee?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  confirmationWaitMs?: number;
}

export interface SubmitSocialAnchorBatchOnZekoResult {
  networkId: string;
  contractAddress: string;
  anchorField: string;
  digestField: string;
  confirmed: boolean;
  confirmationSource?: "latest-state" | "event-log";
  observedAtIso?: string;
  observedBlockHeight?: string;
  submitFeeRaw: string;
  submitFee: string;
  submitFeeSource: string;
  attemptCount: number;
  txHash?: string;
}

export interface SocialAnchorFeeQuote {
  feeRaw: string;
  fee: string;
  source: string;
}

export interface SocialAnchorKernelObservedState {
  networkId: string;
  contractAddress: string;
  latestBatchRoot?: string;
  latestBatchDigest?: string;
  anchoredBatchCount?: string;
  recentAnchoredBatches?: SocialAnchorKernelAnchoredBatchEvent[];
  observedAtIso: string;
}

export interface SocialAnchorKernelAnchoredBatchEvent {
  anchorField: string;
  txHash?: string;
  blockHeight?: string;
  observedAtIso: string;
}

export function assertSocialAnchorSigningKeys(input: {
  submitterPublicKey: string;
  socialAnchorPublicKey: string;
  socialAnchorSignerPublicKey: string;
}) {
  if (input.socialAnchorPublicKey !== input.socialAnchorSignerPublicKey) {
    throw new Error(
      `SocialAnchorKernel key mismatch: configured public key ${input.socialAnchorPublicKey} does not match SOCIAL_ANCHOR_PRIVATE_KEY public key ${input.socialAnchorSignerPublicKey}.`
    );
  }
  if (input.socialAnchorPublicKey === input.submitterPublicKey) {
    throw new Error(
      "SocialAnchorKernel key mismatch: CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY resolves to the fee submitter. Use a dedicated SocialAnchorKernel zkApp key, not the submitter/deployer key."
    );
  }
}

function digestToField(value: unknown): Field {
  const digest = canonicalDigest(value);
  const chunks = digest.fieldChunks.map((chunk) => Field.fromJSON(chunk));
  return Poseidon.hash(chunks.length > 0 ? chunks : [ZERO_FIELD]);
}

export function buildSocialAnchorBatchDigestField(rootDigestSha256: string): Field {
  return digestToField({
    type: "clawz-social-anchor-digest-v1",
    rootDigestSha256
  });
}

export function buildSocialAnchorBatchRootField(input: SocialAnchorBatchCommitmentInput): Field {
  return digestToField({
    type: "clawz-social-anchor-batch-v1",
    batchId: input.batchId,
    sessionId: input.sessionId,
    rootDigestSha256: input.rootDigestSha256
  });
}

function parseRawFee(value: string | undefined): bigint | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = BigInt(trimmed);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function rawNanoToMinaString(raw: bigint): string {
  const whole = raw / NANO_MINA_PER_MINA;
  const fraction = raw % NANO_MINA_PER_MINA;
  if (fraction === 0n) {
    return `${whole}.0`;
  }

  return `${whole}.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlRequest<T>(graphqlUrl: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) {
    throw new Error(`graphql_http_${response.status}`);
  }
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message || "graphql_error");
  }
  if (!payload.data) {
    throw new Error("graphql_missing_data");
  }
  return payload.data;
}

export function estimateSocialAnchorFeeQuote(configuredFee?: string): SocialAnchorFeeQuote {
  const configured = parseRawFee(configuredFee);
  const feeRaw = configured ?? DEFAULT_SOCIAL_ANCHOR_FEE_RAW;
  return {
    feeRaw: feeRaw.toString(),
    fee: rawNanoToMinaString(feeRaw),
    source: configured ? "configured-floor" : "default-floor"
  };
}

export function buildSocialAnchorFeeAttemptPlan(baseFeeRaw: string, maxAttempts = DEFAULT_SOCIAL_ANCHOR_MAX_ATTEMPTS): string[] {
  const parsedBaseFee = parseRawFee(baseFeeRaw) ?? DEFAULT_SOCIAL_ANCHOR_FEE_RAW;
  const attempts = Math.max(1, Math.min(maxAttempts, DEFAULT_SOCIAL_ANCHOR_FEE_BUMP_BPS.length));
  return DEFAULT_SOCIAL_ANCHOR_FEE_BUMP_BPS.slice(0, attempts).map((multiplierBps) =>
    ((parsedBaseFee * BigInt(multiplierBps) + 9_999n) / 10_000n).toString()
  );
}

export function isRetryableSocialAnchorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return [
    "Account_nonce_precondition_unsatisfied",
    "Gateway Timeout",
    "504",
    "503",
    "fetch failed",
    "Failed to fetch",
    "socket hang up",
    "ECONNRESET",
    "ETIMEDOUT",
    "network timeout",
    "graphql_http_502",
    "graphql_http_503",
    "graphql_http_504"
  ].some((fragment) => message.includes(fragment));
}

async function readSequencerInferredNonce(graphqlUrl: string, publicKey: string): Promise<number | null> {
  try {
    const result = await graphqlRequest<{ account?: { nonce?: string | null; inferredNonce?: string | null } | null }>(
      graphqlUrl,
      `query SenderNonce($pk: PublicKey!) { account(publicKey: $pk) { nonce inferredNonce } }`,
      { pk: publicKey }
    );
    const inferredNonce = result.account?.inferredNonce ?? result.account?.nonce;
    if (typeof inferredNonce !== "string" || !/^\d+$/.test(inferredNonce)) {
      return null;
    }
    return Number(inferredNonce);
  } catch {
    return null;
  }
}

async function readSubmitterNonce(publicKey: PublicKey, graphqlUrl: string): Promise<number> {
  const inferredNonce = await readSequencerInferredNonce(graphqlUrl, publicKey.toBase58());
  if (typeof inferredNonce === "number" && Number.isFinite(inferredNonce) && inferredNonce >= 0) {
    return inferredNonce;
  }

  const account = await fetchAccount({ publicKey });
  if (account.error || !account.account) {
    throw new Error(`Submitter account fetch failed for ${publicKey.toBase58()}: ${account.error ?? "account missing"}`);
  }
  if (!account.account.nonce) {
    throw new Error(`Submitter account nonce missing for ${publicKey.toBase58()}`);
  }
  return Number(account.account.nonce.toString());
}

async function readSocialAnchorAppState(publicKey: PublicKey): Promise<string[]> {
  const account = await fetchAccount({ publicKey });
  if (account.error || !account.account) {
    throw new Error(`SocialAnchorKernel account fetch failed for ${publicKey.toBase58()}: ${account.error ?? "account missing"}`);
  }
  return (account.account.zkapp?.appState ?? []).map((field) => field.toString());
}

function latestBatchRootFromAppState(appState: string[]): string | undefined {
  return typeof appState[0] === "string" && appState[0].length > 0 ? appState[0] : undefined;
}

function fieldLikeToString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    const serialized = value.toString();
    return serialized && serialized !== "[object Object]" ? serialized : undefined;
  }
  if (Array.isArray(value)) {
    return fieldLikeToString(value[0]);
  }
  return undefined;
}

function socialAnchorEventFieldValue(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const record = event as {
    type?: unknown;
    event?: {
      data?: unknown;
      transactionInfo?: {
        transactionHash?: unknown;
      };
    };
    blockHeight?: unknown;
  };
  if (record.type !== "socialBatchAnchored") {
    return undefined;
  }
  return fieldLikeToString(record.event?.data);
}

function socialAnchorEventTxHash(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const txHash = (event as { event?: { transactionInfo?: { transactionHash?: unknown } } }).event?.transactionInfo?.transactionHash;
  return typeof txHash === "string" && txHash.length > 0 ? txHash : undefined;
}

function socialAnchorEventBlockHeight(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  return fieldLikeToString((event as { blockHeight?: unknown }).blockHeight);
}

async function readRecentSocialAnchorEvents(contractAddress: PublicKey): Promise<SocialAnchorKernelAnchoredBatchEvent[]> {
  const kernel = new SocialAnchorKernel(contractAddress);
  const events = await (kernel as unknown as { fetchEvents: () => Promise<unknown[]> }).fetchEvents();
  return events
    .map((event: unknown) => {
      const anchorField = socialAnchorEventFieldValue(event);
      if (!anchorField) {
        return undefined;
      }
      return {
        anchorField,
        ...(socialAnchorEventTxHash(event) ? { txHash: socialAnchorEventTxHash(event)! } : {}),
        ...(socialAnchorEventBlockHeight(event) ? { blockHeight: socialAnchorEventBlockHeight(event)! } : {}),
        observedAtIso: new Date().toISOString()
      };
    })
    .filter((event: SocialAnchorKernelAnchoredBatchEvent | undefined): event is SocialAnchorKernelAnchoredBatchEvent => Boolean(event))
    .slice(-200);
}

async function findAnchoredBatchEvent(
  contractAddress: PublicKey,
  expectedAnchorField: string
): Promise<SocialAnchorKernelAnchoredBatchEvent | undefined> {
  try {
    const events = await readRecentSocialAnchorEvents(contractAddress);
    return events.find((event) => event.anchorField === expectedAnchorField);
  } catch {
    return undefined;
  }
}

export async function readSocialAnchorKernelStateOnZeko(input: {
  socialAnchorPublicKey: string;
  networkId?: string;
  mina?: string;
  archive?: string;
}): Promise<SocialAnchorKernelObservedState> {
  const networkId = input.networkId ?? "testnet";
  const mina = normalizeGraphqlEndpoint(input.mina ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(input.archive ?? mina);
  Mina.setActiveInstance(
    Mina.Network({
      networkId: networkId as never,
      mina,
      archive
    })
  );

  const publicKey = PublicKey.fromBase58(input.socialAnchorPublicKey);
  const [appState, recentAnchoredBatches] = await Promise.all([
    readSocialAnchorAppState(publicKey),
    readRecentSocialAnchorEvents(publicKey).catch(() => [])
  ]);
  return {
    networkId,
    contractAddress: publicKey.toBase58(),
    ...(typeof appState[0] === "string" ? { latestBatchRoot: appState[0] } : {}),
    ...(typeof appState[1] === "string" ? { latestBatchDigest: appState[1] } : {}),
    ...(typeof appState[2] === "string" ? { anchoredBatchCount: appState[2] } : {}),
    ...(recentAnchoredBatches.length > 0 ? { recentAnchoredBatches } : {}),
    observedAtIso: new Date().toISOString()
  };
}

async function waitForAnchoredBatchRoot(
  contractAddress: PublicKey,
  expectedAnchorField: string,
  timeoutMs: number,
  pollIntervalMs = DEFAULT_SOCIAL_ANCHOR_CONFIRMATION_POLL_MS
): Promise<{ confirmed: boolean; source?: "latest-state" | "event-log"; event?: SocialAnchorKernelAnchoredBatchEvent }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appState = await readSocialAnchorAppState(contractAddress);
      if (latestBatchRootFromAppState(appState) === expectedAnchorField) {
        return { confirmed: true, source: "latest-state" };
      }
      const event = await findAnchoredBatchEvent(contractAddress, expectedAnchorField);
      if (event) {
        return { confirmed: true, source: "event-log", event };
      }
    } catch {}
    await sleep(pollIntervalMs);
  }
  const lateEvent = await findAnchoredBatchEvent(contractAddress, expectedAnchorField);
  return lateEvent ? { confirmed: true, source: "event-log", event: lateEvent } : { confirmed: false };
}

export async function submitSocialAnchorBatchOnZeko(
  input: SubmitSocialAnchorBatchOnZekoInput
): Promise<SubmitSocialAnchorBatchOnZekoResult> {
  const networkId = input.networkId ?? "testnet";
  const mina = normalizeGraphqlEndpoint(input.mina ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(input.archive ?? mina);
  const network = Mina.Network({
    networkId: networkId as never,
    mina,
    archive
  });
  Mina.setActiveInstance(network);

  if (!socialAnchorKernelCompiled) {
    await SocialAnchorKernel.compile();
    socialAnchorKernelCompiled = true;
  }

  const submitter = PrivateKey.fromBase58(input.submitterPrivateKey);
  const socialAnchorKey = PrivateKey.fromBase58(input.socialAnchorPrivateKey);
  const contractAddress = input.socialAnchorPublicKey
    ? PublicKey.fromBase58(input.socialAnchorPublicKey)
    : socialAnchorKey.toPublicKey();
  const contractAddressBase58 = contractAddress.toBase58();
  assertSocialAnchorSigningKeys({
    submitterPublicKey: submitter.toPublicKey().toBase58(),
    socialAnchorPublicKey: contractAddressBase58,
    socialAnchorSignerPublicKey: socialAnchorKey.toPublicKey().toBase58()
  });
  const contractAccount = await fetchAccount({ publicKey: contractAddress });
  if (contractAccount.error) {
    throw new Error(
      `SocialAnchorKernel account not found on ${networkId}: ${contractAddressBase58}. Deploy the contract before anchoring batches.`
    );
  }

  const batchRootField = buildSocialAnchorBatchRootField(input);
  const batchDigestField = buildSocialAnchorBatchDigestField(input.rootDigestSha256);
  const kernel = new SocialAnchorKernel(contractAddress);
  const feeQuote = estimateSocialAnchorFeeQuote(input.fee);
  const feeAttempts = buildSocialAnchorFeeAttemptPlan(feeQuote.feeRaw, input.maxAttempts);
  const retryDelayMs = Math.max(250, input.retryDelayMs ?? DEFAULT_SOCIAL_ANCHOR_RETRY_DELAY_MS);
  const confirmationWaitMs = Math.max(2_000, input.confirmationWaitMs ?? DEFAULT_SOCIAL_ANCHOR_CONFIRMATION_WAIT_MS);
  const expectedAnchorField = batchRootField.toString();

  let lastError: unknown;
  for (let attempt = 1; attempt <= feeAttempts.length; attempt += 1) {
    const submitFeeRaw = feeAttempts[attempt - 1] ?? feeQuote.feeRaw;
    const submitterNonce = await readSubmitterNonce(submitter.toPublicKey(), mina);
    try {
      const tx = await Mina.transaction(
        { sender: submitter.toPublicKey(), fee: submitFeeRaw, nonce: submitterNonce } as never,
        async () => {
          await kernel.anchorBatch(batchRootField, batchDigestField);
        }
      );
      const pending = await tx.sign([submitter, socialAnchorKey]).send();
      const txHash =
        typeof pending === "object" &&
        pending !== null &&
        "hash" in pending &&
        typeof (pending as { hash?: unknown }).hash === "string"
          ? ((pending as { hash: string }).hash)
          : undefined;

      const confirmation = await waitForAnchoredBatchRoot(contractAddress, expectedAnchorField, confirmationWaitMs);
      const observedTxHash = confirmation.event?.txHash ?? txHash;
      return {
        networkId,
        contractAddress: contractAddressBase58,
        anchorField: expectedAnchorField,
        digestField: batchDigestField.toString(),
        confirmed: confirmation.confirmed,
        ...(confirmation.source ? { confirmationSource: confirmation.source } : {}),
        ...(confirmation.confirmed ? { observedAtIso: confirmation.event?.observedAtIso ?? new Date().toISOString() } : {}),
        ...(confirmation.event?.blockHeight ? { observedBlockHeight: confirmation.event.blockHeight } : {}),
        submitFeeRaw,
        submitFee: rawNanoToMinaString(parseRawFee(submitFeeRaw) ?? DEFAULT_SOCIAL_ANCHOR_FEE_RAW),
        submitFeeSource: attempt === 1 ? feeQuote.source : "retry-bump",
        attemptCount: attempt,
        ...(observedTxHash ? { txHash: observedTxHash } : {})
      };
    } catch (error) {
      lastError = error;
      const confirmation = await waitForAnchoredBatchRoot(contractAddress, expectedAnchorField, Math.min(confirmationWaitMs, 6_000));
      if (confirmation.confirmed) {
        return {
          networkId,
          contractAddress: contractAddressBase58,
          anchorField: expectedAnchorField,
          digestField: batchDigestField.toString(),
          confirmed: true,
          ...(confirmation.source ? { confirmationSource: confirmation.source } : {}),
          observedAtIso: confirmation.event?.observedAtIso ?? new Date().toISOString(),
          ...(confirmation.event?.blockHeight ? { observedBlockHeight: confirmation.event.blockHeight } : {}),
          submitFeeRaw,
          submitFee: rawNanoToMinaString(parseRawFee(submitFeeRaw) ?? DEFAULT_SOCIAL_ANCHOR_FEE_RAW),
          submitFeeSource: attempt === 1 ? feeQuote.source : "retry-bump",
          attemptCount: attempt,
          ...(confirmation.event?.txHash ? { txHash: confirmation.event.txHash } : {})
        };
      }
      if (!isRetryableSocialAnchorError(error) || attempt === feeAttempts.length) {
        break;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(
    `SocialAnchorKernel batch submit failed after ${feeAttempts.length} attempt${feeAttempts.length === 1 ? "" : "s"}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
