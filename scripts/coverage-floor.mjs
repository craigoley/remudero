#!/usr/bin/env node
// A historical absolute floor can admit a narrow run; it cannot certify current added lines.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { isMainModule } from './lib/argv.mjs';

export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // BACKSTOP: one daily complete floor.
export const MAX_CANDIDATES = 6; // BACKSTOP: three runs from each existing producer.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function command(root, file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_ARCHIVE_BYTES,
    timeout: 60_000, ...options });
  requireValue(result.status === 0 && !result.error && !result.signal,
    `${file} ${args[0]} failed (${result.status ?? result.error?.code ?? result.signal})`);
  return result.stdout;
}
const git = (root, args) => command(root, 'git', args).trim();
export function suiteCorpus(root, source = 'HEAD') {
  return git(root, ['ls-tree', '-r', '--name-only', source, '--', 'test']).split('\n')
    .filter((path) => /^test\/.*\.test\.ts$/.test(path)).sort();
}
export function context(root, env = process.env) {
  requireValue(git(root, ['status', '--porcelain', '--untracked-files=no']) === '', 'tracked producer/consumer tree is dirty');
  const files = ['package-lock.json', '.nvmrc', 'scripts/coverage-merge-ratchet.mjs',
    'scripts/coverage-floor.mjs', 'scripts/coverage-baseline.json', 'package.json', 'test/setup/tmp-hygiene.ts',
    '.github/workflows/ci.yml', '.github/workflows/coverage-nightly.yml',
    'scripts/test-with-retry.mjs', 'scripts/test-tier-manifest.mjs', 'tsconfig.json'];
  requireValue(readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '') === process.versions.node, 'runtime differs from committed pin');
  const policy = Object.fromEntries(files.map((path) => [path, hash(readFileSync(join(root, path)))]));
  policy.flags = '--enable-source-maps --experimental-test-coverage --test-coverage-exclude=test/** --import tsx --import ./test/setup/tmp-hygiene.ts';
  return { repository: env.GITHUB_REPOSITORY, head: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']), run: String(env.GITHUB_RUN_ID ?? ''),
    attempt: Number(env.GITHUB_RUN_ATTEMPT), node: process.version, platform: process.platform,
    policyDigest: hash(json(policy)) };
}
export function positiveLcov(lcov) {
  requireValue(lcov.trim().endsWith('end_of_record'), 'truncated LCOV');
  const records = lcov.trim().split('end_of_record').filter((row) => row.trim());
  const sources = new Set();
  requireValue(records.length > 0, 'empty LCOV');
  let lines = 0; let branches = 0;
  for (const row of records) {
    const source = row.match(/^SF:(.+)$/m)?.[1];
    const lf = row.match(/^LF:([0-9]+)$/m)?.[1];
    const brf = row.match(/^BRF:([0-9]+)$/m)?.[1];
    requireValue(source && !sources.has(source) && lf !== undefined && brf !== undefined,
      'malformed or duplicate LCOV source');
    const lh = row.match(/^LH:([0-9]+)$/m)?.[1]; const brh = row.match(/^BRH:([0-9]+)$/m)?.[1];
    const da = [...row.matchAll(/^DA:([0-9]+),([0-9]+)$/gm)];
    const brda = [...row.matchAll(/^BRDA:([0-9]+),([0-9]+),([0-9]+),([0-9]+|-)$/gm)];
    requireValue(lh !== undefined && brh !== undefined && Number(lh) <= Number(lf) && Number(brh) <= Number(brf) &&
      da.length === Number(lf) && new Set(da.map((entry) => entry[1])).size === da.length &&
      da.filter((entry) => Number(entry[2]) > 0).length === Number(lh) && brda.length === Number(brf) &&
      new Set(brda.map((entry) => entry.slice(1, 4).join(','))).size === brda.length &&
      brda.filter((entry) => entry[4] !== '-' && Number(entry[4]) > 0).length === Number(brh), 'incomplete LCOV records');
    sources.add(source); lines += Number(lf); branches += Number(brf);
  }
  requireValue(lines > 0 && branches > 0, 'LCOV lacks positive line/branch corpus');
  return { sources: sources.size, lines, branches };
}
export function produce(root, shards, lcov, env = process.env, now = Date.now()) {
  const ctx = context(root, env); const expected = suiteCorpus(root); const seen = new Set();
  requireValue(expected.length > 0 && /^[^/]+\/[^/]+$/.test(ctx.repository ?? '') &&
    /^\d+$/.test(ctx.run) && ctx.attempt >= 1, 'producer identity/corpus unavailable');
  const rows = [];
  for (let n = 1; n <= 8; n++) {
    const path = join(shards, `coverage-shard-${n}`);
    const suites = readFileSync(join(path, 'suites'), 'utf8').trim().split('\n');
    requireValue(readFileSync(join(path, 'test-exit'), 'utf8').trim() === '0', 'nonzero shard exit');
    requireValue(readFileSync(join(path, 'selection'), 'utf8').trim() === 'all', 'partial shard selection');
    requireValue(suites.length > 0 && new Set(suites).size === suites.length && suites.every((suite) => expected.includes(suite) && !seen.has(suite)),
      'unverified, duplicate or empty shard suites');
    suites.forEach((suite) => seen.add(suite)); rows.push({ shard: n, exit: 0, suites });
  }
  requireValue(expected.length === seen.size, 'incomplete full suite union');
  return { version: 1, ...ctx, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    measuredAt: new Date(now).toISOString(), lcovDigest: hash(lcov), corpus: positiveLcov(lcov),
    suitesDigest: hash(json(expected)), shards: rows };
}
export function validateFloor(root, floor, lcov, run, artifact, current, now = Date.now()) {
  requireValue(floor.version === 1 && sha(floor.head) && sha(floor.tree), 'legacy producer');
  requireValue(run.status === 'completed' && run.conclusion === 'success', 'producer run not successful');
  const nightly = run.path === '.github/workflows/coverage-nightly.yml' &&
    ['schedule', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main' &&
    floor.ref === 'refs/heads/main';
  const merged = run.path === '.github/workflows/ci.yml' && run.event === 'merge_group';
  requireValue(nightly || merged, 'untrusted producer');
  requireValue(floor.repository === current.repository && artifact.workflow_run?.repository_id === run.repository?.id &&
    String(run.id) === floor.run && run.run_attempt === floor.attempt && run.head_sha === floor.head &&
    floor.event === run.event && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === floor.head &&
    artifact.name === (nightly ? 'coverage-nightly' : 'coverage-merged') && artifact.expired === false,
    'producer artifact identity mismatch');
  const times = [floor.measuredAt, run.updated_at, artifact.created_at].map(Date.parse);
  requireValue(times.every((time) => Number.isFinite(time) && now >= time && now - time <= MAX_AGE_MS),
    'expired or future floor');
  requireValue(floor.node === current.node && floor.platform === current.platform &&
    floor.policyDigest === current.policyDigest, 'incompatible runtime/dependency/coverage policy');
  requireValue(hash(lcov) === floor.lcovDigest, 'LCOV digest mismatch'); positiveLcov(lcov);
  requireValue(git(root, ['rev-parse', `${floor.head}^{tree}`]) === floor.tree, 'source tree mismatch');
  // A successful merge-group run is usable only after its measured tree is on protected main.
  // BACKSTOP: 256 protected-main ancestors. An older unproven tree falls back to full.
  const mainTrees = git(root, ['log', '-256', '--format=%T', 'origin/main']).split('\n');
  requireValue(mainTrees.includes(floor.tree), 'producer tree not on protected main ancestry');
  const expected = suiteCorpus(root, floor.head); const seen = new Set();
  requireValue(expected.length > 0 && hash(json(expected)) === floor.suitesDigest &&
    Array.isArray(floor.shards) && floor.shards.length === 8, 'missing full suite evidence');
  for (let n = 1; n <= 8; n++) {
    const row = floor.shards[n - 1];
    requireValue(row?.shard === n && row.exit === 0 && Array.isArray(row.suites) && row.suites.length > 0 && new Set(row.suites).size === row.suites.length &&
      row.suites.every((suite) => expected.includes(suite) && !seen.has(suite)), 'partial or failed shard evidence');
    row.suites.forEach((suite) => seen.add(suite));
  }
  requireValue(seen.size === expected.length, 'incomplete producer suite union');
  return true;
}
function savePin(dir, pin) {
  mkdirSync(dir, { recursive: true });
  const sealed = { ...pin, digest: hash(json(pin)) };
  writeFileSync(join(dir, 'decision.json'), json(sealed) + '\n'); return sealed;
}
export function selectFloor(root, out, env = process.env, transport, now = Date.now()) {
  const current = context(root, env);
  const full = (reason) => savePin(out, { version: 1, current, mode: 'all', reason });
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || env.RMD_AFFECTED_SUITE_LIVE !== '1') return full('live flag off or final full integration event');
  const gh = transport ?? ((args, binary = false) => command(root, 'gh', args, binary ? { encoding: null } : {}));
  const reasons = [];
  try {
    const candidates = [];
    for (const [workflow, event] of [['coverage-nightly.yml', null], ['ci.yml', 'merge_group']]) {
      const query = `repos/${current.repository}/actions/workflows/${workflow}/runs?status=success&per_page=3${event ? `&event=${event}` : '&branch=main'}`;
      const result = JSON.parse(gh(['api', query]));
      requireValue(Array.isArray(result.workflow_runs), 'unreadable producer run list');
      candidates.push(...result.workflow_runs);
    }
    candidates.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    for (const run of candidates.slice(0, MAX_CANDIDATES)) {
      const temp = mkdtempSync(join(tmpdir(), 'rmd-floor-'));
      try {
        const artifacts = JSON.parse(gh(['api', `repos/${current.repository}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts;
        requireValue(Array.isArray(artifacts), 'unreadable artifact list');
        const wanted = run.event === 'merge_group' ? 'coverage-merged' : 'coverage-nightly';
        const matches = artifacts.filter((artifact) => artifact.name === wanted);
        requireValue(matches.length === 1, 'missing or ambiguous floor artifact'); const artifact = matches[0];
        requireValue(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES &&
          /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ''), 'archive size/digest unavailable');
        const archive = gh(['api', `repos/${current.repository}/actions/artifacts/${artifact.id}/zip`], true);
        requireValue(hash(archive) === artifact.digest.slice(7), 'archive digest mismatch');
        writeFileSync(join(temp, 'floor.zip'), archive);
        const entries = command(root, 'unzip', ['-Z1', join(temp, 'floor.zip')]).trim().split('\n');
        requireValue(entries.length >= 2 && entries.length <= 3 && new Set(entries).size === entries.length &&
          entries.includes('lcov.info') && entries.includes('coverage-floor.json') &&
          entries.every((entry) => ['lcov.info', 'coverage-floor.json', 'coverage-nightly-summary.json'].includes(entry)), 'unsafe archive entries');
        const listing = command(root, 'unzip', ['-l', join(temp, 'floor.zip')]);
        const bytes = listing.match(/^\s*([0-9]+)\s+[0-9]+ files$/m)?.[1];
        requireValue(bytes !== undefined && Number(bytes) <= MAX_ARCHIVE_BYTES, 'expanded archive bound');
        command(root, 'unzip', ['-q', join(temp, 'floor.zip'), '-d', temp]);
        const floor = JSON.parse(readFileSync(join(temp, 'coverage-floor.json'), 'utf8'));
        const lcov = readFileSync(join(temp, 'lcov.info'), 'utf8');
        validateFloor(root, floor, lcov, run, artifact, current, now);
        mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'lcov.info'), lcov);
        return savePin(out, { version: 1, current, mode: 'eligible', reason: 'fresh complete compatible floor', floor, run, artifact });
      } catch (error) { reasons.push(`${run.id}: ${error.message}`); }
      finally { rmSync(temp, { recursive: true, force: true }); }
    }
  } catch (error) { reasons.push(error.message); }
  return full(`no verified floor; ${reasons.join('; ') || 'no successful producer candidates'}`);
}
export function verifyPin(root, dir, env = process.env, now = Date.now()) {
  const { digest, ...pin } = JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8'));
  requireValue(hash(json(pin)) === digest && json(pin.current) === json(context(root, env)), 'pin digest/current execution mismatch');
  requireValue(['all', 'eligible', 'narrow'].includes(pin.mode), 'unknown decision');
  if (pin.mode !== 'all') validateFloor(root, pin.floor, readFileSync(join(dir, 'lcov.info'), 'utf8'), pin.run, pin.artifact, pin.current, now);
  if (pin.mode === 'narrow') requireValue(Array.isArray(pin.shards) && pin.shards.length === 8 &&
    pin.shards.every((suites) => Array.isArray(suites) && suites.length > 0 && suites.every((suite) => suiteCorpus(root).includes(suite))), 'unverified narrow decision');
  return pin;
}
export function finalizePin(root, dir, suitesPath, env = process.env) {
  const pin = verifyPin(root, dir, env);
  if (pin.mode === 'all') return savePin(dir, pin);
  const suites = readFileSync(suitesPath, 'utf8').trim().split('\n'); const corpus = suiteCorpus(root);
  if (suites[0] === 'full' || suites.length === 0 || !suites.every((suite) => corpus.includes(suite)) || new Set(suites).size !== suites.length)
    return savePin(dir, { version: 1, current: pin.current, mode: 'all', reason: 'selector did not produce a verified narrow set' });
  const shards = [];
  for (let n = 1; n <= 8; n++) {
    const result = spawnSync(process.execPath, ['scripts/test-tier-manifest.mjs', '--select-candidates', suitesPath,
      '--shard', `${n}/8`, '--base', 'HEAD^1'], { cwd: root, encoding: 'utf8' });
    const selected = result.stdout?.trim().split('\n') ?? [];
    if (result.status !== 0 || !selected[0] || !selected.every((suite) => suites.includes(suite)))
      return savePin(dir, { version: 1, current: pin.current, mode: 'all', reason: `narrow shard ${n} empty or unreadable; global full fallback` });
    shards.push(selected);
  }
  const union = shards.flat();
  requireValue(new Set(union).size === suites.length && union.length === suites.length, 'narrow shard union mismatch');
  return savePin(dir, { ...pin, mode: 'narrow', shards });
}
// The producer runs alongside shard setup. Waiting consumes the shard's existing 49-minute
// bound, never a new dependency before it. Four reads at >=180-second intervals, at most 10m.
export function waitForPinArtifact(root, env = process.env, transport, clock = {
  now: () => performance.now(), sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}) {
  const repository = env.GITHUB_REPOSITORY, run = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') &&
    /^[1-9][0-9]*$/.test(run ?? '') && /^[1-9][0-9]*$/.test(attempt ?? '') && Number.isSafeInteger(Number(run)) && sha(env.RMD_COVERAGE_RUN_HEAD),
    'pin readiness requires the current repository/run/attempt/head');
  const name = `coverage-floor-pin-${attempt}`;
  const deadline = clock.now() + 600_000;
  for (let n = 0; n < 4; n++) {
    const started = clock.now();
    requireValue(started < deadline, 'pin publication timed out inside the shard budget');
    const args = ['api', `repos/${repository}/actions/runs/${run}/artifacts?name=${name}&per_page=2`];
    const response = JSON.parse(transport ? transport(args) : command(root, 'gh', args, {
      timeout: Math.min(60_000, deadline - started), maxBuffer: 1024 * 1024,
    }));
    requireValue(clock.now() < deadline, 'pin publication timed out inside the shard budget');
    requireValue(Number.isInteger(response.total_count) && response.total_count >= 0 &&
      Array.isArray(response.artifacts) && response.artifacts.length === response.total_count &&
      response.total_count <= 1, 'ambiguous or incomplete pin artifact response');
    if (response.total_count === 1) {
      const artifact = response.artifacts[0];
      requireValue(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.name === name &&
        artifact.expired === false && artifact.workflow_run?.id === Number(run) &&
        artifact.workflow_run?.head_sha === env.RMD_COVERAGE_RUN_HEAD &&
        Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= MAX_ARCHIVE_BYTES && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ''),
        'pin artifact identity/size/digest mismatch');
      return String(artifact.id); // Official downloader verifies the immutable archive digest.
    }
    const wake = Math.min(deadline, started + 180_000);
    if (clock.now() < wake) clock.sleep(wake - clock.now());
  }
  if (clock.now() < deadline) clock.sleep(deadline - clock.now());
  throw new Error('pin publication timed out inside the shard budget');
}
export function main(argv, env = process.env, root = REPO_ROOT) {
  const [verb, dir, third] = argv;
  if (verb === 'wait-pin') console.log(waitForPinArtifact(root, env));
  else if (verb === 'record') {
    const exits = Array.from({ length: 8 }, (_, n) => readFileSync(join(root, 'coverage-shards', `coverage-shard-${n + 1}`, 'test-exit'), 'utf8').trim());
    requireValue(exits.every((code) => /^[0-9]+$/.test(code)), 'unreadable producer exits');
    if (exits.some((code) => code !== '0')) {
      writeFileSync(join(dir, 'coverage-floor.json'), json({ version: 0, reason: 'red measurement; not an admissible floor', shardExits: exits }) + '\n');
      return 0; // Preserve the diagnostic upload; the existing terminal test-exit gate still fails.
    }
    return main(['produce', dir, third], env, root);
  } else if (verb === 'produce') {
    const lcov = readFileSync(third, 'utf8');
    writeFileSync(join(dir, 'coverage-floor.json'), json(produce(root, join(root, 'coverage-shards'), lcov, env)) + '\n');
  } else if (verb === 'select') console.log(selectFloor(root, dir, env).reason);
  else if (verb === 'finalize') console.log(finalizePin(root, dir, third, env).reason);
  else if (verb === 'mode') console.log(verifyPin(root, dir, env).mode);
  else if (verb === 'shard') {
    const pin = verifyPin(root, dir, env); const n = Number(third);
    requireValue(Number.isInteger(n) && n >= 1 && n <= 8 && pin.mode !== 'eligible', 'unfinalized/invalid shard decision');
    if (pin.mode === 'narrow') console.log(pin.shards[n - 1].join('\n'));
  } else if (verb === 'verify-shards') {
    const pin = verifyPin(root, dir, env);
    for (let n = 1; n <= 8; n++) requireValue(readFileSync(join(third, `coverage-shard-${n}`, 'selection'), 'utf8').trim() === pin.mode,
      'shards disagree with globally pinned selection');
  } else throw new Error('coverage-floor: expected produce/select/finalize/mode/shard/verify-shards/wait-pin');
  return 0;
}
if (isMainModule(import.meta.url)) { try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`coverage-floor: REFUSED: ${error.message}`); process.exitCode = 1; } }
