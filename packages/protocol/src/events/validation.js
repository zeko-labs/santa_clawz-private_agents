function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isClawzEvent(value) {
    if (!isRecord(value)) {
        return false;
    }
    return (typeof value.id === "string" &&
        typeof value.type === "string" &&
        typeof value.occurredAtIso === "string" &&
        isRecord(value.payload));
}
export function assertClawzEvent(value) {
    if (!isClawzEvent(value)) {
        throw new Error("Invalid ClawZ event payload.");
    }
    return value;
}
