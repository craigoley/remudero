import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isMainModule } from './argv.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
export const AUTHOR_OUTPUT_LIMIT_BYTES = 100 * 1024 * 1024;
export const AUTHOR_STEP_RUNTIME_MS = 4 * 60 * 60 * 1000;
export const AUTHOR_CAPTURE_PARENT_ENV = 'RMD_AUTHOR_CAPTURE_PARENT_PID';
const GROUP_SHUTDOWN_GRACE_MS = 2000;

// This marker only opts an immediate owned child into cancellation; it grants no authority.
const inheritedParentTracking = () => process.ppid > 0 && process.env[AUTHOR_CAPTURE_PARENT_ENV] === String(process.ppid);

/**
 * A small spooler owns the pipes while the synchronous author waits. No test reruns.
 * `heartbeat` (a test-slot lease's handle, W1-T9928): spawnSync blocks the author's event loop for the
 * whole step, so the SPOOLER, whose loop stays live, beats the reservation, and every covered descendant
 * inherits the reservation marker so a waiter can still see the work after the author dies.
 */
export function captureStepSync(file, args, { cwd, env = process.env, stdoutPath, stderrPath, resultPath,
  maxBytes = AUTHOR_OUTPUT_LIMIT_BYTES, runtimeMs = AUTHOR_STEP_RUNTIME_MS, spawnCapture = spawnSync, heartbeat,
  trackParent = inheritedParentTracking() } = {}) {
  if (typeof trackParent !== 'boolean' || (trackParent && process.platform === 'win32')) {
    throw new Error('parent tracking requires a boolean option and POSIX process groups');
  }
  const config = { file, args, cwd, stdoutPath, stderrPath, resultPath, maxBytes, runtimeMs,
    trackParent, parentPid: trackParent ? process.pid : null, ...(heartbeat ? { heartbeat } : {}) };
  // A full verified file list can exceed Linux's single-argument limit even when
  // the real child's many small arguments fit. Stdin avoids adding that extra limit.
  const transport = spawnCapture(process.execPath, heartbeat ? ['--import', 'tsx', SCRIPT] : [SCRIPT], {
    cwd, env: heartbeat ? { ...env, ...heartbeat.coverageEnvironment } : env,
    input: JSON.stringify(config), encoding: 'utf8', maxBuffer: 1024 * 1024,
    // Survive an outer group's KILL, but retain its pipes until this helper closes its reader.
    ...(trackParent ? { detached: true, stdio: ['pipe', 'inherit', 'inherit'] } : {}),
  });
  let outcome;
  try {
    if (transport.status !== 0 || transport.signal || transport.error) {
      throw transport.error ?? Object.assign(new Error(`capture transport exited ${transport.status}, signal=${transport.signal}`), { code: 'ERR_AUTHOR_CAPTURE_TRANSPORT' });
    }
    outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (outcome.version !== 1 || typeof outcome.outputComplete !== 'boolean' ||
        !(outcome.status === null || Number.isInteger(outcome.status))) {
      throw Object.assign(new Error('invalid native capture receipt'), { code: 'ERR_AUTHOR_CAPTURE_RECEIPT' });
    }
  } catch (error) {
    outcome = { status: transport.status, signal: transport.signal, error: { message: error.message, code: error.code }, outputComplete: false };
  }
  // Setup failures happen before the child can write to the step's stderr file. Surface the
  // spooler's own diagnostic as well, so an initial heartbeat refusal is visible to the author.
  const stepStderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
  return { status: outcome.status, signal: outcome.signal,
    durationMs: outcome.durationMs, startedAt: outcome.startedAt, finishedAt: outcome.finishedAt,
    ...(outcome.error ? { error: Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) } : {}),
    stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '',
    stderr: outcome.error && transport.stderr ? stepStderr + transport.stderr : stepStderr,
    outputComplete: outcome.outputComplete,
  };
}

async function spool(config) {
  if (![config.maxBytes, config.runtimeMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('capture byte and runtime bounds must be positive safe integers');
  }
  if ((config.trackParent !== undefined && typeof config.trackParent !== 'boolean') ||
      (config.trackParent && (process.platform === 'win32' || !Number.isSafeInteger(config.parentPid) || config.parentPid <= 0))) {
    throw new Error('invalid parent tracking configuration');
  }
  if (config.trackParent && process.ppid !== config.parentPid) throw new Error('capture owner is no longer this helper\'s parent');
  // Loaded before the child exists, so no 'close' can fire while this module is still importing.
  const slotModule = config.heartbeat ? await import(new URL('../../src/lib/test-slot.ts', import.meta.url).href) : undefined;
  const startedAt=new Date().toISOString(),started=performance.now();
  const out = openSync(config.stdoutPath, 'wx', 0o600);
  let err;
  try { err = openSync(config.stderrPath, 'wx', 0o600); }
  catch (error) { closeSync(out); throw error; }
  let storedBytes = 0, observedBytes = 0, error, closed = false, escalation, killedAt, parentWatch, parentLost = false, spawnFailed = false;
  // Publish the protected reservation before spawning: the author may exit as soon as its child starts.
  // This subprocess's event loop stays live while the author blocks in spawnSync.
  const heartbeat = slotModule?.startTestSlotHeartbeat(config.heartbeat, (row) => record(err, Buffer.from(`${JSON.stringify(row)}\n`)));
  const childEnv = { ...process.env };
  delete childEnv[AUTHOR_CAPTURE_PARENT_ENV];
  if (config.trackParent) childEnv[AUTHOR_CAPTURE_PARENT_ENV] = String(process.pid);
  const child = spawn(config.file, config.args, { cwd: config.cwd, env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const kill = (signal) => {
    if (closed || !child.pid) return;
    if (signal === 'SIGKILL') killedAt ??= performance.now();
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (cause) { if (cause.code !== 'ESRCH') error ??= { message: cause.message, code: cause.code }; }
  };
  const stop = (message, code) => {
    error ??= { message, code };
    kill('SIGTERM');
    escalation ??= setTimeout(() => kill('SIGKILL'), GROUP_SHUTDOWN_GRACE_MS).unref();
  };
  function record(fd, chunk) {
    observedBytes += chunk.length;
    const kept = chunk.subarray(0, Math.max(0, config.maxBytes - storedBytes));
    try {
      let written = 0;
      while (written < kept.length) {
        const count = writeSync(fd, kept, written, kept.length - written);
        if (count === 0) throw Object.assign(new Error('log write made no progress'), { code: 'ERR_AUTHOR_LOG_WRITE' });
        written += count;
        storedBytes += count;
      }
    } catch (cause) { stop(cause.message, cause.code ?? 'ERR_AUTHOR_LOG_WRITE'); }
    if (observedBytes > config.maxBytes) stop(`native output exceeded ${config.maxBytes} total bytes`, 'ERR_AUTHOR_OUTPUT_LIMIT');
  }
  child.stdout.on('data', (chunk) => record(out, chunk));
  child.stderr.on('data', (chunk) => record(err, chunk));
  child.on('error', (cause) => { spawnFailed = true; error ??= { message: cause.message, code: cause.code }; });
  const interrupted = () => stop('capture interrupted before completion', 'ERR_AUTHOR_CAPTURE_INTERRUPTED');
  process.on('SIGTERM', interrupted);
  process.on('SIGINT', interrupted);
  const timer = setTimeout(() => stop(`native step exceeded ${config.runtimeMs} ms`, 'ERR_AUTHOR_STEP_TIMEOUT'), config.runtimeMs).unref();
  if (config.trackParent) {
    const checkParent = () => {
      // Never signal or probe the supplied PID: only this helper's actual parent relationship.
      if (!parentLost && process.ppid !== config.parentPid) {
        parentLost = true;
        stop('capture owner exited before completion', 'ERR_AUTHOR_CAPTURE_PARENT_EXITED');
      }
    };
    parentWatch = setInterval(checkParent, 50).unref();
    checkParent();
  }
  const native = await new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
  const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch (cause) { return cause.code !== 'ESRCH'; } };
  // 'close' proves the leader and its stdio closed, not that disconnected descendants ended.
  // This group was created by this capture; never reap a PID or group from an external receipt.
  if (!spawnFailed && child.pid && process.platform !== 'win32' && !escalation && groupAlive()) {
    // esbuild/loader helpers can finish their normal shutdown just after leader.close.
    // Give natural group closure the existing teardown grace, not an immediate false
    // refusal. The original runtime, output and parent-loss monitors stay active.
    const drainUntil = performance.now() + GROUP_SHUTDOWN_GRACE_MS;
    while (!escalation && groupAlive() && performance.now() < drainUntil) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!escalation && groupAlive()) stop('native leader closed with live descendants', 'ERR_AUTHOR_DESCENDANTS_ALIVE');
  }
  // A leader that obeyed SIGTERM closes the pipes while members that ignored it live on: finish the escalation.
  while (escalation && child.pid && process.platform !== 'win32' && groupAlive() &&
    !(killedAt !== undefined && performance.now() - killedAt > GROUP_SHUTDOWN_GRACE_MS)) await new Promise((resolve) => setTimeout(resolve, 50));
  closed = true;
  if (heartbeat) {
    // Withdraw the cadence only once the step's whole process group is gone (signal 0 delivers nothing).
    let groupEnded = process.platform === 'win32' || !child.pid;
    if (!groupEnded) {
      try { process.kill(-child.pid, 0); }
      catch (cause) { groupEnded = cause.code === 'ESRCH'; }
    }
    heartbeat.stop(groupEnded);
  }
  clearTimeout(timer);
  clearTimeout(escalation);
  clearInterval(parentWatch);
  process.off('SIGTERM', interrupted);
  process.off('SIGINT', interrupted);
  try { fsyncSync(out); fsyncSync(err); }
  finally { closeSync(out); closeSync(err); }
  writeFileSync(config.resultPath + '.pending', JSON.stringify({ version: 1, status: spawnFailed ? null : native.status,
    startedAt, finishedAt:new Date().toISOString(), durationMs:Math.ceil(performance.now()-started),
    signal: native.signal, spawnCloseCode: spawnFailed ? native.status : null, error: error ?? null,
    ...(config.trackParent ? { parentTracking: { ownerPid: config.parentPid, helperPid: process.pid,
      childPid: child.pid ?? null, ownerLost: parentLost } } : {}),
    outputComplete: !error && !native.signal, storedBytes, observedBytes }) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  // Publish complete JSON atomically and exclusively; a reader never sees a half-written result.
  linkSync(config.resultPath + '.pending', config.resultPath);
  unlinkSync(config.resultPath + '.pending');
}

if (isMainModule(import.meta.url)) {
  try { await spool(JSON.parse(readFileSync(0, 'utf8'))); }
  catch (error) { console.error(`author capture failed: ${error.message}`); process.exitCode = 1; }
}
