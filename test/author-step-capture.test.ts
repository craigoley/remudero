import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitRepo } from './helpers/git-repo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/lib/author-step-capture.mjs');
const mod = (existsSync(SCRIPT) ? await import(pathToFileURL(SCRIPT).href) : {}) as {
  captureStepSync: (file: string, args: string[], options: Record<string, unknown>) => {
    status: number | null; signal: string | null; error?: Error; stdout: string; stderr: string; outputComplete: boolean;
  };
};
function fixture() {
  const repo = gitRepo({ kind: 'author-capture' });
  const root = join(repo.dir, 'logs');
  mkdirSync(root, { mode: 0o700 });
  return { root, stdoutPath: join(root, 'stdout.log'), stderrPath: join(root, 'stderr.log'), resultPath: join(root, 'result.json') };
}

test('author step capture refuses malformed native receipts despite a successful transport exit', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  for (const receipt of [
    { version: 0, status: 0, outputComplete: true },
    { version: 1, status: 0, outputComplete: 'complete' },
    { version: 1, status: '0', outputComplete: true },
    { version: 1, status: 0.5, outputComplete: true },
    { version: 1, status: 7, signal: null, outputComplete: true },
  ]) {
    const f = fixture();
    let captures = 0;
    const result = mod.captureStepSync(process.execPath, ['-e', ''], {
      ...f, cwd: ROOT,
      spawnCapture(_file: string, _args: string[], options: { input: string }) {
        const request = JSON.parse(options.input);
        assert.equal(request.resultPath, f.resultPath);
        captures++;
        // The transport seam supplies the artifact; production still reads and validates it.
        writeFileSync(f.resultPath, JSON.stringify(receipt), { flag: 'wx' });
        writeFileSync(f.stdoutPath, 'receipt diagnostic witness\n', { flag: 'wx' });
        return { status: 0, signal: null };
      },
    });
    assert.equal(captures, 1, 'the controlled transport must actually supply the measured receipt');
    assert.match(result.stdout, /receipt diagnostic witness/);
    if (receipt.version === 1 && receipt.status === 7) {
      assert.equal(result.status, 7, 'positive control: native failure survives transport success');
      assert.equal(result.error, undefined);
      assert.equal(result.outputComplete, true);
    } else {
      assert.equal((result.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_CAPTURE_RECEIPT');
      assert.equal(result.outputComplete, false, 'a transport exit zero cannot certify an invalid receipt');
    }
  }
});

test('author step capture preserves native failure, signal and spawn error with private logs', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  for (const kind of ['failed', 'signalled', 'missing']) {
    const f = fixture();
    const result = mod.captureStepSync(kind === 'missing' ? join(f.root, 'missing-command') : process.execPath,
      kind === 'missing' ? [] : ['-e', `console.log('native stdout'); console.error('native stderr'); ${kind === 'failed' ? 'process.exitCode = 7' : "process.kill(process.pid, 'SIGTERM')"}`],
      { ...f, cwd: ROOT, env: process.env });
    assert.equal(result.status, kind === 'failed' ? 7 : null);
    assert.equal(result.signal, kind === 'signalled' ? 'SIGTERM' : null);
    if (kind === 'missing') assert.equal((result.error as NodeJS.ErrnoException).code, 'ENOENT');
    else {
      assert.match(result.stdout, /native stdout/);
      assert.match(result.stderr, /native stderr/);
    }
    for (const path of [f.stdoutPath, f.stderrPath, f.resultPath]) assert.equal(statSync(path).mode & 0o077, 0);
  }
});

test('author step capture transports a large file list without packing it into one OS argument', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  const f = fixture();
  const files = Array.from({ length: 3200 }, (_, i) => `test/${'x'.repeat(43)}-${i}.test.ts`);
  const code = `const assert=require('node:assert/strict'); const args=process.argv.slice(1); assert.equal(args.length,3200); assert.equal(args[0],${JSON.stringify(files[0])}); assert.equal(args.at(-1),${JSON.stringify(files.at(-1))}); console.log('large argv native witness'); process.exitCode=7;`;
  assert.ok(Buffer.byteLength(JSON.stringify({ args: files })) > 131072, 'positive corpus must exceed Linux single-argument space');
  const result = mod.captureStepSync(process.execPath, ['-e', code, ...files], { ...f, cwd: ROOT });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 7, 'real child verdict, not the transport exit, must survive');
  assert.match(result.stdout, /large argv native witness/);
  assert.equal(JSON.parse(readFileSync(f.resultPath, 'utf8')).status, 7);
});

test('author step capture bounds total stored output without certifying a truncated success', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  const f = fixture();
  const result = mod.captureStepSync(process.execPath, ['-e', "process.stdout.write('x'.repeat(65536)); process.stderr.write('y'.repeat(65536));"],
    { ...f, cwd: ROOT, env: process.env, maxBytes: 1024 });
  assert.equal((result.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_OUTPUT_LIMIT');
  assert.equal(statSync(f.stdoutPath).size + statSync(f.stderrPath).size, 1024);
  const outcome = JSON.parse(readFileSync(f.resultPath, 'utf8'));
  assert.equal(outcome.outputComplete, false);
  assert.ok(outcome.observedBytes > outcome.storedBytes);
});

test('author step capture enforces a finite runtime and refuses invalid bounds or reused logs', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  const f = fixture();
  const result = mod.captureStepSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { ...f, cwd: ROOT, runtimeMs: 1000 });
  assert.equal((result.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_STEP_TIMEOUT');
  assert.equal(result.signal, 'SIGTERM');
  const invalid = fixture();
  const bad = mod.captureStepSync(process.execPath, ['-e', ''], { ...invalid, cwd: ROOT, maxBytes: 0 });
  assert.equal((bad.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_CAPTURE_TRANSPORT');
  assert.equal(existsSync(invalid.stdoutPath), false, 'invalid bounds never start an unbounded capture');
  const reused = mod.captureStepSync(process.execPath, ['-e', ''], { ...f, cwd: ROOT });
  assert.equal((reused.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_CAPTURE_TRANSPORT');
  assert.equal(JSON.parse(readFileSync(f.resultPath, 'utf8')).error.code, 'ERR_AUTHOR_STEP_TIMEOUT');
});

test('author step capture kills its own signal-resistant descendant group after the bounded grace', () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  const f = fixture();
  const descendant = "process.on('SIGTERM',()=>{}); console.log('owned descendant witness'); setInterval(()=>{},1000);";
  const code = `process.on('SIGTERM',()=>{}); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const result = mod.captureStepSync(process.execPath, ['-e', code], { ...f, cwd: ROOT, runtimeMs: 1000 });
  assert.match(result.stdout, /owned descendant witness/);
  assert.equal((result.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_STEP_TIMEOUT');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(JSON.parse(readFileSync(f.resultPath, 'utf8')).outputComplete, false);
});

test('author step capture writes live output and survives loss of its waiting parent', async () => {
  assert.equal(typeof mod.captureStepSync, 'function');
  const f = fixture();
  const release = join(f.root, 'release');
  const code = `console.log('live output witness'); console.error('live stderr witness'); const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exitCode=7}},10);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e',
    `import {captureStepSync} from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; captureStepSync(process.execPath,['-e',${JSON.stringify(code)}],${JSON.stringify({ ...f, cwd: ROOT, runtimeMs: 10000 })});`],
  { cwd: ROOT, stdio: 'ignore' });
  const closed = new Promise<string | null>((resolve) => parent.once('close', (_code, signal) => resolve(signal)));
  const waitFor = async (predicate: () => boolean) => {
    for (let turn = 0; turn < 500 && !predicate(); turn++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'bounded native witness never arrived');
  };
  try {
    await waitFor(() => existsSync(f.stdoutPath) && readFileSync(f.stdoutPath, 'utf8').includes('live output witness'));
    assert.equal(existsSync(f.resultPath), false, 'live output is not a completed result');
    assert.equal(parent.kill('SIGKILL'), true);
    assert.equal(await closed, 'SIGKILL');
    writeFileSync(release, 'release');
    await waitFor(() => existsSync(f.resultPath));
    assert.equal(JSON.parse(readFileSync(f.resultPath, 'utf8')).status, 7);
    assert.match(readFileSync(f.stderrPath, 'utf8'), /live stderr witness/);
  } finally {
    writeFileSync(release, 'release');
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  }
});

const PARENT_ENV = 'RMD_AUTHOR_CAPTURE_PARENT_PID';

test('author step capture parent tracking is opt-in or inherited only from its immediate parent', () => {
  const previous = process.env[PARENT_ENV];
  try {
    for (const entry of [
      { marker: undefined, option: undefined, tracked: false },
      { marker: 'foreign-owner', option: undefined, tracked: false },
      { marker: String(process.pid), option: undefined, tracked: false },
      { marker: String(process.ppid), option: undefined, tracked: true },
      { marker: String(process.ppid), option: false, tracked: false },
      { marker: undefined, option: true, tracked: true },
    ]) {
      if (entry.marker === undefined) delete process.env[PARENT_ENV];
      else process.env[PARENT_ENV] = entry.marker;
      const f = fixture(); let calls = 0;
      const result = mod.captureStepSync(process.execPath, ['-e', ''], { ...f, cwd: ROOT,
        // An injected child environment must not activate inheritance in this caller.
        env: { ...process.env, [PARENT_ENV]: String(process.ppid) }, trackParent: entry.option,
        spawnCapture(_file: string, _args: string[], options: { input: string; detached?: boolean; stdio?: string[] }) {
          calls++;
          const config = JSON.parse(options.input);
          assert.equal(config.trackParent, entry.tracked);
          assert.equal(config.parentPid, entry.tracked ? process.pid : null);
          assert.equal(options.detached, entry.tracked ? true : undefined);
          assert.deepEqual(options.stdio, entry.tracked ? ['pipe', 'inherit', 'inherit'] : undefined);
          writeFileSync(f.resultPath, JSON.stringify({ version: 1, status: 0, signal: null, outputComplete: true }));
          return { status: 0, signal: null };
        } });
      assert.equal(calls, 1); assert.equal(result.error, undefined); assert.equal(result.status, 0);
    }
    assert.throws(() => mod.captureStepSync(process.execPath, [], { trackParent: 'true' }), /boolean/);
  } finally {
    if (previous === undefined) delete process.env[PARENT_ENV]; else process.env[PARENT_ENV] = previous;
  }
});

test('parent-tracked capture preserves transport and receipt failures rather than certifying completion', () => {
  for (const kind of ['error', 'signal', 'exit', 'json']) {
    const f = fixture();
    const result = mod.captureStepSync(process.execPath, [], { ...f, cwd: ROOT, trackParent: true,
      spawnCapture() {
        if (kind === 'json') writeFileSync(f.resultPath, '{');
        return { status: kind === 'exit' ? 3 : kind === 'json' ? 0 : null,
          signal: kind === 'signal' ? 'SIGKILL' : null,
          ...(kind === 'error' ? { error: Object.assign(new Error('owned transport refused'), { code: 'EACCES' }) } : {}) };
      } });
    assert.equal(result.outputComplete, false);
    assert.ok(result.error);
    if (kind === 'error') assert.equal((result.error as NodeJS.ErrnoException).code, 'EACCES');
    if (kind === 'signal' || kind === 'exit') assert.equal((result.error as NodeJS.ErrnoException).code, 'ERR_AUTHOR_CAPTURE_TRANSPORT');
  }
});

test('parent-tracked capture binds its real owner and marks only its owned native child', () => {
  const f = fixture();
  const code = `require('node:assert/strict').equal(process.env[${JSON.stringify(PARENT_ENV)}],String(process.ppid)); console.log('owned parent marker'); process.exitCode=7;`;
  const result = mod.captureStepSync(process.execPath, ['-e', code], { ...f, cwd: ROOT, trackParent: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 7); assert.equal(result.outputComplete, true);
  assert.match(result.stdout, /owned parent marker/);
  const native = JSON.parse(readFileSync(f.resultPath, 'utf8'));
  assert.equal(native.parentTracking.ownerPid, process.pid);
  assert.equal(native.parentTracking.ownerLost, false);
  assert.ok(native.parentTracking.helperPid > 0 && native.parentTracking.childPid > 0);
});

type OwnedReady = { ownerPid: number; helperPid: number; childPid: number; descendantPid: number };
async function boundedWait(predicate: () => boolean, message: string, boundMs = 5000) {
  const deadline = Date.now() + boundMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
}
function pidClosed(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'readback requires an observed positive PID');
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}

test('a closed author leader cannot leave a disconnected reader group or certify success', async () => {
  const f = fixture(), readyPath = join(f.root, 'disconnected-reader.json');
  // Self-expiration also bounds the negative control against the old capture implementation.
  const reader = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));
    process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(91),12000);`;
  const leader = `const fs=require('node:fs');
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(reader)},${JSON.stringify(readyPath)}],{stdio:'ignore'}).unref();
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyPath)})){clearInterval(timer);process.exit(0)}},10);`;
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: 'ignore' });
  const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
  let pid: number | undefined;
  try {
    const result = mod.captureStepSync(process.execPath, ['-e', leader], { ...f, cwd: ROOT, runtimeMs: 15000 });
    pid = Number(readFileSync(readyPath, 'utf8'));
    assert.equal(result.status, 0, 'preserve the leader verdict separately from incomplete group closure');
    assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ERR_AUTHOR_DESCENDANTS_ALIVE');
    assert.equal(result.outputComplete, false);
    assert.equal(pidClosed(pid), true, 'the disconnected resistant reader must be gone before publication');
    assert.equal(pidClosed(unrelated.pid!), false, 'a different process group must stay untouched');
    assert.equal(JSON.parse(readFileSync(f.resultPath, 'utf8')).error.code, 'ERR_AUTHOR_DESCENDANTS_ALIVE');
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
    await unrelatedClosed;
    if (pid !== undefined) await boundedWait(() => pidClosed(pid!), 'self-expiring owned reader did not close', 14000);
  }
});

test('author step capture allows natural descendant shutdown without extending its runtime', () => {
  for (const bounded of [false, true]) {
    const f = fixture(), ready = join(f.root, 'draining.pid'), natural = join(f.root, 'natural-exit');
    const reader = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
      setTimeout(()=>{fs.writeFileSync(${JSON.stringify(natural)},'closed naturally');process.exit(0)},${bounded ? 1200 : 200});`;
    const leader = `const fs=require('node:fs');
      require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(reader)}],{stdio:'ignore'}).unref();
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0)}},5);`;
    const result = mod.captureStepSync(process.execPath, ['-e', leader], { ...f, cwd: ROOT, runtimeMs: bounded ? 500 : 10000 });
    if (bounded) {
      assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ERR_AUTHOR_STEP_TIMEOUT');
      assert.equal(result.outputComplete, false, 'normal shutdown does not extend the original runtime');
      assert.equal(existsSync(natural), false, 'runtime expiry still terminates the owned group');
    } else {
      assert.equal(result.status, 0);
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.outputComplete, true);
      assert.equal(readFileSync(natural, 'utf8'), 'closed naturally');
    }
    assert.equal(pidClosed(Number(readFileSync(ready, 'utf8'))), true, 'the owned descendant must close before returning');
  }
});

function resistantReader(readyPath: string) {
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{});
    const [ready,owner,helper]=process.argv.slice(1);
    fs.writeFileSync(ready+'.next',JSON.stringify({ownerPid:Number(owner),helperPid:Number(helper),childPid:process.ppid,descendantPid:process.pid}));
    fs.renameSync(ready+'.next',ready); setTimeout(()=>process.exit(91),10000); setInterval(()=>{},100);`;
  return `process.on('SIGTERM',()=>{});
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(readyPath)},process.argv[1],String(process.ppid)],{stdio:'inherit'});
    setTimeout(()=>process.exit(91),10000); setInterval(()=>{},100);`;
}
function readReady(path: string): OwnedReady {
  const ready = JSON.parse(readFileSync(path, 'utf8')) as OwnedReady;
  assert.equal(new Set(Object.values(ready)).size, 4);
  for (const pid of Object.values(ready)) assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return ready;
}
async function readyPidsClosed(path: string, boundMs = 5000) {
  if (!existsSync(path)) return;
  const ready = readReady(path);
  await boundedWait(() => Object.values(ready).every(pidClosed), 'owned helper, owner, reader and descendant must all be absent', boundMs);
}

test('parent-tracked helper survives owner KILL until its resistant reader and descendant are closed', async () => {
  const f = fixture(), readyPath = join(f.root, 'ready.json');
  const code = `import {captureStepSync} from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    captureStepSync(process.execPath,['-e',${JSON.stringify(resistantReader(readyPath))},String(process.pid)],${JSON.stringify({ ...f, cwd: ROOT, runtimeMs: 15000, trackParent: true })});`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(owner.stdout && owner.stderr);
  owner.stdout.resume(); owner.stderr.resume(); let closed = false;
  owner.once('close', () => { closed = true; });
  try {
    await boundedWait(() => existsSync(readyPath), 'both resistant processes must be ready before owner cancellation');
    const ready = readReady(readyPath); assert.equal(ready.ownerPid, owner.pid);
    assert.equal(owner.kill('SIGKILL'), true);
    await boundedWait(() => closed, 'inherited pipes must close after owned cancellation', 7000);
    assert.equal(owner.signalCode, 'SIGKILL');
    // This must already exist at owner.close, not arrive on a later polling retry.
    const native = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.ok(native.error, 'owner loss must be recorded as a refusal');
    assert.equal(native.error.code, 'ERR_AUTHOR_CAPTURE_PARENT_EXITED');
    assert.equal(native.signal, 'SIGKILL'); assert.equal(native.status, null); assert.equal(native.outputComplete, false);
    assert.deepEqual(native.parentTracking, { ownerPid: owner.pid, helperPid: ready.helperPid, childPid: ready.childPid, ownerLost: true });
    assert.ok(native.finishedAt);
    await readyPidsClosed(readyPath);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    // Fixtures self-expire on failure; never signal a PID obtained from an arbitrary receipt.
    await boundedWait(() => closed, 'owned transport did not close during bounded cleanup', 17000);
    await readyPidsClosed(readyPath, 12000);
  }
});

test('nested parent-tracked capture closes inherited pipes only after outer timeout and inner group KILL', async () => {
  const outer = fixture(), inner = fixture(), readyPath = join(inner.root, 'ready.json');
  const returned = join(outer.root, 'returned.json');
  const ownerCode = `import {captureStepSync} from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    captureStepSync(process.execPath,['-e',${JSON.stringify(resistantReader(readyPath))},String(process.pid)],${JSON.stringify({ ...inner, cwd: ROOT, runtimeMs: 15000 })});`;
  const driverCode = `import {captureStepSync} from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; import {writeFileSync} from 'node:fs';
    const result=captureStepSync(process.execPath,['--input-type=module','-e',${JSON.stringify(ownerCode)}],${JSON.stringify({ ...outer, cwd: ROOT, runtimeMs: 4000, trackParent: true })});
    writeFileSync(${JSON.stringify(returned)},JSON.stringify(result));`;
  const driver = spawn(process.execPath, ['--input-type=module', '-e', driverCode], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(driver.stdout && driver.stderr);
  driver.stdout.resume(); driver.stderr.resume(); let closed = false;
  driver.once('close', () => { closed = true; });
  try {
    await boundedWait(() => existsSync(readyPath), 'nested reader and descendant must be ready before the 4s outer timeout', 3000);
    const ready = readReady(readyPath);
    await boundedWait(() => closed, 'nested outer capture must finish after inner cancellation', 8000);
    assert.equal(driver.exitCode, 0);
    const result = JSON.parse(readFileSync(returned, 'utf8'));
    const outerNative = JSON.parse(readFileSync(outer.resultPath, 'utf8'));
    const innerNative = JSON.parse(readFileSync(inner.resultPath, 'utf8'));
    assert.equal(result.outputComplete, false);
    assert.equal(outerNative.error.code, 'ERR_AUTHOR_STEP_TIMEOUT');
    assert.equal(outerNative.parentTracking.ownerPid, driver.pid);
    assert.equal(outerNative.parentTracking.childPid, ready.ownerPid);
    assert.ok(innerNative.error, 'nested owner loss must be recorded before the outer terminal');
    assert.equal(innerNative.error.code, 'ERR_AUTHOR_CAPTURE_PARENT_EXITED');
    assert.equal(innerNative.signal, 'SIGKILL'); assert.equal(innerNative.status, null); assert.equal(innerNative.outputComplete, false);
    assert.deepEqual(innerNative.parentTracking, { ownerPid: ready.ownerPid, helperPid: ready.helperPid, childPid: ready.childPid, ownerLost: true });
    assert.ok(Date.parse(innerNative.finishedAt) <= Date.parse(outerNative.finishedAt), 'outer receipt cannot precede nested terminal receipt');
    await readyPidsClosed(readyPath);
    await boundedWait(() => pidClosed(outerNative.parentTracking.helperPid), 'outer helper must also be absent');
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    await boundedWait(() => closed, 'nested transport did not close during bounded cleanup', 17000);
    await readyPidsClosed(readyPath, 12000);
  }
});
