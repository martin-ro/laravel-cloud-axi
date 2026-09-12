---
name: laravel-cloud-axi
description: Inspect Laravel Cloud apps, environments, deployments, logs, and billing, or run approved deployments and remote commands.
---

# Laravel Cloud AXI

Inspect Laravel Cloud resources, read logs, and run guarded deployment operations.

Use Node.js 22 or later. Run `npm ci` in the checkout first.
Set `LARAVEL_CLOUD_TOKEN` through the environment or a secret manager. Never print or save the token.
Replace `<checkout>` below with the absolute checkout path. A global install is not required.

Run `node <checkout>/bin/laravel-cloud-axi.js` to see live state.
Run `node <checkout>/bin/laravel-cloud-axi.js --help` to discover commands.

```sh
node <checkout>/bin/laravel-cloud-axi.js logs --env '<id>' --since '1h'
node <checkout>/bin/laravel-cloud-axi.js deployment list --env '<id>'
node <checkout>/bin/laravel-cloud-axi.js --help
node <checkout>/bin/laravel-cloud-axi.js app list
node <checkout>/bin/laravel-cloud-axi.js environment list --app <id>
node <checkout>/bin/laravel-cloud-axi.js logs --env <id> --since 1h
node <checkout>/bin/laravel-cloud-axi.js deploy --env <id> --dry-run
node <checkout>/bin/laravel-cloud-axi.js deploy --env <id> --confirm --wait
node <checkout>/bin/laravel-cloud-axi.js command run --env <id> --command "php artisan about" --confirm --wait
```

- Obtain user approval before a mutation. A command example is not approval.
- Use exact resource IDs from list output. Never guess an application or environment.
- Read commands can use `.cloud/config.json`. Mutations require explicit targets and `--confirm`.
- `--dry-run` performs no API requests. Deploy and command run create a new operation on every confirmed call.
- After an uncertain result, inspect the operation list. Do not repeat a mutation without checking.
- Use `deployment wait <id>` or `command wait <id>` to resume waiting. A timeout does not cancel remote work.
- Lists report count, total, page, and has_more. Use `--page` or `--all` for more results.
- Use `--fields` to select fields and `--full` for complete text. Structured credentials stay redacted.
- Logs and command output can contain secrets in free text. Do not share them without review.
- Output is TOON. Exit codes: 0 success, 1 operational error, 2 invalid input.
- Session hooks are optional. Install them only when asked, with `setup hooks` after `link --app <id> --env <id>`.
