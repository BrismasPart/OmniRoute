/**
 * #14313: an OpenCode free-tier refusal is request-scoped for combo routing.
 *
 * The refusal is the same verdict on every account for the same request shape, so
 * neither model lockout nor provider cooldown may fire from it. Combo's scoped-failure
 * gate currently only knows local limiter codes, context overflow, 404 resource-not-found
 * and a few status/type pairs — FreeTierError and the relayed sentence fall through,
 * so `scopedFailure` stays false and both lockout arms (priority + done-retrying) run.
 */
import test from "node:test";
import assert from "node:assert/strict";

const FREE_TIER_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
  },
});
const RELAYED_MESSAGE = "OpenCode's free tier can only be used from within OpenCode";
const PLAIN_AUTH_BODY = JSON.stringify({
  error: { message: "invalid api key", type: "auth_error" },
});

const { isComboRequestScopedFailure, isRequestScopedUpstreamFailure, shouldSkipConnDisable } =
  await import("../../open-sse/services/combo/comboPredicates.ts");

function refusalResponse(status = 403): Response {
  return new Response(FREE_TIER_BODY, {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a FreeTierError type is request-scoped upstream", () => {
  assert.equal(isRequestScopedUpstreamFailure({ type: "FreeTierError" }), true);
  assert.equal(isRequestScopedUpstreamFailure({ code: "FreeTierError" }), true);
});

test("a free-tier 403 body is a combo request-scoped failure", () => {
  assert.equal(
    isComboRequestScopedFailure(refusalResponse(), FREE_TIER_BODY, { type: "FreeTierError" }),
    true
  );
});

test("a relayed free-tier sentence without error.type is still request-scoped", () => {
  assert.equal(isComboRequestScopedFailure(refusalResponse(), RELAYED_MESSAGE, undefined), true);
});

test("class 451 free-tier refusal is request-scoped like 403", () => {
  assert.equal(isComboRequestScopedFailure(refusalResponse(451), FREE_TIER_BODY, undefined), true);
});

test("shouldSkipConnDisable never cools the connection for a free-tier refusal", () => {
  assert.equal(
    shouldSkipConnDisable(
      { status: 403, response: refusalResponse(), errorCode: null, errorType: "FreeTierError" },
      false,
      false,
      "opencode"
    ),
    true
  );
});

test("an ordinary auth 403 is NOT request-scoped (unchanged)", () => {
  const response = new Response(PLAIN_AUTH_BODY, {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  assert.equal(
    isComboRequestScopedFailure(response, PLAIN_AUTH_BODY, { type: "auth_error" }),
    false
  );
});

// 2026-11-16: the free lane also answers 429 `FreeUsageLimitError` to a request it will
// not spend free capacity on (measured: the OpenCode CLI's conversation-title call, 10/10,
// while a coding turn from the same model/account/session answers 200 in the same second).
// The response carries `retry-after` ≈ seconds to 00:00 UTC; taken as a target cooldown it
// marks the combo semaphore rate-limited for ~24 h, so every later request waits out the
// semaphore timeout and the combo answers 503 — the block this scoping prevents.
const FREE_USAGE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeUsageLimitError",
    message:
      "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); " +
      "subscribe to OpenCode Go to keep going: https://opencode.ai/go",
  },
});
const FREE_USAGE_LIMIT_MESSAGE =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); " +
  "subscribe to OpenCode Go to keep going: https://opencode.ai/go";

function freeUsageLimitResponse(status = 429, body = FREE_USAGE_LIMIT_BODY): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "retry-after": "85085" },
  });
}

test("a free-usage-limit 429 from opencode is a combo request-scoped failure", () => {
  for (const provider of ["opencode", "opencode-zen", "opencode-go"]) {
    assert.equal(
      isComboRequestScopedFailure(
        freeUsageLimitResponse(),
        FREE_USAGE_LIMIT_MESSAGE,
        { type: "FreeUsageLimitError" },
        provider
      ),
      true
    );
  }
});

test("the free-usage-limit body alone marks the failure request-scoped", () => {
  assert.equal(
    isComboRequestScopedFailure(
      freeUsageLimitResponse(),
      FREE_USAGE_LIMIT_BODY,
      undefined,
      "opencode-zen"
    ),
    true
  );
});

test("the same 429 on a foreign provider keeps its own handling", () => {
  assert.equal(
    isComboRequestScopedFailure(
      freeUsageLimitResponse(),
      FREE_USAGE_LIMIT_MESSAGE,
      { type: "FreeUsageLimitError" },
      "groq"
    ),
    false
  );
  // Without a provider the predicate cannot scope the body to opencode, so it must not
  // claim the failure — the visitor that knows the provider passes it explicitly.
  assert.equal(isComboRequestScopedFailure(freeUsageLimitResponse(), FREE_USAGE_LIMIT_BODY), false);
});

test("a paid-lane monthly limit 429 stays a real target cooldown", () => {
  const body = JSON.stringify({
    type: "error",
    error: { type: "RateLimitError", message: "monthly usage limit reached for this key" },
  });
  assert.equal(
    isComboRequestScopedFailure(freeUsageLimitResponse(429, body), body, undefined, "opencode-zen"),
    false
  );
});
