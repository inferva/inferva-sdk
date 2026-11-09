import { ConnectionError, errorFrom, InfervaError, ResponseParseError } from "./errors";
import { ChatCompletionStream } from "./stream";
import type {
  ChainPage,
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ModelList,
  ParamsResponse,
  RequestRecord,
  Stats,
} from "./types";

export const DEFAULT_BASE_URL = "https://dapp.inferva.xyz";
export const DEFAULT_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type InfervaClientOptions = {
  /** Agent key (`inf_sk_...`). Only needed for `chat.completions.create()`. */
  apiKey?: string;
  /** Defaults to `https://dapp.inferva.xyz`. A trailing `/v1` is accepted and ignored. */
  baseURL?: string;
  /** Custom fetch, for tests or runtimes without a global fetch. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. For streams it covers the wait for the first byte. Default 60s. */
  timeoutMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Call = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, number | string | undefined>;
  body?: unknown;
  auth?: boolean;
  stream?: boolean;
  options?: RequestOptions;
};

/**
 * Client for the INFERVA agent endpoint.
 *
 * ```ts
 * const inferva = new InfervaClient({ apiKey: process.env.INFERVA_KEY });
 * const res = await inferva.chat.completions.create({ messages: [{ role: "user", content: "Hello" }] });
 * console.log(res.choices[0].message.content, res.inferva.cost_usdc);
 * ```
 */
export class InfervaClient {
  readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: InfervaClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!options.fetch && typeof fetch !== "function") throw new InfervaError("No fetch implementation found. Use Node.js 18+ or pass `fetch` in the options.");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = options.headers ?? {};
  }

  readonly chat = {
    completions: {
      create: ((params: ChatCompletionCreateParams, options?: RequestOptions) =>
        params.stream === true
          ? this.request<ChatCompletionStream>({ method: "POST", path: "/v1/chat/completions", body: params, auth: true, stream: true, options })
          : this.request<ChatCompletion>({ method: "POST", path: "/v1/chat/completions", body: params, auth: true, options })) as {
        (params: ChatCompletionCreateParamsStreaming, options?: RequestOptions): Promise<ChatCompletionStream>;
        (params: ChatCompletionCreateParamsNonStreaming, options?: RequestOptions): Promise<ChatCompletion>;
        (params: ChatCompletionCreateParams, options?: RequestOptions): Promise<ChatCompletion | ChatCompletionStream>;
      },
    },
  };

  readonly models = {
    /** `auto` plus every model an active provider serves, with its price per 1,000 tokens. No key needed. */
    list: (options?: RequestOptions) => this.request<ModelList>({ method: "GET", path: "/v1/models", options }),
  };

  /** Network totals: volume, fees, staking, capacity, providers and the last 24 epochs. Amounts in micro units. */
  stats(options?: RequestOptions): Promise<Stats> {
    return this.request({ method: "GET", path: "/api/stats", options });
  }

  /** Current protocol parameters and what each one means. */
  params(options?: RequestOptions): Promise<ParamsResponse> {
    return this.request({ method: "GET", path: "/api/params", options });
  }

  /** Settlement log records in order after `after` (a `seq`), with the genesis hash. `limit` 1 to 200, default 200. */
  chain(query: { after?: number; limit?: number } = {}, options?: RequestOptions): Promise<ChainPage> {
    return this.request({ method: "GET", path: "/api/chain", query: { after: query.after, limit: query.limit }, options });
  }

  /** The most recent settled requests across the network, newest first. `limit` 1 to 200, default 50. */
  requests(query: { limit?: number } = {}, options?: RequestOptions): Promise<RequestRecord[]> {
    return this.request({ method: "GET", path: "/api/requests", query: { limit: query.limit }, options });
  }

  private url(path: string, query?: Call["query"]) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return `${this.baseURL}${path}${qs ? `?${qs}` : ""}`;
  }

  private async request<T>(call: Call): Promise<T> {
    const headers: Record<string, string> = { accept: call.stream ? "text/event-stream" : "application/json", ...this.headers };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    if (call.auth) {
      if (!this.apiKey) throw new InfervaError("Missing API key. Pass `apiKey: \"inf_sk_...\"` to InfervaClient.");
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const outer = call.options?.signal;
    const onAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) onAbort();
    else outer?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = call.options?.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(call.path, call.query), {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: controller.signal,
      });
    } catch (e) {
      done();
      throw new ConnectionError(timedOut ? `Request timed out after ${timeoutMs} ms` : `Request failed: ${(e as Error)?.message ?? String(e)}`, { body: e });
    }

    if (!res.ok) {
      done();
      const text = await res.text().catch(() => "");
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        /* keep text */
      }
      throw errorFrom(body, res.status, res.headers);
    }

    if (call.stream) {
      // The timeout only guards the wait for headers; a stream may legitimately run longer.
      // The caller's signal stays linked, so aborting it still stops the stream.
      if (timer !== undefined) clearTimeout(timer);
      return new ChatCompletionStream(res, controller) as T;
    }

    try {
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ResponseParseError(`Expected JSON from ${call.path}, got: ${text.slice(0, 200)}`, { status: res.status, body: text, headers: res.headers });
      }
    } catch (e) {
      if (e instanceof InfervaError) throw e;
      throw new ConnectionError(timedOut ? `Request timed out after ${timeoutMs} ms` : `Reading the response failed: ${(e as Error)?.message ?? String(e)}`, { body: e });
    } finally {
      done();
    }
  }
}
