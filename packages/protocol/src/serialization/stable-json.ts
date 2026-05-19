export type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | StableJsonValue[]
  | { [key: string]: StableJsonValue | undefined };

function normalizeValue(value: unknown): StableJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeValue(nested)]);

    return Object.fromEntries(sortedEntries) as StableJsonValue;
  }

  return value as StableJsonValue;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
