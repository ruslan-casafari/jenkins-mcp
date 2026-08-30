import { formatDuration, formatTimestamp } from "./tools/helpers.js";
/** Fields worth pulling for a build; keeps responses small on busy controllers. */
export const BUILD_TREE = "number,result,building,timestamp,duration,estimatedDuration,url,displayName,description," +
    "actions[parameters[name,value],causes[shortDescription,userName]]," +
    "changeSets[items[commitId,msg,author[fullName]]]";
/** Same as BUILD_TREE minus changesets — used when listing many builds at once. */
export const BUILD_TREE_SHORT = "number,result,building,timestamp,duration,url,displayName," +
    "actions[causes[shortDescription,userName]]";
/** Short list view plus build parameters, for filtering many builds by parameter. */
export const BUILD_TREE_PARAMS = "number,result,building,timestamp,duration,url,displayName," +
    "actions[causes[shortDescription,userName],parameters[name,value]]";
/** A build that has not finished has result === null; report that as RUNNING rather than "unknown". */
export function summarizeBuild(raw) {
    if (!raw)
        return null;
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
            ? Object.fromEntries(parameters.filter((p) => p.name).map((p) => [p.name, p.value]))
            : undefined,
        changes: changes.length ? changes : undefined,
    };
}
export async function fetchBuild(client, path, ref, tree = BUILD_TREE) {
    const raw = await client.getJson(`${path}/${ref}/api/json`, { tree });
    const summary = summarizeBuild(raw);
    if (!summary)
        throw new Error(`Build ${ref} returned no data.`);
    return summary;
}
export const JOB_STATUS_TREE = `name,fullName,url,description,color,inQueue,lastBuild[${BUILD_TREE}],` +
    "lastSuccessfulBuild[number,timestamp,url],lastFailedBuild[number,timestamp,url]";
export function jobsTree(depth) {
    const fields = "_class,name,fullName,url,color";
    let tree = `jobs[${fields}]`;
    for (let level = 1; level < depth; level++) {
        tree = `jobs[${fields},${tree}]`;
    }
    return tree;
}
/** Flattens the nested folder tree Jenkins returns into "folder/sub/job" entries. */
export function flattenJobs(jobs, prefix = "") {
    const result = [];
    for (const job of jobs ?? []) {
        const name = job.name ?? "";
        const fullName = job.fullName ?? (prefix ? `${prefix}/${name}` : name);
        const isFolder = Array.isArray(job.jobs) || /Folder|MultiBranch|OrganizationFolder/i.test(job._class ?? "");
        result.push({ fullName, url: job.url, color: job.color, isFolder });
        if (job.jobs?.length)
            result.push(...flattenJobs(job.jobs, fullName));
    }
    return result;
}
