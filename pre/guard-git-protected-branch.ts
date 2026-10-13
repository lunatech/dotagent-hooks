// pre/guard-git-protected-branch.ts
//
// Prevents the agent from creating commits directly on protected branches.
// Tree-sitter identifies actual Git commands, while Git itself reports the
// current branch and the repository's default branch. Git metadata is not
// parsed by this hook.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HookAPI } from "../lib/hook-api.ts";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

const execFileAsync = promisify(execFile);
const FIXED_PROTECTED_BRANCHES = new Set(["main", "master", "default"]);

function executableName(value: string): string {
  return value.split("/").pop() ?? value;
}

type GitCommand = {
  name: string;
  repository?: string;
  dynamic?: string;
};

// Parse Git global options until the sub-command. -C is deliberately parsed
// here so branch checks use the repository selected by the command itself.
function parseGitCommand(words: ShellWord[], cwd: string): GitCommand {
  let repository = cwd;

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word.dynamic) return { name: "", dynamic: "Git options or sub-command" };

    if (word.text === "-C") {
      const path = words[index + 1];
      if (!path || path.dynamic) return { name: "", dynamic: "the git -C repository path" };
      repository = path.text.startsWith("/") ? path.text : `${repository}/${path.text}`;
      index += 1;
      continue;
    }

    if (word.text.startsWith("-C") && word.text.length > 2) {
      repository = word.text.slice(2);
      if (!repository.startsWith("/")) repository = `${cwd}/${repository}`;
      continue;
    }

    if (["--git-dir", "--work-tree", "--namespace", "--config-env"].includes(word.text)) {
      const value = words[index + 1];
      if (!value || value.dynamic) return { name: "", dynamic: `the ${word.text} value` };
      index += 1;
      continue;
    }

    if (
      word.text.startsWith("--git-dir=") ||
      word.text.startsWith("--work-tree=") ||
      word.text.startsWith("--namespace=") ||
      word.text.startsWith("--config-env=")
    )
      continue;
    if (word.text.startsWith("-")) continue;

    return { name: word.text, repository };
  }

  return { name: "", repository };
}

async function gitOutput(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], { timeout: 2000, maxBuffer: 16 * 1024 });
  return result.stdout.trim();
}

async function protectedBranch(repository: string): Promise<{ branch?: string; protectedBranch?: string; error?: string }> {
  try {
    const branch = await gitOutput(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) return { error: "the repository is in a detached HEAD state" };

    if (FIXED_PROTECTED_BRANCHES.has(branch)) return { branch, protectedBranch: branch };

    try {
      const defaultBranch = await gitOutput(repository, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      const remoteBranch = defaultBranch.replace(/^origin\//, "");
      if (remoteBranch && branch === remoteBranch) return { branch, protectedBranch: remoteBranch };
    } catch {
      // A repository without origin/HEAD can still use the fixed names above.
    }

    return { branch };
  } catch {
    return { error: "the current branch could not be verified with Git" };
  }
}

function advisory(command: string, cwd: string, explanation: string): string {
  return [
    "Git commit prohibited by user policy.",
    `What it does: ${explanation}.`,
    `Working directory: ${cwd}`,
    "Review the target branch and run the command personally if this direct commit is intended:",
    `  ${command}`,
  ].join("\n");
}

export default function guardGitProtectedBranch(pi: HookAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : "";
    const cwd = typeof input.cwd === "string" ? input.cwd : ".";
    if (!/\bgit\b/.test(command)) return;

    const ast = await parseShellAst(command);
    if (ast.error) return;

    for (const { words } of ast.commands) {
      if (words.length === 0 || words[0].dynamic || executableName(words[0].text) !== "git") continue;
      const git = parseGitCommand(words, cwd);
      if (git.dynamic) {
        return { block: true, reason: advisory(command, cwd, `${git.dynamic} cannot be verified safely`) };
      }
      if (git.name !== "commit") continue;

      const state = await protectedBranch(git.repository ?? cwd);
      if (state.error) return { block: true, reason: advisory(command, cwd, state.error) };
      if (state.protectedBranch) {
        return {
          block: true,
          reason: advisory(command, cwd, `creates a commit directly on protected branch '${state.protectedBranch}'`),
        };
      }
    }
  });
}
