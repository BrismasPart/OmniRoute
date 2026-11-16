/**
 * Free-tier classification from the synced catalog.
 *
 * `deriveFreeModelIds` answers `null` when the snapshot cannot tell free from paid. That
 * distinction is what keeps a live free id on the free lane: an empty set (the shape this
 * function used to build when the models.dev cost table had not synced) marks every model
 * premium, so `isPremiumOpencodeModel` refuses it the keyless request and the upstream
 * answers 429 FreeUsageLimitError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFreeModelIds } from "../../open-sse/executors/opencodeFreeTierContract.ts";

type Pricing = Record<string, Record<string, { input: number; output: number }>>;

const ZERO = { input: 0, output: 0 };
const notDeprecated = () => undefined;

test("answers null when no catalog has been synced", () => {
  const pricing: Pricing = { "opencode-zen": { "some-model": ZERO } };
  assert.equal(deriveFreeModelIds(new Set(), pricing, notDeprecated), null);
});

test("answers null when models.dev pricing is empty", () => {
  const available = new Set(["deepseek-v4.1-flash-free", "glm-5.3-flash-free"]);
  assert.equal(deriveFreeModelIds(available, {}, notDeprecated), null);
  assert.equal(deriveFreeModelIds(available, null, notDeprecated), null);
  assert.equal(deriveFreeModelIds(available, undefined, notDeprecated), null);
});

test("answers null when pricing only covers other providers", () => {
  const available = new Set(["deepseek-v4.1-flash-free"]);
  const pricing: Pricing = { anthropic: { "claude-sonnet-4.5": { input: 3, output: 15 } } };
  assert.equal(deriveFreeModelIds(available, pricing, notDeprecated), null);
});

test("treats zero-cost ids as free and priced ids as premium", () => {
  const available = new Set(["free-model", "paid-model", "half-free-model"]);
  const pricing: Pricing = {
    "opencode-zen": {
      "free-model": ZERO,
      "paid-model": { input: 1, output: 2 },
      "half-free-model": { input: 0, output: 2 },
    },
  };
  assert.deepEqual([...deriveFreeModelIds(available, pricing, notDeprecated)!], ["free-model"]);
});

test("drops deprecated ids even at zero cost", () => {
  const available = new Set(["retired-free", "live-free"]);
  const pricing: Pricing = { "opencode-zen": { "retired-free": ZERO, "live-free": ZERO } };
  const statusOf = (id: string) => (id === "retired-free" ? "deprecated" : undefined);
  assert.deepEqual([...deriveFreeModelIds(available, pricing, statusOf)!], ["live-free"]);
});

test("falls back to the `opencode` alias when `opencode-zen` carries no pricing", () => {
  const available = new Set(["deepseek-v4.1-flash-free"]);
  const pricing: Pricing = { opencode: { "deepseek-v4.1-flash-free": ZERO } };
  assert.deepEqual(
    [...deriveFreeModelIds(available, pricing, notDeprecated)!],
    ["deepseek-v4.1-flash-free"]
  );
});
