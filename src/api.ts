import type { JenkinsClient } from "./client.js";
import { formatDuration, formatTimestamp } from "./tools/helpers.js";

interface RawAction {
  _class?: string;
  parameters?: Array<{ name?: string; value?: unknown }>;
  causes?: Array<{ shortDescription?: string; userName?: string }>;
}

export interface RawBuild {
  number?: number;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
  estimatedDuration?: number;
  url?: string;
  displayName?: string;
  description?: string | null;
  actions?: RawAction[];
  changeSets?: Array<{
    items?: Array<{ commitId?: string; msg?: string; author?: { fullName?: string } }>;
  }>;
}

/** Fields worth pulling for a build; keeps responses small on busy controllers. */
export const BUILD_TREE =
  "number,result,building,timestamp,duration,estimatedDuration,url,displayName,description," +
  "actions[parameters[name,value],causes[shortDescription,userName]]," +
  "changeSets[items[commitId,msg,author[fullName]]]";

/** Same as BUILD_TREE minus changesets — used when listing many builds at once. */
export const BUILD_TREE_SHORT =
  "number,result,building,timestamp,duration,url,displayName," +
  "actions[causes[shortDescription,userName]]";

/** Short list view plus build parameters, for filtering many builds by parameter. */
export const BUILD_TREE_PARAMS =
  "number,result,building,timestamp,duration,url,displayName," +
  "actions[causes[shortDescription,userName],parameters[name,value]]";

export interface BuildSummary {
  number?: number;
  status: string;
  building?: boolean;
  startedAt?: string;
  duration?: string;
  url?: string;
  displayName?: string;
  description?: string;
  triggeredBy?: string;
  parameters?: Record<string, unknown>;
  changes?: string[];
}

/** A build that has not finished has result === null; report that as RUNNING rather than "unknown". */
export function summarizeBuild(raw: RawBuild | null | undefined): BuildSummary | null {
  if (!raw) return null;

  const actions = raw.actions ?? [];
  const parameters = actions.find((action) => action.parameters)?.parameters;
  const cause = actions.find((action) => action.causes)?.causes?.[0];
  const changes = (raw.changeSets ?? [])
    .flatMap((set) => set.items ?? [])
    .slice(0, 20)
    .map((item) => {
      const sha = item.commitId?.slice(0, 8) ?? "";
      const author = item.author?.fullName ? ` (${item.author.fullName})` : "";
      return `${sha} ${item.msg ?? ""}${author}`.trim();
    });

  return {
    number: raw.number,
    status: raw.building ? "RUNNING" : (raw.result ?? "UNKNOWN"),
    building: raw.building || undefined,
    startedAt: formatTimestamp(raw.timestamp),
    duration: raw.building
      ? `${formatDuration(Date.now() - (raw.timestamp ?? Date.now())) ?? "0s"} so far, estimated ${formatDuration(raw.estimatedDuration) ?? "unknown"}`
      : formatDuration(raw.duration),
    url: raw.url,
    displayName: raw.displayName,
    description: raw.description ?? undefined,
    triggeredBy: cause?.userName ?? cause?.shortDescription,
    parameters: parameters?.length
      ? Object.fromEntries(parameters.filter((p) => p.name).map((p) => [p.name!, p.value]))
      : undefined,
    changes: changes.length ? changes : undefined,
  };
}

export async function fetchBuild(
  client: JenkinsClient,
  path: string,
  ref: string,
  tree = BUILD_TREE,
): Promise<BuildSummary> {
  const raw = await client.getJson<RawBuild>(`${path}/${ref}/api/json`, { tree });
  const summary = summarizeBuild(raw);
  if (!summary) throw new Error(`Build ${ref} returned no data.`);
  return summary;
}

export interface RawJobStatus {
  name?: string;
  fullName?: string;
  url?: string;
  description?: string;
  color?: string;
  inQueue?: boolean;
  lastBuild?: RawBuild;
  lastSuccessfulBuild?: RawBuild;
  lastFailedBuild?: RawBuild;
}

export const JOB_STATUS_TREE =
  `name,fullName,url,description,color,inQueue,lastBuild[${BUILD_TREE}],` +
  "lastSuccessfulBuild[number,timestamp,url],lastFailedBuild[number,timestamp,url]";

export interface RawJob {
  _class?: string;
  name?: string;
  fullName?: string;
  url?: string;
  color?: string;
  jobs?: RawJob[];
  /** Present only when the caller asks for it in the tree expression. */
  lastBuild?: RawBuild;
}

export function jobsTree(depth: number): string {
  const fields = "_class,name,fullName,url,color";
  let tree = `jobs[${fields}]`;
  for (let level = 1; level < depth; level++) {
    tree = `jobs[${fields},${tree}]`;
  }
  return tree;
}

export interface FlatJob {
  fullName: string;
  url?: string;
  color?: string;
  isFolder: boolean;
}

/** Flattens the nested folder tree Jenkins returns into "folder/sub/job" entries. */
export function flattenJobs(jobs: RawJob[] | undefined, prefix = ""): FlatJob[] {
  const result: FlatJob[] = [];
  for (const job of jobs ?? []) {
    const name = job.name ?? "";
    const fullName = job.fullName ?? (prefix ? `${prefix}/${name}` : name);
    const isFolder = Array.isArray(job.jobs) || /Folder|MultiBranch|OrganizationFolder/i.test(job._class ?? "");
    result.push({ fullName, url: job.url, color: job.color, isFolder });
    if (job.jobs?.length) result.push(...flattenJobs(job.jobs, fullName));
  }
  return result;
}
