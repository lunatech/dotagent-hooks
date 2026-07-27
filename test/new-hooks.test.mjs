// test/new-hooks.test.mjs
// Regression tests for the new hook files added in the scratch merge.
// Each test drives the hook through a minimal mock HookAPI and asserts
// observable block/pass behaviour without inspecting source text.

import assert from "node:assert/strict";
import test from "node:test";

import guardAwsWrite from "../pre/guard-aws-write.ts";
import guardCurlWrite from "../pre/guard-curl-write.ts";
import guardGcxWrite from "../pre/guard-gcx-write.ts";
import guardKubectlWrite from "../pre/guard-kubectl-write.ts";
import guardPkgInstall from "../pre/guard-pkg-install.ts";
import askMode from "../pre/ask-mode.ts";

// ---------------------------------------------------------------------------
// Minimal mock HookAPI
// ---------------------------------------------------------------------------

function createMockPI() {
  const handlers = { tool_call: [], tool_result: [] };
  const commands = {};
  return {
    pi: {
      on(event, handler) {
        (handlers[event] ??= []).push(handler);
      },
      registerCommand(name, options) {
        commands[name] = options;
      },
    },
    commands,
    async fireToolCall(toolName, command) {
      const event = { toolName, input: { command } };
      for (const h of handlers.tool_call) {
        const result = await h(event);
        if (result) return result;
      }
      return undefined;
    },
    async fireToolResult(toolName, command, content) {
      const event = { toolName, input: { command }, content };
      for (const h of handlers.tool_result) {
        const result = await h(event);
        if (result) return result;
      }
      return undefined;
    },
  };
}

async function assertBlocked(hookFactory, toolName, command) {
  const mock = createMockPI();
  hookFactory(mock.pi);
  const result = await mock.fireToolCall(toolName, command);
  assert.ok(result?.block === true, `expected block for: ${command}`);
  return result;
}

async function assertAllowed(hookFactory, toolName, command) {
  const mock = createMockPI();
  hookFactory(mock.pi);
  const result = await mock.fireToolCall(toolName, command);
  assert.equal(result, undefined, `expected pass for: ${command}`);
}

// ---------------------------------------------------------------------------
// guard-aws-write
// ---------------------------------------------------------------------------

test("guard-aws-write blocks mutating AWS operations", async () => {
  await assertBlocked(guardAwsWrite, "bash", "aws s3 rm s3://bucket/key");
  await assertBlocked(guardAwsWrite, "bash", "aws ec2 terminate-instances --instance-ids i-123");
  await assertBlocked(guardAwsWrite, "bash", "aws iam create-user --user-name alice");
});

test("guard-aws-write allows read-only AWS operations", async () => {
  // Hook checks for known read-only action prefixes: describe, list, get, etc.
  // aws s3 ls uses `ls` (not a recognised prefix) so use `list-objects` instead.
  await assertAllowed(guardAwsWrite, "bash", "aws s3 list-objects --bucket my-bucket");
  await assertAllowed(guardAwsWrite, "bash", "aws ec2 describe-instances");
  await assertAllowed(guardAwsWrite, "bash", "aws iam list-users");
  await assertAllowed(guardAwsWrite, "bash", "aws s3 get-object --bucket b --key k /tmp/out");
});

test("guard-aws-write ignores non-bash tools", async () => {
  await assertAllowed(guardAwsWrite, "read", "aws s3 rm s3://bucket/key");
});

// ---------------------------------------------------------------------------
// guard-curl-write
// ---------------------------------------------------------------------------

test("guard-curl-write blocks write method flags", async () => {
  await assertBlocked(guardCurlWrite, "bash", "curl -X POST https://api.example.com/items");
  await assertBlocked(guardCurlWrite, "bash", "curl --request DELETE https://api.example.com/items/1");
  await assertBlocked(guardCurlWrite, "bash", "curl -X PUT https://api.example.com/items/1 -H 'Content-Type: application/json'");
});

test("guard-curl-write blocks implicit POST via --data", async () => {
  await assertBlocked(guardCurlWrite, "bash", "curl https://api.example.com/submit -d 'payload'");
  await assertBlocked(guardCurlWrite, "bash", "curl --data-raw 'x=1' https://api.example.com");
  await assertBlocked(guardCurlWrite, "bash", "curl --data-binary @file.json https://api.example.com");
});

test("guard-curl-write allows safe GET requests", async () => {
  await assertAllowed(guardCurlWrite, "bash", "curl https://api.example.com/items");
  await assertAllowed(guardCurlWrite, "bash", "curl -G https://api.example.com/search?q=foo");
  await assertAllowed(guardCurlWrite, "bash", "curl -I https://example.com");
});

// ---------------------------------------------------------------------------
// guard-gcx-write
// ---------------------------------------------------------------------------

test("guard-gcx-write blocks known write verbs", async () => {
  await assertBlocked(guardGcxWrite, "bash", "gcx dashboards create --title 'My Dashboard'");
  await assertBlocked(guardGcxWrite, "bash", "gcx slo delete slo-abc123");
  await assertBlocked(guardGcxWrite, "bash", "gcx alert definitions update --id 1 --name test");
});

test("guard-gcx-write blocks gcx api with write method", async () => {
  await assertBlocked(guardGcxWrite, "bash", "gcx api -X POST /api/v1/something");
  await assertBlocked(guardGcxWrite, "bash", "gcx api --data '{\"key\":\"val\"}' /api/endpoint");
});

test("guard-gcx-write blocks unknown verbs conservatively", async () => {
  const result = await assertBlocked(guardGcxWrite, "bash", "gcx dashboards frobnicate --id 1");
  assert.match(result.reason, /unrecognised verb/);
});

test("guard-gcx-write allows read-only verbs", async () => {
  await assertAllowed(guardGcxWrite, "bash", "gcx dashboards list");
  await assertAllowed(guardGcxWrite, "bash", "gcx slo get slo-abc123");
  await assertAllowed(guardGcxWrite, "bash", "gcx metrics query --expr 'up'");
});

test("guard-gcx-write does not false-positive on gcx tokens in echo arguments", async () => {
  // With regex this blocked because \bgcx\b matched inside the echo string.
  // With AST the executable is echo, not gcx — must pass.
  await assertAllowed(guardGcxWrite, "bash", "echo 'gcx delete foo'");
  await assertAllowed(guardGcxWrite, "bash", 'echo "gcx dashboards create --title test"');
});

test("guard-gcx-write blocks dynamic token in verb position", async () => {
  // $ACTION is dynamic — exact verb unknown, must block with precise message.
  const result = await assertBlocked(guardGcxWrite, "bash", "gcx dashboards $ACTION --id 1");
  assert.match(result.reason, /dynamic token/);
});

test("guard-gcx-write allows gcx api with read-only method", async () => {
  await assertAllowed(guardGcxWrite, "bash", "gcx api -X GET /api/v1/dashboards");
  await assertAllowed(guardGcxWrite, "bash", "gcx api /api/v1/dashboards");
});

// ---------------------------------------------------------------------------
// guard-kubectl-write
// ---------------------------------------------------------------------------

test("guard-kubectl-write blocks write verbs", async () => {
  await assertBlocked(guardKubectlWrite, "bash", "kubectl apply -f deployment.yaml");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl create deployment nginx --image=nginx");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl delete pod my-pod");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl scale deployment/web --replicas=3");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl exec -it my-pod -- /bin/bash");
});

test("guard-kubectl-write blocks destructive rollout sub-commands", async () => {
  await assertBlocked(guardKubectlWrite, "bash", "kubectl rollout restart deployment/web");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl rollout undo deployment/web");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl rollout pause deployment/web");
  await assertBlocked(guardKubectlWrite, "bash", "kubectl rollout resume deployment/web");
});

test("guard-kubectl-write allows read-only kubectl operations", async () => {
  await assertAllowed(guardKubectlWrite, "bash", "kubectl get pods");
  await assertAllowed(guardKubectlWrite, "bash", "kubectl describe deployment web");
  await assertAllowed(guardKubectlWrite, "bash", "kubectl logs my-pod");
  await assertAllowed(guardKubectlWrite, "bash", "kubectl rollout status deployment/web");
});

// ---------------------------------------------------------------------------
// guard-pkg-install
// ---------------------------------------------------------------------------

test("guard-pkg-install blocks pip install", async () => {
  await assertBlocked(guardPkgInstall, "bash", "pip install requests");
  await assertBlocked(guardPkgInstall, "bash", "pip3 install numpy scipy");
});

test("guard-pkg-install blocks uv add", async () => {
  await assertBlocked(guardPkgInstall, "bash", "uv add httpx");
});

test("guard-pkg-install blocks npm install", async () => {
  await assertBlocked(guardPkgInstall, "bash", "npm install lodash");
  await assertBlocked(guardPkgInstall, "bash", "npm i express");
});

test("guard-pkg-install blocks brew install", async () => {
  await assertBlocked(guardPkgInstall, "bash", "brew install jq");
});

test("guard-pkg-install allows package manager read operations", async () => {
  // uv run is not blocked (not uv add)
  await assertAllowed(guardPkgInstall, "bash", "uv run script.py");
  // pip show is not blocked
  await assertAllowed(guardPkgInstall, "bash", "pip show requests");
  // npm list is not blocked
  await assertAllowed(guardPkgInstall, "bash", "npm list");
});

test("guard-pkg-install annotates Python import errors post-execution", async () => {
  const mock = createMockPI();
  guardPkgInstall(mock.pi);
  const content = [{ type: "text", text: "Traceback:\nModuleNotFoundError: No module named 'httpx'" }];
  const result = await mock.fireToolResult("bash", "python3 script.py", content);
  assert.ok(result != null, "expected annotated result");
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  assert.match(text, /guard-pkg-install/);
  assert.match(text, /uv/);
});

test("guard-pkg-install does not annotate when no import error", async () => {
  const mock = createMockPI();
  guardPkgInstall(mock.pi);
  const content = [{ type: "text", text: "Hello, world!" }];
  const result = await mock.fireToolResult("bash", "python3 script.py", content);
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// ask-mode
// ---------------------------------------------------------------------------

test("ask-mode blocks non-allowed tools when enabled", async () => {
  const mock = createMockPI();
  // Patch env before registering
  process.env.OMP_ASK_MODE = "0";
  // Re-import would share module state, so toggle via the registered command instead
  askMode(mock.pi);

  // Simulate /ask on via the command handler
  const ctx = { hasUI: false, ui: { notify: async () => {} } };
  await mock.commands.ask.handler("on", ctx);

  const result = await mock.fireToolCall("bash", "echo hi");
  assert.ok(result?.block === true, "bash should be blocked in ask mode");
  assert.match(result.reason, /ask mode/);
});

test("ask-mode allows read tool when enabled", async () => {
  const mock = createMockPI();
  process.env.OMP_ASK_MODE = "0";
  askMode(mock.pi);

  const ctx = { hasUI: false, ui: { notify: async () => {} } };
  await mock.commands.ask.handler("on", ctx);

  const result = await mock.fireToolCall("read", "/some/path");
  assert.equal(result, undefined, "read should be allowed in ask mode");
});

test("ask-mode allows web_search tool when enabled", async () => {
  const mock = createMockPI();
  process.env.OMP_ASK_MODE = "0";
  askMode(mock.pi);

  const ctx = { hasUI: false, ui: { notify: async () => {} } };
  await mock.commands.ask.handler("on", ctx);

  const result = await mock.fireToolCall("web_search", "query");
  assert.equal(result, undefined, "web_search should be allowed in ask mode");
});

test("ask-mode allows all tools when disabled", async () => {
  const mock = createMockPI();
  process.env.OMP_ASK_MODE = "0";
  askMode(mock.pi);

  // Explicitly disable in case a previous test left module-level state on.
  const ctx = { hasUI: false, ui: { notify: async () => {} } };
  await mock.commands.ask.handler("off", ctx);

  const result = await mock.fireToolCall("bash", "echo hi");
  assert.equal(result, undefined, "bash should pass when ask mode is off");
});

test("ask-mode registers the /ask command", () => {
  const mock = createMockPI();
  process.env.OMP_ASK_MODE = "0";
  askMode(mock.pi);
  assert.ok("ask" in mock.commands, "/ask command must be registered");
});
