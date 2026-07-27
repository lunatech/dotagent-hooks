// pre/guard-aws-write.ts
//
// Blocks AWS CLI write/mutating operations while allowing read-only calls.
// Strategy: allowlist known read-only action prefixes; block everything else.
//
// Read-only prefixes allowed through: describe, list, get, head, check,
// query, scan, search, validate, generate-presigned, help, wait.
//

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Matches any `aws <service> <action>` invocation
const AWS_CMD = /\baws\s+(\S+)\s+(\S+)/;

// Read-only action prefixes — anything matching these is allowed through
const AWS_READONLY = /^(describe|list|get|head|check|query|scan|search|validate|generate-presigned|help|wait)/;

export default function (pi: HookAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    const m = cmd.match(AWS_CMD);
    if (m) {
      const service = m[1];
      const action = m[2];
      if (!AWS_READONLY.test(action)) {
        return {
          block: true,
          reason: `Refused: aws ${service} ${action} is a write/mutating operation. ` + "Run manually after reviewing the impact.",
        };
      }
    }
  });
}
