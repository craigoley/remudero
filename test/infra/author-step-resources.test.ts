import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {REPO_ROOT} from '#test/helpers/repo-root.js';

const captureModule = '#scripts/lib/author-step-capture.mjs';
const {captureStepSync} = await import(captureModule);

test("W1-T10961: normal exit cancellation and pressure refusal preserve terminal failure evidence and prove owned child closure before release", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-author-resources-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home'), temp = join(root, 'tmp');
  mkdirSync(home); mkdirSync(temp);
  const env = {PATH: process.env.PATH, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp};
  for (const kind of ['normal', 'failed', 'cancelled', 'pressure', 'timeout']) {
    const dir = join(root, kind); mkdirSync(dir);
    const pidPath = join(dir, 'child.pid'), readerPath = join(dir, 'reader.pid');
    const paths = {stdoutPath: join(dir, 'stdout'), stderrPath: join(dir, 'stderr'), resultPath: join(dir, 'native.json')};
    const setup = `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidPath + '.pending')},String(process.pid));
      fs.renameSync(${JSON.stringify(pidPath + '.pending')},${JSON.stringify(pidPath)});`;
    const action = kind === 'normal' ? "console.log('normal terminal witness');" :
      kind === 'failed' ? "console.error('terminal failure witness');process.exitCode=7;" :
      kind === 'cancelled' ? "process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);" :
      kind === 'pressure' ? "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000);" :
      'setInterval(()=>{},1000);';
    const reader = `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(readerPath + '.pending')},String(process.pid));
      fs.renameSync(${JSON.stringify(readerPath + '.pending')},${JSON.stringify(readerPath)});
      setTimeout(()=>process.exit(0),${kind === 'normal' || kind === 'failed' ? 100 : 10000});`;
    const group = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(reader)}],{stdio:'ignore'}).unref();
      const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readerPath)})){clearInterval(ready);${action}}},5);`;
    const result = captureStepSync(process.execPath, ['-e', setup + group], {
      ...paths, cwd: REPO_ROOT, env, trackParent: true, maxBytes: 1024, runtimeMs: kind === 'timeout' ? 500 : 10000,
    });
    const receipt = JSON.parse(readFileSync(paths.resultPath, 'utf8'));
    const pid = receipt.parentTracking.childPid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    if (existsSync(pidPath)) assert.equal(Number(readFileSync(pidPath, 'utf8')), pid);
    else assert.equal(kind, 'timeout', `${kind}: the real native child must have run`);
    assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH',
      `${kind}: the recorded child must be closed before returning its resources`);
    if (existsSync(readerPath)) {
      const readerPid = Number(readFileSync(readerPath, 'utf8'));
      assert.ok(Number.isSafeInteger(readerPid) && readerPid > 0 && readerPid !== pid);
      assert.throws(() => process.kill(readerPid, 0), (error: any) => error.code === 'ESRCH',
        `${kind}: disconnected descendants must also close before the capture returns`);
    } else assert.equal(kind, 'timeout', `${kind}: the descendant must have started`);
    assert.equal(receipt.parentTracking.ownerPid, process.pid);
    assert.equal(receipt.parentTracking.childPid, pid);
    assert.equal(receipt.parentTracking.ownerLost, false);
    assert.equal(receipt.status, result.status);
    assert.equal(receipt.signal, result.signal);
    assert.equal(receipt.outputComplete, result.outputComplete);
    assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
    assert.ok(statSync(paths.stdoutPath).size + statSync(paths.stderrPath).size <= 1024);
    if (kind === 'normal' || kind === 'failed') {
      assert.equal(result.status, kind === 'normal' ? 0 : 7);
      assert.equal(result.error, undefined);
      assert.equal(result.outputComplete, true);
      assert.match(kind === 'normal' ? result.stdout : result.stderr,
        kind === 'normal' ? /normal terminal witness/ : /terminal failure witness/);
    } else {
      const code = kind === 'cancelled' ? 'ERR_AUTHOR_CAPTURE_INTERRUPTED' :
        kind === 'pressure' ? 'ERR_AUTHOR_OUTPUT_LIMIT' : 'ERR_AUTHOR_STEP_TIMEOUT';
      assert.equal(result.error?.code, code);
      assert.equal(receipt.error.code, code);
      assert.equal(result.outputComplete, false);
      assert.equal(result.signal, 'SIGTERM');
      const saved = readFileSync(paths.resultPath, 'utf8');
      const retry = captureStepSync(process.execPath, ['-e', ''], {...paths, cwd: REPO_ROOT, env});
      assert.equal(retry.error?.code, 'ERR_AUTHOR_CAPTURE_TRANSPORT');
      assert.equal(retry.outputComplete, false);
      assert.equal(readFileSync(paths.resultPath, 'utf8'), saved, 'a second attempt must preserve the old refusal');
    }
  }
});
