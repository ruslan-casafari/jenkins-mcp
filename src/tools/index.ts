import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { JenkinsClient } from "../client.js";
import { registerProjectTools } from "./projects.js";
import { registerBuildTools } from "./builds.js";

export function registerTools(server: McpServer, client: JenkinsClient, config: Config): void {
  registerProjectTools(server, client, config);
  registerBuildTools(server, client, config);
}
