#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { boundedNodeTestArgs } from './test-tier-manifest.mjs';
import { isMainModule } from './lib/argv.mjs';

/** A deadline-only launcher for npm census scripts. The enclosing native gate owns admission;
 * acquiring another slot here would nest it. Preserve targets, reporters, stdio and exit status. */
export function runNativeTests(args, { root = process.cwd(), run = spawnSync } = {}) {
  if (!args.includes('--test')) throw new Error('native test launcher requires --test');
  const result = run(process.execPath, boundedNodeTestArgs(args, root), { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isMainModule(import.meta.url)) process.exitCode = runNativeTests(process.argv.slice(2));
