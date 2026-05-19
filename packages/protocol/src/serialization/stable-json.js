function normalizeValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeValue(item));
    }
    if (value && typeof value === "object") {
        const sortedEntries = Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalizeValue(nested)]);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}
export function stableJsonStringify(value) {
    return JSON.stringify(normalizeValue(value));
}
