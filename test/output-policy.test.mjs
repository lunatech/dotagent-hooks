import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import outputPolicy from "../pre/output-policy.ts";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "output-policy");

function mock() {
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
        ui: { notify: async (message, level) => notifications.push({ message, level }) },
      });
    },
  };
}

test("output-policy aborts repeated assistant output", async () => {
  const original = (() => {
    try {
      return readFileSync(configPath, "utf8");
    } catch {
      return undefined;
    }
  })();
  writeFileSync(configPath, "maxChars=96000\nmaxRepeats=3\nminBlockChars=32\nminRepeatedChars=90\n");
  try {
    const harness = mock();
    outputPolicy(harness.pi);
    const block = `${"repeat me ".repeat(5)}\n`;
    await harness.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: block.repeat(3) } });
    assert.equal(harness.aborts(), 1);
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0].message, /output-policy:repetition=3/);
  } finally {
    if (original === undefined) unlinkSync(configPath);
    else writeFileSync(configPath, original);
  }
});

test("output-policy ignores reasoning and tool-call deltas", async () => {
  const original = (() => {
    try {
      return readFileSync(configPath, "utf8");
    } catch {
      return undefined;
    }
  })();
  writeFileSync(configPath, "maxChars=0\nmaxRepeats=2\nminBlockChars=8\nminRepeatedChars=16\n");
  try {
    const harness = mock();
    outputPolicy(harness.pi);
    const repeated = "reasoning that should not count\n".repeat(30);
    await harness.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: repeated } });
    await harness.fire("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: repeated } });
    assert.equal(harness.aborts(), 0);
  } finally {
    if (original === undefined) unlinkSync(configPath);
    else writeFileSync(configPath, original);
  }
});

test("output-policy has no tool-result handler", () => {
  const harness = mock();
  outputPolicy(harness.pi);
  assert.equal(harness.hasHandler("tool_result"), false);
});
