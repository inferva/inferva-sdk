import { describe, expect, it } from "vitest";
import { ChatCompletionStream, InfervaClient, InsufficientFundsError, ProviderError, sseData, type ChatCompletionChunk } from "../src";
import { INFERVA_BLOCK, chunk, event, mockFetch, sse } from "./helpers";

const KEY = "inf_sk_placeholder";
const params = { messages: [{ role: "user" as const, content: "Hello" }], stream: true as const };

const FINAL = chunk({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 38, total_tokens: 50 }, inferva: INFERVA_BLOCK });

async function collect(stream: ChatCompletionStream) {
  const out: ChatCompletionChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("streaming", () => {
  it("sends stream: true and accepts event-stream", async () => {
    const fetch = mockFetch(sse([event(chunk({ role: "assistant", content: "Hi" })), event(FINAL), event("[DONE]")]));
    const stream = await new InfervaClient({ apiKey: KEY, fetch }).chat.completions.create(params);
    expect(stream).toBeInstanceOf(ChatCompletionStream);
    const { init } = fetch.calls[0]!;
    expect(JSON.parse(init.body as string).stream).toBe(true);
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    await collect(stream);
  });

  it("yields chunks in order and captures usage and the inferva block from the last one", async () => {
    const fetch = mockFetch(
      sse([event(chunk({ role: "assistant", content: "Hello" })), event(chunk({ content: "! How" })), event(chunk({ content: " can I help?" })), event(FINAL), event("[DONE]")]),
    );
    const stream = await new InfervaClient({ apiKey: KEY, fetch }).chat.completions.create(params);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "Hello" });
    expect(chunks.map((c) => c.choices[0]!.delta.content ?? "").join("")).toBe("Hello! How can I help?");
    expect(chunks[3]!.choices[0]!.finish_reason).toBe("stop");
    expect(stream.usage).toEqual({ prompt_tokens: 12, completion_tokens: 38, total_tokens: 50 });
    expect(stream.inferva?.cost_usdg).toBe(0.000099);
    expect(stream.inferva?.settlement.prev_hash).toBe("5d029b4f");
  });

  it("handles events split across network chunks, CRLF and comments", async () => {
    const raw = event(chunk({ role: "assistant", content: "A" })) + ": keep-alive\n\n" + event(chunk({ content: "B" })).replace(/\n/g, "\r\n") + event(FINAL) + event("[DONE]");
    const pieces: string[] = [];
    for (let i = 0; i < raw.length; i += 7) pieces.push(raw.slice(i, i + 7));
    const stream = await new InfervaClient({ apiKey: KEY, fetch: mockFetch(sse(pieces)) }).chat.completions.create(params);
    expect(await stream.text()).toBe("AB");
    expect(stream.inferva?.receipt).toBe(INFERVA_BLOCK.receipt);
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode(event(chunk({ role: "assistant", content: "héllo — ✓" })) + event("[DONE]"));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const stream = await new InfervaClient({ apiKey: KEY, fetch: mockFetch(new Response(body)) }).chat.completions.create(params);
    expect(await stream.text()).toBe("héllo — ✓");
  });

  it("stops at [DONE] even if more data follows", async () => {
    const stream = await new InfervaClient({ apiKey: KEY, fetch: mockFetch(sse([event(chunk({ role: "assistant", content: "x" })), event("[DONE]"), event(chunk({ content: "y" }))])) }).chat.completions.create(params);
    expect(await stream.text()).toBe("x");
  });

  it("throws a typed error sent inside the stream at settlement", async () => {
    const fetch = mockFetch(
      sse([
        event(chunk({ role: "assistant", content: "partial" })),
        event({ error: { message: "This request costs 0.000099 USDG and the key owner has 0.", type: "insufficient_funds" } }),
        event("[DONE]"),
      ]),
    );
    const stream = await new InfervaClient({ apiKey: KEY, fetch }).chat.completions.create(params);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const c of stream) seen.push(c.choices[0]!.delta.content ?? "");
    })().catch((e) => e);
    expect(seen).toEqual(["partial"]);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err.type).toBe("insufficient_funds");
    expect(err.status).toBeUndefined();
    expect(stream.inferva).toBeUndefined();
  });

  it("throws ProviderError when nothing was delivered", async () => {
    const fetch = mockFetch(sse([event({ error: { message: "Basalt Inference could not complete this request. You were not charged.", type: "provider_error" } }), event("[DONE]")]));
    const stream = await new InfervaClient({ apiKey: KEY, fetch }).chat.completions.create(params);
    await expect(stream.text()).rejects.toBeInstanceOf(ProviderError);
  });

  it("raises HTTP errors before the stream starts", async () => {
    const fetch = mockFetch(new Response(JSON.stringify({ error: { message: "Unknown or revoked API key", type: "invalid_api_key" } }), { status: 401 }));
    await expect(new InfervaClient({ apiKey: KEY, fetch }).chat.completions.create(params)).rejects.toMatchObject({ name: "AuthenticationError", status: 401 });
  });

  it("refuses to be read twice", async () => {
    const stream = await new InfervaClient({ apiKey: KEY, fetch: mockFetch(sse([event("[DONE]")])) }).chat.completions.create(params);
    await stream.text();
    await expect(stream.text()).rejects.toThrow(/already been read/);
  });
});

describe("sseData", () => {
  it("joins multi-line data fields and ignores other fields", async () => {
    const body = new Response("event: x\nid: 1\ndata: a\ndata: b\n\ndata:c\n\nretry: 5\n\ndata: tail").body!;
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    expect(out).toEqual(["a\nb", "c", "tail"]);
  });
});
