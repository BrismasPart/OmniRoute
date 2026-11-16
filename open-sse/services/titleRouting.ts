/**
 * Conversation-title routing — sends a CLI harness's title/auxiliary call to a route the
 * operator picks, instead of letting it ride the main chat model.
 *
 * Why: harnesses (the OpenCode CLI, among others) name the session by calling the SAME
 * `/v1/chat/completions` endpoint with a tiny auxiliary prompt. On a free lane that call is
 * the one upstream refuses (measured 2026-11-16: `429 FreeUsageLimitError`, same model,
 * account and session answering a coding turn 200 in the same second), so every turn pays
 * the combo walking its targets for a request that cannot succeed, and the session title
 * never gets generated. The title is a labeling task, not part of the user's work: it does
 * not need the model the user chose.
 *
 * Scope is deliberately narrow — a title request is recognized by shape AND by its prompt
 * anchor, so an ordinary short chat ("Hello!") is never rerouted. Only the model string
 * changes: the request itself keeps its messages, tools and parameters.
 */

// Prompt anchors observed in title/auxiliary calls. Exact lowercase substrings; a
// near-miss falls through to normal routing (fail closed — rerouting the user's work
// because a prompt looked similar would be worse than not rerouting a title).
const TITLE_PROMPT_ANCHORS = [
  // OpenCode CLI (observed 2026-11-16): "You name conversations so the user can find
  // them later in a list of past sessions. … Reply with a title for it and nothing else".
  "you name conversations so the user can find them later",
  "reply with a title for it and nothing else",
  // Generic title instructions used by other harnesses.
  "generate a title for this conversation",
  "give this conversation a title",
  "name this conversation",
  "suggest a title for this",
];

interface TitleRequestMessage {
  role?: unknown;
  content?: unknown;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join(" ");
}

/**
 * True when the body is a harness title/auxiliary call: a single user turn, at most one
 * system message, no assistant/tool turns, no tools, and a title prompt anchor in the
 * system content. A coding turn always carries either history or tools, so it is excluded
 * by shape before the text is even read.
 */
export function hasConversationTitleShape(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { messages?: unknown; tools?: unknown };
  const tools = record.tools;
  if (Array.isArray(tools) && tools.length > 0) return false;
  const messages = record.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 2) return false;

  const typed = messages as TitleRequestMessage[];
  const userMessages = typed.filter((message) => message?.role === "user");
  if (userMessages.length !== 1) return false;
  const systemMessages = typed.filter(
    (message) => message?.role === "system" || message?.role === "developer"
  );
  if (systemMessages.length > 1) return false;

  const systemContent = systemMessages.map((message) => messageText(message.content)).join(" ");
  if (!systemContent) return false;
  const lower = systemContent.toLowerCase();
  return TITLE_PROMPT_ANCHORS.some((anchor) => lower.includes(anchor));
}

/**
 * Resolve whether this request should be routed to the configured title route.
 *
 * Routes only when the shape matches, the operator configured a target, and it differs
 * from the current model (so re-entry on the already-chosen target is a no-op). The
 * returned string is a normal model reference — provider/model, alias, or combo name — and
 * is resolved by the usual pipeline.
 */
export function resolveTitleRouteOverride(
  currentModel: string,
  body: unknown,
  configuredTitleModel: string | null | undefined
): { wasRouted: boolean; model: string } {
  const configured = typeof configuredTitleModel === "string" ? configuredTitleModel.trim() : "";
  if (!configured || configured === currentModel) return { wasRouted: false, model: currentModel };
  if (!hasConversationTitleShape(body)) return { wasRouted: false, model: currentModel };
  return { wasRouted: true, model: configured };
}
