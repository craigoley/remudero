// Qualify known workload requirements before starting a contained suite.
// Refusal preserves the suite for compatible/full assurance; nothing is skipped.
import {spawnSync} from 'node:child_process';
import {lstatSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const RULES = [
  ['test/merge-lcov.test.ts', 'an oversized coverage manifest is sparse but still hits the real byte bound', ['sparse-manifest']],
  ['test/coverage-batches.test.ts', 'testSlotProcessFacts(process.pid)!.start', ['process-start']],
  ['test/workspace-usage.test.ts', 'workspace seed metadata records APFS materialization without claiming unique physical disk cost', ['dependency-fixture-write']],
  ['test/mac-janitor-dependency-health.test.ts', 'Janitor dependency health: shared node_modules and runner symlinks are read without repair', ['dependency-fixture-write', 'shell-input']],
  ['test/dependency-seeds.test.ts', 'dependency seed preserves occupied installs while refusing incomplete and dangling node_modules', ['dependency-fixture-write']],
  ['test/deploy/janitor-journal-continuity.test.ts', 'a pinned Janitor journal keeps existing history and one shared-storage recovery inode', ['shell-input']],
];
const CAPABILITIES = new Set(['sparse-manifest', 'process-start', 'dependency-fixture-write', 'shell-input']);

export function declaredScopedRequirements(root, files) {
  const requirements = [], declarations = [];
  for (const file of files) {
    const rule = RULES.find(row => row[0] === file);
    if (!rule) { declarations.push({file, scope: 'no-special-requirements-declared'}); continue; }
    const path = resolve(root, file), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 ** 2)
      throw new Error(`context declaration input is not a bounded regular suite: ${file}`);
    if (!readFileSync(path, 'utf8').includes(rule[1]))
      throw new Error(`context declaration witness changed; qualification UNKNOWN: ${file}`);
    declarations.push({file, witness: rule[1], requirements: rule[2]});
    requirements.push(...rule[2]);
  }
  return {requirements: [...new Set(requirements)].sort(), declarations,
    scope: 'declared-special-requirements-only; no universal compatibility claim'};
}

// Runs in the same sandbox, filesystem, environment and Node loader as the suite.
// File sizes are logical bytes; allocated blocks use the native 512-byte unit.
export async function nativeContextProbe({requirements, volume, processFactsUrl}) {
  const fs = await import('node:fs');
  const {join} = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const root = fs.mkdtempSync(join(volume, 'compat-'));
  const observations = {};
  try {
    for (const name of requirements) {
      if (name === 'sparse-manifest') {
        const path = join(root, 'sparse');
        fs.writeFileSync(path, '');
        fs.truncateSync(path, 64 * 1024 ** 2 + 1);
        const st = fs.statSync(path), allocatedBytes = st.blocks * 512;
        observations[name] = {supported: st.size === 64 * 1024 ** 2 + 1 && allocatedBytes <= 64 * 1024,
          logicalBytes: st.size, pathAllocatedBytes: allocatedBytes};
        fs.unlinkSync(path);
      } else if (name === 'dependency-fixture-write') {
        const dir = join(root, 'node_modules');
        fs.mkdirSync(dir);
        try {
          fs.writeFileSync(join(dir, 'synthetic-fixture'), 'probe');
          observations[name] = {supported: true};
        } catch (error) {
          observations[name] = {supported: false, reason: error.code ?? 'write-unavailable'};
        }
      } else if (name === 'process-start') {
        const {testSlotProcessFacts} = await import(processFactsUrl);
        const facts = testSlotProcessFacts(process.pid);
        observations[name] = {supported: typeof facts?.start === 'string' && facts.start.length > 0,
          reason: facts?.start ? 'actual-self-process-start-observed' : 'self-process-start-unavailable'};
      } else if (name === 'shell-input') {
        // Bash3 materializes both redirections in global /tmp even with TMPDIR.
        // Probe the installed selected shell inside containment; never allow /tmp.
        const code = 'read -r a <<\'RMD_INPUT\'\ncontrol\nRMD_INPUT\nread -r b <<< control\n[ "$a" = control ] && [ "$b" = control ]';
        const result = spawnSync('bash', ['-c', code], {env: {...process.env, TMPDIR: root},
          encoding: 'utf8', timeout: 2000, maxBuffer: 4096});
        observations[name] = {supported: result.status === 0 && !result.signal && !result.error,
          reason: result.status === 0 ? 'contained-shell-input-observed' : 'contained-shell-input-unavailable'};
      }
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
  return {version: 1, observations, temporaryProbeRemoved: true};
}

export function contextProbeSource(input) {
  if (!Array.isArray(input.requirements) || input.requirements.some(name => !CAPABILITIES.has(name)))
    throw new Error('unknown context capability; qualification refused');
  return `import {nativeContextProbe} from ${JSON.stringify(import.meta.url)};const result=await nativeContextProbe(${JSON.stringify(input)});console.log(JSON.stringify(result));`;
}

export function qualifyScopedContext({root, files, volume, profile, env, node = process.execPath,
  launch = profile === undefined ? [] : ['/usr/bin/sandbox-exec', '-p', profile]} = {}) {
  const declared = declaredScopedRequirements(root, files);
  if (!declared.requirements.length) return {...declared, state: 'no-special-requirements-declared', probesRun: false};
  const source = contextProbeSource({requirements: declared.requirements, volume,
    processFactsUrl: pathToFileURL(resolve(root, 'src/lib/test-slot.ts')).href});
  const argv = [...launch, node, '--import', 'tsx', '--input-type=module', '-e', source];
  const child = spawnSync(argv[0], argv.slice(1), {cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024});
  const childClosure = child.signal || (child.error && child.error.code !== 'ENOENT') ||
    (child.status === null && !child.error) ? 'unproven' : 'closed';
  const unknown = reason => ({...declared, state: 'refused', probesRun: true, reason, childClosure,
    requiredFullSuitesRemain: files, qualificationOnly: true});
  if (child.status !== 0 || child.signal || child.error)
    return unknown(`native-context-probe-unavailable:${child.error?.code ?? child.signal ?? child.status}`);
  let result;
  try { result = JSON.parse(child.stdout); }
  catch { return unknown('native-context-probe-unreadable'); }
  if (result?.version !== 1 || result.temporaryProbeRemoved !== true)
    return unknown('native-context-probe-incomplete');
  const refused = declared.requirements.filter(name => result.observations?.[name]?.supported !== true);
  return {...declared, observations: result.observations, state: refused.length ? 'refused' : 'qualified',
    refusedRequirements: refused, probesRun: true, childClosure,
    qualificationOnly: true, requiredFullSuitesRemain: files};
}
