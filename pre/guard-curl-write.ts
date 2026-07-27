// pre/guard-curl-write.ts
//
// Blocks curl requests that mutate remote state:
//   - -X POST/PUT/DELETE/PATCH or --request POST/PUT/DELETE/PATCH
//   - -d / --data / --data-raw / --data-binary (implicit POST)
//
// Allows: GET requests, -G (GET with query params), read-only probes.
//

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Explicit write method flag
const CURL_WRITE = /\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i;

// --data flags imply a POST even without -X
const CURL_DATA = /\bcurl\b.*(\s-d\s|\s--data\b|\s--data-raw\b|\s--data-binary\b)/;

export default function (pi: HookAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (CURL_WRITE.test(cmd)) {
      return {
        block: true,
        reason: "Refused: curl with a write method (POST/PUT/DELETE/PATCH). " + "Review the endpoint and run manually.",
      };
    }

    if (CURL_DATA.test(cmd)) {
      return {
        block: true,
        reason: "Refused: curl with --data implies a POST. " + "Review the endpoint and payload, then run manually.",
      };
    }
  });
}
