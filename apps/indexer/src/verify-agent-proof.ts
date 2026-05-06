import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ClawzAgentDiscoveryDocument,
  type ClawzAgentProofBundle,
  type WitnessPlanLike,
  verifyAgentProofBundle
} from "@clawz/protocol";

interface CliOptions {
  url?: string;
  bundlePath?: string;
  discoveryPath?: string;
  witnessPlanPath?: string;
  sessionId?: string;
  turnId?: string;
  json: boolean;
  noWitnessPlan: boolean;
}

function printUsage() {
  console.log(
    [
      "Usage: node verify-agent-proof.js [options]",
      "",
      "Options:",
      "  --url <baseUrl>           Fetch discovery and proof bundle from a running ClawZ indexer",
      "  --bundle <path-or-url>    Read a proof bundle from disk or URL",
      "  --discovery <path-or-url> Read a discovery document from disk or URL",
      "  --witness-plan <path>     Optional deployment witness plan JSON to cross-check trust anchors",
      "  --session <sessionId>     Optional session override when fetching from --url",
      "  --turn <turnId>           Optional turn override when fetching from --url",
      "  --json                    Print full verification report as JSON",
      "  --no-witness-plan         Skip default local witness-plan lookup",
      "  --help                    Show this help"
    ].join("\n")
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    noWitnessPlan: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      continue;
    }

    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }

    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token === "--no-witness-plan") {
      options.noWitnessPlan = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value after ${token}`);
    }

    if (token === "--url") {
      options.url = value;
      index += 1;
      continue;
    }

    if (token === "--bundle") {
      options.bundlePath = value;
      index += 1;
      continue;
    }

    if (token === "--discovery") {
      options.discoveryPath = value;
      index += 1;
      continue;
    }

    if (token === "--witness-plan") {
      options.witnessPlanPath = value;
      index += 1;
      continue;
    }

    if (token === "--session") {
      options.sessionId = value;
      index += 1;
      continue;
    }

    if (token === "--turn") {
      options.turnId = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.url && !options.bundlePath) {
    throw new Error("Provide either --url or --bundle.");
  }

  return options;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readJson<T>(location: string): Promise<T> {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${location}: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  return JSON.parse(await readFile(location, "utf8")) as T;
}

async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    try {
      const raw = await readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed.name === "clawz") {
        return current;
      }
    } catch {}

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate ClawZ workspace root.");
    }
    current = parent;
  }
}

async function defaultWitnessPlanPath(): Promise<string | undefined> {
  const thisFile = fileURLToPath(import.meta.url);
  const workspaceRoot = await findWorkspaceRoot(path.dirname(thisFile));
  const candidates = [
    path.join(workspaceRoot, "packages", "contracts", "deployments", "latest-witness-plan.json"),
    path.join(workspaceRoot, "packages", "contracts", "artifacts", "deployment-witness-plan.json")
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  return undefined;
}

function printHumanReport(report: ReturnType<typeof verifyAgentProofBundle>) {
  const status = report.ok ? "PASS" : "FAIL";
  console.log(`${status} ${report.serviceId}`);
  console.log(`bundleDigest.sha256 = ${report.bundleDigestSha256}`);

  for (const check of report.checks) {
    console.log(`${check.ok ? "ok " : "bad"} ${check.label}${check.note ? ` - ${check.note}` : ""}`);
  }

  if (report.witnessPlanCoverage) {
    console.log(
      `witness plan: ${report.witnessPlanCoverage.ok ? "covered" : "missing"}${
        report.witnessPlanCoverage.scenarioId ? ` (${report.witnessPlanCoverage.scenarioId})` : ""
      }`
    );
    if (report.witnessPlanCoverage.missing.length > 0) {
      console.log(`missing: ${report.witnessPlanCoverage.missing.join(", ")}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let discovery: ClawzAgentDiscoveryDocument | undefined;
  let bundle: ClawzAgentProofBundle;

  if (options.url) {
    const baseUrl = normalizeBaseUrl(options.url);
    discovery = await readJson<ClawzAgentDiscoveryDocument>(`${baseUrl}/.well-known/clawz-agent.json`);

    const proofUrl = new URL(`${baseUrl}/api/interop/agent-proof`);
    if (options.sessionId) {
      proofUrl.searchParams.set("sessionId", options.sessionId);
    }
    if (options.turnId) {
      proofUrl.searchParams.set("turnId", options.turnId);
    }
    bundle = await readJson<ClawzAgentProofBundle>(proofUrl.toString());
  } else {
    bundle = await readJson<ClawzAgentProofBundle>(options.bundlePath!);
    if (options.discoveryPath) {
      discovery = await readJson<ClawzAgentDiscoveryDocument>(options.discoveryPath);
    }
  }

  let witnessPlan: WitnessPlanLike | undefined;
  const witnessPlanPath =
    options.witnessPlanPath ?? (!options.noWitnessPlan ? await defaultWitnessPlanPath() : undefined);
  if (witnessPlanPath) {
    witnessPlan = await readJson<WitnessPlanLike>(witnessPlanPath);
  }

  const report = verifyAgentProofBundle(bundle, {
    ...(discovery ? { discovery } : {}),
    ...(witnessPlan ? { witnessPlan } : {})
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
