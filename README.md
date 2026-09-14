# laravel-cloud-axi

An [AXI](https://github.com/kunchenguid/axi) wrapper around official Laravel Cloud commands, like [gh-axi](https://github.com/kunchenguid/gh-axi) wraps `gh`. It adds compact TOON output, input validation, exact read-target checks, and optional agent session context.

Production Cloud operations use the `cloud` executable through argv subprocesses. There is no HTTP client, PHP shim, separate login, keyring, saved-token parser, or general command passthrough. The installed AXI SDK supplies the command runtime and hooks. The TOON encoder runs at the output boundary; internal values stay JSON.

## Install

Requires Node.js 22 or later and the [official Cloud CLI](https://github.com/laravel/cloud-cli). Command mappings were checked against v0.5.0. API-token fallback requires v0.6.0 or later in the 0.x series.

```sh
npm ci
node bin/laravel-cloud-axi.js --help
npm install -g .
```

Examples below use the optional PATH install. Without it, use `node /absolute/checkout/bin/laravel-cloud-axi.js`. This package is not published to npm. `CLOUD_BIN` can select a trusted official executable path; it is not a shell command. The wrapper does not update the official CLI or itself.

## Authentication and native limits

Log in yourself, outside an agent session:

```sh
cloud auth
laravel-cloud-axi app list
```

This wrapper has no `auth` command. Login, logout and token storage belong to `cloud auth`. Any supported read, including `app list` or no-argument home, is the access check.

Credential order:

1. Run the native read with no token override. The official CLI selects its saved login.
2. Only an exact native no-saved-login error permits `LARAVEL_CLOUD_API_TOKEN` from the process environment.
3. Otherwise use that same variable from the project's `.env`.

Fallback is delegated as the child's `LARAVEL_CLOUD_TOKEN`, supported by native v0.6.0. It is never copied to a token file or command argument. The initial native attempt withholds both token variables. A caller's `LARAVEL_CLOUD_TOKEN` is not a wrapper credential source. Invalid saved credentials, ambiguous logins, timeouts, malformed responses and credential rejection do not switch sources. The read is repeated once only after an explicit missing-login result and a compatible version check. Subsequent reads in that invocation use the same fallback.

No saved login and no fallback means `AUTH_REQUIRED`. With a fallback but native v0.5.0, save a login yourself or upgrade the official CLI. `.env` is read only after the explicit no-login result. Quotes and comments work. Variables and shell expressions are not executed. The wrapper does not change `.env` or `process.env`.

**Upstream safety limit:** native v0.5.0 and v0.6.0 can start OAuth and open a browser when all stored tokens expire. Closed stdin, CI mode and `--no-interaction` do not prevent that branch. Agent-detection environment markers are withheld, but native detection can also use files. Each subprocess has a 10-second hard deadline and process cleanup. This bounds waiting; it does not guarantee that native login or a browser cannot start. The wrapper does not implement a second authentication system to work around this provider behavior.

The official CLI owns token selection and storage. It can remove expired saved tokens during ordinary reads. This wrapper does not read, copy or write the saved credential file, and cannot promise that the provider leaves it unchanged.

Native login is not organization-agnostic. `~/.config/cloud/config.json` can store several tokens. Project `.cloud/config.json` stores one `organization_id`, not a list. With one valid token, native uses it. With several valid tokens, native uses the token whose organization matches that single ID. If the ID is missing or matches none of the tokens, native fails and this wrapper returns `AUTH_AMBIGUOUS`. It does not prompt, pick another token, or retry with fallback credentials.

First-time multi-token setup is `cloud repo:config` in a Git project, or write `organization_id` yourself. `link` cannot bootstrap that selection: the application read already needs a chosen token. After a successful read, `link` copies the application's organization ID into that native key so later reads in the same project keep the same organization. Use read-only credentials where possible.

## Supported commands

Every subcommand has concise `--help` with flags and examples. Unknown flags are rejected before any dependency call, including when combined with `--help`. Use exact IDs, not names. A returned ID that differs from the requested ID is an error, not a successful fallback.

| Command | Native operation |
| --- | --- |
| `app list`, `app view <id>` | `application:list`, `application:get <id>` |
| `environment list --app <id>` | Exact-checked `application:get <id>`, then its included environments |
| `environment view <id>` | `environment:get <id>` |
| `deployment view <id>`, `deployment wait <id>` | `deployment:get <id>` |
| `command view <id>`, `command wait <id>` | `command:get <id>` |
| `instance view <id>` | `instance:get <id>` |
| `domain view <id>` | `domain:get <id>` |
| `database list`, `database view <id>` | `database-cluster:list`, `database-cluster:get <id>` |
| `cache list`, `cache view <id>` | `cache:list`, `cache:get <id>` |
| `bucket list`, `bucket view <id>` | `bucket:list`, `bucket:get <id>` |
| `usage --period 0` | `usage --period=current`, organization billing |
| `link --app <id> --env <id>` | Exact application and environment reads, then local `organization_id`, application and environment defaults |
| `setup hooks [--status\|--remove]` | Opt-in local agent configuration |

A noun without an action selects its list. `home` and no arguments show live state. Linked home shows the environment, current deployment ID and available instance count. Unlinked home lists applications. No-argument output includes the executable path and a short description. Bare `-v`, `-V`, and `--version` load no command graph and print only the package version.

### Project scope

```sh
laravel-cloud-axi app list
laravel-cloud-axi environment list --app <id>
laravel-cloud-axi link --app <id> --env <id>
laravel-cloud-axi
```

Scope matches native `LocalConfig`: the Git root, including worktree `.git` files, otherwise the current directory. Nested `.cloud` files inside Git and parent configs outside Git are not used. Native subprocesses run in this same directory. `.env`, link, read defaults and hooks use this scope too.

`link` validates both returned IDs, environment membership and the application's organization ID before saving `.cloud/config.json`. That `organization_id` is the native token selector when several logins exist. Other keys are preserved. The write is atomic with mode `0600`. An unchanged link is a local no-op. Explicit read flags override linked target IDs.

### Output

```text
scope: selected organization
count: 1
total: 1
has_more: false
app[1]{id,name,region,repositoryFullName}:
  app-example,Store,us-east-2,acme/store
```

- Supported native lists collect all pages. AXI displays at most 100 rows by default. `--limit` changes the display limit; `--all` shows the full returned collection. They cannot reduce native network work or output size.
- Filters are local exact matches on the complete returned collection, before display limiting. Counts refer to the filtered scope. Empty results state zero with scope. `has_more` means hidden display rows, not a provider cursor.
- `--fields id,name,status` selects native camelCase fields. Dotted paths work. Missing fields return `null`. Default list rows have 3 or 4 columns.
- Detail strings have a 1000-character preview, total length and a conditional `--full` hint. `--full` expands text, never structured secrets.
- `usage` uses native camelCase integer-cent fields. Periods `0..3` remain supported, with `0` mapped to `current`.
- Wait commands poll existing operations only. Default deadline: 300 seconds; maximum: 3600 seconds. A deadline does not cancel remote work. Remote failure returns exit 1 with the last checked result.
- All data and errors go to stdout as TOON. Exit codes: 0 success or local no-op, 1 failure, 2 invalid input. Raw dependency errors and stack traces are not forwarded. One JSON document is required for reads; progress JSON lines are not treated as a final result.

## Migration from the HTTP implementation

This is a reduced, read-focused surface, not feature parity.

| Earlier behavior | Current behavior and alternative |
| --- | --- |
| Direct API calls without PHP or `cloud` | Official executable and its runtime are required |
| Environment/.env fallback with any native version | Requires v0.6.0, only after an explicit no-saved-login result |
| Wrapper selected saved tokens and asserted organization | Native CLI owns token and organization selection |
| `auth`, `auth status` | Removed: run `cloud auth`, then `laravel-cloud-axi app list` |
| API snake_case `--fields` | Native camelCase, for example `repositoryFullName`, `exitCode`, `currentDeploymentId` |
| `--page` | Targeted usage error: use `--limit` or `--all` |
| Server-side list filters | Local exact filters on complete supported collections |
| `deployment`, `command`, `instance`, `domain` lists | Unsupported: native list output cannot prove its resolved environment, including empty results |
| Environment logs and deployment logs | Unsupported: environment scope/pagination cannot be proved; deployment logs has no native command |
| `usage --env` | Unsupported: native output does not identify its resolved environment |
| `deploy`, `command run` | Unsupported: native resolvers can fall back to another target after a failed exact lookup |
| Environment start/stop | Unsupported: no native command |
| Nearest `.cloud/config.json` lookup | Git root, otherwise current directory |

Use `environment view <id> --fields deploymentIds,currentDeploymentId,instances,domainIds` to inspect available related IDs. These relationship arrays are not a promise of complete history. For command IDs, logs, environment billing, full history or remote writes, use the Cloud dashboard yourself.

Legacy unsupported commands remain as explicit errors with targeted help. `--confirm` cannot enable them. Their `--dry-run` returns `supported: false`, sends nothing and does not print a fake HTTP request or claim a mutation will work. Preflight reads cannot make a later native write safe when its second resolver can fall back. No remote mutation is sent or retried. Local link and hook setup are the only supported mutations and are idempotent.

## Subprocess and data safety

Native reads use argv execution without a shell, closed stdin, `--json`, `--no-interaction` and `--no-ansi`. Runtime paths and network trust/proxy settings are inherited. Agent markers, PHP injection settings, `CLOUD_BASE_URL`, and unrelated variables are not. The API host cannot be changed through this wrapper. Only listed native read commands can run; no unrestricted passthrough exists.

Combined stdout/stderr is bounded to 5 MiB. On timeout or excess output the process is killed. On POSIX, cleanup also kills its process group. This cannot undo a browser or network action already performed by native code. Windows process-tree cleanup and hook behavior are not validated.

Structured credential fields are redacted, including camelCase environment variables and connection data. Configured fallback values are removed from output before truncation. Saved tokens are unknown to the wrapper, and arbitrary free text can contain other secrets. This is not a general secret scanner. Review resource text before sharing it.

## Agent integration

Choose the hook first for automatic live context, or the generated skill for on-demand guidance. Only one is needed; both can be installed.

```sh
laravel-cloud-axi setup hooks
laravel-cloud-axi setup hooks --status
laravel-cloud-axi setup hooks --remove
```

Setup requires explicit intent, a linked project and a persistent install. Normal commands never install hooks. The SDK manages project Claude Code `.claude/settings.json`, Codex `.codex/hooks.json`, and OpenCode `.opencode/plugins/laravel-cloud-axi.js`. Codex setup also enables the shared `hooks = true` feature in `~/.codex/config.toml`. Removal preserves that shared feature and unrelated settings.

Repeated installation with the same path is a no-op. Setup repairs paths after relocation. A PATH-verified executable is preferred; otherwise the SDK uses its absolute path. Setup rejects unsafe fallback paths because the SDK does not quote them. No session transcripts or session-end history are collected. The session context uses the same native authentication limits described above.

The installable skill is [`skills/laravel-cloud-axi/SKILL.md`](skills/laravel-cloud-axi/SKILL.md). Install or copy that directory through your agent's skill system. It uses an absolute checkout command, so a global install is not required. It is generated from shared CLI guidance without live state.

## Development

```sh
npm run skill
npm run check
git diff --check
npm pack --dry-run
```

Tests are offline. An executable fake `cloud` records argv, cwd, environment and stdin. Tests cover validation, native DTO shapes/signatures, exact-target fallback rejection, local list counts, errors, limits, process cleanup, credential fallback, context, hooks and the fast version path. Synthetic `.env` fixtures are the only credential fixtures read by tests. No test logs in, deploys, runs remote commands, or reads real credentials. The skill freshness check fails if generated guidance is stale.
