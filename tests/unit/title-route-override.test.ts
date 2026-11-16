import { describe, it } from "node:test";
import assert from "node:assert";
import {
  hasConversationTitleShape,
  resolveTitleRouteOverride,
} from "../../open-sse/services/titleRouting.ts";

// Verbatim from the OpenCode CLI (call_logs 2026-11-16): the title call the free lane
// refuses with `429 FreeUsageLimitError` while the same session's coding turn answers 200.
const OPENCODE_TITLE_PROMPT =
  "You name conversations so the user can find them later in a list of past sessions.\n\n" +
  "You will receive the first message of a conversation, or for an ongoing conversation " +
  "its original request and recent messages. Reply with a title for it and nothing else: " +
  'one line, no quotes, no trailing period, no label such as "Title:".';
const OPENCODE_TITLE_USER =
  "Here is the first message of the conversation:\n\n<message>\nit's not\n</message>\n\n" +
  "Reply with the title only.";

const titleBody = () => ({
  model: "open-free",
  stream: true,
  messages: [
    { role: "system", content: OPENCODE_TITLE_PROMPT },
    { role: "user", content: OPENCODE_TITLE_USER },
  ],
});

const agentBody = () => ({
  model: "open-free",
  stream: true,
  messages: [
    { role: "system", content: "You are an AI agent running in OpenCode, a coding agent harness." },
    { role: "user", content: "it's not" },
    { role: "assistant", content: 'What "it"? No context.' },
    { role: "user", content: "That's was just a test." },
  ],
});

describe("conversation-title request detection", () => {
  it("recognizes the OpenCode CLI title call", () => {
    assert.strictEqual(hasConversationTitleShape(titleBody()), true);
  });

  it("recognizes a title call that also carries other content blocks", () => {
    const body = titleBody();
    body.messages[0] = {
      role: "system",
      content: [{ type: "text", text: OPENCODE_TITLE_PROMPT }] as never,
    };
    assert.strictEqual(hasConversationTitleShape(body), true);
  });

  it("does not touch an ordinary one-line chat turn", () => {
    assert.strictEqual(
      hasConversationTitleShape({ model: "auto", messages: [{ role: "user", content: "Hello!" }] }),
      false
    );
  });

  it("does not touch an agent turn, even with a title-shaped first message", () => {
    assert.strictEqual(hasConversationTitleShape(agentBody()), false);
  });

  it("rejects a title prompt that still declares tools (agent-shaped call)", () => {
    const body = { ...titleBody(), tools: [{ type: "function", function: { name: "read" } }] };
    assert.strictEqual(hasConversationTitleShape(body), false);
  });

  it("rejects a two-message body whose prompt is not a title instruction", () => {
    const body = {
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Explain this stack trace." },
      ],
    };
    assert.strictEqual(hasConversationTitleShape(body), false);
  });

  it("rejects malformed bodies", () => {
    assert.strictEqual(hasConversationTitleShape(null), false);
    assert.strictEqual(hasConversationTitleShape("nope"), false);
    assert.strictEqual(hasConversationTitleShape({ messages: "nope" }), false);
    assert.strictEqual(hasConversationTitleShape({ messages: [] }), false);
  });
});

describe("title route override", () => {
  it("routes a title call to the configured target", () => {
    assert.deepStrictEqual(resolveTitleRouteOverride("open-free", titleBody(), "auto"), {
      wasRouted: true,
      model: "auto",
    });
  });

  it("accepts a model reference or combo name as the target", () => {
    assert.deepStrictEqual(
      resolveTitleRouteOverride("open-free", titleBody(), " mistral/mistral-medium-3.5 "),
      { wasRouted: true, model: "mistral/mistral-medium-3.5" }
    );
  });

  it("is inert when no target is configured", () => {
    for (const configured of [undefined, null, "", "   "]) {
      assert.deepStrictEqual(resolveTitleRouteOverride("open-free", titleBody(), configured), {
        wasRouted: false,
        model: "open-free",
      });
    }
  });

  it("is inert for a non-title request even when a target is configured", () => {
    assert.deepStrictEqual(resolveTitleRouteOverride("open-free", agentBody(), "auto"), {
      wasRouted: false,
      model: "open-free",
    });
  });

  it("does not rewrite when the request already targets the title route", () => {
    assert.deepStrictEqual(resolveTitleRouteOverride("auto", titleBody(), "auto"), {
      wasRouted: false,
      model: "auto",
    });
  });
});
