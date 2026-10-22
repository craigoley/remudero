#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compilerEnvironment } from '../src/lib/compiler-budget.ts';
import { runTypecheck } from '../src/lib/typecheck-run.ts';
import { typecheckEnv } from '../src/lib/typecheck-buildinfo.ts';
import { isMainModule } from './lib/argv.mjs';
import { REPO_ROOT } from './lib/repo-root.mjs';

/** One whole-project invocation; additional flags cannot silently undo its checker/CPU budget. */
export function main(argv, root = REPO_ROOT, spawn = spawnSync) {
  if (argv.length !== 1 || !['build', 'typecheck'].includes(argv[0])) {
    console.error('compile-project: expected build or typecheck');
    return 2;
  }
  try {
    if (argv[0] === 'typecheck') {
      return runTypecheck(root, [], { spawn: (file, args, cwd, env) => spawn(file, args, { cwd, stdio: 'inherit', env }) });
    }
    const args = ['-p', 'tsconfig.json', '--checkers', '1'];
    const parentEnv = typecheckEnv(process.env);
    const result = spawn(join(root, 'node_modules', '.bin', 'tsc'), args, {
      cwd: root, stdio: 'inherit', env: { ...parentEnv, ...compilerEnvironment(parentEnv) },
    });
    if (result.error || result.signal || !Number.isInteger(result.status) || result.status < 0) {
      console.error(`compile-project: native compiler did not complete (${result.error?.message ?? result.signal ?? 'no exit status'})`);
      return 1;
    }
    return result.status;
  } catch (error) {
    console.error(`compile-project: ${error.message}`);
    return 1;
  }
}
if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
