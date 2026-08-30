import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config, Project } from "../config.js";
import type { JenkinsClient } from "../client.js";
import { BUILD_TREE_SHORT, JOB_STATUS_TREE, flattenJobs, jobsTree, summarizeBuild } from "../api.js";
import type { RawJob, RawJobStatus } from "../api.js";
import { formatTimestamp, guard, jobPath, ok } from "./helpers.js";

export function registerProjectTools(server: McpServer, client: JenkinsClient, config: Config): void {
  server.registerTool(
    "jenkins_list_projects",
    {
      title: "List configured projects",
      description:
        "List the projects and environments configured for this Jenkins server, with the Jenkins job path behind each one. " +
        "Call this first to learn which project/environment names the other tools accept. Reads local config only, no Jenkins request.",
      inputSchema: {},
    },
    guard(async () =>
      ok(config, {
        jenkinsUrl: config.url,
        configFile: config.configPath ?? "(none — projects can also come from JENKINS_PROJECTS)",
        projects: config.projects.map((project) => ({
          project: project.name,
          description: project.description,
          environments: Object.fromEntries(project.environments.map((env) => [env.name, env.job])),
          branchEnvironments: project.multibranch
            ? `${project.multibranch} — per-branch and per-PR jobs live here; list them with jenkins_list_branches, then pass "branch" to the build tools`
            : undefined,
        })),
        note: config.projects.length
          ? undefined
          : "No projects configured yet. Use jenkins_search_jobs to find job paths, then add them to the config file.",
      }),
    ),
  );

  server.registerTool(
    "jenkins_project_status",
    {
      title: "Build status per environment",
      description:
        "Current build status of a project across its environments: last build result, whether one is running now, when it ran, " +
        "who triggered it, its parameters and the commits it carried, plus the last successful and last failed build numbers. " +
        "Omit 'project' to get every configured project at once.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project name from jenkins_list_projects. Omit to report on all configured projects."),
        environment: z
          .string()
          .optional()
          .describe("Environment name, e.g. 'prod'. Omit to report on all environments of the project."),
      },
    },
    guard(async ({ project, environment }) => {
      // Accept the "web/prod" shorthand the build tools also take.
      const wantedEnv =
        environment ?? (project?.includes("/") ? project.slice(project.indexOf("/") + 1) : undefined);
      const projects = selectProjects(config, project);
      const results = await Promise.all(
        projects.map(async (entry) => ({
          project: entry.name,
          description: entry.description,
          environments: await Promise.all(
            entry.environments
              .filter((env) => !wantedEnv || env.name.toLowerCase() === wantedEnv.toLowerCase())
              .map(async (env) => {
                try {
                  const raw = await client.getJson<RawJobStatus>(`${jobPath(env.job)}/api/json`, {
                    tree: JOB_STATUS_TREE,
                  });
                  return {
                    environment: env.name,
                    job: env.job,
                    url: raw.url,
                    queued: raw.inQueue || undefined,
                    lastBuild: summarizeBuild(raw.lastBuild),
                    lastSuccessfulBuild: raw.lastSuccessfulBuild?.number
                      ? {
                          number: raw.lastSuccessfulBuild.number,
                          at: formatTimestamp(raw.lastSuccessfulBuild.timestamp),
                        }
                      : undefined,
                    lastFailedBuild: raw.lastFailedBuild?.number
                      ? {
                          number: raw.lastFailedBuild.number,
                          at: formatTimestamp(raw.lastFailedBuild.timestamp),
                        }
                      : undefined,
                  };
                } catch (error) {
                  return {
                    environment: env.name,
                    job: env.job,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }),
          ),
        })),
      );

      if (wantedEnv && results.every((entry) => entry.environments.length === 0)) {
        throw new Error(
          `No environment "${wantedEnv}" in ${projects.map((p) => p.name).join(", ")}. ` +
            "Call jenkins_list_projects to see the available environments.",
        );
      }
      return ok(config, results);
    }),
  );

  server.registerTool(
    "jenkins_list_branches",
    {
      title: "Branch and pull request environments",
      description:
        "List the live branch and pull request environments of a project — the jobs inside its multibranch folder — " +
        "with the result of the last build of each. Use it to find which PR environments exist before asking about a specific one.",
      inputSchema: {
        project: z.string().describe("Project name that has a multibranch folder configured."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter, e.g. '1234' or 'feature'. Omit to list everything."),
        onlyPullRequests: z.boolean().optional().describe("Keep only pull request jobs. Default false."),
        limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 40."),
      },
    },
    guard(async ({ project, query, onlyPullRequests, limit }) => {
      const [entry] = selectProjects(config, project);
      if (!entry?.multibranch) {
        throw new Error(
          `Project "${project}" has no "multibranch" folder configured. ` +
            'Add e.g. "multibranch": "platform/web-pipeline" to it, so branch and PR jobs can be resolved.',
        );
      }

      const raw = await client.getJson<{ jobs?: RawJob[] }>(`${jobPath(entry.multibranch)}/api/json`, {
        tree: `jobs[name,url,color,lastBuild[${BUILD_TREE_SHORT}]]`,
      });

      const prefix = (entry.prPrefix ?? "PR-").toLowerCase();
      const needle = query?.trim().toLowerCase();
      const all = raw.jobs ?? [];
      const matches = all
        .filter((child) => !onlyPullRequests || (child.name ?? "").toLowerCase().startsWith(prefix))
        .filter((child) => !needle || (child.name ?? "").toLowerCase().includes(needle));

      const max = limit ?? 40;
      return ok(config, {
        project: entry.name,
        multibranch: entry.multibranch,
        found: matches.length,
        returned: Math.min(matches.length, max),
        environments: matches.slice(0, max).map((child) => ({
          branch: child.name,
          isPullRequest: (child.name ?? "").toLowerCase().startsWith(prefix) || undefined,
          url: child.url,
          lastBuild: summarizeBuild(child.lastBuild),
        })),
        hint: 'Pass any of these as "branch" to the build tools, e.g. branch: "PR-1234".',
      });
    }),
  );

  server.registerTool(
    "jenkins_search_jobs",
    {
      title: "Search Jenkins jobs",
      description:
        "Find jobs on the controller by substring match on their path. Use this to discover the full job path of a project " +
        "before adding it to the config file, or to reach a job that is not configured as a project.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against the full job path. Omit to list everything found."),
        folder: z
          .string()
          .optional()
          .describe("Restrict the search to this folder path, e.g. 'platform/web'."),
        depth: z.number().int().min(1).max(6).optional().describe("Folder levels to descend. Default 3."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum jobs to return. Default 50."),
        includeFolders: z.boolean().optional().describe("Include folders in the results. Default false."),
      },
    },
    guard(async ({ query, folder, depth, limit, includeFolders }) => {
      const base = folder?.trim() ? `${jobPath(folder)}/api/json` : "api/json";
      const raw = await client.getJson<{ jobs?: RawJob[] }>(base, { tree: jobsTree(depth ?? 3) });

      const prefix = folder?.trim().replace(/^\/+|\/+$/g, "") ?? "";
      const needle = query?.trim().toLowerCase();
      const matches = flattenJobs(raw.jobs, prefix)
        .filter((job) => includeFolders || !job.isFolder)
        .filter((job) => !needle || job.fullName.toLowerCase().includes(needle));

      const max = limit ?? 50;
      return ok(config, {
        matched: matches.length,
        returned: Math.min(matches.length, max),
        jobs: matches.slice(0, max).map((job) => ({
          job: job.fullName,
          status: describeColor(job.color),
          isFolder: job.isFolder || undefined,
          url: job.url,
        })),
      });
    }),
  );

  server.registerTool(
    "jenkins_whoami",
    {
      title: "Check Jenkins connection",
      description:
        "Verify the configured URL and credentials: returns the authenticated user and the Jenkins version. " +
        "Use this when other tools fail with 401 or 403.",
      inputSchema: {},
    },
    guard(async () => {
      const [me, version] = await Promise.all([
        client.getJson<{ id?: string; fullName?: string }>("me/api/json", { tree: "id,fullName" }),
        client.serverVersion().catch(() => null),
      ]);
      return ok(config, {
        jenkinsUrl: client.baseUrl,
        jenkinsVersion: version ?? "unknown",
        authenticatedAs: me.fullName ?? me.id ?? "anonymous",
        accessMode: "read-only (this server never issues write requests)",
        configuredProjects: config.projects.length,
      });
    }),
  );
}

function selectProjects(config: Config, name?: string): Project[] {
  if (!name?.trim()) {
    if (!config.projects.length) {
      throw new Error(
        "No projects are configured. Add them to the config file, or pass a job path to jenkins_list_builds / jenkins_get_build_log.",
      );
    }
    return config.projects;
  }
  const wanted = name.trim().toLowerCase().split("/")[0]!;
  const project = config.projects.find((entry) => entry.name.toLowerCase() === wanted);
  if (!project) {
    throw new Error(
      `Unknown project "${name}". Known projects: ${config.projects.map((p) => p.name).join(", ") || "(none)"}.`,
    );
  }
  return [project];
}

/** Jenkins encodes job state in a ball colour; "_anime" means a build is in progress. */
function describeColor(color?: string): string | undefined {
  if (!color) return undefined;
  const running = color.endsWith("_anime");
  const base = color.replace(/_anime$/, "");
  const known: Record<string, string> = {
    blue: "SUCCESS",
    green: "SUCCESS",
    yellow: "UNSTABLE",
    red: "FAILURE",
    aborted: "ABORTED",
    notbuilt: "NOT_BUILT",
    disabled: "DISABLED",
  };
  const status = known[base] ?? base.toUpperCase();
  return running ? `${status} (build running)` : status;
}
