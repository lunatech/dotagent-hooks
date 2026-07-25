import assert from "node:assert/strict";
import test from "node:test";
import commandSafetyHook, { evaluateCommandPolicy } from "../pre/command-safety.ts";

async function assertBlocked(command, kind = "destructive") {
  const result = await evaluateCommandPolicy(command, "/tmp/repo");
  assert.equal(result?.kind, kind, command);
  if (kind === "destructive") {
    assert.match(result.reason, /What it does:/);
    assert.ok(result.reason.includes(command));
    assert.ok(result.reason.includes('cd -- "/tmp/repo"'));
  }
}

async function assertAllowed(command) {
  assert.equal(await evaluateCommandPolicy(command, "/tmp/repo"), null, command);
}

test("blocks destructive commands in compound shell syntax", async () => {
  await assertBlocked("(rm target)");
  await assertBlocked("if true; then rm target; fi");
  await assertBlocked("case x in x) rm target;; esac");
});

test("unwraps qualified wrappers and wrapper assignments", async () => {
  await assertBlocked("/usr/bin/sudo rm target");
  await assertBlocked("sudo FOO=bar rm target");
  await assertBlocked("sudo env rm target");
  await assertBlocked("command env FOO=bar rm target");
  await assertAllowed("command -v rm");
});

test("inspects nested shell commands after option terminators", async () => {
  await assertBlocked("sh -c -- 'rm target'");
  await assertBlocked("bash -lc -- 'git push origin main'");
  await assertBlocked("bash -o xtrace -c 'rm target'");
  await assertBlocked("bash -o -c -c 'rm target'");
});

test("rejects command-local Git aliases", async () => {
  await assertBlocked("git -c alias.p=push p origin main");
  await assertBlocked("git -calias.x='!rm target' x");
  await assertBlocked("git --config-env=alias.p=ALIAS_VALUE p origin main");
});

test("blocks Git operations that discard working-tree data", async () => {
  await assertBlocked("git rm target");
  await assertBlocked("git checkout -f main");
  await assertBlocked("git switch --discard-changes main");
});

test("accepts combined short commit options and enforces message structure", async () => {
  await assertAllowed("git commit -am 'feat: valid subject'");
  await assertAllowed("git commit -m 'fix: body' -m $'line one\\nline two' -m 'Refs: #42'");
  await assertBlocked("git commit -m 'fix: subject' -m $'one\\ntwo\\nthree'", "commit-message");
});

test("ignores destructive-looking text in shell comments", async () => {
  await assertAllowed("echo ok # ; rm target");
});

test("rejects dynamic policy control arguments", async () => {
  await assertBlocked("X=push; git $X origin main");
  await assertBlocked("terraform $op");
  await assertBlocked("kubectl $verb pod/name");
  await assertBlocked("docker $noun rm example");
});

test("blocks substitutions, output redirects, and malformed shell syntax", async () => {
  await assertBlocked("echo $(rm target)");
  await assertBlocked("xargs sh -c 'rm target'");
  await assertBlocked("printf hi > output.txt");
  await assertBlocked("if");
});

test("registers an asynchronous bash tool-call guard", async () => {
  let handler;
  commandSafetyHook({ on(event, callback) { if (event === "tool_call") handler = callback; } });
  assert.equal(typeof handler, "function");
  assert.equal((await handler({ toolName: "bash", input: { command: "git push origin main", cwd: "/tmp/repo" } }))?.block, true);
  assert.equal(await handler({ toolName: "bash", input: { command: "git add src/file.ts", cwd: "/tmp/repo" } }), undefined);
});
