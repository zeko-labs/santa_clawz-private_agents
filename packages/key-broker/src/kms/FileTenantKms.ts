import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TenantKms } from "../types.js";
import { randomKey } from "../wrapping/aes-gcm.js";

function encodeKey(buffer: Buffer): string {
  return buffer.toString("base64");
}

function decodeKey(encoded: string): Buffer {
  return Buffer.from(encoded, "base64");
}

async function readOrCreateKey(filePath: string): Promise<Buffer> {
  try {
    return decodeKey(await readFile(filePath, "utf8"));
  } catch (error) {
    const maybeCode = error as { code?: string };
    if (maybeCode.code !== "ENOENT") {
      throw error;
    }

    const key = randomKey();
    try {
      await writeFile(filePath, encodeKey(key), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(filePath, 0o600);
      return key;
    } catch (writeError) {
      const maybeWriteCode = writeError as { code?: string };
      if (maybeWriteCode.code === "EEXIST") {
        return decodeKey(await readFile(filePath, "utf8"));
      }
      throw writeError;
    }
  }
}

export class FileTenantKms implements TenantKms {
  constructor(private readonly baseDir: string) {}

  private async ensureDirs() {
    await mkdir(path.join(this.baseDir, "tenants"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.baseDir, "workspaces"), { recursive: true, mode: 0o700 });
  }

  async getTenantKey(tenantId: string): Promise<Buffer> {
    await this.ensureDirs();
    const filePath = path.join(this.baseDir, "tenants", `${tenantId}.key`);
    return readOrCreateKey(filePath);
  }

  async getWorkspaceKey(tenantId: string, workspaceId: string): Promise<Buffer> {
    await this.ensureDirs();
    const filePath = path.join(this.baseDir, "workspaces", `${tenantId}__${workspaceId}.key`);
    return readOrCreateKey(filePath);
  }
}
