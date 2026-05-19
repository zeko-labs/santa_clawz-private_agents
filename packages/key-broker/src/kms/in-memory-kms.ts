import type { TenantKms } from "../types.js";
import { randomKey } from "../wrapping/aes-gcm.js";

export class InMemoryTenantKms implements TenantKms {
  private readonly tenantKeys = new Map<string, Buffer>();
  private readonly workspaceKeys = new Map<string, Buffer>();

  async getTenantKey(tenantId: string): Promise<Buffer> {
    if (!this.tenantKeys.has(tenantId)) {
      this.tenantKeys.set(tenantId, randomKey());
    }

    return this.tenantKeys.get(tenantId)!;
  }

  async getWorkspaceKey(tenantId: string, workspaceId: string): Promise<Buffer> {
    const composite = `${tenantId}:${workspaceId}`;
    if (!this.workspaceKeys.has(composite)) {
      this.workspaceKeys.set(composite, randomKey());
    }

    return this.workspaceKeys.get(composite)!;
  }
}
