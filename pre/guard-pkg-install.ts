// pre/guard-pkg-install.ts
//
// Blocks silent package installs that modify environments without confirmation:
//   - pip / pip3 install  → advise: use uv/uvx instead
//   - uv add
//   - npm install / npm i
//   - brew install
//
// Advisory on bare python/python3 invocations that fail with missing imports:
//   - detects ModuleNotFoundError / ImportError in bash output post-execution
//   - appends uv/uvx guidance to what the LLM sees
//

import type { HookAPI } from "../lib/hook-api.ts";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

const VALUE_FLAGS: Record<string, true> = {
  "--prefix": true,
  "--userconfig": true,
  "--registry": true,
  "--cache": true,
  "--config": true,
  "--python": true,
  "--index-url": true,
  "--extra-index-url": true,
  "--constraint": true,
  "--editable": true,
  "--project": true,
  "--directory": true,
  "--workspace": true,
  "--workspaces": true,
  "--global-dir": true,
  "-C": true,
  "-c": true,
  "-i": true,
};

function executableName(value: string): string {
  return value.split("/").pop() ?? value;
}

function subcommand(words: ShellWord[]): string | undefined {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (word.dynamic) return undefined;
    if (word.text === "--") return words[i + 1]?.dynamic ? undefined : words[i + 1]?.text;
    if (!word.text.startsWith("-")) return word.text;
    const flag = word.text.split("=", 1)[0];
    if (VALUE_FLAGS[flag] && !word.text.includes("=")) i += 1;
  }
  return undefined;
}

function packageOperation(words: ShellWord[]): "pip" | "uv" | "npm" | "brew" | undefined {
  if (!words[0] || words[0].dynamic) return undefined;
  const executable = executableName(words[0].text);
  const command = subcommand(words);
  if (command === undefined) return undefined;
  if (["pip", "pip3"].includes(executable) && command === "install") return "pip";
  if (executable === "uv" && command === "add") return "uv";
  if (executable === "npm" && ["install", "i"].includes(command)) return "npm";
  if (executable === "brew" && command === "install") return "brew";
  return undefined;
}
const PYTHON_IMPORT_ERR = /ModuleNotFoundError|ImportError|No module named/;
const PYTHON_CMD = /\bpython3?\s/;

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    const ast = await parseShellAst(cmd);
    if (ast.error) return;
    for (const { words } of ast.commands) {
      const operation = packageOperation(words);
      if (!operation) continue;
      const reasons = {
        pip: "Refused: pip/pip3 install is not allowed — it modifies the shared Python environment silently. Use uv or uvx instead.",
        uv: "Refused: uv add modifies the project dependencies. Review and run manually.",
        npm: "Refused: npm install modifies node_modules. Review and run manually.",
        brew: "Refused: brew install modifies system packages. Run manually.",
      };
      return { block: true, reason: reasons[operation] };
    }
  });

  // Post-execution: if a bash command output contains a Python import error,
  // append uv/uvx guidance. Never blocks — only annotates what the LLM sees.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown> | undefined;
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!PYTHON_CMD.test(cmd)) return;
    const text = event.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (!PYTHON_IMPORT_ERR.test(text)) return;

    const advisory =
      "\n\n[hook: guard-pkg-install] Python import error detected. " +
      "Do NOT use pip install. Use uv/uvx to supply the missing package:\n" +
      "  • uv run --with <pkg1> --with <pkg2> <script.py>\n" +
      "  • uvx --from <pkg> <cmd>   (for packaged CLI tools)\n" +
      "  • uv run <script.py>       (if pyproject.toml already declares the dep)";

    return {
      content: event.content.map((c) => (c.type === "text" ? { ...c, text: (c.text ?? "") + advisory } : c)),
    };
  });
}
