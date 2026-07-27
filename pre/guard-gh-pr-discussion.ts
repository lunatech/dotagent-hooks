// pre/guard-gh-pr-discussion.ts
//
// Blocks gh CLI commands that post to or modify a PR discussion thread:
//   gh pr comment   — creates, edits, or deletes a comment on a PR
//   gh pr review    — submits an approval, change-request, or comment review
//
// Everything else is allowed through, including gh pr edit (metadata changes),
// gh pr merge, gh pr close, gh pr view, gh pr list, etc.
//
// Uses the Tree-sitter AST so that `gh pr comment` inside a quoted string or
// echo argument is never mistaken for a live invocation. Dynamic tokens in the
// topic or sub-command position are blocked with a precise "cannot verify" message.
//
// -R / --repo may appear before the topic (gh -R owner/repo pr comment) or
// after it (gh pr comment -R owner/repo); both positions are handled.
//

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

// `gh pr` sub-commands that post to or modify the PR discussion thread.
const PR_DISCUSSION_WRITE: Record<string, true> = { comment: true, review: true };

// Flags that consume the next word as a value and may appear anywhere in
// the command, including before the `pr` topic.
const VALUE_FLAGS: Record<string, true> = { "-R": true, "--repo": true };

type GhResult = { kind: "write"; verb: string } | { kind: "pass" } | { kind: "dynamic" };

// Walk the words of a `gh` command and classify it against the discussion
// write policy. words[0] is "gh".
function classifyGhCommand(words: ShellWord[]): GhResult {
  // Phase 1: skip past flags (and their values) to find the topic word.
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w.text.startsWith("-")) {
      if (w.dynamic) return { kind: "dynamic" };
      // Flags of the form --flag=value consume no extra word
      if (VALUE_FLAGS[w.text])
        i += 2; // skip flag + separate value word
      else i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return { kind: "pass" };

  const topic = words[i];
  if (topic.dynamic) return { kind: "dynamic" };
  if (topic.text !== "pr") return { kind: "pass" }; // not a PR command
  i++;

  // Phase 2: skip flags between the topic and sub-command.
  while (i < words.length) {
    const w = words[i];
    if (w.text.startsWith("-")) {
      if (w.dynamic) return { kind: "dynamic" };
      if (VALUE_FLAGS[w.text]) i += 2;
      else i += 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return { kind: "pass" };

  const sub = words[i];
  if (sub.dynamic) return { kind: "dynamic" };
  if (PR_DISCUSSION_WRITE[sub.text]) return { kind: "write", verb: sub.text };
  return { kind: "pass" };
}

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    // Fast path: skip commands that don't mention gh at all
    if (!/\bgh\b/.test(cmd)) return;

    const ast = await parseShellAst(cmd);
    // Parse failures are already blocked by command-safety.ts
    if (ast.error) return;

    for (const { words } of ast.commands) {
      if (words.length === 0) continue;
      if (words[0].dynamic || words[0].text !== "gh") continue;

      const result = classifyGhCommand(words);

      if (result.kind === "dynamic") {
        return {
          block: true,
          reason:
            "Refused: gh command uses a dynamic token in topic or sub-command position — " +
            "cannot verify whether it would post to a PR discussion. Run manually.",
        };
      }

      if (result.kind === "write") {
        const what = result.verb === "comment" ? "posts a comment to a PR discussion thread" : "submits a review to a PR";
        return {
          block: true,
          reason: `Refused: gh pr ${result.verb} ${what}. Run manually after reviewing the content.`,
        };
      }
    }
  });
}
