// scripts/pool-run-tally.mjs — a node:test reporter that writes ONE JSON line once the run has ended:
// the run's summary counts, the files whose tests reported, and the files whose own child reported a
// per-file summary. scripts/pure-test-pool.mjs judges a run complete only from this line.
//
// Written only at the END of the event stream, on purpose: a run that was cut short — a test calling
// the real `process.exit(0)` in the shared pool process — never reaches the end, so it leaves no line,
// and "no line" is read as "no summary", never as a pass.

/** @param {AsyncIterable<{ type: string, data?: Record<string, unknown> }>} source */
export default async function* poolRunTally(source) {
  let summary = null;
  const testFiles = new Set();
  const fileSummaries = new Set();
  for await (const event of source) {
    const data = event?.data ?? {};
    if (event?.type === "test:summary") {
      // Node emits one per file child (isolated runs, `file` set) and one for the whole run (no `file`).
      if (typeof data.file === "string") fileSummaries.add(data.file);
      else summary = data.counts ?? null;
    } else if ((event?.type === "test:pass" || event?.type === "test:fail") && typeof data.file === "string") {
      testFiles.add(data.file);
    }
  }
  yield `${JSON.stringify({ version: 1, summary, testFiles: [...testFiles].sort(), fileSummaries: [...fileSummaries].sort() })}\n`;
}
