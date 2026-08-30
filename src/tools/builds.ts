import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { JenkinsClient } from "../client.js";
import { BUILD_TREE_PARAMS, BUILD_TREE_SHORT, fetchBuild, summarizeBuild } from "../api.js";
import type { RawBuild } from "../api.js";
import { buildRef, guard, ok, resolveTarget, tailLines, truncate } from "./helpers.js";
import type { Target } from "./helpers.js";

/** Every build tool takes the same target: a configured project/environment, or a raw job path. */
const targetSchema = {
  project: z.string().optional().describe("Project name from jenkins_list_projects, e.g. 'web'. Accepts 'web/prod' shorthand."),
  environment: z.string().optional().describe("Environment name, e.g. 'dev', 'staging', 'prod'."),
  branch: z
    .string()
    .optional()
    .describe(
      "Branch or pull request of the project's multibranch folder, e.g. 'PR-1234', '1234' or 'feature/login'. " +
        "Use this for per-PR environments instead of 'environment'.",
    ),
  job: z
    .string()
    .optional()
    .describe("Raw Jenkins job path or job URL, used instead of project/environment for jobs that are not configured."),
};

const buildSchema = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe("Build number, or an alias such as 'lastBuild', 'lastFailedBuild', 'lastSuccessfulBuild'. Default 'lastBuild'.");

/** Jenkins reports the total log size even for an out-of-range offset, so this probes cheaply. */
const SIZE_PROBE_OFFSET = 2_000_000_000;
const MAX_LOG_BYTES = 4_000_000;

export function registerBuildTools(server: McpServer, client: JenkinsClient, config: Config): void {
  server.registerTool(
    "jenkins_list_builds",
    {
      title: "Recent builds",
      description:
        "Recent builds of one project environment (or raw job), newest first: number, result, when it ran, how long it took and who triggered it. " +
        "Use it to see the deploy history of an environment or to find the build number of a failure.",
      inputSchema: {
        ...targetSchema,
        limit: z.number().int().min(1).max(100).optional().describe("How many builds to return. Default 15."),
        onlyFailed: z.boolean().optional().describe("Return only builds that did not succeed. Default false."),
        parameters: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Keep only builds whose build parameters match all of these, e.g. {\"PR\": \"1234\"}. " +
              "Use this when one shared job deploys every pull request and the PR number is a parameter.",
          ),
      },
    },
    guard(async ({ project, environment, branch, job, limit, onlyFailed, parameters }) => {
      const target = resolveTarget(config, { project, environment, branch, job });
      const count = limit ?? 15;
      const filtering = onlyFailed || !!parameters;
      // Fetch a wider window when filtering, so the requested count can still be met.
      const window = filtering ? Math.min(count * 5, 100) : count;
      const raw = await client.getJson<{ builds?: RawBuild[] }>(`${target.path}/api/json`, {
        tree: `builds[${parameters ? BUILD_TREE_PARAMS : BUILD_TREE_SHORT}]{0,${window}}`,
      });

      const builds = (raw.builds ?? [])
        .map(summarizeBuild)
        .filter((build): build is NonNullable<typeof build> => build !== null)
        .filter((build) => !onlyFailed || !["SUCCESS", "RUNNING"].includes(build.status))
        .filter((build) => matchesParameters(build.parameters, parameters))
        .slice(0, count);

      return ok(config, {
        target: target.label,
        scanned: raw.builds?.length ?? 0,
        builds,
        note:
          filtering && builds.length < count
            ? `Filtered the ${raw.builds?.length ?? 0} most recent builds; raise 'limit' to scan further back.`
            : undefined,
      });
    }),
  );

  server.registerTool(
    "jenkins_get_build",
    {
      title: "Build details",
      description:
        "Details of a single build: result, timing, trigger, build parameters and the commits included. " +
        "Use it to answer 'what is deployed on prod' or 'what changed in this build'.",
      inputSchema: { ...targetSchema, build: buildSchema },
    },
    guard(async ({ project, environment, branch, job, build }) => {
      const target = resolveTarget(config, { project, environment, branch, job });
      const summary = await fetchBuild(client, target.path, buildRef(build));
      return ok(config, { target: target.label, build: summary });
    }),
  );

  server.registerTool(
    "jenkins_get_build_log",
    {
      title: "Build console log",
      description:
        "Console output of a build. Returns the tail by default, which is where a failure usually explains itself. " +
        "Use 'search' to grep the log with surrounding context, or 'start' to continue reading a running build from a byte offset.",
      inputSchema: {
        ...targetSchema,
        build: buildSchema,
        tail: z.number().int().min(1).max(5000).optional().describe("Lines to return from the end of the log. Default 200."),
        search: z
          .string()
          .optional()
          .describe("Regular expression; returns matching lines with 3 lines of context instead of the tail."),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Byte offset to read from, as returned in 'nextStart' by a previous call. Reads forward from there."),
      },
    },
    guard(async ({ project, environment, branch, job, build, tail, search, start }) => {
      const target = resolveTarget(config, { project, environment, branch, job });
      const ref = buildRef(build);
      const logPath = `${target.path}/${ref}/logText/progressiveText`;

      const size = (await client.getLogChunk(logPath, SIZE_PROBE_OFFSET)).size;
      const wantedBytes = search ? MAX_LOG_BYTES : Math.min(Math.max((tail ?? 200) * 300, 64_000), MAX_LOG_BYTES);
      const from = start ?? Math.max(0, size - wantedBytes);
      const chunk = await client.getLogChunk(logPath, from);

      const body = search
        ? grep(chunk.text, search)
        : start !== undefined
          ? chunk.text
          : tailLines(chunk.text, tail ?? 200);

      return ok(config, [
        `# ${target.label} build ${ref} — console log`,
        `log size: ${size} bytes, read from offset ${from}${chunk.more ? " (build still writing)" : ""}`,
        `nextStart: ${chunk.size}`,
        "",
        truncate(body, config.maxOutputChars - 200),
      ].join("\n"));
    }),
  );

  server.registerTool(
    "jenkins_diagnose_build",
    {
      title: "Explain a failed build",
      description:
        "One-shot triage of a failing build: result and trigger, the pipeline stage that failed with its error, the log of that stage, " +
        "failed tests, and the tail of the console log. Start here when a build broke and you need to know why.",
      inputSchema: {
        ...targetSchema,
        build: buildSchema,
        logLines: z.number().int().min(20).max(2000).optional().describe("Console log lines to include. Default 150."),
      },
    },
    guard(async ({ project, environment, branch, job, build, logLines }) => {
      const target = resolveTarget(config, { project, environment, branch, job });
      const ref = buildRef(build);

      const [summary, stages, tests, log] = await Promise.all([
        fetchBuild(client, target.path, ref),
        describeStages(client, target, ref),
        fetchTestReport(client, target, ref, 10),
        readLogTail(client, target, ref, logLines ?? 150),
      ]);

      return ok(config, {
        target: target.label,
        build: summary,
        pipeline: stages ?? "No pipeline stage data (not a Pipeline job, or the Pipeline REST plugin is unavailable).",
        tests: tests ?? "No test report attached to this build.",
        consoleLogTail: log,
      });
    }),
  );

  server.registerTool(
    "jenkins_get_test_report",
    {
      title: "Test results",
      description:
        "Test summary of a build with the failing cases and their error messages. Returns nothing when the build published no test report.",
      inputSchema: {
        ...targetSchema,
        build: buildSchema,
        maxFailures: z.number().int().min(1).max(100).optional().describe("Failing cases to include. Default 25."),
      },
    },
    guard(async ({ project, environment, branch, job, build, maxFailures }) => {
      const target = resolveTarget(config, { project, environment, branch, job });
      const ref = buildRef(build);
      const report = await fetchTestReport(client, target, ref, maxFailures ?? 25);
      return ok(config, {
        target: target.label,
        build: ref,
        tests: report ?? "No test report attached to this build.",
      });
    }),
  );
}

/** All requested parameters must match, compared as trimmed strings. */
function matchesParameters(
  actual: Record<string, unknown> | undefined,
  wanted: Record<string, string> | undefined,
): boolean {
  if (!wanted || !Object.keys(wanted).length) return true;
  return Object.entries(wanted).every(
    ([key, value]) => String(actual?.[key] ?? "").trim().toLowerCase() === value.trim().toLowerCase(),
  );
}

function grep(text: string, pattern: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid 'search' regular expression: ${(error as Error).message}`);
  }

  const lines = text.split("\n");
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length && matches < 200; i++) {
    if (!regex.test(lines[i]!)) continue;
    matches++;
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
  }
  if (!matches) return `No lines matched /${pattern}/i in the fetched portion of the log.`;

  const out: string[] = [`${matches} matching line(s) for /${pattern}/i:`, ""];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (previous !== -1 && index > previous + 1) out.push("---");
    out.push(`${index + 1}: ${lines[index]}`);
    previous = index;
  }
  return out.join("\n");
}

async function readLogTail(
  client: JenkinsClient,
  target: Target,
  ref: string,
  lines: number,
): Promise<string> {
  const logPath = `${target.path}/${ref}/logText/progressiveText`;
  const size = (await client.getLogChunk(logPath, SIZE_PROBE_OFFSET)).size;
  const from = Math.max(0, size - Math.min(Math.max(lines * 300, 64_000), MAX_LOG_BYTES));
  const chunk = await client.getLogChunk(logPath, from);
  return tailLines(chunk.text, lines);
}

interface RawStage {
  id?: string;
  name?: string;
  status?: string;
  durationMillis?: number;
  error?: { message?: string; type?: string };
}

/** Pipeline stage view; absent (404) for freestyle jobs, which is not an error. */
async function describeStages(client: JenkinsClient, target: Target, ref: string) {
  const description = await client
    .getJsonOrNull<{ status?: string; stages?: RawStage[] }>(`${target.path}/${ref}/wfapi/describe`)
    .catch(() => null);
  if (!description?.stages?.length) return null;

  const stages = description.stages.map((stage) => ({
    name: stage.name,
    status: stage.status,
    durationMs: stage.durationMillis,
    error: stage.error?.message,
  }));

  const failed = description.stages.find((stage) => /FAILED|ABORTED|UNSTABLE/i.test(stage.status ?? ""));
  const failedStageLog = failed?.id
    ? await client
        .getJsonOrNull<{ text?: string }>(`${target.path}/${ref}/execution/node/${failed.id}/wfapi/log`)
        .then((log) => (log?.text ? tailLines(log.text, 120) : undefined))
        .catch(() => undefined)
    : undefined;

  return {
    status: description.status,
    stages,
    failedStage: failed ? { name: failed.name, status: failed.status, error: failed.error?.message } : undefined,
    failedStageLog,
  };
}

interface RawTestReport {
  failCount?: number;
  skipCount?: number;
  passCount?: number;
  totalCount?: number;
  suites?: Array<{
    name?: string;
    cases?: Array<{
      className?: string;
      name?: string;
      status?: string;
      errorDetails?: string | null;
      errorStackTrace?: string | null;
    }>;
  }>;
}

async function fetchTestReport(client: JenkinsClient, target: Target, ref: string, maxFailures: number) {
  const report = await client
    .getJsonOrNull<RawTestReport>(`${target.path}/${ref}/testReport/api/json`, {
      tree: "failCount,skipCount,passCount,totalCount,suites[cases[className,name,status,errorDetails]]",
    })
    .catch(() => null);
  if (!report) return null;

  const failures = (report.suites ?? [])
    .flatMap((suite) => suite.cases ?? [])
    .filter((testCase) => /FAILED|REGRESSION|ERROR/i.test(testCase.status ?? ""))
    .slice(0, maxFailures)
    .map((testCase) => ({
      test: [testCase.className, testCase.name].filter(Boolean).join("."),
      status: testCase.status,
      error: testCase.errorDetails ? truncate(testCase.errorDetails, 1500) : undefined,
    }));

  return {
    total: report.totalCount,
    passed: report.passCount,
    failed: report.failCount,
    skipped: report.skipCount,
    failures: failures.length ? failures : undefined,
  };
}
