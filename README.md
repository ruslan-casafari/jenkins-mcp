# jenkins-mcp

**Read-only** MCP server for Jenkins. It reports build status across the
environments of your projects and pulls the logs when something breaks.

The server cannot write: its HTTP client only ever issues `GET`, so no builds
are triggered, stopped or reconfigured through it.

## Install

Runs straight from the repository with `npx`, no local clone needed:

```bash
# public repository
npx -y github:ruslan-casafari/jenkins-mcp --help

# private repository (over your ssh key)
npx -y git+ssh://git@github.com/ruslan-casafari/jenkins-mcp.git --help

# pin a tag or commit
npx -y github:ruslan-casafari/jenkins-mcp#v0.1.0
```

Installing from git makes npm fetch the devDependencies and compile TypeScript
(`prepare` → `tsc`), so the first run takes a few seconds; later runs come from
the npx cache.

> After pushing new commits npx may still serve a cached version.
> Refresh with `npx --ignore-existing github:ruslan-casafari/jenkins-mcp`.
>
> If your npm config sets `ignore-scripts=true`, the build will not run on
> install — use a local clone in that case.

From a local clone:

```bash
git clone git@github.com:ruslan-casafari/jenkins-mcp.git
cd jenkins-mcp && npm install     # npm install already builds dist/
node dist/index.js --help
```

## Configuring projects

The point of the config is that you describe your projects and their
environments once, then work with short names — `web` / `prod` instead of
`platform/web/deploy-prod`.

Create a config file (`jenkins-mcp.example.json` is a starting point):

```json
{
  "url": "https://jenkins.example.com",
  "user": "your-login",
  "projects": {
    "web": {
      "description": "Main website",
      "environments": {
        "dev": "platform/web/deploy-dev",
        "staging": "platform/web/deploy-staging",
        "prod": "platform/web/deploy-prod"
      }
    },
    "api": { "dev": "platform/api/dev", "prod": "platform/api/prod" },
    "mobile": "platform/mobile/build"
  }
}
```

A project can be written in three shapes, whichever is shortest for the case:

| Shape | Use it when |
| --- | --- |
| `"mobile": "path/to/job"` | one job; the environment is named `default` |
| `"api": { "dev": "...", "prod": "..." }` | several environments, no description |
| `"web": { "description": "...", "environments": { ... } }` | full form |

A job path is the job's full path in Jenkins (`folder/subfolder/job`). A URL
copied from the browser works too and is parsed — including `/view/some-view/`
tab segments, a context path and a trailing build number. If you do not know
the exact path, ask the assistant: it will find it with `jenkins_search_jobs`.

### Pull request environments

Per-PR environments come and go on their own, so they cannot be listed in the
config. Point the project at its multibranch folder instead, and name the
pull request per request:

```json
{
  "pycore": {
    "description": "Backend core",
    "multibranch": "pycore",
    "environments": { "main": "pycore/main" }
  }
}
```

Given `job/pycore/view/change-requests/job/PR-2829/` in the browser, the project
is `pycore` with `multibranch: "pycore"`; `view/change-requests` is a UI tab and
does not belong in the config.

The pull request itself goes into the `branch` argument of any build tool, in
any of these forms: `2829`, `#2829`, `pr-2829`, `PR-2829`. A branch name such as
`feature/login` works as well. Static environments (`main` above) keep working
as before.

- "which PR environments are alive" → `jenkins_list_branches`
- "why did PR-2829 fail" → `jenkins_diagnose_build` with `branch: "2829"`

If PR jobs are not named `PR-*` (for example `MR-*` on GitLab), add
`"prPrefix": "MR-"` to the project, and `2829` will expand to `MR-2829`.

The other common layout is a single shared deploy job where the PR number
arrives as a build parameter. No multibranch folder is needed then; find the
build with a filter instead: `jenkins_list_builds` with
`parameters: { "PR": "2829" }`.

Where the server looks for a config when `--config` is not given (first hit wins):

1. `./jenkins-mcp.json`
2. `./.jenkins-mcp.json`
3. `~/.config/jenkins-mcp/config.json`
4. `~/.jenkins-mcp.json`

The MCP client decides the server's working directory, so an absolute
`--config` path is the reliable choice.

## Token

The token is a Jenkins API token: profile → **Security** → *Add new token*
(`https://jenkins.example.com/me/security`). A UI password will not work when
SSO is in place.

Keep the token in the `JENKINS_TOKEN` environment variable rather than in the
config file.

## Connecting Claude Code

```bash
claude mcp add jenkins \
  --env JENKINS_TOKEN=xxxxxxxxxxxx \
  -- npx -y github:ruslan-casafari/jenkins-mcp --config ~/.jenkins-mcp.json
```

Or in the project's `.mcp.json` / in `~/.claude.json`:

```json
{
  "mcpServers": {
    "jenkins": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "github:ruslan-casafari/jenkins-mcp",
        "--config",
        "/Users/me/.jenkins-mcp.json"
      ],
      "env": { "JENKINS_TOKEN": "${JENKINS_TOKEN}" }
    }
  }
}
```

To keep everything in that one file instead, drop the config file and pass the
projects as JSON in `JENKINS_PROJECTS`:

```json
{
  "mcpServers": {
    "jenkins": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ruslan-casafari/jenkins-mcp"],
      "env": {
        "JENKINS_URL": "https://jenkins.example.com",
        "JENKINS_USER": "your-login",
        "JENKINS_TOKEN": "${JENKINS_TOKEN}",
        "JENKINS_PROJECTS": "{\"pycore\":{\"multibranch\":\"pycore\",\"environments\":{\"main\":\"pycore/main\"}},\"web\":{\"dev\":\"platform/web/deploy-dev\",\"prod\":\"platform/web/deploy-prod\"}}"
      }
    }
  }
}
```

Either block suits any MCP client with a stdio transport.

To check the connection, ask the assistant to call `jenkins_whoami`: it returns
the authenticated user, the Jenkins version and how many projects are configured.

## Tools

| Tool | What it does |
| --- | --- |
| `jenkins_list_projects` | Configured projects, their environments and the jobs behind them. No Jenkins request. |
| `jenkins_project_status` | State of a project's environments: last build, who triggered it, parameters, commits, last successful and last failed build. No arguments — every project. |
| `jenkins_list_builds` | Build history of an environment, with an `onlyFailed` filter. |
| `jenkins_get_build` | Details of one build: result, parameters, changes. |
| `jenkins_get_build_log` | Console log: tail, `search` by regex with context, `start` to keep reading a running build. |
| `jenkins_diagnose_build` | Triage of a failed build in one call: the failed pipeline stage with its error and log, failed tests, console tail. |
| `jenkins_get_test_report` | Test summary and failing cases with their messages. |
| `jenkins_list_branches` | Live branch and PR environments of a project from its multibranch folder, with the last build of each. |
| `jenkins_search_jobs` | Find jobs on the controller — to get a path and add the project to the config. |
| `jenkins_whoami` | Check the URL, the credentials and the permissions. |

Every build tool takes its target the same way: `project` + `environment` (or
`project: "web/prod"`), `project` + `branch` for pull requests and branches, or
`job` with a raw path for jobs that are not in the config. The `build` argument
is a build number or a Jenkins alias (`lastBuild`, `lastFailedBuild`,
`lastSuccessfulBuild`, …), defaulting to `lastBuild`.

Questions this covers:

- "what is on prod for web" → `jenkins_project_status`
- "why did the last api build on staging fail" → `jenkins_diagnose_build`
- "show everything about timeout in the log" → `jenkins_get_build_log` with `search: "timeout"`
- "when did prod last deploy successfully" → `jenkins_list_builds`
- "what happened to the PR-2829 build" → `jenkins_diagnose_build` with `branch: "2829"`

## Runtime options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--url` | `JENKINS_URL` | — (required) |
| `--user` | `JENKINS_USER` | — |
| `--token` | `JENKINS_TOKEN`, `JENKINS_API_TOKEN` | — |
| `--config` | `JENKINS_MCP_CONFIG` | auto-discovery (see above) |
| `--insecure` | `JENKINS_INSECURE_TLS=1` | off |
| `--timeout` | `JENKINS_TIMEOUT_MS` | `30000` |
| `--max-output` | `JENKINS_MAX_OUTPUT_CHARS` | `80000` |

Flags take precedence over environment variables, which take precedence over
the config file.

`JENKINS_PROJECTS` holds the same structure as `projects` in the config file,
as a JSON string.

`--insecure` disables TLS certificate verification for the whole process — turn
it on only for an internal controller with a self-signed certificate.

## Development

```bash
npm install       # installs dependencies and builds dist/
npm run typecheck
npm run build
```

Node.js 20+.
