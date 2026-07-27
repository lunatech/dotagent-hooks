// pre/ask-mode.ts
//
// Implements ask mode: a restricted operating mode where only `read` and `web_search`
// tools are available. Other tools are blocked with a clear message.
//
// USAGE:
// ------
//
// 1. During a session, use the /ask slash command:
//    /ask           Toggle ask mode on
//    /ask off       Toggle ask mode off
//    /ask status    Check ask mode status
//
// 2. Start omp in ask mode at startup (optional):
//    OMP_ASK_MODE=1 omp
//    or use the bash function: omp-ask
//
// Tools allowed in ask mode:
//   - read (file/directory reading)
//   - web_search (web searching)
//
// All other tools return:
//   "you are in ask mode. Do not try to invoke external tools. If required, ask user to provide output"

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Module-level state: persists across tool calls within a session
// Initialized from environment variable or defaults to false
let askModeEnabled = process.env.OMP_ASK_MODE === "1" || process.env.OMP_ASK_MODE === "true";

export default function (pi: HookAPI) {
  // Register /ask slash command for toggling ask mode
  pi.registerCommand("ask", {
    description: "Toggle ask mode (research-only: read and web_search tools only)",
    handler: async (args, ctx) => {
      // Parse subcommand from args (can be string or array)
      let subcommand: string | undefined;
      if (typeof args === "string") {
        subcommand = args.trim().toLowerCase();
      } else if (Array.isArray(args) && args.length > 0) {
        subcommand = String(args[0]).trim().toLowerCase();
      }
      // else: subcommand stays undefined for bare /ask

      if (subcommand === "off") {
        askModeEnabled = false;
        if (ctx.hasUI) {
          await ctx.ui.notify("Ask mode disabled. All tools are available.");
        }
        return;
      }

      if (subcommand === "status") {
        const status = askModeEnabled ? "ON" : "OFF";
        if (ctx.hasUI) {
          await ctx.ui.notify(`Ask mode: ${status}`);
        }
        return;
      }

      // Default: toggle on (bare /ask or explicit /ask on)
      if (subcommand === "on" || !subcommand) {
        askModeEnabled = true;
        if (ctx.hasUI) {
          await ctx.ui.notify("Ask mode enabled. Only read and web_search tools are available.");
        }
        return;
      }

      // Unknown subcommand
      if (ctx.hasUI) {
        await ctx.ui.notify(
          `Unknown ask mode command: ${subcommand}\n\nUsage:\n  /ask        Toggle ask mode on\n  /ask off    Toggle ask mode off\n  /ask status Check ask mode status`,
        );
      }
    },
  });

  // Block all tools except read and web_search when ask mode is enabled
  pi.on("tool_call", (event) => {
    if (!askModeEnabled) {
      // Ask mode not enabled - allow all tools
      return;
    }

    const toolName = event.toolName ?? "";
    const allowedTools = ["read", "web_search"];

    // Allow read and web_search
    if (allowedTools.includes(toolName)) {
      return;
    }

    // Block all other tools
    return {
      block: true,
      reason: "you are in ask mode. Do not try to invoke external tools. If required, ask user to provide output",
    };
  });
}
