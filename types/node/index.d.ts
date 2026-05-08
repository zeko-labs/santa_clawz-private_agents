declare class Buffer extends Uint8Array {
  static from(data: string | ArrayLike<number>, encoding?: string): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static alloc(size: number): Buffer;
  static byteLength(data: string, encoding?: string): number;
  readonly byteLength: number;
  copy(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  readUInt16BE(offset: number): number;
  readBigUInt64BE(offset: number): bigint;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
  writeUInt16BE(value: number, offset: number): number;
  writeBigUInt64BE(value: bigint, offset: number): number;
}

declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  cwd(): string;
  exit(code?: number): never;
};

declare module "node:crypto" {
  export function createHash(name: string): {
    update(value: string, encoding?: string): { digest(encoding: "hex" | "base64"): string };
  };

  export function createHmac(name: string, key: string | Buffer): {
    update(value: string, encoding?: string): { digest(encoding: "hex"): string };
  };

  export function timingSafeEqual(left: Buffer, right: Buffer): boolean;

  export function hkdfSync(
    digest: string,
    key: Buffer,
    salt: Buffer,
    info: Buffer,
    keylen: number
  ): Buffer;

  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;

  export function createCipheriv(
    algorithm: string,
    key: Buffer,
    iv: Buffer
  ): {
    update(data: Buffer): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  };

  export function createDecipheriv(
    algorithm: string,
    key: Buffer,
    iv: Buffer
  ): {
    update(data: Buffer): Buffer;
    final(): Buffer;
    setAuthTag(tag: Buffer): void;
  };
}

declare module "node:http" {
  import type { Socket } from "node:net";

  export interface IncomingMessage {
    headers: Record<string, string | string[] | undefined>;
    method?: string;
    url?: string;
  }

  export interface Server {
    on(event: "upgrade", listener: (request: IncomingMessage, socket: Socket) => void): this;
    listen(port: number, host: string, listener?: () => void): this;
  }

  export function createServer(app?: unknown): Server;
}

declare module "node:net" {
  export interface Socket {
    destroyed: boolean;
    destroy(): void;
    end(): void;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "close" | "error", listener: () => void): this;
    once(event: "close" | "error", listener: () => void): this;
    write(data: string | Buffer): void;
  }
}

declare module "node:fs/promises" {
  export function access(path: string): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string,
    options: { encoding: string; mode?: number; flag?: string }
  ): Promise<void>;
}

declare module "fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:child_process" {
  export function execSync(
    command: string,
    options?: {
      stdio?: unknown;
      input?: string;
      timeout?: number;
      env?: Record<string, string | undefined>;
    }
  ): Buffer;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;

  const path: {
    join: typeof join;
    dirname: typeof dirname;
    relative: typeof relative;
    isAbsolute: typeof isAbsolute;
    sep: typeof sep;
  };

  export default path;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elementName: string]: any;
  }
}

declare module "react" {
  export type ReactNode = unknown;
  export type SetStateAction<T> = T | ((prevState: T) => T);
  export type Dispatch<A> = (value: A) => void;

  export function useState<T>(initialValue: T): [T, Dispatch<SetStateAction<T>>];
  export function useEffect(effect: () => void | (() => void), dependencies?: unknown[]): void;
  export function useMemo<T>(factory: () => T, dependencies: unknown[]): T;
  export function useDeferredValue<T>(value: T): T;
  export function startTransition(callback: () => void): void;

  const React: {
    StrictMode: (props: { children?: ReactNode }) => any;
  };

  export default React;
}

declare module "react/jsx-runtime" {
  export const Fragment: unique symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}

declare module "react-dom/client" {
  export function createRoot(container: Element | DocumentFragment): {
    render(node: unknown): void;
  };
}

declare module "vite" {
  export function defineConfig<T>(config: T): T;
}

declare module "@vitejs/plugin-react" {
  export default function react(): unknown;
}

declare module "express" {
  type Handler = (request: any, response: any) => void;

  interface Request {
    body: unknown;
    params: Record<string, string | undefined>;
    path: string;
    query: Record<string, string | string[] | undefined>;
    header(name: string): string | undefined;
  }

  interface Response {
    setHeader(name: string, value: string): void;
    status(code: number): Response;
    json(value: unknown): void;
    type(value: string): Response;
    send(value: string): void;
    end(): void;
  }

  interface ExpressApp {
    disable(name: string): void;
    use(...args: any[]): void;
    get(path: string, handler: Handler): void;
    options(path: string, handler: Handler): void;
    post(path: string, handler: Handler): void;
    put(path: string, handler: Handler): void;
    delete(path: string, handler: Handler): void;
    listen(port: number, host?: string, callback?: () => void): void;
  }

  interface ExpressFactory {
    (): ExpressApp;
    json(options?: unknown): unknown;
  }

  const express: ExpressFactory;
  export default express;
}

declare module "o1js" {
  export class Field {
    constructor(value?: unknown);
    assertEquals(other: Field): void;
    toString(): string;
    static fromJSON(value: string): Field;
  }

  export function State<T>(): {
    get(): T;
    getAndRequireEquals(): T;
    set(value: T): void;
  };

  export function state(type: unknown): PropertyDecorator;
  export function method(target: unknown, propertyKey: string, descriptor: PropertyDescriptor): void;

  export class UInt64 {
    value: Field;
    add(other: UInt64): UInt64;
    assertEquals(other: UInt64): void;
    assertGreaterThanOrEqual(other: UInt64): void;
    static from(value: number | string | bigint): UInt64;
  }

  export class MerkleTree {
    constructor(height: number);
    getRoot(): Field;
  }

  export const Poseidon: {
    hash(fields: Field[]): Field;
  };

  export const Permissions: {
    default(): Record<string, unknown>;
    proof(): unknown;
  };

  export class PublicKey {
    static fromBase58(value: string): PublicKey;
    toBase58(): string;
  }

  export class PrivateKey {
    static fromBase58(value: string): PrivateKey;
    toPublicKey(): PublicKey;
  }

  export class SmartContract {
    account: {
      permissions: {
        set(value: unknown): void;
      };
    };

    constructor(address?: PublicKey);
    init(): void;
    deploy(): void;
    emitEvent(name: string, value: Field): void;
    static compile(): Promise<unknown>;
  }

  export class AccountUpdate {
    static fundNewAccount(publicKey: PublicKey): void;
  }

  export const Mina: {
    Network(config: { networkId: unknown; mina: string; archive: string }): unknown;
    setActiveInstance(instance: unknown): void;
    transaction(
      options: { sender: PublicKey; fee: string },
      callback: () => Promise<void> | void
    ): Promise<{
      prove(): Promise<void>;
      sign(keys: PrivateKey[]): {
        send(): Promise<unknown>;
      };
      send(): Promise<unknown>;
      toJSON(): unknown;
    }>;
  };

  export function fetchAccount(args: {
    publicKey: PublicKey;
  }): Promise<{
    error?: string;
    account?: {
      nonce?: UInt64;
      zkapp?: {
        appState?: Field[];
      };
    };
  }>;

  export function Struct<T extends Record<string, unknown>>(shape: T): any;

  export interface ZkProgramInstance {
    compile(): Promise<unknown>;
  }

  export function ZkProgram(config: unknown): ZkProgramInstance;

  export namespace ZkProgram {
    function Proof(program: ZkProgramInstance): new (...args: any[]) => any;
  }
}
