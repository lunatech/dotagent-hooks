import type { HookAPI } from "../lib/hook-api.ts";
import { readOutputPolicyConfig } from "../output-policy-config.ts";

const MAX_PENDING_CHARS = 16_384;

interface State {
  totalChars: number;
  pending: string;
  lastBlock?: string;
  repeats: number;
  repeatedChars: number;
  aborted: boolean;
}
function fresh(): State {
  return { totalChars: 0, pending: "", repeats: 0, repeatedChars: 0, aborted: false };
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

export default function outputPolicy(pi: HookAPI): void {
  const config = readOutputPolicyConfig();
  let state = fresh();
  const reset = () => {
    state = fresh();
  };
  pi.on("message_start", reset);
  pi.on("turn_start", reset);
  pi.on("agent_start", reset);
  pi.on("agent_end", reset);
  pi.on("message_update", (event, ctx) => {
    if (state.aborted) return;
    const delta = deltaOf(event);
    if (delta === undefined) return;
    state.totalChars += delta.length;
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
    if (state.pending.length > MAX_PENDING_CHARS) state.pending = state.pending.slice(-MAX_PENDING_CHARS);
    if (warning === undefined) return;
    state.aborted = true;
    ctx.abort();
    try {
      ctx.ui?.notify(warning, "warning");
    } catch {
      /* abort must not depend on UI notifications */
    }
  });
}
