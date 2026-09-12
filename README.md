# laravel-cloud-axi

An [AXI](https://axi.md/) for Laravel Cloud: compact TOON output, live project state, and guarded operations for coding agents.

Uses the [Laravel Cloud API](https://laravel.com/cloud/docs/api/introduction) directly. It does not need PHP or the `cloud` executable. The [AXI SDK](https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js) supplies the command runtime and optional session hooks.

## Install from this checkout

Requires Node.js 22 or later.

```sh
npm ci
node bin/laravel-cloud-axi.js --help

# Optional: expose laravel-cloud-axi on PATH.
npm install -g .
```

The examples below assume the PATH install. Otherwise use `node /path/to/laravel-cloud-axi/bin/laravel-cloud-axi.js` in its place. This project has not been published to npm.

## Authentication

Create a scoped API token in your Laravel Cloud organization settings. Supply it as `LARAVEL_CLOUD_TOKEN`, preferably through a secret manager.

```sh
export LARAVEL_CLOUD_TOKEN='<your-scoped-token>'
laravel-cloud-axi auth
laravel-cloud-axi
```

The token selects the organization. Use read-only permissions unless an operation needs write access. The CLI does not save tokens, read the official CLI's saved OAuth tokens, or open a browser. Avoid putting real tokens in shell history.

## Link a project

```sh
laravel-cloud-axi app list
laravel-cloud-axi environment list --app <application-id>
laravel-cloud-axi link --app <application-id> --env <environment-id>
laravel-cloud-axi
```

`link` verifies that the environment belongs to the application. It merges IDs into `.cloud/config.json`, the same project file used by the official Cloud CLI. Other keys are preserved. Writes are atomic and use mode `0600`. Repeating the same link is a no-op.

Read commands find the nearest `.cloud/config.json`, without crossing a Git root. Outside Git, a new link is written in the current directory. Explicit read flags override the linked IDs. Billing is organization-wide unless `--env` is given.

With a linked environment, no arguments show its status, current deployment ID, and instance count. Without a link, no arguments list applications.

## Commands

Every command supports `--help`. Flags go after the command. Resource names are not resolved: use exact IDs from list output.

| Command | Purpose |
| --- | --- |
| `app list`, `app view <id>` | Applications |
| `environment list --app <id>`, `environment view <id>` | Environments |
| `deployment list --env <id>`, `deployment view <id>` | Deployment history and details |
| `deployment logs <id>` | Build and deployment logs |
| `deployment wait <id> --timeout 300` | Wait for an existing deployment |
| `deploy --env <id> --dry-run` | Preview a deployment request |
| `deploy --env <id> --confirm --wait` | Deploy and return its final state |
| `command list --env <id>`, `command view <id>` | Remote command history and output |
| `command run --env <id> --command "php artisan about" --confirm --wait` | Run a remote command |
| `command wait <id> --timeout 300` | Wait for an existing remote command |
| `environment start <id> --confirm` | Start and deploy an environment |
| `environment stop <id> --confirm` | Stop an environment and cancel active deployments |
| `logs --env <id> --since 1h --query "error"` | Search environment logs |
| `instance list --env <id>`, `instance view <id>` | Compute instances |
| `domain list --env <id>`, `domain view <id>` | Domain and TLS state |
| `database list`, `database view <id>` | Database clusters, not individual schemas |
| `cache list`, `cache view <id>` | Caches |
| `bucket list`, `bucket view <id>` | Object storage buckets |
| `usage --period 0 --env <id>` | Billing totals and environment usage in cents |
| `auth` | Check the token's organization |
| `setup hooks [--status\|--remove]` | Optional project session hooks |

A resource noun without an action runs its list command. For example, `cache` means `cache list`.

### Output and pagination

```text
count: 2
total: 2
page: 1
has_more: false
app[2]{id,name,region,repository.full_name}:
  app-example1,Store,us-east-2,acme/store
  app-example2,Docs,eu-central-1,acme/docs
help[2]: laravel-cloud-axi app view <id>,laravel-cloud-axi environment list --app <id>
```

- Lists return one complete API page with 3 or 4 fields per row. Page size is set by Cloud.
- `--page 2` reads another page. `--all` reads all pages from the selected page, up to 100 pages. The reported page is the last page read. A failed page fails the command, not a partial success.
- `count` is the number returned. `total` is the server total. `null` means the API did not supply a total, including for logs.
- Empty results include an explicit zero-result message.
- `--fields id,name,status` selects fields. Field names use API snake_case. Dotted paths such as `repository.full_name` work. Missing fields return `null`.
- Detail views include attributes and available relationship IDs/counts. Strings stop at 1000 characters with a size hint. `--full` returns complete text, not additional pages.
- Filters differ by resource. For example, `deployment list --env <id> --status build.failed` uses a server-side filter. Use the command's `--help` for all accepted flags.
- All results and errors go to stdout as TOON. Exit codes are `0` for success, `1` for operational failures, and `2` for invalid input. Wait commands return `1` for a failed remote operation.

Environment logs default to the last hour. `--from` and `--to` require ISO 8601 timestamps with timezones. Cursor continuation must retain both timestamps and all filters; the next-step hint carries them forward. Log `--type` accepts `application`, `access`, or `all`.

## Operation safety

- Mutations require an explicit target ID and `--confirm`. They never use linked target defaults. All environments, including production, use this gate.
- `--dry-run` validates the input and prints the request without an API call. It does not check remote permissions or resource existence.
- Deployments and remote commands are not idempotent. Each confirmed invocation creates a new operation. They are never retried automatically.
- Start is a no-op when the environment is running or deploying. Stop is a no-op when it is stopped. Otherwise the API performs the state change.
- Without `--wait`, deployment and command creation return their operation IDs. With `--wait`, polling stops after 300 seconds by default, with a maximum of 3600 seconds. Timeout does not cancel remote work. Resume with the corresponding `wait <id>` command.
- After a network failure or uncertain mutation result, inspect deployment or command history before repeating it.
- API requests have a 10-second timeout and a 5 MiB response limit. Redirects are refused. Pagination must stay on the same HTTPS origin and resource path. There is no API-host override.
- Known structured credential fields and the configured API token are redacted, including with `--full`. This is not a secret scanner: logs, command strings, and arbitrary free text can still contain other secrets. Review them before sharing.

This version does not create or delete infrastructure, change environment variables, manage secret values, or provide an unrestricted API passthrough. Use the Cloud dashboard for those operations.

## Agent integration

Choose a session hook for automatic context or the skill for on-demand guidance. Only one is needed.

### Session hooks

After linking a project, explicitly install hooks:

```sh
laravel-cloud-axi setup hooks
laravel-cloud-axi setup hooks --status
laravel-cloud-axi setup hooks --remove
```

Setup uses the SDK to install project-scoped integrations for:

- Claude Code: `.claude/settings.json`
- Codex: `.codex/hooks.json`
- OpenCode: `.opencode/plugins/laravel-cloud-axi.js`

Codex also needs the shared `hooks = true` feature in **`~/.codex/config.toml`**. Setup enables that user-level feature. Removing hooks leaves the shared feature enabled and preserves unrelated configuration.

Normal commands never install hooks. Setup repairs the executable path after relocation. Repeating setup with the same path does not rewrite files. Hooks use the linked project and need the token in the agent's environment. No session transcripts are collected.

Use a persistent installation for hooks, not an `npx` cache. The current SDK does not quote fallback executable paths, so setup rejects paths with spaces or shell metacharacters. Hook integration is tested on Linux; Windows is not validated.

### On-demand skill

The generated skill is at [`skills/laravel-cloud-axi/SKILL.md`](skills/laravel-cloud-axi/SKILL.md). Install or copy that directory through your agent's skill system. It uses an absolute checkout path, so a global executable is not required.

## Development

```sh
npm ci
npm run skill
npm run check
npm pack --dry-run
```

Tests use Node's built-in test runner and simulated Cloud responses. They cover input validation, API errors, pagination, redaction, operation status, context persistence, hooks, and executable behavior. They do not need a Cloud account and never call the live API.

The skill is generated from the CLI's shared guidance. `npm run check` fails when it is stale. GitHub Actions runs these checks on Node 22 and 24.

API mappings were checked against the [official OpenAPI document](https://cloud.laravel.com/api-docs/api.json). Live deployments and account-specific permissions still need a separate, approved smoke test.
