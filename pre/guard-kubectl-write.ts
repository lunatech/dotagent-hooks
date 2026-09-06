// pre/guard-kubectl-write.ts
//
// Blocks kubectl operations that modify cluster state.
// Allowed through: get, describe, logs, top, explain, diff, version,
//                  config, port-forward, wait, auth, api-resources,
//                  api-versions, cluster-info, proxy (read-only use).
//
// Uses the Tree-sitter AST so that `kubectl delete` inside a quoted string
// or echo argument is never mistaken for a live invocation. Dynamic tokens
// in verb position are blocked with a precise "cannot verify" message.
//

import type { HookAPI } from "../lib/hook-api.ts";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

// Direct write verbs
const KUBECTL_WRITE_VERBS: Record<string, true> = {
  apply: true,
  create: true,
  delete: true,
  replace: true,
  patch: true,
  edit: true,
  scale: true,
  drain: true,
  cordon: true,
  uncordon: true,
  taint: true,
  annotate: true,
  label: true,
  exec: true,
  cp: true,
};

// rollout sub-commands that mutate state
const ROLLOUT_WRITE_SUBS: Record<string, true> = {
  restart: true,
  undo: true,
  pause: true,
  resume: true,
};

// kubectl flags that consume the next word as a value (most common ones)
const KUBECTL_VALUE_FLAGS: Record<string, true> = {
  "-n": true,
  "--namespace": true,
  "-f": true,
  "--filename": true,
  "-l": true,
  "--selector": true,
  "--context": true,
  "--cluster": true,
  "--user": true,
  "--kubeconfig": true,
  "--server": true,
  "-o": true,
  "--output": true,
  "--field-selector": true,
};

type KubectlResult = { kind: "write"; verb: string } | { kind: "rollout-write"; sub: string } | { kind: "pass" } | { kind: "dynamic" };

// Find the first positional word (verb) after `kubectl`, skipping flags.
function classifyKubectlCommand(words: ShellWord[]): KubectlResult {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.text.startsWith("-")) {
      if (w.dynamic) return { kind: "dynamic" };
      if (KUBECTL_VALUE_FLAGS[w.text]) i++; // skip value word
      continue;
    }
    if (w.dynamic) return { kind: "dynamic" };

    const verb = w.text;

    if (verb === "rollout") {
      // Scan ahead for the rollout sub-command, skipping flags
      for (let j = i + 1; j < words.length; j++) {
        const sub = words[j];
        if (sub.text.startsWith("-")) continue;
        if (sub.dynamic) return { kind: "dynamic" };
        if (ROLLOUT_WRITE_SUBS[sub.text]) return { kind: "rollout-write", sub: sub.text };
        return { kind: "pass" }; // e.g. rollout status
      }
      return { kind: "pass" };
    }

    if (KUBECTL_WRITE_VERBS[verb]) return { kind: "write", verb };
    return { kind: "pass" };
  }
  return { kind: "pass" };
}

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (!/\bkubectl\b/.test(cmd)) return;

    const ast = await parseShellAst(cmd);
    if (ast.error) return; // command-safety.ts already blocks parse failures

    for (const { words } of ast.commands) {
      if (words.length === 0) continue;
      if (words[0].dynamic || words[0].text !== "kubectl") continue;

      const result = classifyKubectlCommand(words);

      if (result.kind === "dynamic") {
        return {
          block: true,
          reason: "Refused: kubectl command uses a dynamic token — cannot verify whether it would modify cluster state. " + "Run manually.",
        };
      }

      if (result.kind === "rollout-write") {
        const what = result.sub === "restart" ? "triggers a rolling restart of live pods" : "modifies cluster state";
        return {
          block: true,
          reason: `Refused: kubectl rollout ${result.sub} ${what}. ` + "Run manually after confirming the target.",
        };
      }

      if (result.kind === "write") {
        return {
          block: true,
          reason: `Refused: kubectl ${result.verb} modifies cluster state. ` + "Review the manifest/target and run manually.",
        };
      }
    }
  });
}
