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

const PIP = /\b(pip3?)\s+install\b/;
const UV_ADD = /\buv\s+add\b/;
const NPM = /\bnpm\s+(install|i)\b/;
const BREW = /\bbrew\s+install\b/;
const PYTHON_IMPORT_ERR = /ModuleNotFoundError|ImportError|No module named/;
const PYTHON_CMD = /\bpython3?\s/;

export default function (pi: HookAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (PIP.test(cmd)) {
      return {
        block: true,
        reason:
          "Refused: pip/pip3 install is not allowed — it modifies the shared Python environment silently. " +
          "Use uv or uvx instead:\n" +
          "  • Run a one-off command with a package:  uvx --from <pkg> <cmd>  or  uv run --with <pkg> <script.py>\n" +
          "  • Add a project dependency:              uv add <pkg>  (then resubmit for user approval)\n" +
          "  • Install a standalone tool:             uv tool install <pkg>",
      };
    }

    if (UV_ADD.test(cmd)) {
      return {
        block: true,
        reason: "Refused: uv add modifies the project dependencies. " + "Review and run manually.",
      };
    }

    if (NPM.test(cmd)) {
      return {
        block: true,
        reason: "Refused: npm install modifies node_modules. " + "Review and run manually.",
      };
    }

    if (BREW.test(cmd)) {
      return {
        block: true,
        reason: "Refused: brew install modifies system packages. Run manually.",
      };
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
