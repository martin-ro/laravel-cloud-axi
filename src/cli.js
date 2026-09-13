import { runAxiCli, AxiError } from 'axi-sdk-js';
import { encode as renderOutput } from '@toon-format/toon';
import { createCloud, present } from './cloud.js';
import { COMMAND_NAMES, DESCRIPTION, GUIDANCE, RULES, execute } from './commands.js';

export async function main(argv, options = {}) {
  const runtime = { cwd: process.cwd(), ...options };
  runtime.cloud ??= createCloud({ cwd: runtime.cwd });
  await runAxiCli({
    argv,
    version: options.version ?? '0.1.0',
    description: DESCRIPTION,
    stdout: options.stdout,
    topLevelHelp: `${renderOutput({
      description: DESCRIPTION,
      commands: {
        app: 'list | view <id>',
        environment: 'list --app <id> | view <id>',
        deployment: 'view <id> | wait <id>',
        command: 'view <id> | wait <id>',
        instance: 'view <id>',
        domain: 'view <id>',
        database: 'list | view <id> (clusters)',
        cache: 'list | view <id>',
        bucket: 'list | view <id>',
        usage: '[--period 0..3]: organization billing',
        auth: '[status]: check native access; never invokes login',
        link: '--app <id> --env <id>: validate and save project read defaults',
        setup: 'hooks [--status|--remove]: opt-in agent session context',
        home: 'Show live project state, also the default with no arguments',
      },
      unsupported: ['deploy, command run, environment start/stop: no safe native write target guarantee', 'deployment/command/instance/domain list: cannot prove native scope and completeness', 'logs, deployment logs, usage --env: no safe equivalent'],
      rules: RULES,
      examples: GUIDANCE.slice(0, 3),
    })}\n`,
    home: () => execute('home', [], runtime),
    commands: Object.assign(Object.create(null), Object.fromEntries(COMMAND_NAMES.map(command => [command, args => execute(command, [...args], runtime)]))),
    formatError: error => {
      const output = present({
        error: error instanceof AxiError ? error.message : 'Local operation failed. Check file permissions and project configuration.',
        code: error instanceof AxiError ? error.code : 'LOCAL_ERROR',
        help: [...(error.result?.help ?? []), ...(error.suggestions ?? ['laravel-cloud-axi --help'])],
      });
      return {
        output: `${renderOutput({ ...output, ...error.result, help: output.help })}\n`,
        exitCode: error.code === 'USAGE_ERROR' ? 2 : 1,
      };
    },
  });
}
