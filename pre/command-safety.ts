import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

type ShellWord = {
  value: string;
  operator: boolean;
};

type PolicyDecision = {
  kind: "destructive" | "commit-message";
  reason: string;
};

const ANSI_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  "'": "'",
};
const COMMAND_SEPARATORS: Record<string, true> = {
  ";": true,
  "&&": true,
  "||": true,
  "|": true,
  "&": true,
  "\n": true,
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

function decodeAnsiEscape(source: string, slashIndex: number): { value: string; endIndex: number } {
  const escapedCharacter = source[slashIndex + 1];
  if (Object.hasOwn(ANSI_ESCAPES, escapedCharacter)) {
    return { value: ANSI_ESCAPES[escapedCharacter], endIndex: slashIndex + 1 };
  }

  const numericStart = slashIndex + 1;
  if (escapedCharacter === "x") {
    const digits = source.slice(slashIndex + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? "";
    if (digits) return { value: String.fromCodePoint(Number.parseInt(digits, 16)), endIndex: slashIndex + 1 + digits.length };
  }
  if (escapedCharacter === "u" || escapedCharacter === "U") {
    const length = escapedCharacter === "u" ? 4 : 8;
    const digits = source.slice(slashIndex + 2, slashIndex + 2 + length);
    if (digits.length === length && /^[0-9A-Fa-f]+$/.test(digits)) {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint <= 0x10ffff) {
        return { value: String.fromCodePoint(codePoint), endIndex: slashIndex + 1 + length };
      }
    }
  }
  const octalDigits = source.slice(numericStart).match(/^[0-7]{1,3}/)?.[0] ?? "";
  if (octalDigits) return { value: String.fromCodePoint(Number.parseInt(octalDigits, 8)), endIndex: slashIndex + octalDigits.length };
  return { value: escapedCharacter, endIndex: slashIndex + 1 };
}

function containsActiveSubstitution(command: string): boolean {
  let quote: "'" | '"' | "ansi" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'" || quote === "ansi") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' && quote === '"') {
      quote = null;
      continue;
    }
    if (character === '"' && quote === null) {
      quote = '"';
      continue;
    }
    if (character === "'" && quote === null) {
      quote = command[index - 1] === "$" ? "ansi" : "'";
      continue;
    }
    if (character === "`" || ((character === "$" || character === "<" || character === ">") && command[index + 1] === "(")) return true;
  }
  return false;
}

function tokenizeShell(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let value = "";
  let quote: "'" | '"' | "ansi" | null = null;
  let escaped = false;

  const flush = (): void => {
    if (value.length > 0) {
      words.push({ value, operator: false });
      value = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote === "ansi") {
      if (character === "'") {
        quote = null;
      } else if (character === "\\" && index + 1 < command.length) {
        const decoded = decodeAnsiEscape(command, index);
        value += decoded.value;
        index = decoded.endIndex;
      } else {
        value += character;
      }
      continue;
    }
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      continue;
    }
    if (character === "$" && command[index + 1] === "'") {
      quote = "ansi";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\n") {
      flush();
      words.push({ value: "\n", operator: true });
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      flush();
      const pair = command.slice(index, index + 2);
      const operator = pair === "||" || pair === "&&" ? pair : character;
      words.push({ value: operator, operator: true });
      if (operator.length === 2) index += 1;
      continue;
    }
    if (character === ">" || character === "<") {
      flush();
      const pair = command.slice(index, index + 2);
      const operator = pair === ">>" || pair === "<<" || pair === ">|" ? pair : character;
      words.push({ value: operator, operator: true });
      if (operator.length === 2) index += 1;
      continue;
    }
    value += character;
  }

  if (escaped) value += "\\";
  flush();
  return words;
}

function splitCommands(words: ShellWord[]): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let current: ShellWord[] = [];

  for (const word of words) {
    if (word.operator && Object.hasOwn(COMMAND_SEPARATORS, word.value)) {
      if (current.length > 0) commands.push(current);
      current = [];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function unwrapCommand(words: ShellWord[]): string[] {
  const values = words.filter((word) => !word.operator).map((word) => word.value);
  let index = 0;

  while (index < values.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index])) index += 1;
  if (values[index] === "env") {
    index += 1;
    while (index < values.length) {
      const option = values[index];
      if (option.startsWith("-S") || option === "--split-string" || option.startsWith("--split-string=")) return ["$env-split-string"];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
        index += 1;
      } else if (/^(?:-u|--unset|-C|--chdir)$/.test(option)) {
        index += 2;
      } else if (option === "--") {
        index += 1;
        break;
      } else if (option.startsWith("-")) {
        index += 1;
      } else {
        break;
      }
    }
  }
  while (index < values.length && Object.hasOwn(SHELL_WRAPPERS, values[index])) {
    const wrapper = values[index];
    index += 1;
    while (index < values.length && values[index].startsWith("-")) {
      const option = values[index];
      if (wrapper === "command" && /^-[^-]*[vV]/.test(option)) return [];
      if (option === "--") {
        index += 1;
        break;
      }
      if (wrapper === "sudo" && /^(?:-u|-g|-h|-p|-r|-t|-C|-D|-R|-T|--user|--group|--host|--prompt|--role|--type|--close-from|--chdir|--chroot|--command-timeout)$/.test(option)) {
        index += 2;
      } else if (wrapper === "time" && /^(?:-f|--format|-o|--output)$/.test(option)) {
        index += 2;
      } else if (wrapper === "exec" && option === "-a") {
        index += 2;
      } else {
        index += 1;
      }
    }
  }
  return values.slice(index);
}

function executableName(value: string | undefined): string {
  return (value ?? "").split("/").pop() ?? "";
}

function gitSubcommand(args: string[]): { name: string; args: string[] } {
  let index = 1;
  while (index < args.length) {
    const value = args[index];
    if (value === "-C" || value === "-c" || value === "--git-dir" || value === "--work-tree" || value === "--namespace") {
      index += 2;
      continue;
    }
    if (value.startsWith("--git-dir=") || value.startsWith("--work-tree=") || value.startsWith("--namespace=")) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return { name: value, args: args.slice(index + 1) };
  }
  return { name: "", args: [] };
}

function destructiveExplanation(command: string[]): string | null {
  const executable = executableName(command[0]);
  const direct = Object.hasOwn(DESTRUCTIVE_EXECUTABLES, executable) ? DESTRUCTIVE_EXECUTABLES[executable] : undefined;
  if (direct !== undefined) return direct;

  if (/^mkfs(?:\.|$)/.test(executable)) return "creates a filesystem and destroys the existing data on the target device";
  if (executable === "dd" && command.slice(1).some((argument) => argument.startsWith("of="))) return "writes raw bytes to a target and can overwrite a file or disk";
  if (executable === "diskutil" && command.slice(1).some((argument) => /^(?:erase|partition|delete|remove)/i.test(argument))) return "changes disk partitions or filesystems and may destroy stored data";
  if (executable === "terraform" && command[1] === "destroy") return "destroys infrastructure managed by Terraform";
  if (executable === "kubectl" && command[1] === "delete") return "deletes Kubernetes resources";
  if (executable === "docker" && (command[1] === "rm" || command[1] === "rmi" || (command[1] === "system" && command[2] === "prune") || (command[2] === "rm" && ["container", "image", "network", "volume"].includes(command[1])))) return "deletes Docker resources or cached data";
  if (["npm", "pnpm", "yarn", "pip", "pip3", "brew", "gem", "cargo"].includes(executable) && ["remove", "rm", "uninstall", "uninstall-global"].includes(command[1])) return "uninstalls packages from the current environment";

  if (executable === "find" && command.slice(1).some((argument) => argument === "-delete" || argument === "-exec" || argument === "-execdir")) return "deletes paths directly or executes another command for matched paths";
  if (executable === "xargs" && command.slice(1).some((argument) => Object.hasOwn(DESTRUCTIVE_EXECUTABLES, executableName(argument)))) return "invokes a destructive command for items read from standard input";

  if (executable === "git") {
    const git = gitSubcommand(command);
    if (git.name === "push") return "publishes local refs and objects to a remote Git repository";
    if (git.name === "clean") return "permanently removes untracked files from the working tree";
    if (git.name === "reset" && git.args.some((argument) => ["--hard", "--merge", "--keep"].includes(argument))) return "resets Git state and can discard uncommitted work";
    if (git.name === "restore") return "replaces working-tree or staged file content and can discard changes";
    if (git.name === "checkout" && git.args.includes("--")) return "replaces working-tree file content and can discard changes";
    if (git.name === "branch" && git.args.some((argument) => argument === "-d" || argument === "-D" || argument.startsWith("--delete"))) return "deletes one or more Git branches";
    if (git.name === "tag" && git.args.some((argument) => argument === "-d" || argument === "--delete")) return "deletes one or more Git tags";
    if (git.name === "stash" && ["drop", "clear"].includes(git.args[0])) return "deletes saved Git stash entries";
  }

  return null;
}

function parseCommitMessage(args: string[]): { message?: string; error?: string } {
  const paragraphs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-m" || argument === "--message") {
      const message = args[index + 1];
      if (message === undefined) return { error: `${argument} requires a message` };
      paragraphs.push(message);
      index += 1;
    } else if (argument.startsWith("--message=")) {
      paragraphs.push(argument.slice("--message=".length));
    } else if (argument.startsWith("-m") && argument.length > 2) {
      paragraphs.push(argument.slice(2));
    } else if (argument === "-F" || argument === "--file" || argument.startsWith("--file=")) {
      return { error: "message files are not accepted because the hook cannot verify the final editor input" };
    } else if (["-c", "-C", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--no-edit"].includes(argument) || argument.startsWith("--reuse-message=") || argument.startsWith("--reedit-message=") || argument.startsWith("--fixup=") || argument.startsWith("--squash=")) {
      return { error: `${argument} reuses or generates a message that is not explicit in the command` };
    }
  }

  if (paragraphs.length === 0) return { error: "an explicit -m/--message value is required" };
  return { message: paragraphs.join("\n\n") };
}

function validateCommitMessage(message: string): string | null {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  const subject = lines[0];
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?: \S.*$/.test(subject)) {
    return "the subject must match <type>[optional scope]: <description>";
  }
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
  if (footers.length > 0 && footers.some((line) => !footerPattern.test(line))) return "each footer must use Token: value, Token #value, or BREAKING CHANGE: value";
  if (tail.slice(separator + 1).includes("")) return "footers must be consecutive lines";
  return null;
}

function destructiveAdvisory(command: string, cwd: string, explanation: string): string {
  return [
    "Destructive command prohibited by user policy. Do not retry it with another tool.",
    `What it does: ${explanation}.`,
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

export function evaluateCommandPolicy(command: string, cwd = "."): PolicyDecision | null {
  if (containsActiveSubstitution(command)) {
    return {
      kind: "destructive",
      reason: destructiveAdvisory(command, cwd, "runs command or process substitution whose side effects cannot be verified safely"),
    };
  }

  const words = tokenizeShell(command);
  if (words.some((word) => word.operator && [">", ">>", ">|"].includes(word.value))) {
    return {
      kind: "destructive",
      reason: destructiveAdvisory(command, cwd, "writes through shell output redirection and may overwrite or modify a file"),
    };
  }

  for (const shellCommand of splitCommands(words)) {
    const values = unwrapCommand(shellCommand);
    if (values.length === 0) continue;

    if (/[$`]/.test(values[0])) {
      return {
        kind: "destructive",
        reason: destructiveAdvisory(command, cwd, "constructs the executable name dynamically, so its destructive effect cannot be verified safely"),
      };
    }

    const executable = executableName(values[0]);
    const nestedCommandIndex = ["bash", "dash", "fish", "ksh", "sh", "zsh"].includes(executable)
      ? values.findIndex((value, index) => index > 0 && /^-[^-]*c/.test(value)) + 1
      : executable === "eval"
        ? 1
        : 0;
    if (nestedCommandIndex > 0 && values[nestedCommandIndex]) {
      const nestedDecision = evaluateCommandPolicy(values[nestedCommandIndex], cwd);
      if (nestedDecision?.kind === "destructive") {
        return {
          kind: "destructive",
          reason: destructiveAdvisory(command, cwd, "runs nested shell code that the safety policy identified as destructive"),
        };
      }
      if (nestedDecision) return nestedDecision;
    }

    const explanation = destructiveExplanation(values);
    if (explanation) {
      return { kind: "destructive", reason: destructiveAdvisory(command, cwd, explanation) };
    }

    if (executable === "git") {
      const git = gitSubcommand(values);
      if (git.name === "commit") {
        const parsed = parseCommitMessage(git.args);
        const problem = parsed.error ?? validateCommitMessage(parsed.message ?? "");
        if (problem) return { kind: "commit-message", reason: commitAdvisory(command, problem) };
      }
    }
  }

  return null;
}

export default function commandSafetyHook(pi: HookAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return;
    const cwd = typeof input.cwd === "string" ? input.cwd : ".";
    const decision = evaluateCommandPolicy(command, cwd);
    if (decision) return { block: true, reason: decision.reason };
  });
}
