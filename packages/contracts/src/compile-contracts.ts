import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApprovalKernel } from "./approval/ApprovalKernel.js";
import { DisclosureKernel } from "./disclosure/DisclosureKernel.js";
import { EscrowKernel } from "./escrow/EscrowKernel.js";
import { ApprovalPolicyProgram } from "./proofs/ApprovalPolicyProgram.js";
import { BudgetConservationProgram } from "./proofs/BudgetConservationProgram.js";
import { CommitteeProgram } from "./proofs/CommitteeProgram.js";
import { DisclosureScopeProgram } from "./proofs/DisclosureScopeProgram.js";
import { RegistryKernel } from "./registry/RegistryKernel.js";
import { SessionKernel } from "./session/SessionKernel.js";
import { buildDeploymentWitnessPlan } from "./shared/witness-builders.js";
import { SocialAnchorKernel } from "./social/SocialAnchorKernel.js";
import { TurnKernel } from "./turn/TurnKernel.js";

async function writeCompileArtifacts(payload: {
  generatedAt: string;
  contracts: string[];
  proofs: string[];
}) {
  const artifactsDir = join(process.cwd(), "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const witnessPlanPath = join(artifactsDir, "deployment-witness-plan.json");
  const compileManifestPath = join(artifactsDir, "latest-compile.json");
  await writeFile(witnessPlanPath, `${JSON.stringify(buildDeploymentWitnessPlan(), null, 2)}\n`, "utf8");
  await writeFile(
    compileManifestPath,
    `${JSON.stringify({ ...payload, witnessPlanPath }, null, 2)}\n`,
    "utf8"
  );

  console.log(`Wrote witness plan to ${witnessPlanPath}`);
  console.log(`Wrote compile manifest to ${compileManifestPath}`);
}

async function main() {
  const compileTargets = [
    ["RegistryKernel", RegistryKernel],
    ["SessionKernel", SessionKernel],
    ["TurnKernel", TurnKernel],
    ["ApprovalKernel", ApprovalKernel],
    ["DisclosureKernel", DisclosureKernel],
    ["EscrowKernel", EscrowKernel],
    ["SocialAnchorKernel", SocialAnchorKernel]
  ] as const;

  for (const [label, contractClass] of compileTargets) {
    const startedAt = Date.now();
    await contractClass.compile();
    console.log(`${label} compiled in ${Date.now() - startedAt}ms`);
  }

  const programs = [
    ["ApprovalPolicyProgram", ApprovalPolicyProgram],
    ["BudgetConservationProgram", BudgetConservationProgram],
    ["CommitteeProgram", CommitteeProgram],
    ["DisclosureScopeProgram", DisclosureScopeProgram]
  ] as const;

  for (const [label, program] of programs) {
    const startedAt = Date.now();
    await program.compile();
    console.log(`${label} compiled in ${Date.now() - startedAt}ms`);
  }

  await writeCompileArtifacts({
    generatedAt: new Date().toISOString(),
    contracts: compileTargets.map(([label]) => label),
    proofs: programs.map(([label]) => label)
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
