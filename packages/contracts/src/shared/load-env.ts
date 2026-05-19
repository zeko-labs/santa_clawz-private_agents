import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export async function loadLocalEnv(cwd = process.cwd()): Promise<void> {
  const path = join(cwd, ".env");

  try {
    await access(path);
  } catch {
    return;
  }

  const contents = await readFile(path, "utf8");
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const value = line.slice(separatorIndex + 1).trim();
    process.env[key] = stripWrappingQuotes(value);
  }
}
