import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();

function hasValue(name) {
  return Boolean(process.env[name]?.trim());
}

function splitCsv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function exists(relativePath) {
  try {
    await access(path.join(workspaceRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(workspaceRoot, relativePath), "utf8"));
}

async function fileMode(relativePath) {
  try {
    const info = await stat(path.join(workspaceRoot, relativePath));
    return info.mode & 0o777;
  } catch {
    return undefined;
  }
}

function addCheck(checks, label, ok, detail, severity = "fail") {
  checks.push({
    label,
    ok,
    detail,
    severity
  });
}

function isProductionEnv() {
  return process.env.NODE_ENV === "production" || process.env.CLAWZ_RUNTIME_ENV === "production";
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(process.env[name]?.trim().toLowerCase() ?? "");
}

async function main() {
  const json = process.argv.includes("--json");
  const checks = [];
  const warnings = [];
  const productionMode = isProductionEnv();
  const authMode = process.env.CLAWZ_REQUIRE_API_AUTH?.trim().toLowerCase() ?? "auto";
  const authRequired = authMode === "auto" ? productionMode : ["1", "true", "yes", "on"].includes(authMode);
  const apiKeyHashes = splitCsv(process.env.CLAWZ_API_KEY_SHA256);
  const apiKeys = splitCsv(process.env.CLAWZ_API_KEYS);
  const allowedOrigins = splitCsv(process.env.CLAWZ_ALLOWED_ORIGINS);
  const keyMode = process.env.CLAWZ_KEY_BROKER_MODE?.trim() || "durable-local-file-backed";
  const blobStoreMode = process.env.CLAWZ_BLOB_STORE_MODE?.trim() || "local-file-backed";
  const publicProofSurface = process.env.CLAWZ_PUBLIC_PROOF_SURFACE?.trim() || (productionMode ? "discovery-only" : "full");
  const dataDir = process.env.CLAWZ_DATA_DIR?.trim();
  const regulatedEnterprise = isTruthyEnv("CLAWZ_REGULATED_ENTERPRISE");

  addCheck(checks, "workspace", await exists("pnpm-workspace.yaml"), "pnpm workspace manifest");
  addCheck(checks, "runtime env", productionMode, "NODE_ENV=production or CLAWZ_RUNTIME_ENV=production");
  addCheck(checks, "api auth required", authRequired, `CLAWZ_REQUIRE_API_AUTH=${authMode}`);
  addCheck(
    checks,
    "api key configured",
    apiKeyHashes.length + apiKeys.length > 0,
    "CLAWZ_API_KEY_SHA256 or CLAWZ_API_KEYS"
  );
  addCheck(
    checks,
    "cors allowlist",
    allowedOrigins.length > 0 && !allowedOrigins.includes("*"),
    allowedOrigins.length > 0 ? allowedOrigins.join(",") : "CLAWZ_ALLOWED_ORIGINS is empty"
  );
  addCheck(
    checks,
    "key broker mode",
    keyMode !== "in-memory-default-export",
    `CLAWZ_KEY_BROKER_MODE=${keyMode}`
  );
  addCheck(
    checks,
    "data directory",
    Boolean(dataDir),
    dataDir || "CLAWZ_DATA_DIR is not set; runtime will default to .clawz-data",
    "warn"
  );
  addCheck(
    checks,
    "blob store mode",
    blobStoreMode === "http-object-store" || Boolean(dataDir),
    `CLAWZ_BLOB_STORE_MODE=${blobStoreMode}`,
    "warn"
  );

  if (keyMode === "external-kms-backed") {
    addCheck(checks, "external kms endpoint", hasValue("CLAWZ_KMS_ENDPOINT"), "CLAWZ_KMS_ENDPOINT");
    addCheck(checks, "external kms auth", hasValue("CLAWZ_KMS_API_KEY"), "CLAWZ_KMS_API_KEY", "warn");
  } else if (keyMode === "durable-local-file-backed") {
    warnings.push("durable-local-file-backed is safe for pilot/self-hosted operators, but regulated enterprise deployments should use external-kms-backed mode.");
  }

  if (blobStoreMode === "http-object-store") {
    addCheck(checks, "blob object endpoint", hasValue("CLAWZ_BLOB_STORE_ENDPOINT"), "CLAWZ_BLOB_STORE_ENDPOINT");
    addCheck(checks, "blob object auth", hasValue("CLAWZ_BLOB_STORE_API_KEY"), "CLAWZ_BLOB_STORE_API_KEY", "warn");
  } else if (blobStoreMode === "local-file-backed") {
    warnings.push("local-file-backed blob storage is acceptable with a durable mounted CLAWZ_DATA_DIR; use http-object-store for object-storage-backed enterprise retention.");
  } else {
    addCheck(checks, "blob store mode valid", false, `Unsupported CLAWZ_BLOB_STORE_MODE=${blobStoreMode}`);
  }

  if (apiKeys.length > 0) {
    warnings.push("CLAWZ_API_KEYS contains plaintext API keys; prefer CLAWZ_API_KEY_SHA256 in production.");
  }

  if (publicProofSurface === "full") {
    warnings.push("CLAWZ_PUBLIC_PROOF_SURFACE=full exposes full proof bundles publicly; discovery-only is the safer enterprise default.");
  }

  if (regulatedEnterprise) {
    addCheck(
      checks,
      "regulated api key hash",
      apiKeyHashes.length > 0 && apiKeys.length === 0,
      "CLAWZ_REGULATED_ENTERPRISE=true requires CLAWZ_API_KEY_SHA256 and no CLAWZ_API_KEYS plaintext"
    );
    addCheck(
      checks,
      "regulated external key broker",
      keyMode === "external-kms-backed",
      "CLAWZ_KEY_BROKER_MODE=external-kms-backed"
    );
    addCheck(
      checks,
      "regulated external blob store",
      blobStoreMode === "http-object-store",
      "CLAWZ_BLOB_STORE_MODE=http-object-store"
    );
    addCheck(
      checks,
      "regulated privacy gateway attested",
      isTruthyEnv("CLAWZ_PRIVACY_GATEWAY_ATTESTED_EXTERNAL_HSM") ||
        process.env.CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER === "external-hsm-derive",
      "Run pnpm check:privacy-gateway -- --require-external-hsm, then set CLAWZ_PRIVACY_GATEWAY_ATTESTED_EXTERNAL_HSM=true"
    );
    addCheck(
      checks,
      "regulated proof surface",
      publicProofSurface !== "full",
      `CLAWZ_PUBLIC_PROOF_SURFACE=${publicProofSurface}`
    );
  }

  addCheck(checks, "deployment manifest", await exists("packages/contracts/deployments/latest-testnet.json"), "latest-testnet.json");
  addCheck(
    checks,
    "deployment witness plan",
    await exists("packages/contracts/deployments/latest-witness-plan.json"),
    "latest-witness-plan.json"
  );

  if (await exists("packages/contracts/deployments/latest-witness-plan.json")) {
    const plan = await readJson("packages/contracts/deployments/latest-witness-plan.json");
    const firstCall = plan.contracts?.[0];
    addCheck(
      checks,
      "registry witness retained",
      firstCall?.kernel === "RegistryKernel" && firstCall?.method === "registerAgent",
      "latest-witness-plan.json starts with RegistryKernel.registerAgent"
    );
  }

  if (await exists("packages/contracts/.env")) {
    const mode = await fileMode("packages/contracts/.env");
    addCheck(
      checks,
      "contracts env permissions",
      mode === undefined || (mode & 0o077) === 0,
      mode === undefined ? "unavailable" : `0${mode.toString(8)}`,
      "warn"
    );
  }

  const failures = checks.filter((check) => !check.ok && check.severity !== "warn");
  const warningChecks = checks.filter((check) => !check.ok && check.severity === "warn");
  const report = {
    ok: failures.length === 0,
    workspaceRoot,
    generatedAtIso: new Date().toISOString(),
    checks,
    warnings: [...warnings, ...warningChecks.map((check) => `${check.label}: ${check.detail}`)]
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`ClawZ production preflight ${report.ok ? "passed" : "failed"}`);
    checks.forEach((check) => {
      const marker = check.ok ? "ok " : check.severity === "warn" ? "warn" : "bad";
      console.log(`${marker} ${check.label}: ${check.detail}`);
    });
    report.warnings.forEach((warning) => console.log(`warn ${warning}`));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
