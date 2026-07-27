// pre/guard-aws-write.ts
//
// Blocks AWS CLI write/mutating operations while allowing read-only calls.
// Strategy: allowlist known read-only action prefixes; block everything else.
//
// Read-only prefixes allowed through: describe, list, get, head, check,
// query, scan, search, validate, generate-presigned, help, wait.
//
// Uses the Tree-sitter AST so that `aws s3 rm` inside a quoted string or
// echo argument is never mistaken for a live invocation. Dynamic tokens in
// service or action position are blocked with a precise "cannot verify" message.
//

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

// Read-only action prefixes — anything starting with these is allowed through.
const AWS_READONLY_PREFIX = /^(describe|list|get|head|check|query|scan|search|validate|generate-presigned|help|wait)/;

// AWS global flags that consume the next word as a value.
// All other global flags are boolean (--debug, --no-verify-ssl, etc.).
const AWS_VALUE_FLAGS: Record<string, true> = {
  "--profile": true,
  "--region": true,
  "--endpoint-url": true,
  "--output": true,
  "--query": true,
  "--ca-bundle": true,
  "--cli-input-json": true,
  "--cli-input-yaml": true,
  "--page-size": true,
  "--max-items": true,
  "--starting-token": true,
  "--color": true,
  "--cli-read-timeout": true,
  "--cli-connect-timeout": true,
};

type AwsResult = { kind: "write"; service: string; action: string } | { kind: "pass" } | { kind: "dynamic" };

// Collect the first two positional (non-flag) words after `aws`.
// The AWS CLI structure is: aws [global-options] <service> <action> [params].
function classifyAwsCommand(words: ShellWord[]): AwsResult {
  const positional: ShellWord[] = [];
  for (let i = 1; i < words.length && positional.length < 2; i++) {
    const w = words[i];
    if (w.text.startsWith("-")) {
      if (w.dynamic) return { kind: "dynamic" };
      if (AWS_VALUE_FLAGS[w.text]) i++; // skip the value word
      continue;
    }
    if (w.dynamic) return { kind: "dynamic" };
    positional.push(w);
  }

  if (positional.length < 2) return { kind: "pass" };
  const service = positional[0].text;
  const action = positional[1].text;
  if (AWS_READONLY_PREFIX.test(action)) return { kind: "pass" };
  return { kind: "write", service, action };
}

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (!/\baws\b/.test(cmd)) return;

    const ast = await parseShellAst(cmd);
    if (ast.error) return; // command-safety.ts already blocks parse failures

    for (const { words } of ast.commands) {
      if (words.length === 0) continue;
      if (words[0].dynamic || words[0].text !== "aws") continue;

      const result = classifyAwsCommand(words);

      if (result.kind === "dynamic") {
        return {
          block: true,
          reason:
            "Refused: aws command uses a dynamic token where service or action would be — " +
            "cannot verify the operation safely. Run manually.",
        };
      }

      if (result.kind === "write") {
        return {
          block: true,
          reason:
            `Refused: aws ${result.service} ${result.action} is a write/mutating operation. ` + "Run manually after reviewing the impact.",
        };
      }
    }
  });
}
