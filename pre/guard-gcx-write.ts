// pre/guard-gcx-write.ts
//
// Blocks gcx CLI operations that mutate live Grafana Cloud state.
//
// Strategy: parse the shell command with the Tree-sitter AST (same parser
// as command-safety.ts) so that gcx tokens inside quoted strings or echo
// arguments are not mistaken for real commands. Walk the AST words
// left-to-right, skipping flags and known group/namespace tokens, and
// classify the first word that is a known verb. Block if it is a write
// verb; pass if it is a read verb; block conservatively if it is unknown.
// Dynamic tokens (shell variables, command substitutions) are blocked with
// a precise "cannot verify" message rather than a misleading "unrecognised
// verb" message.
//
// Special case — `gcx api`:
//   Block if an explicit write method (-X POST/PUT/DELETE/PATCH,
//   --request …, --data / -d) is present. All other gcx api calls pass.
//
// Read-only verbs allowed through (not exhaustive — anything genuinely
// new will be conservatively blocked until added here):
//   get, list, search, status, timeline, report, scores, show, diff,
//   export, diagnose, inspect, query, labels, metadata, series, summary,
//   schema, versions, snapshot, validate, pull, help, help-tree, commands,
//   check, view, current-context, list-contexts, path, regions, open,
//   providers, sources, chart, exemplars, profile-types, billing, log,
//   schemas, examples, final-shifts, list-alerts, judge, version, prune.
//

import type { HookAPI } from "../lib/hook-api.ts";
import { parseShellAst, type ShellWord } from "../lib/shell-ast.ts";

function executableName(value: string): string {
  return value.split("/").pop() ?? value;
}

// ---------------------------------------------------------------------------
// Verb tables
// ---------------------------------------------------------------------------

// Read-only terminal verbs — safe to run without confirmation.
const GCX_READONLY_VERBS: Record<string, true> = {
  get: true,
  list: true,
  search: true,
  status: true,
  timeline: true,
  report: true,
  scores: true,
  show: true,
  diff: true,
  export: true,
  diagnose: true,
  inspect: true,
  query: true,
  labels: true,
  metadata: true,
  series: true,
  summary: true,
  schema: true,
  versions: true,
  snapshot: true,
  validate: true,
  pull: true,
  help: true,
  "help-tree": true,
  commands: true,
  check: true,
  view: true,
  "current-context": true,
  "list-contexts": true,
  path: true,
  regions: true,
  open: true,
  providers: true,
  sources: true,
  chart: true,
  exemplars: true,
  "profile-types": true,
  billing: true,
  "final-shifts": true,
  log: true,
  "list-alerts": true,
  judge: true,
  version: true,
  prune: true,
  // resources sub-commands that are reads
  schemas: true,
  examples: true,
  // k6 auth sub-command
  token: true,
};

// Write/mutating verbs — block unconditionally.
const GCX_WRITE_VERBS: Record<string, true> = {
  create: true,
  update: true,
  delete: true,
  push: true,
  apply: true,
  upsert: true,
  set: true,
  unset: true,
  reset: true,
  edit: true,
  configure: true,
  remove: true,
  exclude: true,
  include: true,
  clear: true,
  close: true, // irm incidents close
  acknowledge: true,
  resolve: true,
  silence: true,
  unacknowledge: true,
  unresolve: true,
  unsilence: true,
  escalate: true,
  deploy: true, // synthetic-monitoring probes deploy
  dismiss: true, // adaptive traces recommendations dismiss
  cancel: true, // aio11y experiments cancel
  save: true, // aio11y saved-conversations save
  add: true, // aio11y collections conversations add
  "token-reset": true, // synthetic-monitoring probes token-reset
  "use-context": true, // config use-context (switches active context)
};

// Pure routing/namespace tokens — never a verb themselves.
// Rule: if a name is also a read or write verb, do NOT put it here.
const GCX_GROUPS: Record<string, true> = {
  // top-level groups
  resources: true,
  dashboards: true,
  slo: true,
  alert: true,
  "synthetic-monitoring": true,
  irm: true,
  k6: true,
  fleet: true,
  kg: true,
  metrics: true,
  logs: true,
  traces: true,
  profiles: true,
  datasources: true,
  aio11y: true,
  appo11y: true,
  frontend: true,
  instrumentation: true,
  api: true,
  config: true,
  dev: true,
  assistant: true,
  agent: true,
  completion: true,
  // sub-groups
  definitions: true,
  reports: true,
  "contact-points": true,
  "mute-timings": true,
  "notification-policies": true,
  groups: true,
  instances: true,
  oncall: true,
  incidents: true,
  checks: true,
  probes: true,
  "load-tests": true,
  "load-zones": true,
  "env-vars": true,
  "test-run": true,
  pipelines: true,
  collectors: true,
  tenant: true,
  entities: true,
  insights: true,
  meta: true,
  "model-rules": true,
  "relabel-rules": true,
  suppressions: true,
  adaptive: true,
  exemptions: true,
  recommendations: true,
  segments: true,
  "drop-rules": true,
  patterns: true,
  policies: true,
  overrides: true,
  settings: true,
  apps: true,
  clusters: true,
  services: true,
  evaluators: true,
  guards: true,
  experiments: true,
  collections: true,
  conversations: true,
  "saved-conversations": true,
  scores: true,
  templates: true,
  agents: true,
  generations: true,
  "alert-groups": true,
  "escalation-chains": true,
  "escalation-policies": true,
  integrations: true,
  "resolution-notes": true,
  "shift-swaps": true,
  shifts: true,
  "slack-channels": true,
  teams: true,
  "user-groups": true,
  users: true,
  webhooks: true,
  organizations: true,
  routes: true,
  investigations: true,
  activity: true,
  contexts: true,
  severities: true,
  "allowed-load-zones": true,
  "allowed-projects": true,
  auth: true,
  rules: true, // kg rules / alert rules / aio11y rules — child verb does the work
  stacks: true, // top-level group; stacks list/get/regions are read verbs
  schedules: true, // k6 schedules / oncall schedules — child verb does the work
  runs: true, // k6 runs — child verb does the work
};

// ---------------------------------------------------------------------------
// AST-based helpers
// ---------------------------------------------------------------------------

// Classify the gcx api call by the HTTP method / data flag present.
// Returns "method" if a write HTTP method is detected, "data" if a request
// body flag is detected, or null if the call looks read-only.
// Dynamic flags (shell expansions) are treated conservatively as write.
function gcxApiWriteKind(words: ShellWord[]): "method" | "data" | null {
  // words[0]="gcx", words[1]="api"; start from index 2
  for (let i = 2; i < words.length; i++) {
    const w = words[i];
    if (w.dynamic) return "method"; // can't verify — block conservatively
    const t = w.text;
    // -X <METHOD> or --request <METHOD>
    if (t === "-X" || t === "--request") {
      const method = (words[i + 1]?.text ?? "").toUpperCase();
      i++; // consume the value word in either case
      if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) return "method";
      continue;
    }
    // --request=METHOD
    if (/^--request=(POST|PUT|DELETE|PATCH)$/i.test(t)) return "method";
    // -d / --data / --data-raw / --data-binary (with or without = value)
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") return "data";
    if (/^(?:--data|--data-raw|--data-binary)=/.test(t)) return "data";
  }
  return null;
}

type VerbResult = { kind: "write" | "readonly" | "unknown"; verb: string } | { kind: "dynamic" } | { kind: "none" };

// Walk the words of a gcx command (words[0] is "gcx") to find the first
// token that acts as a verb. Flags and group/namespace tokens are skipped.
// Dynamic tokens are surfaced immediately so the caller can emit a precise
// "cannot verify" message.
function extractGcxVerb(words: ShellWord[]): VerbResult {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    // Flags and their attached values are never the verb
    if (word.text.startsWith("-")) continue;
    // A dynamic token in verb position cannot be verified
    if (word.dynamic) return { kind: "dynamic" };
    const t = word.text;
    if (GCX_WRITE_VERBS[t] !== undefined) return { kind: "write", verb: t };
    if (GCX_READONLY_VERBS[t] !== undefined) return { kind: "readonly", verb: t };
    if (GCX_GROUPS[t] !== undefined) continue; // namespace — keep walking
    // Positional arg: path fragment, UUID, digit-prefixed
    if (/[/=]/.test(t) || /^\d/.test(t) || /^[a-f0-9]{8}-/.test(t)) continue;
    // Unknown bare word — treat conservatively as the verb
    return { kind: "unknown", verb: t };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    // Fast path: skip commands that don't mention gcx at all
    if (!/\bgcx\b/.test(cmd)) return;

    const ast = await parseShellAst(cmd);
    if (ast.error) {
      return {
        block: true,
        reason: "Refused: cannot parse the shell syntax to verify the gcx operation safely. " + "Run manually after reviewing.",
      };
    }

    for (const { words } of ast.commands) {
      if (words.length === 0) continue;
      // Only inspect commands whose executable is literally "gcx"
      if (words[0].dynamic || executableName(words[0].text) !== "gcx") continue;

      // --- gcx api: only HTTP method / data flags matter ---
      if (!words[1]?.dynamic && words[1]?.text === "api") {
        const kind = gcxApiWriteKind(words);
        if (kind === "method") {
          return {
            block: true,
            reason:
              "Refused: gcx api with a write method (POST/PUT/DELETE/PATCH) mutates live Grafana state. " +
              "Review the endpoint and run manually.",
          };
        }
        if (kind === "data") {
          return {
            block: true,
            reason:
              "Refused: gcx api with --data implies a POST to live Grafana state. " + "Review the endpoint and payload, then run manually.",
          };
        }
        continue; // read-only api call — allow
      }

      // --- all other gcx sub-commands: classify by verb ---
      const result = extractGcxVerb(words);

      if (result.kind === "dynamic") {
        return {
          block: true,
          reason: "Refused: gcx command uses a dynamic token in verb position — cannot verify the operation safely. " + "Run manually.",
        };
      }
      if (result.kind === "none") continue;

      if (result.kind === "write") {
        return {
          block: true,
          reason: `Refused: gcx ... ${result.verb} modifies live Grafana Cloud state. ` + "Review the target and run manually.",
        };
      }
      if (result.kind === "unknown") {
        return {
          block: true,
          reason:
            `Refused: gcx ... ${result.verb} is an unrecognised verb — blocked conservatively. ` +
            "If this is a read-only operation, run it manually.",
        };
      }
      // kind === "readonly" — allow
    }
  });
}
