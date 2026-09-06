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

export interface CommandOptions {
  description: string;
  handler: (args: string | string[], ctx: CommandContext) => Promise<void> | void;
}

export interface HookAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult> | ToolCallResult): void;
  on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<ToolResultReturn> | ToolResultReturn): void;
  registerCommand(name: string, options: CommandOptions): void;
}
