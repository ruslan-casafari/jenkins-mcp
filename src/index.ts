#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HELP, loadConfig } from "./config.js";
import { JenkinsClient } from "./client.js";
import { registerTools } from "./tools/index.js";

function version(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return (JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const config = loadConfig(argv);
  if (config.insecureTls) {
    // Opt-in only: internal controllers often sit behind a self-signed certificate.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  if (!config.token) {
    // stderr, never stdout — stdout carries the MCP protocol.
    console.error("jenkins-mcp: no API token configured; only anonymously readable items will be visible.");
  }

  const server = new McpServer(
    { name: "jenkins-mcp", version: version() },
    {
      instructions:
        "Read-only access to a Jenkins controller. Projects and their environments (dev/staging/prod) are configured locally: " +
        "call jenkins_list_projects to see them, jenkins_project_status for the current state of each environment, " +
        "jenkins_list_builds for history, and jenkins_diagnose_build or jenkins_get_build_log when a build failed. " +
        "This server cannot trigger, stop or modify anything.",
    },
  );

  registerTools(server, new JenkinsClient(config), config);

  await server.connect(new StdioServerTransport());
  console.error(
    `jenkins-mcp ${version()} ready — ${config.url}, ${config.projects.length} project(s)` +
      `${config.configPath ? ` from ${config.configPath}` : ""}`,
  );
}

main().catch((error: unknown) => {
  console.error(`jenkins-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
