import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type PublicProofSurfaceMode = "full" | "discovery-only" | "disabled";

export interface SecurityConfig {
  apiAuthRequired: boolean;
  apiKeyConfigured: boolean;
  apiKeyHashes: string[];
  allowedOrigins: string[] | "*";
  publicOnboardingEnabled: boolean;
  publicProofSurface: PublicProofSurfaceMode;
  productionMode: boolean;
  structuredLogs: boolean;
}

interface SecurityRequest {
  id?: string;
  method?: string;
  path?: string;
  url?: string;
  header(name: string): string | undefined;
}

interface SecurityResponse {
  statusCode: number;
  json(body: unknown): SecurityResponse;
  on(event: string, listener: () => void): void;
  setHeader(name: string, value: string): void;
  status(code: number): SecurityResponse;
}

type SecurityNextFunction = () => void;
type SecurityRequestHandler = (request: unknown, response: unknown, next: SecurityNextFunction) => void;

function middleware(
  handler: (request: SecurityRequest, response: SecurityResponse, next: SecurityNextFunction) => void
): SecurityRequestHandler {
  return (request: unknown, response: unknown, next: SecurityNextFunction) =>
    handler(request as SecurityRequest, response as SecurityResponse, next);
}

function splitCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseProofSurface(value?: string, productionMode = false): PublicProofSurfaceMode {
  if (value === "full" || value === "discovery-only" || value === "disabled") {
    return value;
  }

  return productionMode ? "discovery-only" : "full";
}

export function resolveSecurityConfig(env = process.env): SecurityConfig {
  const productionMode = env.NODE_ENV === "production" || env.CLAWZ_RUNTIME_ENV === "production";
  const rawAuthMode = env.CLAWZ_REQUIRE_API_AUTH?.trim().toLowerCase() ?? "auto";
  const apiAuthRequired = rawAuthMode === "auto" ? productionMode : envFlag(rawAuthMode, productionMode);
  const rawKeys = splitCsv(env.CLAWZ_API_KEYS).map(sha256Hex);
  const rawHashes = splitCsv(env.CLAWZ_API_KEY_SHA256);
  const allowedOrigins = splitCsv(env.CLAWZ_ALLOWED_ORIGINS);

  return {
    apiAuthRequired,
    apiKeyConfigured: rawKeys.length + rawHashes.length > 0,
    apiKeyHashes: [...rawKeys, ...rawHashes],
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : productionMode ? [] : "*",
    publicOnboardingEnabled: envFlag(env.CLAWZ_PUBLIC_ONBOARDING, false),
    publicProofSurface: parseProofSurface(env.CLAWZ_PUBLIC_PROOF_SURFACE, productionMode),
    productionMode,
    structuredLogs: envFlag(env.CLAWZ_STRUCTURED_LOGS, productionMode)
  };
}

export function publicSecurityStatus(config: SecurityConfig) {
  return {
    apiAuthRequired: config.apiAuthRequired,
    apiKeyConfigured: config.apiKeyConfigured,
    allowedOrigins: config.allowedOrigins === "*" ? "*" : config.allowedOrigins,
    publicOnboardingEnabled: config.publicOnboardingEnabled,
    publicProofSurface: config.publicProofSurface,
    productionMode: config.productionMode,
    structuredLogs: config.structuredLogs
  };
}

function isOriginAllowed(origin: string, config: SecurityConfig): boolean {
  if (config.allowedOrigins === "*") {
    return true;
  }

  return config.allowedOrigins.includes(origin);
}

function isPublicReadPath(pathname: string, method: string, config: SecurityConfig): boolean {
  if (pathname === "/health" || pathname === "/ready") {
    return true;
  }

  if (method === "GET" && (pathname === "/api/agents" || pathname === "/api/agent-messages" || pathname === "/api/payments")) {
    return true;
  }

  if (method === "GET" && /^\/api\/agents\/[^/]+\/payments$/.test(pathname)) {
    return true;
  }

  if (method === "GET" && /^\/api\/artifacts\/[^/]+\/(manifest|download)$/.test(pathname)) {
    return true;
  }

  if (config.publicProofSurface !== "disabled" && method === "GET" && pathname.startsWith("/.well-known/")) {
    return true;
  }

  if (config.publicProofSurface !== "full") {
    return false;
  }

  return (
    (method === "GET" && (pathname === "/api/interop/agent-proof" || pathname === "/api/interop/verify")) ||
    (method === "POST" && (pathname === "/api/interop/verify" || pathname === "/mcp"))
  );
}

function isPublicOnboardingPath(pathname: string, method: string, config: SecurityConfig): boolean {
  if (!config.publicOnboardingEnabled) {
    return false;
  }

  return (
    (method === "GET" &&
      (pathname === "/api/console/state" ||
        pathname === "/api/social/anchors" ||
        pathname === "/api/social/anchors/export" ||
        pathname === "/api/wallet/sponsor/queue" ||
        pathname === "/api/x402/plan" ||
        pathname === "/api/x402/proof" ||
        pathname === "/api/zeko/health" ||
        pathname === "/.well-known/x402.json" ||
        /^\/api\/agents\/[^/]+\/availability$/.test(pathname) ||
        /^\/api\/agents\/[^/]+\/relay-status$/.test(pathname) ||
        /^\/api\/agents\/[^/]+\/x402-plan$/.test(pathname))) ||
    (method === "POST" &&
      (pathname === "/api/console/register" ||
        pathname === "/api/enrollment/tickets" ||
        pathname === "/api/enrollment/redeem" ||
        pathname === "/api/ownership/challenge" ||
        pathname === "/api/ownership/verify" ||
        pathname === "/api/ownership/reclaim" ||
        (/^\/api\/agents\/[^/]+\/hire$/.test(pathname)) ||
        (/^\/agent\/[^/]+\/hire$/.test(pathname)) ||
        (/^\/api\/agents\/[^/]+\/messages$/.test(pathname)) ||
        pathname === "/api/x402/verify" ||
        pathname === "/api/x402/settle" ||
        pathname === "/api/x402/quote-intent" ||
        pathname === "/api/mission-auth/check" ||
        pathname === "/api/console/trust-mode" ||
        pathname === "/api/console/profile" ||
        (/^\/api\/agents\/[^/]+\/readiness\/refresh$/.test(pathname)) ||
        (/^\/api\/agents\/[^/]+\/archive$/.test(pathname)) ||
        (/^\/api\/agents\/[^/]+\/quotes\/[^/]+\/accept$/.test(pathname)) ||
        (/^\/api\/executions\/[^/]+\/artifacts$/.test(pathname)) ||
        (/^\/api\/agents\/[^/]+\/heartbeat$/.test(pathname)) ||
        pathname === "/api/social/anchors/settle" ||
        pathname === "/api/social/anchors/commit" ||
        pathname === "/api/wallet/sponsor" ||
        pathname === "/api/wallet/recovery/prepare" ||
        pathname === "/api/zeko/flow/run" ||
        pathname === "/api/zeko/session-turn/run"))
  );
}

function isProtectedRequest(request: SecurityRequest, config: SecurityConfig): boolean {
  const method = String(request.method ?? "GET").toUpperCase();
  const pathname = String(request.path ?? request.url ?? "/").split("?")[0] ?? "/";
  const authActive = config.apiAuthRequired || config.apiKeyConfigured;

  if (
    !authActive ||
    method === "OPTIONS" ||
    isPublicReadPath(pathname, method, config) ||
    isPublicOnboardingPath(pathname, method, config)
  ) {
    return false;
  }

  return pathname.startsWith("/api/") || pathname === "/mcp";
}

function extractApiKey(request: SecurityRequest): string | undefined {
  const explicit = request.header("x-api-key");
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const authorization = request.header("authorization");
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  return undefined;
}

function isAuthorized(request: SecurityRequest, config: SecurityConfig): boolean {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return false;
  }

  const presentedHash = sha256Hex(apiKey);
  return config.apiKeyHashes.some((expectedHash) => timingSafeHexEqual(presentedHash, expectedHash));
}

export function applyBaseSecurityHeaders(
  request: SecurityRequest,
  response: SecurityResponse,
  config: SecurityConfig
): void {
  const requestId = request.header("x-request-id") ?? randomUUID();
  request.id = requestId;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");

  const origin = request.header("origin");
  if (typeof origin === "string" && isOriginAllowed(origin, config)) {
    response.setHeader("Access-Control-Allow-Origin", config.allowedOrigins === "*" ? "*" : origin);
    response.setHeader("Access-Control-Allow-Credentials", "false");
  } else if (config.allowedOrigins === "*") {
    response.setHeader("Access-Control-Allow-Origin", "*");
  }

  response.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-api-key, x-clawz-admin-key, x-clawz-artifact-filename, x-clawz-artifact-content-type, x-request-id"
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

export function securityMiddleware(config: SecurityConfig): SecurityRequestHandler {
  return middleware((request: SecurityRequest, response: SecurityResponse, next: SecurityNextFunction) => {
    const startedAt = Date.now();
    applyBaseSecurityHeaders(request, response, config);

    if (config.structuredLogs) {
      response.on("finish", () => {
        console.log(
          JSON.stringify({
            event: "http_request",
            requestId: request.id,
            method: request.method,
            path: request.path,
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt
          })
        );
      });
    }

    const origin = request.header("origin");
    if (request.method === "OPTIONS" && typeof origin === "string" && !isOriginAllowed(origin, config)) {
      response.status(403).json({ error: "Origin is not allowed." });
      return;
    }

    next();
  });
}

export function apiAuthMiddleware(config: SecurityConfig): SecurityRequestHandler {
  return middleware((request: SecurityRequest, response: SecurityResponse, next: SecurityNextFunction) => {
    if (!isProtectedRequest(request, config)) {
      next();
      return;
    }

    if (!config.apiKeyConfigured) {
      response.status(503).json({
        error: "API authentication is required but no API key is configured."
      });
      return;
    }

    if (!isAuthorized(request, config)) {
      response.status(401).json({
        error: "Missing or invalid ClawZ API key."
      });
      return;
    }

    next();
  });
}
