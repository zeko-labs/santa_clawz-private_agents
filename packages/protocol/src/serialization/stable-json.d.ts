export type StableJsonValue = null | boolean | number | string | StableJsonValue[] | {
    [key: string]: StableJsonValue | undefined;
};
export declare function stableJsonStringify(value: unknown): string;
