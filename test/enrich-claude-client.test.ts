import { describe, it, expect } from "vitest";
import { ClaudeClient } from "../src/enrich/claude-client.js";

describe("ClaudeClient", () => {
  it("forces the tool and returns the parsed tool input", async () => {
    const captured: { body?: any } = {};
    const fakeFetch = async (_url: string, init: any) => {
      captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "firmographics", input: { industry: "freight" } }],
      }), { status: 200 });
    };
    const client = new ClaudeClient("sk-test", { fetchImpl: fakeFetch as typeof fetch });
    const out = await client.synthesize("sys", "evidence", "firmographics", { type: "object", properties: {} });
    expect(out).toEqual({ industry: "freight" });
    expect(captured.body.tool_choice).toEqual({ type: "tool", name: "firmographics" });
    expect(captured.body.model).toBe("claude-opus-4-8");
  });
  it("throws on a non-2xx response", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 });
    const client = new ClaudeClient("sk-test", { fetchImpl: fakeFetch as typeof fetch });
    await expect(client.synthesize("s", "u", "firmographics", { type: "object" })).rejects.toThrow(/429|rate_limit/);
  });
});
