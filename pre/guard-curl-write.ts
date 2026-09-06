// pre/guard-curl-write.ts
//
// Blocks curl requests that mutate remote state:
//   - -X POST/PUT/DELETE/PATCH or --request POST/PUT/DELETE/PATCH
//   - -d / --data / --data-raw / --data-binary (implicit POST)
//
// Allows: GET requests, -G (GET with query params), read-only probes.
//
// Uses the Tree-sitter AST so that `curl -X POST` inside a quoted string or
// echo argument is never mistaken for a live invocation. Dynamic tokens in
// flag or value position are blocked with a precise "cannot verify" message.
//

import type { HookAPI } from "../lib/hook-api.ts";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

const WRITE_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  DELETE: true,
  PATCH: true,
};

type CurlResult = { kind: "write-method" } | { kind: "write-data" } | { kind: "pass" } | { kind: "dynamic" };

function classifyCurlCommand(words: ShellWord[]): CurlResult {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.dynamic) return { kind: "dynamic" };
    const t = w.text;

    // -X <METHOD> or --request <METHOD>
    if (t === "-X" || t === "--request") {
      const next = words[i + 1];
      if (!next) continue;
      if (next.dynamic) return { kind: "dynamic" };
      if (WRITE_METHODS[next.text.toUpperCase()]) return { kind: "write-method" };
      i++; // consume the value regardless
      continue;
    }

    // --request=METHOD (attached form)
    const reqMatch = t.match(/^--request=(.+)$/i);
    if (reqMatch && WRITE_METHODS[reqMatch[1].toUpperCase()]) return { kind: "write-method" };

    // -d / --data / --data-raw / --data-binary (standalone or =value)
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") return { kind: "write-data" };
    if (/^(?:--data|--data-raw|--data-binary)=/.test(t)) return { kind: "write-data" };
  }
  return { kind: "pass" };
}

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (!/\bcurl\b/.test(cmd)) return;

    const ast = await parseShellAst(cmd);
    if (ast.error) return; // command-safety.ts already blocks parse failures

    for (const { words } of ast.commands) {
      if (words.length === 0) continue;
      if (words[0].dynamic || words[0].text !== "curl") continue;

      const result = classifyCurlCommand(words);

      if (result.kind === "dynamic") {
        return {
          block: true,
          reason: "Refused: curl command uses a dynamic token — cannot verify whether it would send a write request. " + "Run manually.",
        };
      }

      if (result.kind === "write-method") {
        return {
          block: true,
          reason: "Refused: curl with a write method (POST/PUT/DELETE/PATCH). " + "Review the endpoint and run manually.",
        };
      }

      if (result.kind === "write-data") {
        return {
          block: true,
          reason: "Refused: curl with --data implies a POST. " + "Review the endpoint and payload, then run manually.",
        };
      }
    }
  });
}
