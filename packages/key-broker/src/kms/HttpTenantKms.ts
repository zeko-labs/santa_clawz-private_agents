import type { TenantKms } from "../types.js";

interface KeyResponse {
  keyBase64?: string;
}

function normalizeEndpoint(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function decodeKey(response: KeyResponse, label: string): Buffer {
  if (!response.keyBase64) {
    throw new Error(`External KMS response missing keyBase64 for ${label}.`);
  }

  const key = Buffer.from(response.keyBase64, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`External KMS returned invalid key length for ${label}.`);
  }

  return key;
}

export class HttpTenantKms implements TenantKms {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly bearerToken?: string
  ) {
    if (!endpoint.trim()) {
      throw new Error("CLAWZ_KMS_ENDPOINT is required when using external-kms-backed mode.");
    }

    this.endpoint = normalizeEndpoint(endpoint.trim());
  }

  private async requestKey(path: string, body: Record<string, string>, label: string): Promise<Buffer> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {})
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`External KMS request failed for ${label}: ${response.status}`);
    }

    return decodeKey((await response.json()) as KeyResponse, label);
  }

  getTenantKey(tenantId: string): Promise<Buffer> {
    return this.requestKey("/tenant-key", { tenantId }, `tenant ${tenantId}`);
  }

  getWorkspaceKey(tenantId: string, workspaceId: string): Promise<Buffer> {
    return this.requestKey("/workspace-key", { tenantId, workspaceId }, `workspace ${tenantId}/${workspaceId}`);
  }
}
