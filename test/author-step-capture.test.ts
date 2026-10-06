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
