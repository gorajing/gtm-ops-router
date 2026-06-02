type JsonSchema = Record<string, unknown>;
interface ToolUseBlock { type: "tool_use"; name: string; input: unknown; [k: string]: unknown; }
interface MessageResponse { stop_reason: string; content: Array<{ type: string; [k: string]: unknown }>; }

export interface ClaudeClientOptions { fetchImpl?: typeof fetch; timeoutMs?: number; model?: string; }

export class ClaudeClient {
  private static ENDPOINT = "https://api.anthropic.com/v1/messages";
  private static VERSION = "2023-06-01";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly model: string;

  constructor(private readonly apiKey: string, opts: ClaudeClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.model = opts.model ?? "claude-opus-4-8";
  }

  async synthesize(system: string, userContent: string, toolName: string, inputJsonSchema: JsonSchema): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(ClaudeClient.ENDPOINT, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": ClaudeClient.VERSION, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: userContent }],
          tools: [{ name: toolName, description: `Return the structured result as ${toolName}.`, input_schema: inputJsonSchema }],
          tool_choice: { type: "tool", name: toolName },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try { detail = JSON.parse(raw).error.message; } catch { /* keep raw */ }
      throw new Error(`Anthropic ${res.status}: ${detail}`);
    }
    const msg = JSON.parse(raw) as MessageResponse;
    if (msg.stop_reason === "max_tokens") throw new Error("tool input truncated (max_tokens)");
    const block = msg.content.find((b): b is ToolUseBlock => b.type === "tool_use" && (b as ToolUseBlock).name === toolName);
    if (!block) throw new Error(`no tool_use block for "${toolName}" (stop_reason=${msg.stop_reason})`);
    return block.input;
  }
}
