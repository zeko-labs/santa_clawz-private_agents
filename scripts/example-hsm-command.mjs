import { hkdfSync, randomUUID } from "node:crypto";

const DERIVATION_NAMESPACE = "clawz/privacy-gateway/v1";

async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function deriveKey(rootKey, label, tenantId, workspaceId) {
  const salt = Buffer.from(DERIVATION_NAMESPACE, "utf8");
  const info = Buffer.from(
    label === "workspace" ? [label, tenantId, workspaceId ?? ""].join(":") : [label, tenantId].join(":"),
    "utf8"
  );
  return Buffer.from(hkdfSync("sha256", rootKey, salt, info, 32));
}

const input = await readStdin();
if (input.derivation !== DERIVATION_NAMESPACE) {
  throw new Error(`Unsupported derivation namespace: ${input.derivation}`);
}

const rootKey = Buffer.from(
  process.env.CLAWZ_EXAMPLE_HSM_ROOT_KEY_BASE64 ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "base64"
);
const key = deriveKey(rootKey, input.label, input.tenantId, input.workspaceId);

console.log(
  JSON.stringify({
    keyBase64: key.toString("base64"),
    keyVersion: "example-hsm-command-v1",
    auditId: `audit_${randomUUID()}`,
    provider: "example-hsm-command"
  })
);
