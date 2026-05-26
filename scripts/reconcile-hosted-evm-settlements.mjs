#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_PROTOCOL_FEE_RECIPIENT = "0xF787fF44c5e80c8165e1B4FB156411e2d42c91B2";
const RPC_TIMEOUT_MS = 30_000;
const MAX_LOOKBACK_BLOCKS = 250_000;

function parseArgs(argv) {
  const args = {
    commit: false,
    lookbackBlocks: 100_000,
    matchBeforeMs: 5 * 60 * 1000,
    matchAfterMs: 10 * 60 * 1000,
    dataDir: process.env.CLAWZ_DATA_DIR?.trim() || path.join(process.cwd(), ".clawz-data"),
    rpcUrl: process.env.CLAWZ_BASE_RPC_URL?.trim() || "https://mainnet.base.org"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--commit") {
      args.commit = true;
    } else if (arg === "--dry-run") {
      args.commit = false;
    } else if (arg === "--agent-id") {
      args.agentId = argv[++index];
    } else if (arg === "--data-dir") {
      args.dataDir = argv[++index];
    } else if (arg === "--rpc-url") {
      args.rpcUrl = argv[++index];
    } else if (arg === "--lookback-blocks") {
      args.lookbackBlocks = Number.parseInt(argv[++index] ?? "", 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.lookbackBlocks) || args.lookbackBlocks <= 0) {
    throw new Error("--lookback-blocks must be a positive integer.");
  }
  args.lookbackBlocks = Math.min(args.lookbackBlocks, MAX_LOOKBACK_BLOCKS);
  return args;
}

function printHelp() {
  console.log(`Usage:
  pnpm reconcile:x402 -- --agent-id <agent-id> [--dry-run]
  pnpm reconcile:x402 -- --agent-id <agent-id> --commit

This reconciles old hosted Base x402 settlement_failed ledger rows that were
caused by the local sponsored-budget ledger even though Base USDC transfers
settled on-chain. Dry-run is the default.`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function addressTopic(address) {
  const value = stringValue(address)?.toLowerCase();
  if (!value || !/^0x[a-f0-9]{40}$/.test(value)) {
    return undefined;
  }
  return `0x${value.slice(2).padStart(64, "0")}`;
}

function isTxHash(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) && value.toLowerCase() !== `0x${"0".repeat(64)}`;
}

function remoteVerification(entry) {
  const summary = entry.facilitatorResponseSummary;
  return isRecord(summary?.remoteVerification) ? summary.remoteVerification : undefined;
}

function feeSplit(entry) {
  const remote = remoteVerification(entry);
  return isRecord(remote?.feeSplit) ? remote.feeSplit : undefined;
}

function isSponsoredBudgetCandidate(entry, agentId) {
  return (
    (!agentId || entry.agentId === agentId) &&
    entry.paymentStatus === "settlement_failed" &&
    entry.rail === "base-usdc" &&
    entry.networkId === "eip155:8453" &&
    entry.executionStatus === "completed" &&
    entry.returnStatus === "accepted" &&
    typeof entry.errorMessage === "string" &&
    entry.errorMessage.includes("sponsored budget")
  );
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

async function rpcCall(rpcUrl, method, params) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (isRecord(payload.error)) {
        throw new Error(typeof payload.error.message === "string" ? payload.error.message : JSON.stringify(payload.error));
      }
      return payload.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchTransferLogs(input) {
  const latestHex = await rpcCall(input.rpcUrl, "eth_blockNumber", []);
  const latestBlock = Number.parseInt(latestHex, 16);
  const startBlock = Math.max(0, latestBlock - input.lookbackBlocks);
  const step = 9999;
  const rawLogs = [];
  for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += step + 1) {
    const toBlock = Math.min(latestBlock, fromBlock + step);
    const result = await rpcCall(input.rpcUrl, "eth_getLogs", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: USDC_BASE,
      topics: [TRANSFER_TOPIC, input.fromTopic, input.toTopic]
    }]);
    rawLogs.push(...result.filter(isRecord));
  }

  const parsedLogs = [];
  for (const log of rawLogs) {
    const tx = stringValue(log.transactionHash);
    const blockHex = stringValue(log.blockNumber);
    const data = stringValue(log.data);
    if (!isTxHash(tx) || !blockHex || !data) continue;
    const blockNumber = Number.parseInt(blockHex, 16);
    parsedLogs.push({
      transactionHash: tx,
      blockNumber,
      valueAtomic: BigInt(data).toString(),
      blockHex
    });
  }
  const blockTimes = new Map(await Promise.all(
    [...new Map(parsedLogs.map((log) => [log.blockNumber, log.blockHex])).entries()].map(async ([blockNumber, blockHex]) => {
      const block = await rpcCall(input.rpcUrl, "eth_getBlockByNumber", [blockHex, false]);
      const timestampHex = stringValue(block?.timestamp) || "0x0";
      return [blockNumber, new Date(Number(BigInt(timestampHex)) * 1000).toISOString()];
    })
  ));
  return parsedLogs.map(({ blockHex: _blockHex, ...log }) => ({
    ...log,
    occurredAtIso: blockTimes.get(log.blockNumber)
  }));
}

function routeForEntry(entry) {
  const remote = remoteVerification(entry);
  const split = feeSplit(entry);
  const payerTopic = addressTopic(remote?.payer);
  const sellerTopic = addressTopic(split?.sellerPayTo ?? entry.sellerPayTo);
  const protocolTopic = addressTopic(split?.protocolFeePayTo ?? entry.protocolFeeRecipient ?? DEFAULT_PROTOCOL_FEE_RECIPIENT);
  if (!payerTopic || !sellerTopic || !protocolTopic) {
    return undefined;
  }
  return { payerTopic, sellerTopic, protocolTopic, key: `${payerTopic}:${sellerTopic}:${protocolTopic}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = path.join(args.dataDir, "state");
  const ledgerPath = path.join(stateDir, "payment-ledger.json");
  const hirePath = path.join(stateDir, "hire-requests.json");
  const ledger = await readJson(ledgerPath, { entries: [] });
  const hireRequests = await readJson(hirePath, { requests: [] });
  const candidates = ledger.entries.filter((entry) => isSponsoredBudgetCandidate(entry, args.agentId));

  const routes = new Map();
  for (const entry of candidates) {
    const route = routeForEntry(entry);
    if (route && !routes.has(route.key)) {
      routes.set(route.key, route);
    }
  }

  for (const route of routes.values()) {
    route.sellerLogs = await fetchTransferLogs({
      rpcUrl: args.rpcUrl,
      lookbackBlocks: args.lookbackBlocks,
      fromTopic: route.payerTopic,
      toTopic: route.sellerTopic
    });
    route.protocolLogs = await fetchTransferLogs({
      rpcUrl: args.rpcUrl,
      lookbackBlocks: args.lookbackBlocks,
      fromTopic: route.payerTopic,
      toTopic: route.protocolTopic
    });
  }

  const usedSellerTxs = new Set();
  const matches = [];
  for (const entry of [...candidates].sort((left, right) => Date.parse(left.updatedAtIso) - Date.parse(right.updatedAtIso))) {
    const route = routeForEntry(entry);
    const split = feeSplit(entry);
    const sellerAmount = stringValue(split?.sellerAmount);
    const protocolFeeAmount = stringValue(split?.protocolFeeAmount);
    const loadedRoute = route ? routes.get(route.key) : undefined;
    const entryTime = Date.parse(entry.updatedAtIso);
    const sellerMatch = loadedRoute?.sellerLogs
      ?.filter((log) => (
        log.valueAtomic === sellerAmount &&
        !usedSellerTxs.has(log.transactionHash.toLowerCase()) &&
        Date.parse(log.occurredAtIso) >= entryTime - args.matchBeforeMs &&
        Date.parse(log.occurredAtIso) <= entryTime + args.matchAfterMs
      ))
      .sort((left, right) => Math.abs(Date.parse(left.occurredAtIso) - entryTime) - Math.abs(Date.parse(right.occurredAtIso) - entryTime))[0];
    const protocolMatch = sellerMatch
      ? loadedRoute?.protocolLogs
        ?.filter((log) => log.valueAtomic === protocolFeeAmount && Math.abs(log.blockNumber - sellerMatch.blockNumber) <= 1)
        .sort((left, right) => {
          const leftSameTx = left.transactionHash.toLowerCase() === sellerMatch.transactionHash.toLowerCase();
          const rightSameTx = right.transactionHash.toLowerCase() === sellerMatch.transactionHash.toLowerCase();
          if (leftSameTx !== rightSameTx) return leftSameTx ? -1 : 1;
          return Math.abs(left.blockNumber - sellerMatch.blockNumber) - Math.abs(right.blockNumber - sellerMatch.blockNumber);
        })[0]
      : undefined;
    if (!sellerMatch || !protocolMatch) {
      matches.push({
        ledgerId: entry.ledgerId,
        requestId: entry.hireRequestId,
        matched: false,
        reason: "no_onchain_transfer_match"
      });
      continue;
    }
    usedSellerTxs.add(sellerMatch.transactionHash.toLowerCase());
    matches.push({
      ledgerId: entry.ledgerId,
      requestId: entry.hireRequestId,
      matched: true,
      sellerSettlementTxHash: sellerMatch.transactionHash,
      sellerSettlementBlock: sellerMatch.blockNumber,
      sellerSettlementAtIso: sellerMatch.occurredAtIso,
      protocolFeeTxHash: protocolMatch.transactionHash,
      protocolFeeBlock: protocolMatch.blockNumber,
      protocolFeeAtIso: protocolMatch.occurredAtIso
    });
  }

  if (args.commit) {
    const nowIso = new Date().toISOString();
    const matchByLedgerId = new Map(matches.filter((match) => match.matched).map((match) => [match.ledgerId, match]));
    ledger.entries = ledger.entries.map((entry) => {
      const match = matchByLedgerId.get(entry.ledgerId);
      if (!match) return entry;
      const transactionHashes = Array.from(new Set([
        ...(entry.transactionHashes ?? []),
        match.sellerSettlementTxHash,
        match.protocolFeeTxHash
      ]));
      const {
        errorCode: _errorCode,
        errorMessage: _errorMessage,
        lifecycleStatus: _lifecycleStatus,
        settlementRecovery: _settlementRecovery,
        ...clean
      } = entry;
      return {
        ...clean,
        updatedAtIso: nowIso,
        paymentStatus: "settled",
        settlementReference: match.sellerSettlementTxHash,
        sellerSettlementTxHash: match.sellerSettlementTxHash,
        protocolFeeTxHash: match.protocolFeeTxHash,
        transactionHashes,
        facilitatorResponseSummary: {
          ...(entry.facilitatorResponseSummary ?? {}),
          settlementReconciliation: {
            reconciledAtIso: nowIso,
            source: "render_shell_base_rpc_usdc_transfer_logs",
            reason: "onchain_usdc_transfer_match",
            priorErrorCode: entry.errorCode,
            priorErrorMessage: entry.errorMessage,
            sellerSettlementBlock: match.sellerSettlementBlock,
            protocolFeeBlock: match.protocolFeeBlock
          }
        }
      };
    });

    hireRequests.requests = hireRequests.requests.map((request) => {
      const match = matches.find((candidate) => candidate.matched && candidate.requestId === request.requestId);
      if (!match) return request;
      return {
        ...request,
        paymentStatus: "settled",
        operationalStatus: request.operationalStatus
          ? {
              ...request.operationalStatus,
              paymentStatus: "settled",
              settlementStatus: "settled"
            }
          : request.operationalStatus,
        payment: request.payment
          ? {
              ...request.payment,
              status: "settled",
              settlementReference: match.sellerSettlementTxHash,
              settlementEvents: {
                ...(request.payment.settlementEvents ?? {}),
                sellerSettlementTxHash: match.sellerSettlementTxHash,
                protocolFeeTxHash: match.protocolFeeTxHash,
                transactionHashes: [match.sellerSettlementTxHash, match.protocolFeeTxHash]
              }
            }
          : request.payment
      };
    });

    await writeJsonAtomic(ledgerPath, ledger);
    await writeJsonAtomic(hirePath, hireRequests);
  }

  console.log(JSON.stringify({
    ok: true,
    commit: args.commit,
    dataDir: args.dataDir,
    agentId: args.agentId ?? null,
    candidateCount: candidates.length,
    matchedCount: matches.filter((match) => match.matched).length,
    reconciledCount: args.commit ? matches.filter((match) => match.matched).length : 0,
    unmatchedCount: matches.filter((match) => !match.matched).length,
    matches
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
