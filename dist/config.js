import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const HELP = `jenkins-mcp — read-only MCP server for Jenkins (stdio transport)

Usage:
  jenkins-mcp [options]

Options:
  --url <url>            Jenkins base URL          (env JENKINS_URL)
  --user <name>          Jenkins user id           (env JENKINS_USER)
  --token <token>        API token                 (env JENKINS_TOKEN)
  --config <path>        Project registry file     (env JENKINS_MCP_CONFIG)
  --insecure             Allow self-signed TLS     (env JENKINS_INSECURE_TLS=1)
  --timeout <ms>         Request timeout, default 30000
  --max-output <chars>   Output cap, default 80000
  -h, --help             Show this help
  -v, --version          Show version

Config file (JSON), searched in this order when --config is not given:
  ./jenkins-mcp.json, ./.jenkins-mcp.json,
  ~/.config/jenkins-mcp/config.json, ~/.jenkins-mcp.json

  {
    "url": "https://jenkins.example.com",
    "user": "me",
    "projects": {
      "web": {
        "description": "Main website",
        "environments": {
          "dev":  "platform/web/deploy-dev",
          "prod": "platform/web/deploy-prod"
        }
      },
      "api": { "dev": "platform/api/dev", "prod": "platform/api/prod" },
      "checkout": {
        "environments": { "prod": "platform/checkout/deploy-prod" },
        "multibranch": "platform/checkout-pipeline"
      }
    }
  }

  "multibranch" points at a folder with one job per branch and pull request;
  environments not listed explicitly are resolved there, so "checkout" + "PR-1234"
  reaches platform/checkout-pipeline/PR-1234.
`;
function envFlag(name) {
    const raw = process.env[name];
    return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}
function envNumber(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function candidatePaths() {
    const home = homedir();
    const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    return [
        join(process.cwd(), "jenkins-mcp.json"),
        join(process.cwd(), ".jenkins-mcp.json"),
        join(xdg, "jenkins-mcp", "config.json"),
        join(home, ".jenkins-mcp.json"),
    ];
}
function readConfigFile(explicitPath) {
    if (explicitPath) {
        if (!existsSync(explicitPath)) {
            throw new Error(`Config file not found: ${explicitPath}`);
        }
        return { file: parseConfigFile(explicitPath), path: explicitPath };
    }
    for (const path of candidatePaths()) {
        if (existsSync(path))
            return { file: parseConfigFile(path), path };
    }
    return { file: {} };
}
function parseConfigFile(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        throw new Error(`Cannot read config file ${path}: ${error.message}`);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Config file ${path} is not valid JSON: ${error.message}`);
    }
}
/**
 * Accepts three shapes per project, so short entries stay short:
 *   "web": "platform/web/deploy"                              -> one unnamed environment
 *   "web": { "dev": "...", "prod": "..." }                    -> environment map
 *   "web": { "description": "...", "environments": { ... } }  -> full form
 */
function normalizeProjects(raw, source) {
    if (!raw)
        return [];
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${source}: "projects" must be an object keyed by project name.`);
    }
    return Object.entries(raw).map(([name, value]) => {
        if (typeof value === "string") {
            return { name, environments: [{ name: "default", job: value }] };
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${source}: project "${name}" must be a job path or an object.`);
        }
        const entry = value;
        const description = typeof entry.description === "string" ? entry.description : undefined;
        const multibranch = firstString(entry.multibranch, entry.pullRequests, entry.branches);
        const prPrefix = firstString(entry.prPrefix);
        const envSource = (entry.environments ?? entry.jobs ?? stripMeta(entry));
        const environments = Object.entries(envSource).map(([envName, job]) => {
            if (typeof job !== "string" || !job.trim()) {
                throw new Error(`${source}: project "${name}", environment "${envName}" must be a job path string.`);
            }
            return { name: envName, job: job.trim() };
        });
        if (!environments.length && !multibranch) {
            throw new Error(`${source}: project "${name}" has no environments and no "multibranch" folder.`);
        }
        return { name, description, environments, multibranch, prPrefix };
    });
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
/** Drops the reserved keys so the rest of the object can be read as an environment map. */
function stripMeta(entry) {
    const { description: _description, multibranch: _multibranch, pullRequests: _pullRequests, branches: _branches, prPrefix: _prPrefix, ...rest } = entry;
    return rest;
}
/** CLI flags win over environment variables, which win over the config file. */
export function loadConfig(argv) {
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--"))
            continue;
        const eq = arg.indexOf("=");
        if (eq !== -1) {
            flags.set(arg.slice(2, eq), arg.slice(eq + 1));
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
            flags.set(arg.slice(2), next);
            i++;
        }
        else {
            flags.set(arg.slice(2), true);
        }
    }
    const str = (name) => {
        const value = flags.get(name);
        return typeof value === "string" ? value : undefined;
    };
    const { file, path } = readConfigFile(str("config") ?? process.env.JENKINS_MCP_CONFIG);
    const url = (str("url") ?? process.env.JENKINS_URL ?? file.url ?? "").trim().replace(/\/+$/, "");
    if (!url) {
        throw new Error("Jenkins URL is not set. Pass --url https://jenkins.example.com, set JENKINS_URL, or add \"url\" to the config file.");
    }
    const projectsFromEnv = process.env.JENKINS_PROJECTS
        ? JSON.parse(process.env.JENKINS_PROJECTS)
        : undefined;
    return {
        url,
        user: str("user") ?? process.env.JENKINS_USER ?? file.user,
        token: str("token") ??
            process.env.JENKINS_TOKEN ??
            process.env.JENKINS_API_TOKEN ??
            file.token,
        timeoutMs: Number(str("timeout")) || envNumber("JENKINS_TIMEOUT_MS", file.timeoutMs ?? 30_000),
        maxOutputChars: Number(str("max-output")) || envNumber("JENKINS_MAX_OUTPUT_CHARS", file.maxOutputChars ?? 80_000),
        insecureTls: flags.has("insecure") || envFlag("JENKINS_INSECURE_TLS") || file.insecureTls === true,
        projects: projectsFromEnv
            ? normalizeProjects(projectsFromEnv, "JENKINS_PROJECTS")
            : normalizeProjects(file.projects, path ?? "config"),
        configPath: path,
    };
}
