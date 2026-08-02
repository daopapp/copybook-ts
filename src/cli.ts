#!/usr/bin/env node
/**
 * `copybook-types CUSTOMER.cpy > customer.ts`
 *
 * Writes to stdout rather than taking an output path: the shell already knows
 * how to redirect, and the exit code is what a build cares about.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { generateModule } from './codegen.js';

const USAGE = `Usage: copybook-types <copybook.cpy> [--from <module>]

  --from <module>  module specifier the generated code imports from
                   (default: copybook-ts)

Writes the generated TypeScript module to stdout.`;

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 ? 1 : 0;
  }

  let file: string | undefined;
  let from: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--from') {
      from = args[i + 1];
      if (from === undefined) {
        process.stderr.write('--from needs a module specifier\n');
        return 1;
      }
      i += 1;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`unknown option: ${arg}\n${USAGE}\n`);
      return 1;
    } else if (file === undefined) {
      file = arg;
    } else {
      process.stderr.write(`one copybook at a time, got a second: ${arg}\n`);
      return 1;
    }
  }

  if (file === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const source = readFileSync(file, 'utf8');
  process.stdout.write(generateModule(source, { importFrom: from, sourceName: basename(file) }));
  return 0;
}

try {
  process.exitCode = main(process.argv);
} catch (e) {
  // A copybook this tool refuses is the whole point of running it at build
  // time. Fail loudly, with the message the parser produced.
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
}
