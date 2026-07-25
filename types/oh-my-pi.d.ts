declare module "@oh-my-pi/pi-coding-agent/extensibility/hooks" {
  interface ToolCallEvent {
    toolName: string;
    input: unknown;
  }

  type ToolCallResult = { block: true; reason: string } | undefined;

  export interface HookAPI {
    on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult>): void;
  }
}
