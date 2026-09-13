import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DESCRIPTION, GUIDANCE, RULES, homeGuidance } from '../src/commands.js';

const path = new URL('../skills/laravel-cloud-axi/SKILL.md', import.meta.url);
const portable = text => text.replaceAll('laravel-cloud-axi', 'node <checkout>/bin/laravel-cloud-axi.js');
const content = `---
name: laravel-cloud-axi
description: Inspect Laravel Cloud apps, environments, resource details, existing operations and organization billing through the official CLI.
---

# Laravel Cloud AXI

${DESCRIPTION}

Use Node.js 22 or later and install the official Cloud CLI. Run \`npm ci\` in this checkout.
Replace \`<checkout>\` with its absolute path. A global package install is not required.
This package is not published to npm, so do not use an npx package example.

Run \`node <checkout>/bin/laravel-cloud-axi.js\` for live project state.
Run \`node <checkout>/bin/laravel-cloud-axi.js --help\` for commands and compatibility limits.

\`\`\`sh
${[...new Set([...homeGuidance(), ...GUIDANCE])].map(portable).join('\n')}
\`\`\`

${RULES.map(rule => `- ${portable(rule)}`).join('\n')}
- Project scope is the Git root (including worktrees), otherwise the current directory. Parent .cloud configs outside Git are not used.
- Never print credentials or commit .env. Native saved tokens are not read or copied by this wrapper.
- Free text, command output, and logs can contain secrets. Review before sharing. Redaction is not a general secret scanner.
- Obtain user approval before local link or hook setup. Examples are not approval.
- Use \`node <checkout>/bin/laravel-cloud-axi.js link --app <id> --env <id>\` to save verified read defaults.
- Install optional session context only when asked: \`node <checkout>/bin/laravel-cloud-axi.js setup hooks\`. Use a persistent install, not a temporary cache.
- Setup supports Claude Code, Codex, and OpenCode. Codex setup also enables hooks in its user config.
- Deployment, instance and domain IDs may be available in environment detail relationship fields. Command IDs must come from the Cloud dashboard.
- Use \`deployment wait <id>\` or \`command wait <id>\` to monitor existing work. A deadline does not cancel remote work.
`;

if (process.argv.slice(2).length && process.argv.slice(2).join(' ') !== '--check') throw new Error('Usage: node scripts/skill.js [--check]');
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) throw new Error('Skill is stale. Run npm run skill.');
} else {
  mkdirSync(new URL('.', path), { recursive: true });
  writeFileSync(path, content);
}
