declare module "@oh-my-pi/pi-coding-agent/extensibility/hooks" {
  interface ToolCallEvent {
    toolName: string;
    input: unknown;
  }

  type ToolCallResult = { block: true; reason: string } | undefined;

  interface ToolResultContent {
    type: string;
    text?: string;
  }

  interface ToolResultEvent {
    toolName: string;
    input?: unknown;
    content: ToolResultContent[];
  }

  type ToolResultReturn = { content: ToolResultContent[] } | undefined;

  interface CommandContext {
    hasUI: boolean;
    ui: {
      notify(message: string): Promise<void>;
    };
  }

  interface CommandOptions {
    description: string;
    handler: (args: string | string[], ctx: CommandContext) => Promise<void> | void;
  }

  export interface HookAPI {
    on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult> | ToolCallResult): void;
    on(event: "tool_result", handler: (event: ToolResultEvent) => ToolResultReturn): void;
    registerCommand(name: string, options: CommandOptions): void;
  }
}
