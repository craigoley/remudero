#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const owner = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(owner, 'node_modules', 'typescript', 'bin', 'tsc');

/** Only an unambiguous full check cedes argv ownership to the existing wrapper. */
export function wholeProjectNoEmitArgs(argv, cwd = process.cwd()) {
  const rest = [];
  let noEmit = false, project = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^(?:--(?:incremental|tsbuildinfofile|build|watch|listfiles.*|help|version|init|showconfig|generatecpuprofile|generatetrace)|-[bwvh])(?:=|$)/i.test(arg) ||
        /^(?:--(?:project|noemit)|-p)=/i.test(arg)) return undefined;
    if (arg === '--noEmit') {
      if (noEmit || argv[i + 1] === 'false') return undefined;
      noEmit = true;
      if (argv[i + 1] === 'true') i++;
    } else if (arg === '-p' || arg === '--project') {
      if (project || !['.', 'tsconfig.json'].includes(argv[i + 1])) return undefined;
      project = true; i++;
    } else rest.push(arg);
  }
  if (!noEmit) return undefined;
  if (rest.length) {
    // The real compiler distinguishes option values from source filenames; no duplicate CLI grammar.
    // showConfig reads metadata only. Profiling/tracing invocations above retain their original executor.
    const config = spawnSync(process.execPath, [compiler, '--noEmit', '-p', 'tsconfig.json', ...rest, '--showConfig'], {
      cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RMD_TSC_ENTRY: '1' },
    });
    if (config.status !== 0) return undefined;
  }
  return rest;
}

function atGitRoot(cwd) {
  if (!existsSync(join(cwd, '.git'))) return false;
  // A metadata read, not an admission estimate; the existing Git-call backstop is 60s.
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return git.status === 0 && realpathSync(git.stdout.trim()) === realpathSync(cwd);
}

export function runTscEntry(argv, cwd = process.cwd(), spawn = spawnSync) {
  // Re-entry belongs to the actual child environment, not an injected env argument.
  const extra = process.env.RMD_TSC_ENTRY === '1' ? undefined : wholeProjectNoEmitArgs(argv, cwd);
  const routed = extra !== undefined && atGitRoot(cwd);
  if (routed) process.stderr.write(JSON.stringify({ step: 'typecheck.raw_routed', argv }) + '\n');
  const args = routed
    ? ['--import', join(owner, 'node_modules', 'tsx', 'dist', 'loader.mjs'), join(owner, 'scripts', 'typecheck.mjs'), ...extra]
    : [compiler, ...argv];
  const result = spawn(process.execPath, args, {
    cwd, stdio: 'inherit', env: routed ? { ...process.env, RMD_TSC_ENTRY: '1' } : process.env,
  });
  if (result.error) {
    process.stderr.write(`typecheck: could not run tsc: ${result.error.message}\n`);
    return 127;
  }
  return result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
}

if (import.meta.main) process.exitCode = runTscEntry(process.argv.slice(2));
