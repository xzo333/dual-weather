declare module "openclaw/plugin-sdk/plugin-entry" {
  interface AgentTool {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: any): Promise<unknown>;
  }

  interface OpenClawPluginApi {
    registerTool(tool: AgentTool): void;
  }

  interface PluginEntryOptions {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntryOptions): PluginEntryOptions;
}
