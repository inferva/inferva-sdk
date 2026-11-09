import { describe, expect, it } from "vitest";
import { InfervaClient, InfervaError, fromMicro } from "../src";
import { COMPLETION, json, mockFetch } from "./helpers";

const KEY = "inf_sk_placeholder";

describe("request shaping", () => {
  it("posts chat completions with bearer auth and a JSON body", async () => {
    const fetch = mockFetch(json(COMPLETION));
    const client = new InfervaClient({ apiKey: KEY, fetch });
    const res = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }], max_tokens: 64 });

    expect(fetch.calls).toHaveLength(1);
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe("https://dapp.inferva.xyz/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ model: "auto", messages: [{ role: "user", content: "Hello" }], max_tokens: 64 });

    expect(res.choices[0]!.message.content).toBe("Hello! How can I help?");
    expect(res.inferva.cost_usdg).toBe(0.000099);
    expect(res.inferva.breakdown.protocol_fee).toBe(0.000009);
    expect(res.inferva.receipt).toBe(`https://dapp.inferva.xyz/receipt/${res.id}`);
  });

  it("accepts a base URL with or without /v1 and trailing slashes", async () => {
    for (const baseURL of ["https://example.test", "https://example.test/", "https://example.test/v1", "https://example.test/v1/"]) {
      const fetch = mockFetch(json({ object: "list", data: [] }));
      const client = new InfervaClient({ baseURL, fetch });
      expect(client.baseURL).toBe("https://example.test");
      await client.models.list();
      expect(fetch.calls[0]!.url).toBe("https://example.test/v1/models");
    }
  });

  it("does not send a key on public routes", async () => {
    const fetch = mockFetch(json({ object: "list", data: [] }));
    await new InfervaClient({ apiKey: KEY, fetch }).models.list();
    const { init } = fetch.calls[0]!;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("refuses to call chat completions without a key", async () => {
    const fetch = mockFetch();
    const client = new InfervaClient({ fetch });
    await expect(client.chat.completions.create({ messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow(/Missing API key/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("sends extra headers on every request", async () => {
    const fetch = mockFetch(json({}));
    await new InfervaClient({ fetch, headers: { "x-agent": "demo" } }).stats();
    expect((fetch.calls[0]!.init.headers as Record<string, string>)["x-agent"]).toBe("demo");
  });
});

describe("public /api helpers", () => {
  it("stats() hits /api/stats", async () => {
    const fetch = mockFetch(json({ volume: 381, fees: 35, requests: 1, series: [] }));
    const stats = await new InfervaClient({ fetch }).stats();
    expect(fetch.calls[0]!.url).toBe("https://dapp.inferva.xyz/api/stats");
    expect(stats.requests).toBe(1);
    expect(fromMicro(stats.volume)).toBe(0.000381);
  });

  it("params() hits /api/params", async () => {
    const fetch = mockFetch(json({ params: { fee_bps: 1000 }, info: { fee_bps: { label: "Protocol fee on provider cost", kind: "bps", governable: true } } }));
    const res = await new InfervaClient({ fetch }).params();
    expect(fetch.calls[0]!.url).toBe("https://dapp.inferva.xyz/api/params");
    expect(res.params.fee_bps).toBe(1000);
    expect(res.info.fee_bps!.kind).toBe("bps");
  });

  it("chain() passes after and limit, and omits unset values", async () => {
    const fetch = mockFetch(json({ genesis: "0".repeat(64), records: [] }), json({ genesis: "0".repeat(64), records: [] }));
    const client = new InfervaClient({ fetch });
    await client.chain({ after: 120, limit: 50 });
    await client.chain();
    expect(fetch.calls[0]!.url).toBe("https://dapp.inferva.xyz/api/chain?after=120&limit=50");
    expect(fetch.calls[1]!.url).toBe("https://dapp.inferva.xyz/api/chain");
  });

  it("requests() passes limit", async () => {
    const fetch = mockFetch(json([]));
    await new InfervaClient({ fetch }).requests({ limit: 10 });
    expect(fetch.calls[0]!.url).toBe("https://dapp.inferva.xyz/api/requests?limit=10");
  });
});

describe("transport", () => {
  it("times out", async () => {
    const fetch = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const client = new InfervaClient({ fetch, timeoutMs: 20 });
    const err = await client.stats().catch((e) => e);
    expect(err).toBeInstanceOf(InfervaError);
    expect(err.name).toBe("ConnectionError");
    expect(err.message).toMatch(/timed out after 20 ms/);
    expect(err.retryable).toBe(true);
  });

  it("honours a caller abort signal", async () => {
    const fetch = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const controller = new AbortController();
    const pending = new InfervaClient({ fetch }).stats({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "ConnectionError" });
  });

  it("raises a parse error on non-JSON success bodies", async () => {
    const fetch = mockFetch(new Response("<html>", { status: 200 }));
    await expect(new InfervaClient({ fetch }).stats()).rejects.toMatchObject({ name: "ResponseParseError" });
  });
});
