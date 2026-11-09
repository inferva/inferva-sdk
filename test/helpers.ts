import type { ChatCompletion, ChatCompletionChunk, InfervaBlock } from "../src";

// Example values based on the INFERVA docs chat completions example.
export const INFERVA_BLOCK: InfervaBlock = {
  provider: "Basalt Inference",
  cost_usdg: 0.000099,
  breakdown: {
    provider_cost: 0.00009,
    protocol_fee: 0.000009,
    to_sponsor: 0.000007,
    to_treasury: 0.000002,
  },
  capacity: "cap_9e41d2a07b3c",
  epoch: 498384,
  settlement: { hash: "a3c9e217", prev_hash: "5d029b4f" },
  receipt: "https://dapp.inferva.xyz/receipt/req_4b1f0c9a7e2d58a13c6f",
};

export const COMPLETION: ChatCompletion = {
  id: "req_4b1f0c9a7e2d58a13c6f",
  object: "chat.completion",
  created: 1794182523,
  model: "basalt-70b",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello! How can I help?" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 38, total_tokens: 50 },
  inferva: INFERVA_BLOCK,
};

export const chunk = (delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null, extra: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk => ({
  id: COMPLETION.id,
  object: "chat.completion.chunk",
  created: COMPLETION.created,
  model: COMPLETION.model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

export type Recorded = { url: string; init: RequestInit };

/** A fetch mock that records each call and answers with the given responses in order. */
export function mockFetch(...responses: (Response | (() => Response) | Error)[]) {
  const calls: Recorded[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A text/event-stream response whose body is split into the given raw pieces (to exercise chunk boundaries). */
export function sse(pieces: string[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

/** Encode events exactly as the endpoint writes them: `data: <json>\n\n`. */
export const event = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
