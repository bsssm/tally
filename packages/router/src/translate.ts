/**
 * Shape translation, used only when an Anthropic-shaped request must reach an upstream
 * that speaks OpenAI chat completions only (today: api.openai.com). Every other pairing
 * has a native endpoint on the upstream and is passed through unchanged:
 *   openai shape    → api.anthropic.com/v1/chat/completions, openrouter, openai   (no translation)
 *   anthropic shape → api.anthropic.com/v1/messages, openrouter /api/v1/messages   (no translation)
 *
 * Coverage is deliberately small: system, text, image (base64/url), tool definitions,
 * tool_use/tool_result, max_tokens, stop_sequences, temperature. Thinking blocks are dropped.
 */

type J = Record<string, unknown>;

export interface AnthropicRequest extends J {
  model: string;
  max_tokens?: number;
  system?: string | { type: string; text?: string }[];
  messages: { role: "user" | "assistant"; content: string | J[] }[];
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: J;
  stop_sequences?: string[];
  temperature?: number;
  stream?: boolean;
}

export function anthropicToOpenAIRequest(req: AnthropicRequest, model: string): J {
  const messages: J[] = [];
  const system = typeof req.system === "string" ? req.system : req.system?.map((b) => b.text ?? "").join("\n");
  if (system) messages.push({ role: "system", content: system });

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "user") {
      const toolResults = m.content.filter((b) => b.type === "tool_result");
      for (const b of toolResults) {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: flattenText(b.content) });
      }
      const rest = m.content.filter((b) => b.type !== "tool_result");
      if (rest.length) messages.push({ role: "user", content: rest.map(userPart).filter(Boolean) });
    } else {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text as string).join("");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: J = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    }
  }

  const out: J = { model, messages, stream: req.stream ?? false };
  if (req.max_tokens != null) out.max_completion_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  const tc = req.tool_choice?.type;
  if (tc === "any") out.tool_choice = "required";
  else if (tc === "tool") out.tool_choice = { type: "function", function: { name: req.tool_choice!.name } };
  else if (tc === "none") out.tool_choice = "none";
  if (req.stream) out.stream_options = { include_usage: true };
  return out;
}

function userPart(b: J): J | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "image") {
    const src = b.source as J;
    const url = src.type === "url" ? (src.url as string) : `data:${src.media_type};base64,${src.data}`;
    return { type: "image_url", image_url: { url } };
  }
  return null;
}

function flattenText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as J).text) : "")).join("");
  return "";
}

const FINISH: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "refusal" };

/** OpenAI chat completion → Anthropic message. */
export function openAIToAnthropicResponse(resp: J, model: string): J {
  const choice = ((resp.choices as J[] | undefined) ?? [])[0] ?? {};
  const msg = (choice.message as J | undefined) ?? {};
  const content: J[] = [];
  if (typeof msg.content === "string" && msg.content.length) content.push({ type: "text", text: msg.content });
  for (const c of (msg.tool_calls as J[] | undefined) ?? []) {
    const fn = c.function as J;
    let input: unknown = {};
    try {
      input = JSON.parse((fn.arguments as string) || "{}");
    } catch {
      input = { _raw: fn.arguments };
    }
    content.push({ type: "tool_use", id: c.id, name: fn.name, input });
  }
  const u = (resp.usage as J | undefined) ?? {};
  const details = (u.prompt_tokens_details as J | undefined) ?? {};
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  return {
    id: typeof resp.id === "string" ? resp.id.replace(/^chatcmpl/, "msg") : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: FINISH[String(choice.finish_reason)] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, ((u.prompt_tokens as number) ?? 0) - cached),
      output_tokens: (u.completion_tokens as number) ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

/** Render a finished Anthropic message as the SSE event sequence a streaming client expects. */
export function anthropicMessageToSSE(msg: J): string {
  const ev = (name: string, data: J) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const usage = msg.usage as J;
  let out = ev("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  (msg.content as J[]).forEach((block, i) => {
    if (block.type === "text") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  out += ev("message_stop", { type: "message_stop" });
  return out;
}
