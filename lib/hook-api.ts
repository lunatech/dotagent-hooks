export interface ToolCallEvent {
  toolName: string;
  input: unknown;
}

export type ToolCallResult = { block: true; reason: string } | undefined;

export interface ToolResultContent {
  type: string;
  text?: string;
}

export interface ToolResultEvent {
  toolName: string;
  input?: unknown;
  content: ToolResultContent[];
}

export type ToolResultReturn = { content: ToolResultContent[] } | undefined;

export interface CommandContext {
  hasUI: boolean;
  ui: {
    notify(message: string): Promise<void> | void;
  };
}

export interface MessageUpdateEvent {
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  type?: string;
  delta?: string;
}

export interface MessageUpdateContext {
  abort: () => void;
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): Promise<void> | void;
  };
}

export interface CommandOptions {
  description: string;
  handler: (args: string | string[], ctx: CommandContext) => Promise<void> | void;
}

export interface HookAPI {
  on(event: "message_start" | "turn_start" | "agent_start" | "agent_end", handler: () => void): void;
  on(event: "message_update", handler: (event: MessageUpdateEvent, ctx: MessageUpdateContext) => void): void;
  on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult> | ToolCallResult): void;
  on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<ToolResultReturn> | ToolResultReturn): void;
  registerCommand(name: string, options: CommandOptions): void;
}
