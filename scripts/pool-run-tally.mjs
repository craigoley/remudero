// scripts/pool-run-tally.mjs — a node:test reporter that writes ONE JSON line once the run has ended:
// the run's summary counts, the files whose tests reported, and the files whose own child reported a
// per-file summary. scripts/pure-test-pool.mjs judges a run complete only from this line.
//
// Written only at the END of the event stream, on purpose: a run that was cut short — a test calling
// the real `process.exit(0)` in the shared pool process — never reaches the end, so it leaves no line,
// and "no line" is read as "no summary", never as a pass.

import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// This raw observation stream never supplies summary counts or duration truth.
function fileDiagnostics() {
  const configPath = process.env.RMD_TEST_FILE_DIAGNOSTICS;
  if (!configPath) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.version !== 1 || typeof config.attemptId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(config.attemptId) || typeof config.root !== "string" ||
        !isAbsolute(config.root) || !Array.isArray(config.files)) return null;
    const files = new Map();
    for (const file of config.files) {
      if (typeof file !== "string" || /[\x00-\x1f\x7f]/.test(file) || !/\.test\.[cm]?[jt]s$/.test(file)) return null;
      const absolute = resolve(config.root, file);
      const local = relative(config.root, absolute);
      if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
      files.set(absolute, local.split(sep).join("/"));
    }
    // A nested runner may inherit the opt-in. Only the first reporter owns it.
    closeSync(openSync(`${configPath}.owner`, "wx"));
    const started = process.hrtime.bigint();
    let sequence = 0;
    let available = true;
    const seen = new Set();
    const emit = (phase, extra = {}) => {
      if (!available) return;
      try {
        writeSync(2, `RMD-TEST-FILE-DIAGNOSTIC ${JSON.stringify({ diagnosticVersion: 1,
          attemptId: config.attemptId, sequence: sequence++, phase,
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, ...extra })}\n`);
      } catch {
        available = false;
      }
    };
    emit("selected", { files: [...files.values()] });
    return {
      event(event) {
        const phase = event?.type === "test:enqueue" ? "queued" :
          event?.type === "test:dequeue" ? "dequeued" : event?.type === "test:complete" ? "completed" : null;
        const data = event?.data;
        if (!phase || data?.nesting !== 0 || data.entryFile !== undefined ||
            typeof data.file !== "string" || typeof data.name !== "string") return;
        const absolute = resolve(config.root, data.file);
        if (resolve(config.root, data.name) !== absolute || !files.has(absolute)) return;
        const key = `${phase}:${absolute}`;
        if (seen.has(key)) return;
        seen.add(key);
        emit(phase, { file: files.get(absolute) });
      },
      end() { emit("stream-ended"); },
    };
  } catch {
    // A missing, corrupt, already-owned or unwritable observation is not a verdict.
    return null;
  }
}

/** @param {AsyncIterable<{ type: string, data?: Record<string, unknown> }>} source */
export default async function* poolRunTally(source) {
  const diagnostics = fileDiagnostics();
  let summary = null;
  const testFiles = new Set();
  const fileSummaries = new Set();
  for await (const event of source) {
    diagnostics?.event(event);
    const data = event?.data ?? {};
    if (event?.type === "test:summary") {
      // Node emits one per file child (isolated runs, `file` set) and one for the whole run (no `file`).
      if (typeof data.file === "string") fileSummaries.add(data.file);
      else summary = data.counts ?? null;
    } else if ((event?.type === "test:pass" || event?.type === "test:fail") && typeof data.file === "string") {
      testFiles.add(data.file);
    }
  }
  diagnostics?.end();
  yield `${JSON.stringify({ version: 1, summary, testFiles: [...testFiles].sort(), fileSummaries: [...fileSummaries].sort() })}\n`;
}
