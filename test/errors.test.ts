import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BadRequestError,
  CapacityExhaustedError,
  InfervaClient,
  InfervaError,
  InsufficientFundsError,
  ModelNotAllowedError,
  ModelNotFoundError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  ServerError,
  SettlementBusyError,
  SpendCapReachedError,
  errorFrom,
} from "../src";
import { json, mockFetch } from "./helpers";

const KEY = "inf_sk_placeholder";

// Every status/type pair the endpoint returns, with the endpoint's own message text.
const CASES: [number, string, string, typeof InfervaError][] = [
  [400, "invalid_request_error", "Send a messages array", BadRequestError],
  [401, "invalid_api_key", "Unknown or revoked API key", AuthenticationError],
  [402, "insufficient_funds", "This request can cost up to 0.0001 USDC and the key owner has 0.", InsufficientFundsError],
  [402, "spend_cap_reached", "This key has reached its monthly spend cap of 5 USDC (5 USDC spent this month).", SpendCapReachedError],
  [403, "model_not_allowed", 'This key may not use "nw-large". Allowed models: basalt-8b.', ModelNotAllowedError],
  [404, "model_not_found", 'No active provider serves "nope". See GET /v1/models.', ModelNotFoundError],
  [429, "rate_limit_exceeded", "Rate limit for No tier is 10 requests per minute. Stake more INFER to raise it.", RateLimitError],
  [502, "provider_error", "Basalt Inference could not complete this request. You were not charged.", ProviderError],
  [503, "capacity_exhausted", "No sponsored capacity left. Sponsor capacity in the app to serve this request.", CapacityExhaustedError],
  [503, "settlement_busy", "Settlement busy, try again", SettlementBusyError],
];

describe("error mapping", () => {
  it.each(CASES)("%i %s", async (status, type, message, Cls) => {
    const fetch = mockFetch(json({ error: { message, type } }, status, status === 429 ? { "retry-after": "60" } : {}));
    const err = await new InfervaClient({ apiKey: KEY, fetch })
      .chat.completions.create({ messages: [{ role: "user", content: "Hi" }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Cls);
    expect(err).toBeInstanceOf(InfervaError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(Cls.name);
    expect(err.status).toBe(status);
    expect(err.type).toBe(type);
    expect(err.message).toBe(message);
    expect(err.body).toEqual({ error: { message, type } });
  });

  it("reads Retry-After on rate limits", () => {
    const err = errorFrom({ error: { message: "slow down", type: "rate_limit_exceeded" } }, 429, new Headers({ "retry-after": "60" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(60);
    expect(err.retryable).toBe(true);
  });

  it("marks only transient errors retryable", () => {
    expect(errorFrom({ error: { message: "", type: "settlement_busy" } }, 503).retryable).toBe(true);
    expect(errorFrom({ error: { message: "", type: "capacity_exhausted" } }, 503).retryable).toBe(false);
    expect(errorFrom({ error: { message: "", type: "insufficient_funds" } }, 402).retryable).toBe(false);
  });

  it("handles the string error shape of /api routes and unknown routes", async () => {
    const fetch = mockFetch(json({ error: "Not found" }, 404));
    const err = await new InfervaClient({ fetch }).stats().catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("Not found");
    expect(err.type).toBeUndefined();
  });

  it("falls back to the status when the body is not JSON", async () => {
    const fetch = mockFetch(new Response("Bad gateway", { status: 500 }));
    const err = await new InfervaClient({ fetch }).stats().catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.message).toBe("Request failed with status 500");
    expect(err.body).toBe("Bad gateway");
  });

  it("keeps an unknown type on the base class", () => {
    const err = errorFrom({ error: { message: "new thing", type: "something_new" } }, 409);
    expect(err.constructor).toBe(InfervaError);
    expect(err.type).toBe("something_new");
  });
});
