import assert from "node:assert/strict";
import test from "node:test";
import outputPolicy from "../pre/output-policy.ts";
import { DEFAULT_OUTPUT_POLICY, parseOutputPolicyConfig } from "../output-policy-config.ts";

function mock(notify) {
  const handlers = new Map();
  let aborts = 0;
  const notifications = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return {
    pi,
    aborts: () => aborts,
    notifications,
    hasHandler(event) {
      return handlers.has(event);
    },
    fire(event, payload = {}) {
      const handler = handlers.get(event);
      assert.ok(handler, `missing handler: ${event}`);
      return handler(payload, {
        abort: () => {
          aborts += 1;
        },
        ui: { notify: notify ?? ((message, level) => notifications.push({ message, level })) },
      });
    },
  };
}

test("output-policy aborts repeated assistant output", () => {
  const harness = mock();
  outputPolicy(harness.pi, { ...DEFAULT_OUTPUT_POLICY, maxRepeats: 3, minRepeatedChars: 90 });
  const block = `${"repeat me ".repeat(5)}\n`;
  harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: block.repeat(3) } });
  assert.equal(harness.aborts(), 1);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /output-policy:repetition=3/);
});

test("output-policy ignores reasoning and tool-call deltas", () => {
  const harness = mock();
  outputPolicy(harness.pi, { ...DEFAULT_OUTPUT_POLICY, maxChars: 0, maxRepeats: 2, minBlockChars: 8, minRepeatedChars: 16 });
  const repeated = "reasoning that should not count\n".repeat(30);
  harness.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: repeated } });
  harness.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: repeated } });
  assert.equal(harness.aborts(), 0);
});

test("output-policy aborts even when UI notification rejects", async () => {
  const harness = mock(() => Promise.reject(new Error("UI closed")));
  outputPolicy(harness.pi, { ...DEFAULT_OUTPUT_POLICY, maxChars: 8 });
  harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "long enough to abort" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.aborts(), 1);
});

test("output-policy does not mistake distinct long lines for repetitions", () => {
  const harness = mock();
  outputPolicy(harness.pi, { ...DEFAULT_OUTPUT_POLICY, maxChars: 0, maxRepeats: 2, minRepeatedChars: 64 });
  const suffix = "shared tail ".repeat(1_500);
  for (const prefix of ["first", "second"]) {
    harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: `${prefix}${suffix}` } });
    harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "\n" } });
  }
  assert.equal(harness.aborts(), 0);
  const shortLine = `${"repeat this line ".repeat(5)}\n`;
  harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: shortLine.repeat(2) } });
  assert.equal(harness.aborts(), 1);
});

test("blank or non-decimal maxChars cannot disable the cap", () => {
  for (const value of ["", "0x0", "-1", "9007199254740992"]) {
    assert.equal(parseOutputPolicyConfig(`maxChars=${value}\n`).maxChars, DEFAULT_OUTPUT_POLICY.maxChars);
  }
  assert.equal(parseOutputPolicyConfig("maxChars=0\n").maxChars, 0);
});

test("output-policy has no tool-result handler", () => {
  const harness = mock();
  outputPolicy(harness.pi);
  assert.equal(harness.hasHandler("tool_result"), false);
});
