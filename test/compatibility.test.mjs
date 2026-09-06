import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import piExtension from "../extensions/index.ts";
import commandSafetyHook from "../pre/command-safety.ts";

function createMockAPI() {
  const handlers = { tool_call: [], tool_result: [] };
  const commands = {};
  const pi = {
    on(event, handler) {
      handlers[event].push(handler);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
  };

  return {
    pi,
    commands,
    async fireToolCall(toolName, command) {
      const event = { toolName, input: { command, cwd: "/tmp/repo" } };
      for (const handler of handlers.tool_call) {
        const result = await handler(event);
        if (result) return result;
      }
      return undefined;
    },
    async fireToolResult(toolName, command, content) {
      const event = { toolName, input: { command }, content };
      for (const handler of handlers.tool_result) {
        const result = await handler(event);
        if (result) return result;
      }
      return undefined;
    },
  };
}

test("pi entrypoint registers the shared command policies", async () => {
  const mock = createMockAPI();
  piExtension(mock.pi);
  const blocked = await mock.fireToolCall("bash", "git push origin main");
  assert.equal(blocked?.block, true);
  assert.equal(await mock.fireToolCall("bash", "git status"), undefined);
  assert.equal(await mock.fireToolCall("bash", "echo 'git push origin main'"), undefined);
});

test("pi entrypoint preserves tool-result annotation and leaves built-in /ask available", async () => {
  const mock = createMockAPI();
  piExtension(mock.pi);
  assert.equal(mock.commands.ask, undefined);

  const content = [{ type: "text", text: "ModuleNotFoundError: No module named 'httpx'" }];
  const result = await mock.fireToolResult("bash", "python3 script.py", content);
  assert.match(result?.content[0]?.text ?? "", /guard-pkg-install/);
  assert.match(result?.content[0]?.text ?? "", /uv/);
});

test("OMP and pi entrypoints make the same command-safety decisions", async () => {
  const omp = createMockAPI();
  commandSafetyHook(omp.pi);

  const pi = createMockAPI();
  piExtension(pi.pi);
  for (const command of ["sudo echo unsafe", "git reset --hard HEAD", "echo safe"]) {
    const [ompResult, piResult] = await Promise.all([omp.fireToolCall("bash", command), pi.fireToolCall("bash", command)]);
    assert.equal(piResult?.block, ompResult?.block, command);
    assert.equal(piResult?.block, command === "echo safe" ? undefined : true, command);
  }
});

test("package metadata points pi at the compatibility entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.pi?.extensions, ["./extensions/index.ts"]);
});
