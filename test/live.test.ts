import { describe, expect, it } from "vitest";
import { InfervaClient } from "../src";

// Opt-in smoke test against the real endpoint. Read-only, no key needed: INFERVA_LIVE=1 pnpm test:live
const live = process.env.INFERVA_LIVE === "1";

describe.skipIf(!live)("live endpoint", () => {
  const client = new InfervaClient({ baseURL: process.env.INFERVA_BASE_URL });

  it("lists models, starting with auto", async () => {
    const res = await client.models.list();
    expect(res.object).toBe("list");
    expect(res.data[0]?.id).toBe("auto");
    for (const m of res.data.slice(1)) expect(typeof m.price_per_1k_usdc).toBe("number");
  });

  it("reads network stats", async () => {
    const stats = await client.stats();
    expect(typeof stats.requests).toBe("number");
    expect(stats.series).toHaveLength(24);
  });
});
