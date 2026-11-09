/** Error `type` values the INFERVA endpoint returns. */
export type InfervaErrorType =
  | "invalid_request_error"
  | "invalid_api_key"
  | "insufficient_funds"
  | "spend_cap_reached"
  | "model_not_allowed"
  | "model_not_found"
  | "rate_limit_exceeded"
  | "provider_error"
  | "capacity_exhausted"
  | "settlement_busy"
  | "server_error"
  | (string & {});

export type InfervaErrorInit = {
  status?: number;
  type?: InfervaErrorType;
  body?: unknown;
  headers?: Headers;
};

/** Base class for every error returned by the endpoint or raised by this client. */
export class InfervaError extends Error {
  /** HTTP status. `undefined` for errors that arrive inside a stream or never reached the server. */
  readonly status: number | undefined;
  /** Machine-readable error type from the endpoint, e.g. `capacity_exhausted`. */
  readonly type: InfervaErrorType | undefined;
  /** The parsed error body, when there was one. */
  readonly body: unknown;
  readonly headers: Headers | undefined;

  constructor(message: string, init: InfervaErrorInit = {}) {
    super(message);
    this.name = new.target.name;
    this.status = init.status;
    this.type = init.type;
    this.body = init.body;
    this.headers = init.headers;
  }

  /** True when the same request may succeed if retried later without changes. */
  get retryable(): boolean {
    return false;
  }
}

/** 400 `invalid_request_error`: no `messages` array, or no message has text content. */
export class BadRequestError extends InfervaError {}

/** 401 `invalid_api_key`: missing, unknown or revoked key. */
export class AuthenticationError extends InfervaError {}

/** 402 `insufficient_funds`: the key owner's USDC balance cannot cover the request. Not charged. */
export class InsufficientFundsError extends InfervaError {}

/** 402 `spend_cap_reached`: the key's monthly spend cap would be exceeded. Not charged. */
export class SpendCapReachedError extends InfervaError {}

/** 403 `model_not_allowed`: the key's allowed-models list does not include the requested model. */
export class ModelNotAllowedError extends InfervaError {}

/** 404 `model_not_found`: no active provider serves the requested model. */
export class ModelNotFoundError extends InfervaError {}

/** 404 on a route that does not exist. */
export class NotFoundError extends InfervaError {}

/** 429 `rate_limit_exceeded`: over the tier's requests per minute. */
export class RateLimitError extends InfervaError {
  /** Seconds to wait, from the `Retry-After` header. */
  get retryAfter(): number | undefined {
    const value = Number(this.headers?.get("retry-after"));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  override get retryable() {
    return true;
  }
}

/** 502 `provider_error`: the provider could not complete the request. Not charged. */
export class ProviderError extends InfervaError {
  override get retryable() {
    return true;
  }
}

/** 503 `capacity_exhausted`: no sponsored capacity position has room for the request. Not charged. */
export class CapacityExhaustedError extends InfervaError {}

/** 503 `settlement_busy`: the settlement log was busy. Retry. */
export class SettlementBusyError extends InfervaError {
  override get retryable() {
    return true;
  }
}

/** 5xx or `server_error`: something went wrong on the server. */
export class ServerError extends InfervaError {
  override get retryable() {
    return true;
  }
}

/** The request never got a response: network failure, timeout or abort. */
export class ConnectionError extends InfervaError {
  override get retryable() {
    return true;
  }
}

/** The endpoint sent something this client could not parse. */
export class ResponseParseError extends InfervaError {}

const BY_TYPE: Record<string, typeof InfervaError> = {
  invalid_request_error: BadRequestError,
  invalid_api_key: AuthenticationError,
  insufficient_funds: InsufficientFundsError,
  spend_cap_reached: SpendCapReachedError,
  model_not_allowed: ModelNotAllowedError,
  model_not_found: ModelNotFoundError,
  rate_limit_exceeded: RateLimitError,
  provider_error: ProviderError,
  capacity_exhausted: CapacityExhaustedError,
  settlement_busy: SettlementBusyError,
  server_error: ServerError,
};

function byStatus(status: number | undefined): typeof InfervaError {
  if (status === undefined) return InfervaError;
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 404) return NotFoundError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return InfervaError;
}

/**
 * Build the right error subclass from an error body. Handles both shapes the server uses:
 * `{ "error": { "message": "...", "type": "..." } }` on `/v1/*` and `{ "error": "..." }` on `/api/*`.
 */
export function errorFrom(body: unknown, status?: number, headers?: Headers): InfervaError {
  const raw = (body as { error?: unknown } | null)?.error;
  let message: string | undefined;
  let type: string | undefined;
  if (typeof raw === "string") message = raw;
  else if (raw && typeof raw === "object") {
    const e = raw as { message?: unknown; type?: unknown };
    if (typeof e.message === "string") message = e.message;
    if (typeof e.type === "string") type = e.type;
  }
  const Cls = (type && BY_TYPE[type]) || byStatus(status);
  return new Cls(message ?? (status ? `Request failed with status ${status}` : "Request failed"), { status, type, body, headers });
}
