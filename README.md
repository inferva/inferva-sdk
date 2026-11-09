# @inferva/sdk

TypeScript client for the [INFERVA](https://inferva.xyz) agent endpoint.

INFERVA is one endpoint that AI agents pay through. An agent sends an OpenAI-style chat request with its key, INFERVA
routes it to a provider, meters it, charges the key owner in USDG and writes the request to a hash-chained settlement
log. The protocol fee on every request is split between the capacity sponsor whose capacity served it and the
treasury. INFERVA is launching on Robinhood Chain.

This SDK gives you:

- `chat.completions.create()`, plain or streamed (an async iterator of `chat.completion.chunk` events)
- `models.list()`
- full typing of the `inferva` block every response carries: cost in USDG, the fee breakdown, capacity position,
  epoch, settlement hash and receipt URL
- typed errors for every error code the endpoint returns
- read-only helpers for the public network data: `stats()`, `params()`, `chain()`, `requests()`

Zero runtime dependencies. It uses the global `fetch`, so it runs on Node.js 18+, browsers, Deno, Bun and edge
runtimes.

## Install

Not on npm yet. Install from a clone:

```sh
git clone https://github.com/inferva/inferva-sdk.git && cd inferva-sdk
pnpm install && pnpm build
# then, in your project
pnpm add /absolute/path/to/inferva-sdk
```

Once published it will be `pnpm add @inferva/sdk`.

## Get a key

Open [dapp.inferva.xyz](https://dapp.inferva.xyz), connect a wallet and sign in, then create a key under
**Endpoint & keys**. Keys start with `inf_sk_` and are shown once. Requests are paid from the USDG balance of the
account that owns the key. Every account has the same rate limit, 10 requests per minute.

Keep the key on the server. Do not ship it to a browser.

## Quickstart

```ts
import { InfervaClient } from "@inferva/sdk";

const inferva = new InfervaClient({ apiKey: process.env.INFERVA_KEY }); // inf_sk_...

const res = await inferva.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(res.choices[0].message.content);
console.log(res.inferva.cost_usdg, res.inferva.receipt);
```

`res.inferva` looks like this (example values; see the [docs](https://docs.inferva.xyz/api/chat-completions)):

```json
{
  "provider": "Basalt Inference",
  "cost_usdg": 0.000099,
  "breakdown": {
    "provider_cost": 0.00009,
    "protocol_fee": 0.000009,
    "to_sponsor": 0.000007,
    "to_treasury": 0.000002
  },
  "capacity": "cap_9e41d2a07b3c",
  "epoch": 498384,
  "settlement": { "hash": "a3c9…e217", "prev_hash": "5d02…9b4f" },
  "receipt": "https://dapp.inferva.xyz/receipt/req_4b1f0c9a7e2d58a13c6f"
}
```

## Works with the `openai` client too

The endpoint is OpenAI-compatible, so the official `openai` npm client works by pointing `baseURL` at INFERVA. The
`inferva` block is still in the response, just untyped:

```ts
import OpenAI from "openai";
import type { InfervaBlock } from "@inferva/sdk";

const client = new OpenAI({ baseURL: "https://dapp.inferva.xyz/v1", apiKey: process.env.INFERVA_KEY });
const res = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] });

// The inferva block is there too; type it with this SDK's types:
const { inferva } = res as typeof res & { inferva: InfervaBlock };
```

Use `@inferva/sdk` when you want the `inferva` block, the network helpers and the error classes typed without casts.

## API

### `new InfervaClient(options?)`

| Option      | Default                    | Notes                                                                 |
| ----------- | -------------------------- | --------------------------------------------------------------------- |
| `apiKey`    | none                       | `inf_sk_...`. Only needed for `chat.completions.create()`.            |
| `baseURL`   | `https://dapp.inferva.xyz` | A trailing `/v1` is accepted, so the same value works for both SDKs.  |
| `timeoutMs` | `60000`                    | Per request. For streams it covers the wait for the response headers. |
| `fetch`     | global `fetch`             | Pass your own for tests or older runtimes.                            |
| `headers`   | `{}`                       | Extra headers sent with every request.                                |

Every method takes an optional last argument `{ signal?: AbortSignal; timeoutMs?: number }`.

### `chat.completions.create(params)`

`POST /v1/chat/completions`. Params:

| Field        | Type                                       | Notes                                                                               |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `messages`   | `{ role, content }[]`                      | Required. `content` is a string or an array of parts with `text`.                   |
| `model`      | `string`                                   | `auto` (default) routes to the cheapest active provider, or a model id from below.  |
| `max_tokens` | `number`                                   | Defaults to and is capped at 1,024.                                                 |
| `stream`     | `boolean`                                  | `true` returns a `ChatCompletionStream` instead of a `ChatCompletion`.              |

Current endpoint limits: only the last 20 messages are used, each is cut to 8,000 characters, and every role other
than `assistant` (including `system`) is sent as `user`.

Returns a `ChatCompletion`: `id` (also the settlement record id), `model`, `choices`, `usage` and `inferva`.

### `models.list()`

`GET /v1/models`, no key needed. Returns `auto` plus every model an active provider serves, with the provider name in
`owned_by` and its price in USDG per 1,000 tokens in `price_per_1k_usdg`.

### Network data (read-only, no key)

| Method                       | Route               | Returns                                                                       |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `stats()`                    | `GET /api/stats`    | Volume, fees, requests, sponsor/treasury shares, capacity, last 24 epochs.    |
| `params()`                   | `GET /api/params`   | `{ params, info }`: current protocol parameters and what each one means.      |
| `chain({ after?, limit? })`  | `GET /api/chain`    | `{ genesis, records }`: settlement records in order after `seq` `after`.      |
| `requests({ limit? })`       | `GET /api/requests` | The latest settled requests across the network, newest first.                 |

`limit` is clamped to 1 to 200 by the server. Amounts from these routes are **integers in micro units**
(1 USDG = 1,000,000). Use `fromMicro()` to convert:

```ts
import { InfervaClient, fromMicro } from "@inferva/sdk";

const inferva = new InfervaClient();
const stats = await inferva.stats();
console.log(`${stats.requests} requests, ${fromMicro(stats.fees)} USDG in fees`);

const { genesis, records } = await inferva.chain({ after: 0, limit: 100 });
```

Each record carries `prev_hash` and `hash`, so you can recompute the chain from `genesis` and check receipts you kept
from `res.inferva.settlement`. See [Settlement log](https://docs.inferva.xyz/settlement) for the hashed fields.

## Streaming

```ts
const stream = await inferva.chat.completions.create({
  messages: [{ role: "user", content: "Write a haiku about settlement" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}

console.log(stream.usage, stream.inferva?.cost_usdg);
```

Chunks follow the `chat.completion.chunk` shape. The request is settled once, at the end, with the real usage: the
last chunk has an empty delta, `finish_reason: "stop"`, `usage` and the `inferva` block. The stream keeps them on
`stream.usage` and `stream.inferva` after you finish reading. `await stream.text()` reads everything and returns the
full text. `stream.abort()` stops reading early.

If something fails after the stream has started (for example the balance no longer covers the final cost, or the
provider delivered nothing), the endpoint sends an error event and the iterator throws the matching typed error.
Errors before the stream starts are thrown by `create()` itself.

## Errors

Every error extends `InfervaError` with `status`, `type`, `message`, `body` and `retryable`.

| Status | `type`                  | Class                    | Meaning                                                    |
| ------ | ----------------------- | ------------------------ | ---------------------------------------------------------- |
| 400    | `invalid_request_error` | `BadRequestError`        | No `messages` array, or no message has text content        |
| 401    | `invalid_api_key`       | `AuthenticationError`    | Missing, unknown or revoked key                            |
| 402    | `insufficient_funds`    | `InsufficientFundsError` | The key owner's USDG balance cannot cover the request      |
| 402    | `spend_cap_reached`     | `SpendCapReachedError`   | The key's monthly spend cap would be exceeded              |
| 403    | `model_not_allowed`     | `ModelNotAllowedError`   | The key's allowed-models list excludes this model          |
| 404    | `model_not_found`       | `ModelNotFoundError`     | No active provider serves the requested model              |
| 429    | `rate_limit_exceeded`   | `RateLimitError`         | Over the per-account requests per minute; see `retryAfter` |
| 502    | `provider_error`        | `ProviderError`          | The provider could not complete the request                |
| 503    | `capacity_exhausted`    | `CapacityExhaustedError` | No sponsored capacity position has room for the request    |
| 503    | `settlement_busy`       | `SettlementBusyError`    | The settlement log was busy; retry                         |
| 5xx    | `server_error`          | `ServerError`            | Something went wrong on the server                         |

Also: `NotFoundError` (unknown route), `ConnectionError` (network failure, timeout or abort) and
`ResponseParseError`. Funds and capacity are checked against the worst-case cost before generation, and a request
that fails with any of the errors above is not charged.

```ts
import { CapacityExhaustedError, InsufficientFundsError, RateLimitError } from "@inferva/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  await inferva.chat.completions.create({ messages: [{ role: "user", content: "Hi" }] });
} catch (err) {
  if (err instanceof RateLimitError) await sleep((err.retryAfter ?? 60) * 1000);
  else if (err instanceof InsufficientFundsError) console.error("Top up the key owner's USDG balance");
  else if (err instanceof CapacityExhaustedError) console.error("No sponsored capacity has room right now");
  else throw err;
}
```

## Development

```sh
pnpm install
pnpm test        # unit tests with a mocked fetch
pnpm test:live   # read-only smoke test against the real endpoint (/v1/models and /api/stats, no key)
pnpm typecheck
pnpm build
```

## Links

- Website: https://inferva.xyz
- Docs: https://docs.inferva.xyz
- App: https://dapp.inferva.xyz
- GitHub: https://github.com/inferva

## License

[MIT](./LICENSE)
