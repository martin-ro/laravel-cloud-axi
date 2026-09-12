#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const args = process.argv.slice(2);
if (args.length === 1 && ['-v', '-V', '--version'].includes(args[0])) {
  console.log(version);
} else {
  const { main } = await import('../src/cli.js');
  await main(args, { version });
}
