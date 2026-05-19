import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const distDir = path.join(workspaceRoot, "apps", "web-console", "dist");
const outputRoot = path.join(workspaceRoot, "deploy", "spaceship");
const uploadDir = path.join(outputRoot, "santaclawz.ai");
const archivePath = path.join(outputRoot, "santaclawz-ai-spaceship-upload.zip");

const siteUrl = process.env.SPACESHIP_SITE_URL?.trim() || "https://santaclawz.ai";
const apiUrl = process.env.SPACESHIP_API_URL?.trim() || "https://api.santaclawz.ai";
const faucetUiUrl = process.env.SPACESHIP_ZEKO_FAUCET_UI_URL?.trim() || "https://faucet.zeko.io";
const faucetClaimApiUrl =
  process.env.SPACESHIP_ZEKO_FAUCET_CLAIM_API_URL?.trim() || "https://api.faucet.zeko.io/claim";

const buildResult = spawnSync("pnpm", ["--filter", "@clawz/web-console", "build"], {
  cwd: workspaceRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_CLAWZ_API_BASE_URL: apiUrl,
    VITE_ZEKO_FAUCET_UI_URL: faucetUiUrl,
    VITE_ZEKO_FAUCET_CLAIM_API_URL: faucetClaimApiUrl
  }
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

rmSync(uploadDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(distDir, uploadDir, { recursive: true });

writeFileSync(
  path.join(uploadDir, "deployment.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      siteUrl,
      apiUrl,
      faucetUiUrl,
      faucetClaimApiUrl
    },
    null,
    2
  )}\n`
);

const zipResult = spawnSync("zip", ["-qr", archivePath, "."], {
  cwd: uploadDir,
  stdio: "inherit"
});

if (zipResult.status !== 0) {
  process.exit(zipResult.status ?? 1);
}

process.stdout.write(
  [
    "",
    `Spaceship upload directory: ${uploadDir}`,
    `Spaceship upload archive: ${archivePath}`,
    `Configured API base: ${apiUrl}`,
    `Configured site URL: ${siteUrl}`
  ].join("\n")
);
