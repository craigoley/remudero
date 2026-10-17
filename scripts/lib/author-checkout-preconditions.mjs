import {lstatSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {authorDependencyProvenance} from './author-dependency-provenance.mjs';
import {spawnWithinBudget} from './bounded-subprocess.mjs';

// Preserve the maintained test containment, not arbitrary environment Git configuration.
// Each allowed value only disables background work or rewrites pushes to a dead local path.
function containmentConfigOnly(env) {
  const keys = Object.keys(env).filter(key => key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/.test(key));
  if (!keys.length) return true;
  if (!/^(0|[1-9][0-9]?)$/.test(env.GIT_CONFIG_COUNT ?? '')) return false;
  const count = Number(env.GIT_CONFIG_COUNT);
  if (count > 64 || keys.length !== 1 + count * 2) return false;
  const pushKey = 'url.file:///nonexistent/W1-T4805-live-github-push-blocked-by-the-test-suite/.pushInsteadOf';
  for (let i = 0; i < count; i++) {
    const key = env['GIT_CONFIG_KEY_' + i], value = env['GIT_CONFIG_VALUE_' + i];
    if (!((key === 'gc.auto' && value === '0') || (key === 'receive.autogc' && value === 'false') ||
        (key === pushKey && ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].includes(value)))) return false;
  }
  return true;
}

/** Opt-in, read-only setup diagnostic. No fetch/import, ref/config write, install, lease or test. */
export function checkAuthorCheckout(root, {head, upstream, bundles = [], budgetMs = 10000} = {}, deps = {}) {
  const startedMono = performance.now(), failures = [], observations = [], run = deps.spawn ?? spawnWithinBudget;
  const result = () => ({schema: 'rmd-author-checkout-preconditions/v1',
    state: failures.some(x => x.state === 'unknown') ? 'unknown' : failures.length ? 'blocked' : 'ready',
    failures, observations, elapsedMs: Math.ceil(performance.now() - startedMono),
    executionAllowed: false, authorPass: false, dispatchAllowed: false, dependencyBytesAttested: false,
    upstreamFreshnessVerified: false, scope: 'Local setup metadata only; normal fresh fetch, genuine admission and current-head gates remain required.'});
  const refuse = (code, state = 'blocked') => failures.push({code, state});
  if (!/^[a-f0-9]{40}$/.test(head ?? '') || upstream !== 'https://github.com/craigoley/remudero.git' ||
      !Array.isArray(bundles) || bundles.length > 16 || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10000) {
    refuse('invalid-explicit-head-upstream-or-budget'); return result();
  }
  const env = {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS'].includes(key)) {
    refuse('git-environment-override'); return result();
  }
  if (!containmentConfigOnly(env)) { refuse('git-environment-override'); return result(); }
  const git = (args, allow = [0]) => {
    const r = run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      {cwd: root, env, startedMono, budgetMs, encoding: 'utf8', maxBuffer: 1024 * 1024});
    if (r.error || r.signal || !Number.isInteger(r.status) || !allow.includes(r.status)) {
      throw new Error('git-observation-unavailable');
    }
    return {text: String(r.stdout ?? '').trim(), status: r.status};
  };
  try {
    root = realpathSync(root);
    const actual = git(['rev-parse', 'HEAD']).text;
    if (actual !== head) refuse('head-mismatch');
    const initialStatus = git(['status', '--porcelain', '--untracked-files=all']).text;
    if (initialStatus) refuse('checkout-not-clean');
    const origin = git(['remote', 'get-url', 'origin'], [0, 2]);
    // Do not disclose a wrong origin, which might contain credentials.
    if (origin.status !== 0 || origin.text !== upstream) refuse('wrong-or-missing-upstream');
    const base = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], [0, 128]);
    if (base.status !== 0) refuse('missing-origin-main');
    else observations.push({kind: 'base', head: actual, main: base.text,
      behind: Number(git(['rev-list', '--count', 'HEAD..refs/remotes/origin/main']).text)});
    for (const spec of bundles) {
      if (!spec || typeof spec.path !== 'string' || !/^[a-f0-9]{40}$/.test(spec.head ?? '')) { refuse('invalid-bundle-spec'); continue; }
      const path = resolve(spec.path), before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) { refuse('bundle-not-regular'); continue; }
      const advertised = git(['bundle', 'list-heads', path]).text.split('\n').filter(Boolean).map(line => {
        const split = line.indexOf(' '); return {head: line.slice(0, split), ref: line.slice(split + 1)};
      });
      const matches = advertised.filter(x => x.head === spec.head);
      if (!matches.length) refuse('bundle-head-not-advertised');
      const verified = git(['bundle', 'verify', path], [0, 1]);
      if (verified.status !== 0) refuse('bundle-invalid-or-prerequisite-missing');
      const after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse('bundle-changed', 'unknown');
      observations.push({kind: 'bundle', matches, prerequisitesPresent: verified.status === 0,
        fileIdentity: {dev: before.dev, ino: before.ino, bytes: before.size}, imported: false});
    }
    const dependency = (deps.dependency ?? authorDependencyProvenance)(root);
    observations.push({kind: 'dependency', ...dependency});
    if (dependency.state !== 'present') refuse('dependency-metadata-or-tools-unavailable', 'unknown');
    if (git(['rev-parse', 'HEAD']).text !== actual || git(['status', '--porcelain', '--untracked-files=all']).text !== initialStatus) refuse('source-changed-during-observation', 'unknown');
  } catch { refuse('local-observation-unavailable', 'unknown'); }
  return result();
}
