import { errorFrom, ResponseParseError } from "./errors";
import type { ChatCompletionChunk, InfervaBlock, Usage } from "./types";

/**
 * Yield the `data:` payloads of a server-sent event stream, one per event.
 * Comments, keep-alives and other fields are skipped. Works with any WHATWG ReadableStream.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const line = function* (raw: string): Generator<string> {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") {
      if (data.length) yield data.join("\n");
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield* line(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield* line(buffer);
    yield* line("");
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * A streamed chat completion. Iterate it with `for await` to get each `chat.completion.chunk`.
 * Errors the endpoint sends inside the stream (for example `insufficient_funds` at settlement,
 * or `provider_error` when nothing was delivered) are thrown from the iterator as typed errors.
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  /** Usage of the request, set once the final chunk has arrived. */
  usage: Usage | undefined;
  /** Cost and settlement block, set once the final chunk has arrived. */
  inferva: InfervaBlock | undefined;
  private consumed = false;

  constructor(
    private readonly response: Response,
    private readonly controller: AbortController,
  ) {}

  /** Stop reading. The request still settles on the server for whatever was already delivered. */
  abort(): void {
    this.controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.consumed) throw new Error("This stream has already been read");
    this.consumed = true;
    const body = this.response.body;
    if (!body) throw new ResponseParseError("The response has no body to stream", { status: this.response.status });
    try {
      for await (const payload of sseData(body)) {
        if (payload === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new ResponseParseError(`Could not parse stream event: ${payload.slice(0, 200)}`, { status: this.response.status, body: payload });
        }
        if (parsed && typeof parsed === "object" && "error" in parsed) throw errorFrom(parsed, undefined, this.response.headers);
        const chunk = parsed as ChatCompletionChunk;
        if (chunk.usage) this.usage = chunk.usage;
        if (chunk.inferva) this.inferva = chunk.inferva;
        yield chunk;
      }
    } finally {
      this.controller.abort();
    }
  }

  /** Read the whole stream and return the concatenated assistant text. `usage` and `inferva` are set afterwards. */
  async text(): Promise<string> {
    let out = "";
    for await (const chunk of this) out += chunk.choices[0]?.delta.content ?? "";
    return out;
  }
}
