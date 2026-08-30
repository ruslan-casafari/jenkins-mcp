export class JenkinsError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "JenkinsError";
    }
}
/**
 * Read-only client for the Jenkins remote access API.
 *
 * Every method issues a GET — there is deliberately no way to POST from this
 * server, so it cannot trigger, stop or reconfigure anything.
 */
export class JenkinsClient {
    config;
    constructor(config) {
        this.config = config;
    }
    get baseUrl() {
        return this.config.url;
    }
    buildUrl(path, query) {
        const url = new URL(path.replace(/^\/+/, ""), `${this.config.url}/`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined)
                url.searchParams.set(key, String(value));
        }
        return url.toString();
    }
    authHeaders() {
        const { user, token } = this.config;
        if (!user || !token)
            return {};
        return { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` };
    }
    async get(path, query) {
        const url = this.buildUrl(path, query);
        try {
            return await fetch(url, {
                method: "GET",
                headers: this.authHeaders(),
                redirect: "follow",
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new JenkinsError(`Request to ${url} failed: ${reason}`);
        }
    }
    async check(response, path) {
        if (response.ok)
            return response;
        const body = (await response.text().catch(() => "")).slice(0, 2000);
        throw new JenkinsError(describeFailure(response, path), response.status, body);
    }
    async getJson(path, query) {
        const response = await this.check(await this.get(path, query), path);
        return (await response.json());
    }
    /** Returns null on 404, for endpoints that are simply absent (no test report, no pipeline). */
    async getJsonOrNull(path, query) {
        const response = await this.get(path, query);
        if (response.status === 404)
            return null;
        return (await this.check(response, path).then((r) => r.json()));
    }
    async getText(path, query) {
        const response = await this.check(await this.get(path, query), path);
        return response.text();
    }
    /** Console text plus the total log size reported by Jenkins, for progressive reads. */
    async getLogChunk(path, start) {
        const response = await this.check(await this.get(path, { start }), path);
        const text = await response.text();
        const size = Number(response.headers.get("x-text-size") ?? start + text.length);
        return { text, size, more: response.headers.get("x-more-data") === "true" };
    }
    /** Jenkins version from the controller root, used as a connectivity probe. */
    async serverVersion() {
        const response = await this.get("api/json", { tree: "mode" });
        return response.headers.get("x-jenkins");
    }
}
function describeFailure(response, path) {
    const where = `${response.status} ${response.statusText} for ${path}`;
    if (response.status === 401) {
        return `${where}. Jenkins rejected the credentials — check JENKINS_USER and JENKINS_TOKEN (an API token from /me/security, not the UI password).`;
    }
    if (response.status === 403) {
        return `${where}. Authenticated, but this user lacks Read permission on that item.`;
    }
    if (response.status === 404) {
        return (`${where}. No such job or build — check the job path, e.g. "folder/subfolder/job-name". ` +
            "Use jenkins_search_jobs to find a job, or jenkins_list_branches when looking for a branch or pull request environment " +
            "(a closed pull request loses its job).");
    }
    return where;
}
