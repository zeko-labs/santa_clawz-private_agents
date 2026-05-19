export interface CanonicalDigest {
    stableJson: string;
    sha256Hex: string;
    fieldChunks: string[];
}
export declare function sha256Hex(value: string): string;
export declare function fieldChunksFromHex(hex: string, bytesPerField?: number): string[];
export declare function canonicalDigest(value: unknown): CanonicalDigest;
