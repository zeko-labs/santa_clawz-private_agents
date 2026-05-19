declare module "zeko-x402" {
  export const X402_PAYMENT_REQUIRED_HEADER: string;
  export const X402_PAYMENT_SIGNATURE_HEADER: string;
  export const X402_PAYMENT_RESPONSE_HEADER: string;

  export function buildBaseMainnetUsdcRail(input: Record<string, unknown>): Record<string, unknown>;
  export function buildEthereumMainnetUsdcRail(input: Record<string, unknown>): Record<string, unknown>;
  export function buildCatalog(input: Record<string, unknown>): Record<string, unknown>;
  export function buildPaymentRequired(input: Record<string, unknown>): Record<string, unknown>;
  export function verifyPayment(input: Record<string, unknown>): Record<string, unknown>;
  export function buildSettlementResponse(input: Record<string, unknown>): Record<string, unknown>;
  export function encodeBase64Json(value: unknown): string;
  export function decodeBase64Json(value: string): unknown;
  export function assertPaymentPayload(value: unknown): Record<string, unknown>;

  export class InMemorySettlementLedger {
    constructor(input?: Record<string, unknown>);
    settle(input: Record<string, unknown>): Record<string, unknown>;
  }

  export class HostedX402FacilitatorClient {
    constructor(input: Record<string, unknown>);
    supported(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    verify(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    settle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    verifyAndSettle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  }

  export class CDPFacilitatorClient extends HostedX402FacilitatorClient {
    constructor(input?: Record<string, unknown>);
  }
}
