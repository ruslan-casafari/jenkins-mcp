import type { Config, Project, ProjectEnvironment } from "../config.js";
import { JenkinsError } from "../client.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Accepts a job in any of the shapes a user is likely to paste:
 *   "my-job", "folder/my-job", "job/folder/job/my-job",
 *   "https://jenkins.example.com/job/folder/job/my-job/"
 * and returns the URL path fragment "job/folder/job/my-job".
 */
export function jobPath(job: string): string {
  let raw = job.trim();
  if (!raw) throw new Error("Job path is empty.");

  let isUrlForm = false;
  if (/^https?:\/\//i.test(raw)) {
    raw = new URL(raw).pathname;
    isUrlForm = true;
  }

  const segments = raw.split("/").filter(Boolean).map(decodeSegment);
  const names = segments[0] === "job" || isUrlForm ? parseUrlForm(segments) : dropViews(segments);

  if (!names.length) {
    throw new Error(`Cannot read a job path out of "${job}".`);
  }
  return names.map((name) => `job/${encodeURIComponent(name)}`).join("/");
}

/**
 * Reads the job names out of a Jenkins URL path such as
 *   job/pycore/view/change-requests/job/PR-2829/123/console
 * Names follow a "job" marker; "view/<name>" is a UI filter and carries no job,
 * and anything after the last marker pair (a build number, "api", "console") is dropped.
 * A context path before the first "job" — /jenkins/job/... — is skipped too.
 */
function parseUrlForm(segments: string[]): string[] {
  const names: string[] = [];
  let index = segments.indexOf("job");
  if (index === -1) return dropViews(segments);

  for (; index < segments.length; index++) {
    const marker = segments[index];
    if (marker === "job") {
      const name = segments[index + 1];
      if (name === undefined) break;
      names.push(name);
      index++;
    } else if (marker === "view") {
      index++;
    } else {
      break;
    }
  }
  return names;
}

/** Plain "folder/sub/job" form, tolerating a pasted "folder/view/some-view/job-name". */
function dropViews(segments: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] === "view" && segments[index + 1] !== undefined) {
      index++;
      continue;
    }
    names.push(segments[index]!);
  }
  return names;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const BUILD_ALIASES = new Set([
  "lastBuild",
  "lastCompletedBuild",
  "lastStableBuild",
  "lastSuccessfulBuild",
  "lastFailedBuild",
  "lastUnstableBuild",
  "lastUnsuccessfulBuild",
]);

/** Guards against path injection: only a build number or a known Jenkins alias reaches the URL. */
export function buildRef(build: string | number | undefined): string {
  if (build === undefined || build === null || build === "") return "lastBuild";
  const value = String(build).trim();
  if (/^\d+$/.test(value)) return value;
  if (BUILD_ALIASES.has(value)) return value;
  throw new Error(
    `Invalid build reference "${value}". Use a build number or one of: ${[...BUILD_ALIASES].join(", ")}.`,
  );
}

export interface Target {
  /** URL fragment, e.g. "job/platform/job/web". */
  path: string;
  /** Human label used in output, e.g. "web/prod" or the raw job path. */
  label: string;
  project?: Project;
  environment?: ProjectEnvironment;
}

export interface TargetArgs {
  project?: string;
  environment?: string;
  job?: string;
  branch?: string;
}

function findProject(config: Config, name: string): Project | undefined {
  const wanted = name.trim().toLowerCase();
  return config.projects.find((project) => project.name.toLowerCase() === wanted);
}

function knownProjects(config: Config): string {
  if (!config.projects.length) {
    return `No projects are configured${config.configPath ? ` in ${config.configPath}` : ""}. Pass "job" with a full Jenkins job path instead.`;
  }
  return `Known projects: ${config.projects.map((p) => p.name).join(", ")}.`;
}

/**
 * Resolves a tool's target from a configured project/environment pair, a branch
 * or pull request of the project's multibranch folder, or a raw job path.
 * "web/prod" in `project` is accepted as a shorthand for project + environment.
 */
export function resolveTarget(config: Config, args: TargetArgs): Target {
  if (args.job?.trim()) {
    const job = args.job.trim();
    return { path: jobPath(job), label: job };
  }

  let projectName = args.project?.trim();
  let envName = args.environment?.trim();
  const branchName = args.branch?.trim();
  if (!projectName) {
    throw new Error(`Specify "project" (and usually "environment"), or a raw "job" path. ${knownProjects(config)}`);
  }
  if (!envName && !branchName && projectName.includes("/")) {
    const slash = projectName.indexOf("/");
    envName = projectName.slice(slash + 1);
    projectName = projectName.slice(0, slash);
  }

  const project = findProject(config, projectName);
  if (!project) {
    throw new Error(`Unknown project "${projectName}". ${knownProjects(config)}`);
  }

  if (branchName) return branchTarget(project, branchName);

  const environment = pickEnvironment(project, envName);
  if (environment) {
    return {
      path: jobPath(environment.job),
      label: `${project.name}/${environment.name}`,
      project,
      environment,
    };
  }

  // Not a configured environment, but the project has per-branch jobs: treat it as one.
  return branchTarget(project, envName!);
}

/**
 * A branch or pull request of a multibranch project. The branch name is one job
 * name, so "feature/login" becomes a single %2F-encoded path segment.
 */
function branchTarget(project: Project, rawBranch: string): Target {
  if (!project.multibranch) {
    const available = project.environments.map((env) => env.name).join(", ");
    throw new Error(
      `Project "${project.name}" has no "multibranch" folder configured, so branches and pull requests cannot be resolved. ` +
        `Configured environments: ${available || "(none)"}.`,
    );
  }

  const branch = normalizeBranch(rawBranch, project.prPrefix);
  return {
    path: `${jobPath(project.multibranch)}/job/${encodeURIComponent(branch)}`,
    label: `${project.name}/${branch}`,
    project,
    environment: { name: branch, job: `${project.multibranch}/${branch}` },
  };
}

/** Accepts 1234, #1234, pr-1234 or PR-1234 for a pull request; any other value is a branch name. */
export function normalizeBranch(branch: string, prPrefix = "PR-"): string {
  const value = branch.trim();
  const numeric = /^#?(\d+)$/.exec(value);
  if (numeric) return `${prPrefix}${numeric[1]}`;
  const prefixed = /^(?:pr|mr)[-_ ]?(\d+)$/i.exec(value);
  if (prefixed) return `${prPrefix}${prefixed[1]}`;
  return value;
}

/** Returns undefined when the name is not a configured environment — the caller may treat it as a branch. */
function pickEnvironment(project: Project, envName?: string): ProjectEnvironment | undefined {
  const available = project.environments.map((env) => env.name).join(", ");
  if (!envName) {
    if (project.environments.length === 1) return project.environments[0]!;
    if (!project.environments.length) {
      throw new Error(
        `Project "${project.name}" has only per-branch jobs — pass "branch" with a branch name or pull request number.`,
      );
    }
    throw new Error(
      `Project "${project.name}" has several environments — specify one of: ${available}` +
        `${project.multibranch ? ', or pass "branch" for a pull request environment' : ""}.`,
    );
  }

  const wanted = envName.toLowerCase();
  const match = project.environments.find((env) => env.name.toLowerCase() === wanted);
  if (match) return match;
  if (project.multibranch) return undefined;

  throw new Error(`Project "${project.name}" has no environment "${envName}". Available: ${available}.`);
}

export function formatTimestamp(ms: number | undefined | null): string | undefined {
  if (!ms) return undefined;
  return new Date(ms).toISOString();
}

export function formatDuration(ms: number | undefined | null): string | undefined {
  if (!ms || ms < 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... truncated ${omitted} characters — narrow the request or raise JENKINS_MAX_OUTPUT_CHARS]`;
}

/** Keeps the last N lines, which is where a failing build explains itself. */
export function tailLines(text: string, lines: number): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return `[... ${all.length - lines} earlier lines omitted]\n${all.slice(-lines).join("\n")}`;
}

export function ok(config: Config, data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: truncate(text, config.maxOutputChars) }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Turns thrown errors into tool errors so a bad job name never kills the server. */
export function guard<Args>(
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof JenkinsError) {
        return fail(error.body ? `${error.message}\n\n${error.body}` : error.message);
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}
