/**
 * test/helpers/judged-pool-run.ts — what a fake `spawn` must leave behind for a pool-ladder run to
 * read as complete.
 *
 * scripts/pure-test-pool.mjs passes a pool, its isolated re-run or a leak probe only when the run's
 * tally reporter wrote an end-of-run summary that every given file reported into: exit 0 alone is
 * not a pass (2026-10-11, ci-shard 1/8). A unit test that drives `main()` with a fake spawn writes
 * that summary itself, here, so the fake stands for a run that really finished. A fake that writes
 * nothing stands for a run that died part-way, and is judged a failure.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TALLY_REPORTER = /^--test-reporter=.*pool-run-tally\.mjs$/;
const DESTINATION = "--test-reporter-destination=";

/** True when `args` is a judged pool-ladder run (it carries the tally reporter). */
export function isJudgedRun(args: readonly string[]): boolean {
  return args.some((arg) => TALLY_REPORTER.test(arg));
}

/**
 * Write a complete tally for the `*.test.ts` files in `args` (one passing test each) to the tally
 * reporter's destination, and return `{ status }` for the fake spawn to hand back. An unjudged run
 * (the shard's ordinary isolated rest) is left alone.
 */
export function finishJudgedRun(args: readonly string[], spawnOpts: unknown, status = 0): { status: number } {
  const at = args.findIndex((arg) => TALLY_REPORTER.test(arg));
  if (at < 0) return { status };
  const destination = args[at + 1];
  if (!destination?.startsWith(DESTINATION)) throw new Error(`the tally reporter has no destination after it: ${args.join(" ")}`);
  const cwd = (spawnOpts as { cwd?: string } | undefined)?.cwd ?? process.cwd();
  const files = args.filter((arg) => arg.endsWith(".test.ts")).map((file) => resolve(cwd, file));
  const summary = { tests: files.length, failed: 0, passed: files.length };
  writeFileSync(destination.slice(DESTINATION.length), `${JSON.stringify({ version: 1, summary, testFiles: files, fileSummaries: files })}\n`);
  return { status };
}
