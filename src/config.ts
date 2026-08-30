import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectEnvironment {
  /** Environment key as written in the config, e.g. "dev", "staging", "prod". */
  name: string;
  /** Full Jenkins job path, e.g. "casafari/web/deploy-prod". */
  job: string;
}

export interface Project {
  name: string;
  description?: string;
  environments: ProjectEnvironment[];
  /**
   * Multibranch/organization folder holding one job per branch and pull request,
   * e.g. "platform/web" with children "main", "PR-1234". Environments that are
   * not listed above are resolved as branch jobs inside this folder.
   */
  multibranch?: string;
  /** Prefix Jenkins gives pull request jobs — "PR-" for GitHub, "MR-" for some GitLab setups. */
  prPrefix?: string;
}

export interface Config {
  /** Base URL of the Jenkins controller, without trailing slash. */
  url: string;
  user?: string;
  token?: string;
  timeoutMs: number;
  /** Hard cap on characters returned by a single tool call. */
  maxOutputChars: number;
  /** Accept self-signed certificates (common on internal controllers). */
  insecureTls: boolean;
  projects: Project[];
  /** Config file the projects were loaded from, for diagnostics. */
  configPath?: string;
}

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

interface RawConfigFile {
  url?: string;
  user?: string;
  token?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  insecureTls?: boolean;
  projects?: Record<string, unknown>;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function candidatePaths(): string[] {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(process.cwd(), "jenkins-mcp.json"),
    join(process.cwd(), ".jenkins-mcp.json"),
    join(xdg, "jenkins-mcp", "config.json"),
    join(home, ".jenkins-mcp.json"),
  ];
}

function readConfigFile(explicitPath?: string): { file: RawConfigFile; path?: string } {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Config file not found: ${explicitPath}`);
    }
    return { file: parseConfigFile(explicitPath), path: explicitPath };
  }
  for (const path of candidatePaths()) {
    if (existsSync(path)) return { file: parseConfigFile(path), path };
  }
  return { file: {} };
}

function parseConfigFile(path: string): RawConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as RawConfigFile;
  } catch (error) {
    throw new Error(`Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Accepts three shapes per project, so short entries stay short:
 *   "web": "platform/web/deploy"                              -> one unnamed environment
 *   "web": { "dev": "...", "prod": "..." }                    -> environment map
 *   "web": { "description": "...", "environments": { ... } }  -> full form
 */
function normalizeProjects(raw: Record<string, unknown> | undefined, source: string): Project[] {
  if (!raw) return [];
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

    const entry = value as Record<string, unknown>;
    const description = typeof entry.description === "string" ? entry.description : undefined;
    const multibranch = firstString(entry.multibranch, entry.pullRequests, entry.branches);
    const prPrefix = firstString(entry.prPrefix);
    const envSource = (entry.environments ?? entry.jobs ?? stripMeta(entry)) as Record<string, unknown>;

    const environments = Object.entries(envSource).map(([envName, job]) => {
      if (typeof job !== "string" || !job.trim()) {
        throw new Error(`${source}: project "${name}", environment "${envName}" must be a job path string.`);
      }
      return { name: envName, job: job.trim() };
    });

    if (!environments.length && !multibranch) {
      throw new Error(
        `${source}: project "${name}" has no environments and no "multibranch" folder.`,
      );
    }
    return { name, description, environments, multibranch, prPrefix };
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Drops the reserved keys so the rest of the object can be read as an environment map. */
function stripMeta(entry: Record<string, unknown>): Record<string, unknown> {
  const {
    description: _description,
    multibranch: _multibranch,
    pullRequests: _pullRequests,
    branches: _branches,
    prPrefix: _prPrefix,
    ...rest
  } = entry;
  return rest;
}

/** CLI flags win over environment variables, which win over the config file. */
export function loadConfig(argv: string[]): Config {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }

  const str = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };

  const { file, path } = readConfigFile(str("config") ?? process.env.JENKINS_MCP_CONFIG);

  const url = (str("url") ?? process.env.JENKINS_URL ?? file.url ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error(
      "Jenkins URL is not set. Pass --url https://jenkins.example.com, set JENKINS_URL, or add \"url\" to the config file.",
    );
  }

  const projectsFromEnv = process.env.JENKINS_PROJECTS
    ? (JSON.parse(process.env.JENKINS_PROJECTS) as Record<string, unknown>)
    : undefined;

  return {
    url,
    user: str("user") ?? process.env.JENKINS_USER ?? file.user,
    token:
      str("token") ??
      process.env.JENKINS_TOKEN ??
      process.env.JENKINS_API_TOKEN ??
      file.token,
    timeoutMs: Number(str("timeout")) || envNumber("JENKINS_TIMEOUT_MS", file.timeoutMs ?? 30_000),
    maxOutputChars:
      Number(str("max-output")) || envNumber("JENKINS_MAX_OUTPUT_CHARS", file.maxOutputChars ?? 80_000),
    insecureTls: flags.has("insecure") || envFlag("JENKINS_INSECURE_TLS") || file.insecureTls === true,
    projects: projectsFromEnv
      ? normalizeProjects(projectsFromEnv, "JENKINS_PROJECTS")
      : normalizeProjects(file.projects, path ?? "config"),
    configPath: path,
  };
}
