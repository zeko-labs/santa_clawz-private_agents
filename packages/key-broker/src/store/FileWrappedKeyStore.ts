import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { WrappedKeyRecord, WrappedKeyStore } from "../types.js";

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const maybeCode = error as { code?: string };
    if (maybeCode.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export class FileWrappedKeyStore implements WrappedKeyStore {
  constructor(private readonly baseDir: string) {}

  private async ensureDir() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private getFilePath(keyId: string): string {
    return path.join(this.baseDir, `${keyId}.json`);
  }

  async save(record: WrappedKeyRecord): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(record.keyId);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
  }

  async get(keyId: string): Promise<WrappedKeyRecord | undefined> {
    await this.ensureDir();
    return readJsonFile<WrappedKeyRecord>(this.getFilePath(keyId));
  }

  async list(): Promise<WrappedKeyRecord[]> {
    await this.ensureDir();
    const entries = await readdir(this.baseDir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJsonFile<WrappedKeyRecord>(path.join(this.baseDir, entry)))
    );

    return records.filter((record): record is WrappedKeyRecord => Boolean(record));
  }
}
