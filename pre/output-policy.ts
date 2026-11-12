import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HookAPI } from "../lib/hook-api.ts";
import { readOutputPolicyConfig, type OutputPolicyConfig } from "../output-policy-config.ts";

const MAX_PENDING_CHARS = 16_384;

interface State {
  totalChars: number;
  pending: string;
  pendingTruncated: boolean;
  lastBlock?: string;
  repeats: number;
  repeatedChars: number;
  aborted: boolean;
}
function fresh(): State {
  return { totalChars: 0, pending: "", pendingTruncated: false, repeats: 0, repeatedChars: 0, aborted: false };
}
function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}
function syntaxOnly(line: string): boolean {
  const value = normalize(line);
  if (!value) return true;
  if (/^(?: {0,3})(`{3,}|~{3,})(.*)$/.test(line)) return true;
  if (/^<\/?[A-Za-z][A-Za-z0-9:._-]*(?:\s+[^<>]*)?\/?>(?:\s*)$/.test(value)) return true;
  return /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(value);
}
function deltaOf(event: any): string | undefined {
  const update = event?.assistantMessageEvent ?? event;
  if (typeof update?.delta !== "string") return undefined;
  if (!["text", "text_delta"].includes(String(update.type ?? ""))) return undefined;
  return update.delta;
}

function isWithin(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export default function outputPolicy(pi: HookAPI, config: OutputPolicyConfig = readOutputPolicyConfig()): void {
  let state = fresh();
  const logDirectory = resolve(homedir(), ".agents/hooks");
  const workingDirectory = resolve(process.cwd());
  const shouldLog = isWithin(logDirectory, workingDirectory);
  let loggedChars = 0;
  let sessionChars = 0;
  let messageId: string | null = null;
  let sessionId: string | null = null;
  let turnIndex: number | null = null;
  const logBoundary = (event: string) => {
    if (!shouldLog) return;
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      cwd: workingDirectory,
      messageId,
      sessionId,
      turnIndex,
      charsSincePreviousEvent: sessionChars - loggedChars,
      cumulativeChars: sessionChars,
    };
    try {
      mkdirSync(dirname(resolve(logDirectory, "output-policy.jsonl")), { recursive: true });
      appendFileSync(resolve(logDirectory, "output-policy.jsonl"), `${JSON.stringify(entry)}\n`);
      loggedChars = sessionChars;
    } catch {
      // Debug logging must not interrupt output policy enforcement.
    }
  };
  const reset = (
    event: string,
    payload?: { turnIndex?: number; message?: { id?: string } },
    context?: { sessionManager?: { getSessionId?: () => string } },
  ) => {
    if (event === "agent_start") {
      messageId = null;
      sessionId = null;
      turnIndex = null;
    }
    const activeSessionId = context?.sessionManager?.getSessionId?.();
    if (typeof activeSessionId === "string") sessionId = activeSessionId;
    if (typeof payload?.message?.id === "string") messageId = payload.message.id;
    if (typeof payload?.turnIndex === "number") turnIndex = payload.turnIndex;
    logBoundary(event);
    state = fresh();
    if (event === "agent_start" || event === "agent_end") {
      sessionChars = 0;
      loggedChars = 0;
    }
  };
  pi.on("message_start", (event, context) => reset("message_start", event, context));
  pi.on("turn_start", (event, context) => reset("turn_start", event, context));
  pi.on("agent_start", (event, context) => reset("agent_start", event, context));
  pi.on("agent_end", (event, context) => reset("agent_end", event, context));
  pi.on("message_update", (event, ctx) => {
    if (state.aborted) return;
    const delta = deltaOf(event);
    if (delta === undefined) return;
    state.totalChars += delta.length;
    sessionChars += delta.length;
    let warning: string | undefined;
    if (config.maxChars > 0 && state.totalChars >= config.maxChars) {
      warning = `[output-policy:max-chars=${state.totalChars}]\nModel output stopped after ${state.totalChars.toLocaleString()} streamed characters. Retry or switch model.`;
    }
    state.pending += delta.replace(/\r\n?/g, "\n");
    let newline = state.pending.indexOf("\n");
    while (warning === undefined && newline >= 0) {
      const line = state.pending.slice(0, newline);
      state.pending = state.pending.slice(newline + 1);
      newline = state.pending.indexOf("\n");
      if (state.pendingTruncated || line.length > MAX_PENDING_CHARS) {
        state.pendingTruncated = false;
        state.lastBlock = undefined;
        state.repeats = 0;
        state.repeatedChars = 0;
        continue;
      }
      const block = normalize(line);
      if (syntaxOnly(line)) continue;
      if (block.length < config.minBlockChars) {
        state.lastBlock = undefined;
        state.repeats = 0;
        state.repeatedChars = 0;
      } else if (block === state.lastBlock) {
        state.repeats += 1;
        state.repeatedChars += block.length;
      } else {
        state.lastBlock = block;
        state.repeats = 1;
        state.repeatedChars = block.length;
      }
      if (state.repeats >= config.maxRepeats && state.repeatedChars >= config.minRepeatedChars) {
        warning = `[output-policy:repetition=${state.repeats}]\nModel output stopped after ${state.repeats} consecutive repeated blocks. Retry or switch model.`;
      }
    }
    if (state.pending.length > MAX_PENDING_CHARS) {
      state.pending = state.pending.slice(-MAX_PENDING_CHARS);
      state.pendingTruncated = true;
    }
    if (warning === undefined) return;
    state.aborted = true;
    ctx.abort();
    try {
      void Promise.resolve(ctx.ui?.notify(warning, "warning")).catch(() => {
        /* notification failures must not interrupt the abort */
      });
    } catch {
      /* abort must not depend on UI notifications */
    }
  });
}
