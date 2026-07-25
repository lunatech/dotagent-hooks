import { readFile } from "node:fs/promises";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

type PolicyDecision = {
  kind: "destructive" | "commit-message";
  reason: string;
};

type GitCommand = {
  name: string;
  args: ShellWord[];
  error?: string;
};

type UnwrappedCommand = {
  words: ShellWord[];
  error?: string;
  usesSudo?: boolean;
};

type NestedShell = {
  command?: ShellWord;
  error?: string;
};

const SHELL_WRAPPERS: Record<string, true> = {
  command: true,
  exec: true,
  nohup: true,
  sudo: true,
  time: true,
};
const DESTRUCTIVE_EXECUTABLES: Record<string, string> = {
  rm: "removes files or directories",
  rmdir: "removes directories",
  unlink: "removes a filesystem entry",
  shred: "overwrites and removes file contents",
  truncate: "discards file contents",
  mv: "moves paths and may overwrite an existing destination",
  kill: "terminates a running process",
  killall: "terminates running processes by name",
  pkill: "terminates running processes matching a pattern",
  halt: "stops the operating system",
  poweroff: "powers off the operating system",
  reboot: "restarts the operating system",
  shutdown: "stops or restarts the operating system",
};
const USER_ALLOWED_COMMANDS_PATH = new URL("../user-allowed-commands", import.meta.url);
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function executableName(value: string | undefined): string {
  return (value ?? "").split("/").pop() ?? "";
}

function isAssignment(word: ShellWord): boolean {
  return !word.dynamic && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text);
}

function unwrapCommand(input: ShellWord[]): UnwrappedCommand {
  let usesSudo = false;
  let words = input;
  while (words.length > 0) {
    while (words.length > 0 && isAssignment(words[0])) words = words.slice(1);
    if (words.length === 0 || words[0].dynamic) break;
    const executable = executableName(words[0].text);

    if (executable === "env") {
      let index = 1;
      while (index < words.length) {
        const option = words[index];
        if (option.dynamic) return { words: [], error: "uses dynamic env options that cannot be inspected safely" };
        if (option.text.startsWith("-S") || option.text === "--split-string" || option.text.startsWith("--split-string=")) {
          return { words: [], error: "uses env split-string to construct a command dynamically" };
        }
        if (isAssignment(option)) index += 1;
        else if (/^(?:-u|--unset|-C|--chdir)$/.test(option.text)) index += 2;
        else if (option.text === "--") {
          index += 1;
          break;
        } else if (option.text.startsWith("-")) index += 1;
        else break;
      }
      words = words.slice(index);
      continue;
    }

    if (!Object.hasOwn(SHELL_WRAPPERS, executable)) break;
    const wrapper = executable;
    if (wrapper === "sudo") usesSudo = true;
    let index = 1;
    while (index < words.length && words[index].text.startsWith("-")) {
      const option = words[index];
      if (option.dynamic) return { words: [], error: `uses dynamic ${wrapper} options that cannot be inspected safely` };
      if (wrapper === "command" && /^-[^-]*[vV]/.test(option.text)) return { words: [] };
      if (option.text === "--") {
        index += 1;
        break;
      }
      if (
        wrapper === "sudo" &&
        /^(?:-u|-g|-h|-p|-r|-t|-C|-D|-R|-T|--user|--group|--host|--prompt|--role|--type|--close-from|--chdir|--chroot|--command-timeout)$/.test(
          option.text,
        )
      )
        index += 2;
      else if (wrapper === "time" && /^(?:-f|--format|-o|--output)$/.test(option.text)) index += 2;
      else if (wrapper === "exec" && option.text === "-a") index += 2;
      else index += 1;
    }
    words = words.slice(index);
  }
  return { words, usesSudo };
}

function gitSubcommand(words: ShellWord[]): GitCommand {
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word.dynamic) return { name: "", args: [], error: "constructs a Git subcommand or global option dynamically" };
    const value = word.text;
    if (value === "-c") {
      const config = words[index + 1];
      if (!config || config.dynamic) return { name: "", args: [], error: "uses a dynamic or missing git -c value" };
      if (/^alias\./i.test(config.text))
        return { name: "", args: [], error: "defines a command-local Git alias that can hide a prohibited operation" };
      index += 2;
      continue;
    }
    if (value.startsWith("-c") && value.length > 2) {
      if (/^-calias\./i.test(value))
        return { name: "", args: [], error: "defines a command-local Git alias that can hide a prohibited operation" };
      index += 1;
      continue;
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(value)) {
      const optionValue = words[index + 1];
      if (!optionValue || optionValue.dynamic) return { name: "", args: [], error: `uses a dynamic or missing ${value} value` };
      if (value === "--config-env" && /^alias\./i.test(optionValue.text))
        return { name: "", args: [], error: "loads a Git alias from the environment" };
      index += 2;
      continue;
    }
    if (value.startsWith("--config-env=alias.")) return { name: "", args: [], error: "loads a Git alias from the environment" };
    if (
      value.startsWith("--git-dir=") ||
      value.startsWith("--work-tree=") ||
      value.startsWith("--namespace=") ||
      value.startsWith("--config-env=")
    ) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return { name: value, args: words.slice(index + 1) };
  }
  return { name: "", args: [] };
}

function destructiveExplanation(command: ShellWord[]): string | null {
  const executable = executableName(command[0]?.text);
  const direct = Object.hasOwn(DESTRUCTIVE_EXECUTABLES, executable) ? DESTRUCTIVE_EXECUTABLES[executable] : undefined;
  if (direct !== undefined) return direct;
  const controls = command.slice(1);
  const args = controls.map((word) => word.text);
  const hasDynamicControl = controls.some((word) => word.dynamic);

  if (/^mkfs(?:\.|$)/.test(executable)) return "creates a filesystem and destroys the existing data on the target device";
  if (executable === "dd" && hasDynamicControl) return "uses dynamic dd arguments that can hide a destructive output target";
  if (executable === "dd" && args.some((argument) => argument.startsWith("of=")))
    return "writes raw bytes to a target and can overwrite a file or disk";
  if (executable === "diskutil" && hasDynamicControl) return "uses dynamic diskutil arguments that can hide a destructive disk operation";
  if (executable === "diskutil" && args.some((argument) => /^(?:erase|partition|delete|remove)/i.test(argument)))
    return "changes disk partitions or filesystems and may destroy stored data";
  if (executable === "terraform" && controls[0]?.dynamic)
    return "constructs the Terraform operation dynamically, so its destructive effect cannot be verified";
  if (executable === "terraform" && args[0] === "destroy") return "destroys infrastructure managed by Terraform";
  if (executable === "kubectl" && controls[0]?.dynamic)
    return "constructs the Kubernetes operation dynamically, so its destructive effect cannot be verified";
  if (executable === "kubectl" && args[0] === "delete") return "deletes Kubernetes resources";
  if (executable === "docker" && (controls[0]?.dynamic || controls[1]?.dynamic))
    return "constructs a Docker resource operation dynamically, so its destructive effect cannot be verified";
  if (
    executable === "docker" &&
    (args[0] === "rm" ||
      args[0] === "rmi" ||
      (args[0] === "system" && args[1] === "prune") ||
      (args[1] === "rm" && ["container", "image", "network", "volume"].includes(args[0])))
  )
    return "deletes Docker resources or cached data";
  if (["npm", "pnpm", "yarn", "pip", "pip3", "brew", "gem", "cargo"].includes(executable) && controls[0]?.dynamic)
    return "constructs a package-manager operation dynamically, so uninstall behavior cannot be verified";
  if (
    ["npm", "pnpm", "yarn", "pip", "pip3", "brew", "gem", "cargo"].includes(executable) &&
    ["remove", "rm", "uninstall", "uninstall-global"].includes(args[0])
  )
    return "uninstalls packages from the current environment";
  if (executable === "find" && hasDynamicControl) return "uses dynamic find actions that can hide deletion or command execution";
  if (executable === "find" && args.some((argument) => argument === "-delete" || argument === "-exec" || argument === "-execdir"))
    return "deletes paths directly or executes another command for matched paths";
  if (executable === "xargs")
    return "constructs and invokes commands from standard input, so their destructive effects cannot be verified safely";
  return null;
}

function isUserAllowableDestructiveCommand(command: ShellWord[]): boolean {
  const executable = executableName(command[0]?.text);
  if (Object.hasOwn(DESTRUCTIVE_EXECUTABLES, executable) || /^mkfs(?:\.|$)/.test(executable)) return true;

  const controls = command.slice(1);
  if (controls.some((word) => word.dynamic)) return false;
  const args = controls.map((word) => word.text);

  if (executable === "dd") return args.some((argument) => argument.startsWith("of="));
  if (executable === "diskutil") return args.some((argument) => /^(?:erase|partition|delete|remove)/i.test(argument));
  if (executable === "terraform") return args[0] === "destroy";
  if (executable === "kubectl") return args[0] === "delete";
  if (executable === "docker")
    return (
      args[0] === "rm" ||
      args[0] === "rmi" ||
      (args[0] === "system" && args[1] === "prune") ||
      (args[1] === "rm" && ["container", "image", "network", "volume"].includes(args[0]))
    );
  if (["npm", "pnpm", "yarn", "pip", "pip3", "brew", "gem", "cargo"].includes(executable))
    return ["remove", "rm", "uninstall", "uninstall-global"].includes(args[0]);
  return executable === "find" && args.includes("-delete") && !args.some((argument) => argument === "-exec" || argument === "-execdir");
}

async function readUserAllowedCommands(path: string | URL): Promise<ReadonlySet<string>> {
  try {
    const contents = await readFile(path, "utf8");
    return new Set(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#") && EXECUTABLE_NAME_PATTERN.test(line)),
    );
  } catch {
    return new Set();
  }
}

function destructiveGitExplanation(git: GitCommand): string | null {
  const args = git.args.map((word) => word.text);
  if (git.name === "push") return "publishes local refs and objects to a remote Git repository";
  if (git.name === "clean") return "permanently removes untracked files from the working tree";
  if (git.name === "rm") return "removes tracked files from the working tree and stages their deletion";
  if (["reset", "switch", "branch", "tag", "stash"].includes(git.name) && git.args.some((word) => word.dynamic))
    return "uses dynamic Git options that can hide an operation which discards work or deletes refs";
  if (git.name === "reset" && args.some((argument) => ["--hard", "--merge", "--keep"].includes(argument)))
    return "resets Git state and can discard uncommitted work";
  if (git.name === "restore") return "replaces working-tree or staged file content and can discard changes";
  if (git.name === "checkout") return "switches or replaces working-tree content and can discard local changes";
  if (git.name === "switch" && args.some((argument) => ["-f", "--force", "--discard-changes"].includes(argument)))
    return "forces a branch switch and can discard local changes";
  if (git.name === "branch" && args.some((argument) => argument === "-d" || argument === "-D" || argument.startsWith("--delete")))
    return "deletes one or more Git branches";
  if (git.name === "tag" && args.some((argument) => argument === "-d" || argument === "--delete")) return "deletes one or more Git tags";
  if (git.name === "stash" && ["drop", "clear"].includes(args[0])) return "deletes saved Git stash entries";
  return null;
}

function parseCommitMessage(args: ShellWord[]): { message?: string; error?: string } {
  const paragraphs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.dynamic) return { error: "the commit message or its options use shell expansion and cannot be verified" };
    if (argument.text === "-m" || argument.text === "--message") {
      const message = args[index + 1];
      if (!message) return { error: `${argument.text} requires a message` };
      if (message.dynamic) return { error: "the commit message uses shell expansion and cannot be verified" };
      paragraphs.push(message.text);
      index += 1;
    } else if (argument.text.startsWith("--message=")) {
      paragraphs.push(argument.text.slice("--message=".length));
    } else if (/^-[^-]/.test(argument.text) && argument.text.includes("m")) {
      const messageOffset = argument.text.indexOf("m") + 1;
      const attachedMessage = argument.text.slice(messageOffset);
      if (attachedMessage) paragraphs.push(attachedMessage);
      else {
        const message = args[index + 1];
        if (!message) return { error: `${argument.text} requires a message` };
        if (message.dynamic) return { error: "the commit message uses shell expansion and cannot be verified" };
        paragraphs.push(message.text);
        index += 1;
      }
    } else if (argument.text === "-F" || argument.text === "--file" || argument.text.startsWith("--file=")) {
      return { error: "message files are not accepted because the hook cannot verify the final editor input" };
    } else if (
      ["-c", "-C", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--no-edit"].includes(argument.text) ||
      argument.text.startsWith("--reuse-message=") ||
      argument.text.startsWith("--reedit-message=") ||
      argument.text.startsWith("--fixup=") ||
      argument.text.startsWith("--squash=")
    ) {
      return { error: `${argument.text} reuses or generates a message that is not explicit in the command` };
    }
  }
  if (paragraphs.length === 0) return { error: "an explicit -m/--message value is required" };
  return { message: paragraphs.join("\n\n") };
}

function validateCommitMessage(message: string): string | null {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?: \S.*$/.test(lines[0])) return "the subject must match <type>[optional scope]: <description>";
  if (lines.length === 1) return null;
  if (lines[1] !== "") return "the subject must be followed by a blank line before a body or footer";

  const tail = lines.slice(2);
  while (tail.at(-1) === "") tail.pop();
  if (tail.length === 0) return null;
  const separator = tail.indexOf("");
  const body = separator === -1 ? tail : tail.slice(0, separator);
  const footers = separator === -1 ? [] : tail.slice(separator + 1);
  const footerPattern = /^(?:BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(?:: | #)\S.*$/;
  if (separator === -1 && body.every((line) => footerPattern.test(line))) return null;
  if (body.length > 2) return "the commit body cannot be more than 2 lines";
  if (body.some((line) => line.length === 0)) return "the commit body must contain at most 2 consecutive non-empty lines";
  if (footers.length > 0 && footers.some((line) => !footerPattern.test(line)))
    return "each footer must use Token: value, Token #value, or BREAKING CHANGE: value";
  if (tail.slice(separator + 1).includes("")) return "footers must be consecutive lines";
  return null;
}

function destructiveAdvisory(command: string, cwd: string, explanation: string): string {
  return [
    "Destructive command prohibited by user policy. Do not retry it with another tool.",
    `What it does: ${explanation}.`,
    "User opt-in: supported non-sudo destructive executables can be enabled in user-allowed-commands beside user-allowed-commands.example.",
    "This cannot override sudo, destructive Git operations, or shell behavior whose effects cannot be inspected safely.",
    "Tell the user to execute it personally only if that effect is intended:",
    "1. Open a terminal.",
    `2. Change to the same working directory: cd -- ${JSON.stringify(cwd)}`,
    "3. Review the command and verify backups, target paths, branch, and remote as applicable.",
    `4. Run exactly: ${command}`,
  ].join("\n");
}

function commitAdvisory(command: string, problem: string): string {
  return [
    "Git commit prohibited because its message violates the required format.",
    `Problem: ${problem}.`,
    "Use an explicit message in this form:",
    "<type>[optional scope]: <description>",
    "",
    "[optional body: no more than 2 lines]",
    "",
    "[optional footer(s)]",
    `Rejected command: ${command}`,
  ].join("\n");
}

function nestedShellCommand(words: ShellWord[]): NestedShell {
  const executable = executableName(words[0]?.text);
  if (executable === "eval") return { command: words[1] };
  if (!["bash", "dash", "fish", "ksh", "sh", "zsh"].includes(executable)) return {};

  for (let index = 1; index < words.length; ) {
    const option = words[index];
    if (option.dynamic) return { error: `uses dynamic ${executable} options that cannot be inspected safely` };
    if (option.text === "--") return {};
    if (!option.text.startsWith("-")) return {};
    if (/^-[^-]*[oO]/.test(option.text)) {
      if (/^-[^-]*c/.test(option.text)) return { error: `combines ${executable} command and value-taking options ambiguously` };
      index += 2;
      continue;
    }
    if (["--rcfile", "--init-file"].includes(option.text)) {
      index += 2;
      continue;
    }
    if (option.text.startsWith("--rcfile=") || option.text.startsWith("--init-file=")) {
      index += 1;
      continue;
    }
    if (/^-[^-]*c/.test(option.text)) {
      let commandIndex = index + 1;
      if (words[commandIndex]?.text === "--") commandIndex += 1;
      return { command: words[commandIndex] };
    }
    if (option.text.startsWith("--")) return { error: `uses an unsupported ${executable} option before the command string` };
    index += 1;
  }
  return {};
}

async function evaluateCommandPolicyWithAllowedCommands(
  command: string,
  cwd: string,
  allowedCommands: ReadonlySet<string>,
  allowUserOverrides = true,
): Promise<PolicyDecision | null> {
  const ast = await parseShellAst(command);
  if (ast.error)
    return { kind: "destructive", reason: destructiveAdvisory(command, cwd, `cannot parse the shell syntax safely (${ast.error})`) };
  if (ast.hasCommandSubstitution)
    return {
      kind: "destructive",
      reason: destructiveAdvisory(command, cwd, "runs command or process substitution whose side effects cannot be verified safely"),
    };
  if (ast.outputRedirects.length > 0)
    return {
      kind: "destructive",
      reason: destructiveAdvisory(command, cwd, "writes through shell output redirection and may overwrite or modify a file"),
    };

  for (const parsedCommand of ast.commands) {
    const unwrapped = unwrapCommand(parsedCommand.words);
    if (unwrapped.error) return { kind: "destructive", reason: destructiveAdvisory(command, cwd, unwrapped.error) };
    if (unwrapped.usesSudo)
      return {
        kind: "destructive",
        reason: destructiveAdvisory(command, cwd, "runs a command with elevated privileges through sudo"),
      };
    const words = unwrapped.words;
    if (words.length === 0) continue;
    if (words[0].dynamic)
      return {
        kind: "destructive",
        reason: destructiveAdvisory(
          command,
          cwd,
          "constructs the executable name dynamically, so its destructive effect cannot be verified safely",
        ),
      };

    const nested = nestedShellCommand(words);
    if (nested.error) return { kind: "destructive", reason: destructiveAdvisory(command, cwd, nested.error) };
    if (nested.command) {
      if (nested.command.dynamic)
        return {
          kind: "destructive",
          reason: destructiveAdvisory(command, cwd, "constructs nested shell code dynamically, so its effects cannot be verified safely"),
        };
      const nestedDecision = await evaluateCommandPolicyWithAllowedCommands(
        nested.command.text,
        cwd,
        allowedCommands,
        allowUserOverrides && !unwrapped.usesSudo,
      );
      if (nestedDecision?.kind === "destructive")
        return {
          kind: "destructive",
          reason: destructiveAdvisory(command, cwd, "runs nested shell code that the safety policy identified as destructive"),
        };
      if (nestedDecision) return nestedDecision;
    }

    const explanation = destructiveExplanation(words);
    const executable = executableName(words[0].text);
    const isAllowedForUser =
      allowUserOverrides && !unwrapped.usesSudo && allowedCommands.has(executable) && isUserAllowableDestructiveCommand(words);
    if (explanation && !isAllowedForUser) return { kind: "destructive", reason: destructiveAdvisory(command, cwd, explanation) };
    if (executable !== "git") continue;

    const git = gitSubcommand(words);
    if (git.error) return { kind: "destructive", reason: destructiveAdvisory(command, cwd, git.error) };
    const gitExplanation = destructiveGitExplanation(git);
    if (gitExplanation) return { kind: "destructive", reason: destructiveAdvisory(command, cwd, gitExplanation) };
    if (git.name === "commit") {
      const parsed = parseCommitMessage(git.args);
      const problem = parsed.error ?? validateCommitMessage(parsed.message ?? "");
      if (problem) return { kind: "commit-message", reason: commitAdvisory(command, problem) };
    }
  }
  return null;
}

export async function evaluateCommandPolicy(
  command: string,
  cwd = ".",
  allowedCommandsPath: string | URL = USER_ALLOWED_COMMANDS_PATH,
): Promise<PolicyDecision | null> {
  const allowedCommands = await readUserAllowedCommands(allowedCommandsPath);
  return evaluateCommandPolicyWithAllowedCommands(command, cwd, allowedCommands);
}

export default function commandSafetyHook(pi: HookAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return;
    const cwd = typeof input.cwd === "string" ? input.cwd : ".";
    const decision = await evaluateCommandPolicy(command, cwd);
    if (decision) return { block: true, reason: decision.reason };
  });
}
