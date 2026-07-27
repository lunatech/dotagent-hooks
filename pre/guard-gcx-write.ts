// pre/guard-gcx-write.ts
//
// Blocks gcx CLI operations that mutate live Grafana Cloud state.
//
// Strategy: walk the non-flag tokens left-to-right, skipping known
// group/sub-group namespace tokens, and return the first token that
// is a known verb. Block if it is a write verb; pass if it is a
// read verb; block conservatively if it is unknown.
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

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

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

// gcx api with an explicit write method or request body
const GCX_API_WRITE_METHOD = /\bgcx\s+api\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i;
const GCX_API_DATA = /\bgcx\s+api\b.*(\s-d\s|\s--data\b)/;

// Captures all non-flag tokens after `gcx`
const GCX_TOKENS = /\bgcx\s+((?:[^-\s]\S*\s*)+)/;

function extractVerb(cmd: string): string | null {
  const m = cmd.match(GCX_TOKENS);
  if (!m) return null;
  const tokens = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("-"));

  for (const t of tokens) {
    // Known verb — return immediately
    if (GCX_WRITE_VERBS[t] !== undefined || GCX_READONLY_VERBS[t] !== undefined) return t;
    // Known routing namespace — keep walking
    if (GCX_GROUPS[t] !== undefined) continue;
    // Positional arg: path fragment, UUID, digit-prefixed, or quoted string
    if (/[\/=]/.test(t) || /^\d/.test(t) || /^[a-f0-9]{8}-/.test(t)) continue;
    if (t.startsWith("'") || t.startsWith('"')) continue;
    // Unknown bare word — treat conservatively as the verb
    return t;
  }
  // Only groups/args found — null means pass through (e.g. bare group listings)
  return null;
}

export default function (pi: HookAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : "";

    if (!/\bgcx\b/.test(cmd)) return;

    if (GCX_API_WRITE_METHOD.test(cmd)) {
      return {
        block: true,
        reason:
          "Refused: gcx api with a write method (POST/PUT/DELETE/PATCH) mutates live Grafana state. " +
          "Review the endpoint and run manually.",
      };
    }

    if (GCX_API_DATA.test(cmd)) {
      return {
        block: true,
        reason:
          "Refused: gcx api with --data implies a POST to live Grafana state. " + "Review the endpoint and payload, then run manually.",
      };
    }

    const verb = extractVerb(cmd);
    if (!verb) return;

    if (GCX_WRITE_VERBS[verb] !== undefined) {
      return {
        block: true,
        reason: `Refused: gcx ... ${verb} modifies live Grafana Cloud state. ` + "Review the target and run manually.",
      };
    }

    if (GCX_READONLY_VERBS[verb] === undefined) {
      return {
        block: true,
        reason:
          `Refused: gcx ... ${verb} is an unrecognised verb — blocked conservatively. ` +
          "If this is a read-only operation, run it manually.",
      };
    }
  });
}
