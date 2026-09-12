import assert from "node:assert/strict";
import { spawn as spawnAsync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCiParity } from "../src/lib/ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/**
 * PROGRESS TELEMETRY FOR `rmd preflight --ci-parity`.
 *
 * MEASURED in a container: preflight ran for OVER AN HOUR and emitted ZERO output, and the
 * operator resorted to `docker top` three times to learn what one line would have told him. The
 * cause is `defaultPreflightSpawn`'s `spawnSync`, which pipes stdout/stderr into a buffer, so the
 * suite's own per-file reporter lines existed the whole time and reached nobody.
 *
 * THE TRAP THIS FILE IS WRITTEN AGAINST: a test asserting "progress was emitted" passes happily on
 * a fixture that never ran anything. So the first test below does NOT inspect a return value — it
 * drives the REAL `defaultPreflightSpawn` in a child process and requires the output to be visible
 * to a reader that has NOT waited for completion, while the child is provably still running. A
 * buffered implementation cannot satisfy that no matter what it returns.
 *
 * AND BOTH DIRECTIONS, because streaming everything would be its own defect: several callers read
 * captured stdout AS DATA (`mergeBaseDiffText`, `changedFilesListPath`, `triggerLeaf`'s
 * `/REQUIRED/` test). The non-streaming default must keep capturing, and the wiring test at the
 * bottom pins which calls opted in.
 */

/** A child that prints EARLY, stays alive well past any plausible scheduling jitter, then prints
 *  LATE and exits with `code`. The gap is what makes "did this arrive BEFORE completion?" a real
 *  question rather than a race. */
function slowChildScript(code: number): string {
  return [
    "process.stdout.write('EARLY-LINE\\n');",
    `setTimeout(() => { process.stdout.write('LATE-LINE\\n'); process.exit(${code}); }, 1500);`,
  ].join("");
}

/**
 * Run `defaultPreflightSpawn` inside a real child process and return a live handle on what that
 * process has written so far. The OUTER process never blocks, so "visible before completion" is
 * directly observable — which is the only way to tell streaming from buffering from the outside.
 */
function driveInChildProcess(opts: { stream: boolean; exitCode: number }) {
  const program = [
    "const { defaultPreflightSpawn } = await import('../src/lib/commit-message.js');",
    `const res = defaultPreflightSpawn(process.execPath, ['-e', ${JSON.stringify(slowChildScript(opts.exitCode))}], ${JSON.stringify({ stream: opts.stream })});`,
    "process.stdout.write('RESULT ' + JSON.stringify({ status: res.status, stdout: res.stdout, stderr: res.stderr }) + '\\n');",
  ].join("\n");

  const child = spawnAsync(process.execPath, ["--input-type=module", "--import", "tsx", "-e", program], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (err += String(c)));
  const exited = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return {
    seenSoFar: () => out,
    stderrSoFar: () => err,
    exited,
    running: () => child.exitCode === null,
  };
}

/** Poll until `pred()` or `ms` elapses. Returns whether it became true in time. */
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

test("STREAMS: a stream:true child's output reaches a reader that has NOT waited for completion", async () => {
  const run = driveInChildProcess({ stream: true, exitCode: 0 });

  const arrivedEarly = await waitFor(() => run.seenSoFar().includes("EARLY-LINE"), 8000);
  // THE LOAD-BEARING ASSERTION, and it is deliberately about TIME, not about a return value:
  // EARLY-LINE must be readable while the run is still going. A buffered spawn cannot produce
  // this, because nothing leaves the process until the child exits.
  assert.ok(arrivedEarly, "EARLY-LINE must be visible before the run completes");
  assert.ok(
    !run.seenSoFar().includes("LATE-LINE"),
    "the child should still be mid-run — LATE-LINE arrives 1.5s later, so seeing it already would mean this raced rather than streamed",
  );
  assert.ok(!run.seenSoFar().includes("RESULT "), "the driving call must not have returned yet");

  assert.equal(await run.exited, 0);
  assert.ok(run.seenSoFar().includes("LATE-LINE"), "and the rest of the output still arrives");
});

test("CAPTURES: with stream absent the same child produces NOTHING early and its stdout is captured", async () => {
  const run = driveInChildProcess({ stream: false, exitCode: 0 });

  // The twin of the test above, one variable apart. This is what protects every caller that reads
  // captured stdout as data — if this ever streams, those parses get an empty string.
  const leaked = await waitFor(() => run.seenSoFar().includes("EARLY-LINE"), 700);
  assert.ok(!leaked, "a non-streaming call must emit nothing while it runs");

  assert.equal(await run.exited, 0);
  const line = run.seenSoFar().split("\n").find((l) => l.startsWith("RESULT "))!;
  const res = JSON.parse(line.slice("RESULT ".length)) as { status: number; stdout: string };
  assert.equal(res.status, 0);
  assert.match(res.stdout, /EARLY-LINE/, "the captured stdout must still contain everything the child wrote");
  assert.match(res.stdout, /LATE-LINE/);
});

test("the VERDICT survives streaming: a nonzero exit is still reported as its real status", async () => {
  // The one thing that must not change. `spawnSync` reports `status` for an inherited child just
  // as it does for a piped one, so the pass/fail decision is untouched; only the captured TEXT is
  // traded away, and only for the steps that opted in.
  const run = driveInChildProcess({ stream: true, exitCode: 3 });
  assert.equal(await run.exited, 0, `the driver itself should exit cleanly; stderr was: ${run.stderrSoFar()}`);
  const line = run.seenSoFar().split("\n").find((l) => l.startsWith("RESULT "))!;
  const res = JSON.parse(line.slice("RESULT ".length)) as { status: number; stdout: string | null };
  assert.equal(res.status, 3, "a streamed child's nonzero exit must still be the step's verdict");
});

test("IN-PROCESS: the streaming branch itself runs here, returning a real status and no captured text", () => {
  // The three tests above drive the streaming path inside a CHILD process, because "visible before
  // completion" is only observable from outside a blocking call. That leaves the `stdio` branch
  // exercised somewhere the coverage instrumentation of THIS process cannot see it, so this runs
  // the true branch directly — the one line below prints `streamed-in-process` to the suite's own
  // stdout, which is the mechanism working, not stray output.
  const res = defaultPreflightSpawn(
    process.execPath,
    ["-e", "process.stdout.write('streamed-in-process\\n')"],
    { stream: true },
  );
  assert.equal(res.status, 0, "an inherited child still reports its exit status");
  assert.equal(res.stdout, "", "and its output is NOT captured — it went straight to the terminal");
});

test("W1-T3299 (supersedes the two-step shape): the full suite streams, the coverage shards are CAPTURED and verified, and data-parsing git calls stream never", () => {
  // Proves the flag is actually SET where it matters. Without this, every assertion above could
  // hold on a seam nobody uses.
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string; stream?: boolean } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
    }
    if (file === process.execPath && args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      const shard = args[args.indexOf("--shard") + 1]?.match(/^(\d+)\/4$/)?.[1];
      return shard ? { status: 0, stdout: `test/coverage-shard-${shard}.test.ts\n`, stderr: "" } : { status: 1, stdout: "", stderr: "invalid selector shard" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  runCiParity(REPO_ROOT, { spawn });

  const suite = calls.find((c) => c.file === "npm" && c.args.join(" ") === "run test:ci");
  assert.ok(suite, "the ci job must still shell `npm run test:ci`");
  assert.equal(suite!.opts?.stream, true, "the full-suite step must stream — it is the hour of silence");

  // W1-T3299 — THE COVERAGE LEAF IS FOUR SHARDS NOW, MIRRORING CI, AND IT CAPTURES ON PURPOSE.
  // CI's coverage-shard job states the retry removal outright ("`scripts/test-with-retry.mjs` is
  // GONE from this invocation and STAYS in the `ci` job"), so this local leaf dropped it too —
  // that IS the parity this suite exists to hold, not a regression against it.
  //
  // AND IT MUST NOT STREAM. Each shard's stdout is READ, to refuse folding a shard that produced
  // no `# tests` summary into the coverage total — the same guard the CI job applies. A streamed
  // call returns empty stdout (see the sibling test above), so streaming here would silently
  // disarm that refusal. Capture is the correct trade, and the cost — a shard runs without live
  // progress — is named here rather than left for the next reader to rediscover.
  const shards = calls.filter((c) => c.args.includes("--experimental-test-coverage") && c.args.some((a) => /^test\/coverage-shard-\d+\.test\.ts$/.test(a)));
  assert.equal(shards.length, 4, "the coverage leaf must still run the suite under coverage, as CI's four shards");
  for (const shard of shards) {
    assert.notEqual(
      shard.opts?.stream,
      true,
      "a coverage shard's stdout is parsed for its `# tests` summary — streaming it would disarm that refusal",
    );
  }
  assert.ok(
    !calls.some((c) => c.args.some((a) => a.endsWith("test-with-retry.mjs")) && c.args.includes("--experimental-test-coverage")),
    "the coverage leaf must NOT retry — CI's own shard removed test-with-retry, and this run mirrors it",
  );

  // The other direction: anything whose stdout is READ must stay captured.
  const gitCalls = calls.filter((c) => c.file === "git");
  assert.ok(gitCalls.length > 0, "runCiParity must still shell git");
  for (const c of gitCalls) {
    assert.notEqual(c.opts?.stream, true, `git ${c.args.join(" ")} must NOT stream — its stdout is parsed as data`);
  }
});
