import { describe, expect, it } from "vitest";
import { anthropicMessageToSSE, anthropicToOpenAIRequest, openAIToAnthropicResponse, type AnthropicRequest } from "./translate.js";

describe("translate: Anthropic → OpenAI request", () => {
  it("hoists system, maps tools, tool_use and tool_result", () => {
    const req: AnthropicRequest = {
      model: "claude-opus-5-5",
      max_tokens: 500,
      system: [{ type: "text", text: "Be terse." }],
      tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      stop_sequences: ["END"],
      messages: [
        { role: "user", content: "Weather in Paris?" },
        { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "18C" }] }, { type: "text", text: "and Rome?" }] },
      ],
      stream: true,
    };
    const out = anthropicToOpenAIRequest(req, "gpt-4o");
    expect(out.model).toBe("gpt-4o");
    expect(out.max_completion_tokens).toBe(500);
    expect(out.stop).toEqual(["END"]);
    expect(out.stream_options).toEqual({ include_usage: true });
    const msgs = out.messages as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: "system", content: "Be terse." });
    expect(msgs[1]).toEqual({ role: "user", content: "Weather in Paris?" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "Checking." });
    expect((msgs[2].tool_calls as Record<string, unknown>[])[0]).toEqual({ id: "tu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "18C" });
    expect(msgs[4]).toEqual({ role: "user", content: [{ type: "text", text: "and Rome?" }] });
    expect((out.tools as Record<string, unknown>[])[0]).toMatchObject({ type: "function", function: { name: "get_weather" } });
    expect(out.tool_choice).toBeUndefined();
  });

  it("maps images and forced tool choice", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        tool_choice: { type: "tool", name: "x" },
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what" }] }],
      },
      "gpt-4o",
    );
    const m = (out.messages as Record<string, unknown>[])[0];
    expect(m.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "what" }]);
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "x" } });
    expect(out.stream).toBe(false);
  });
});

describe("translate: OpenAI → Anthropic response", () => {
  const resp = {
    id: "chatcmpl-abc",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Let me check.", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
  };

  it("builds a message with text + tool_use and Anthropic usage fields", () => {
    const msg = openAIToAnthropicResponse(resp, "claude-opus-5-5");
    expect(msg).toMatchObject({ id: "msg-abc", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use" });
    expect(msg.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Rome" } },
    ]);
    expect(msg.usage).toEqual({ input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
  });

  it("renders a finished message as a valid Anthropic SSE sequence", () => {
    const sse = anthropicMessageToSSE(openAIToAnthropicResponse(resp, "claude-opus-5-5"));
    const events = sse.split("\n\n").filter(Boolean).map((e) => e.split("\n")[0].replace("event: ", ""));
    expect(events).toEqual([
      "message_start",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(sse).toContain('"partial_json":"{\\"city\\":\\"Rome\\"}"');
    expect(sse).toContain('"output_tokens":30');
  });
});
