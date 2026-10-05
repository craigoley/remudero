#!/usr/bin/env node
// Dependency-free admission. Only the already-idle source PR shards may avoid setup.
import { readFileSync } from 'node:fs';
import { classifyCoverage, parseChangedFiles } from './diff-class.mjs';
import { isMainModule, parseArgv } from './lib/argv.mjs';

export function requiresSetup(files, { event, shard, live }) {
  return event !== 'pull_request' || !/^[2-8]$/.test(String(shard)) || live !== '0' ||
    !Array.isArray(files) || files.length === 0 ||
    !files.every((file) => typeof file === 'string' && file.length > 0) ||
    classifyCoverage(files).class !== 'SOURCE';
}

export function main(argv, env = process.env) {
  const { values } = parseArgv(argv, {
    'changed-files': { type: 'string' }, shard: { type: 'string' },
  }, { allowPositionals: false });
  let files;
  try { files = parseChangedFiles(readFileSync(values['changed-files'], 'utf8')); }
  catch (error) { console.error(`CI admission: unreadable diff; keeping setup (${error.message})`); }
  const setup = requiresSetup(files, { event: env.GITHUB_EVENT_NAME, shard: values.shard, live: env.RMD_AFFECTED_SUITE_LIVE });
  console.error(`CI admission: setup=${setup}; ${setup ? 'real work or uncertainty' : 'coverage owns source tests; no duplicate shard work'}`);
  console.log(setup ? 'true' : 'false');
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
