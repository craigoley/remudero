import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './argv.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
export const AUTHOR_OUTPUT_LIMIT_BYTES = 100 * 1024 * 1024;
export const AUTHOR_STEP_RUNTIME_MS = 4 * 60 * 60 * 1000;

/** A small spooler owns the pipes while the synchronous author waits. No test reruns. */
export function captureStepSync(file, args, { cwd, env = process.env, stdoutPath, stderrPath, resultPath,
  maxBytes = AUTHOR_OUTPUT_LIMIT_BYTES, runtimeMs = AUTHOR_STEP_RUNTIME_MS } = {}) {
  const config = { file, args, cwd, stdoutPath, stderrPath, resultPath, maxBytes, runtimeMs };
  // A full verified file list can exceed Linux's single-argument limit even when
  // the real child's many small arguments fit. Stdin avoids adding that extra limit.
  const transport = spawnSync(process.execPath, [SCRIPT], {
    cwd, env, input: JSON.stringify(config), encoding: 'utf8', maxBuffer: 1024 * 1024,
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
  return { status: outcome.status, signal: outcome.signal,
    ...(outcome.error ? { error: Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) } : {}),
    stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '',
    stderr: existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '',
    outputComplete: outcome.outputComplete,
  };
}

async function spool(config) {
  if (![config.maxBytes, config.runtimeMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('capture byte and runtime bounds must be positive safe integers');
  }
  const out = openSync(config.stdoutPath, 'wx', 0o600);
  let err;
  try { err = openSync(config.stderrPath, 'wx', 0o600); }
  catch (error) { closeSync(out); throw error; }
  let storedBytes = 0, observedBytes = 0, error, closed = false, escalation, spawnFailed = false;
  const child = spawn(config.file, config.args, { cwd: config.cwd, env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const kill = (signal) => {
    if (closed || !child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (cause) { if (cause.code !== 'ESRCH') error ??= { message: cause.message, code: cause.code }; }
  };
  const stop = (message, code) => {
    error ??= { message, code };
    kill('SIGTERM');
    escalation ??= setTimeout(() => kill('SIGKILL'), 2000).unref();
  };
  const record = (fd, chunk) => {
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
  };
  child.stdout.on('data', (chunk) => record(out, chunk));
  child.stderr.on('data', (chunk) => record(err, chunk));
  child.on('error', (cause) => { spawnFailed = true; error ??= { message: cause.message, code: cause.code }; });
  const interrupted = () => stop('capture interrupted before completion', 'ERR_AUTHOR_CAPTURE_INTERRUPTED');
  process.on('SIGTERM', interrupted);
  process.on('SIGINT', interrupted);
  const timer = setTimeout(() => stop(`native step exceeded ${config.runtimeMs} ms`, 'ERR_AUTHOR_STEP_TIMEOUT'), config.runtimeMs).unref();
  const native = await new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
  closed = true;
  clearTimeout(timer);
  clearTimeout(escalation);
  process.off('SIGTERM', interrupted);
  process.off('SIGINT', interrupted);
  try { fsyncSync(out); fsyncSync(err); }
  finally { closeSync(out); closeSync(err); }
  writeFileSync(config.resultPath + '.pending', JSON.stringify({ version: 1, status: spawnFailed ? null : native.status,
    signal: native.signal, spawnCloseCode: spawnFailed ? native.status : null, error: error ?? null,
    outputComplete: !error && !native.signal, storedBytes, observedBytes }) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  // Publish complete JSON atomically and exclusively; a reader never sees a half-written result.
  linkSync(config.resultPath + '.pending', config.resultPath);
  unlinkSync(config.resultPath + '.pending');
}

if (isMainModule(import.meta.url)) {
  try { await spool(JSON.parse(readFileSync(0, 'utf8'))); }
  catch (error) { console.error(`author capture failed: ${error.message}`); process.exitCode = 1; }
}
