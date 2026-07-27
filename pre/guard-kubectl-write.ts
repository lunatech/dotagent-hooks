// pre/guard-kubectl-write.ts
//
// Blocks kubectl operations that modify cluster state.
// Allowed through: get, describe, logs, top, explain, diff, version,
//                  config, port-forward, wait, auth, api-resources,
//                  api-versions, cluster-info, proxy (read-only use).
//

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Direct write verbs
const KUBECTL_WRITE = /\bkubectl\s+(apply|create|delete|replace|patch|edit|scale|drain|cordon|uncordon|taint|annotate|label|exec|cp)\b/;

// rollout sub-commands that mutate state
const KUBECTL_ROLLOUT_WRITE = /\bkubectl\s+rollout\s+(restart|undo|pause|resume)\b/;

export default function (pi: HookAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    const rollout = cmd.match(KUBECTL_ROLLOUT_WRITE);
    if (rollout) {
      const sub = rollout[1]; // restart | undo | pause | resume
      if (sub === "restart") {
        return {
          block: true,
          reason:
            "Refused: kubectl rollout restart triggers a rolling restart of live pods. " + "Run manually after confirming the target.",
        };
      }
      return {
        block: true,
        reason: `Refused: kubectl rollout ${sub} modifies cluster state. ` + "Review and run manually.",
      };
    }

    const m = cmd.match(KUBECTL_WRITE);
    if (m) {
      const verb = m[1];
      return {
        block: true,
        reason: `Refused: kubectl ${verb} modifies cluster state. ` + "Review the manifest/target and run manually.",
      };
    }
  });
}
