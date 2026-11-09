// Wire types for the INFERVA endpoint. They mirror what the endpoint returns, field for field.

/** 1 USDC = 1,000,000 micro units. The `/api/*` routes report amounts as integers in micro units. */
export const UNIT = 1_000_000;

/** Convert an integer micro-unit amount (as returned by the `/api/*` routes) to a decimal USDC or INFER amount. */
export const fromMicro = (micro: number): number => micro / UNIT;

// ---------- chat completions ----------

export type ChatRole = "system" | "user" | "assistant" | (string & {});

/** A content part. Only `text` is read; any other part contributes nothing. */
export type ChatContentPart = { type?: string; text?: string; [key: string]: unknown };

export type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentPart[];
};

export type ChatCompletionCreateParamsBase = {
  /** Chat messages. The endpoint uses the last 20, cuts each to 8,000 characters and sends every role other than `assistant` as `user`. */
  messages: ChatMessage[];
  /** `auto` (default) routes to the cheapest active provider, or pass a model id from `models.list()`. */
  model?: string;
  /** Maximum output tokens. Defaults to and is capped at 1,024 by the endpoint. */
  max_tokens?: number;
};

export type ChatCompletionCreateParamsNonStreaming = ChatCompletionCreateParamsBase & { stream?: false | null };
export type ChatCompletionCreateParamsStreaming = ChatCompletionCreateParamsBase & { stream: true };
export type ChatCompletionCreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** Cost split of one request, in USDC (decimal, not micro units). */
export type InfervaBreakdown = {
  /** Provider cost before discount. Repaid to the capacity sponsor. */
  provider_cost: number;
  /** Tier discount taken off the provider cost. */
  discount: number;
  /** Protocol fee on top of the provider cost. */
  protocol_fee: number;
  /** Part of the protocol fee that went to $INFER stakers. */
  to_stakers: number;
  /** Part of the protocol fee that went to the capacity sponsor. */
  to_sponsor: number;
  /** Part of the protocol fee that went to the treasury (includes the staker share when nobody is staked). */
  to_treasury: number;
};

/** The `inferva` block every settled response carries next to `choices` and `usage`. */
export type InfervaBlock = {
  /** Name of the provider that served the request. */
  provider: string;
  /** Whether the request was routed with priority (Tier 2 and above). */
  priority: boolean;
  /** The payer's tier at the time of the request, e.g. `"No tier"`, `"Tier 1"`. */
  tier: string;
  /** Total charged in USDC: provider cost minus discount plus protocol fee. */
  cost_usdc: number;
  breakdown: InfervaBreakdown;
  /** Id of the sponsored capacity position that served the request. */
  capacity: string;
  /** The epoch the request settled in. */
  epoch: number;
  /** This record's hash and the hash of the record before it in the settlement log. */
  settlement: { hash: string; prev_hash: string };
  /** Public receipt page for this request: `<origin>/receipt/<id>`. */
  receipt: string;
};

export type ChatCompletion = {
  /** Request id, also the settlement record id. */
  id: string;
  object: "chat.completion";
  /** Unix seconds. */
  created: number;
  /** The model id that served the request. */
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | (string & {});
  }[];
  usage: Usage;
  inferva: InfervaBlock;
};

/**
 * One server-sent event in the `chat.completion.chunk` shape. The first content chunk carries
 * `role: "assistant"`. The last chunk has an empty delta, `finish_reason: "stop"`, plus `usage` and `inferva`.
 */
export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | null | (string & {});
  }[];
  usage?: Usage;
  inferva?: InfervaBlock;
};

// ---------- models ----------

export type Model = {
  id: string;
  object: "model";
  /** Provider name, or `inferva` for `auto`. */
  owned_by: string;
  /** Present on `auto` only. */
  description?: string;
  /** Provider price in USDC per 1,000 tokens, before discount and protocol fee. Absent on `auto`. */
  price_per_1k_usdc?: number;
};

export type ModelList = { object: "list"; data: Model[] };

// ---------- public /api routes (amounts in micro units) ----------

/** Network totals from `GET /api/stats`. Every amount is an integer in micro units (see `fromMicro`). */
export type Stats = {
  volume: number;
  fees: number;
  requests: number;
  treasury: number;
  totalStaked: number;
  stakers: number;
  capacityTotal: number;
  capacityRemaining: number;
  sponsors: number;
  providers: number;
  epoch: number;
  /** Unix milliseconds. */
  epochEndsAt: number;
  epochFees: number;
  epochRequests: number;
  /** The last 24 epochs, oldest first. */
  series: { epoch: number; fees: number; volume: number; requests: number }[];
};

export type ParamKind = "bps" | "amount" | "seconds" | "count";

/** Known protocol parameters. The endpoint may return more keys as governance adds them. */
export type KnownParam =
  | "fee_bps"
  | "staker_share_bps"
  | "sponsor_share_bps"
  | "epoch_seconds"
  | "tier1_stake"
  | "tier2_stake"
  | "tier3_stake"
  | "tier1_discount_bps"
  | "tier2_discount_bps"
  | "tier3_discount_bps"
  | "provider_min_bond"
  | "vote_seconds"
  | "quorum"
  | "provider_min_stake"
  | "provider_unbond_seconds"
  | "congestion_capacity_rpm"
  | "congestion_threshold_bps";

/** `bps` values are basis points, `amount` values are micro units, `seconds` are seconds. */
export type Params = Partial<Record<KnownParam, number>> & Record<string, number>;

export type ParamInfo = { label: string; kind: ParamKind; governable: boolean };

export type ParamsResponse = { params: Params; info: Record<string, ParamInfo> };

/** One record of the hash-chained settlement log. Amounts are integers in micro USDC. */
export type SettlementRecord = {
  seq: number;
  id: string;
  key_id: string;
  payer: string;
  provider: string;
  model: string;
  tokens: number;
  base: number;
  discount: number;
  fee: number;
  to_stakers: number;
  to_sponsor: number;
  to_treasury: number;
  capacity_id: string;
  /** 1 when routed with priority, else 0. */
  priority: number;
  epoch: number;
  prev_hash: string;
  hash: string;
  /** Unix milliseconds. */
  created_at: number;
  /** Usage detail. `null` on older records. Not part of the settlement hash. */
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  /** 1 when the request was streamed, else 0. */
  stream: number;
};

/** A settlement record with the provider's display name, from `GET /api/requests`. */
export type RequestRecord = SettlementRecord & { provider_name: string | null };

/** `GET /api/chain`: records in order, so anyone can recompute every hash from `genesis`. */
export type ChainPage = { genesis: string; records: SettlementRecord[] };
