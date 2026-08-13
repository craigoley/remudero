import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { preflightSummaryPath, type PreflightSummary } from "../src/lib/ci-parity.js";
import { preflightCommand } from "../src/run-task.js";

/**
 * W1-T455 — THE FORGED-SUMMARY DEFECT, AND THE CONTAINMENT THAT CLOSES IT.
 *
 * `test/preflight.test.ts`, `test/preflight-ci-parity.test.ts` and
 * `test/preflight-fast-mode.test.ts` each called `preflightCommand([], { spawn })` with an
 * INJECTED fake spawn and no `--summary-file` — which, before this fix, fell through to
 * `preflightSummaryPath(repoRoot)`: the exact file `preflightFailureNotice` (lib/ci-parity.ts)
 * reads back and reports to the orchestrator AS THE WORKER'S OWN VERDICT. Fifteen of the
 * ledger's 27 recorded `preflight.failed` rows were exactly this — a test's fake
 * `commitlint: { status: 1, stderr: "header-max-length" }` reproduced verbatim, with no argv
 * suffix (`args: []`), because it was `preflightCommand`, not `rmd preflight`, that wrote it.
 *
 * `preflightCommand` now refuses the DEFAULT path whenever `deps.spawn` is set (an injected
 * spawn means a test) unless the caller opts into a specific path via `--summary-file`. These
 * three tests drive the fix from the outside, at the real, un-relocatable `repoRoot` this
 * process resolves to — the same one every worker's `rmd preflight` invocation would write —
 * because the bug was never about WHERE a fixture points a fake repo; it was about the ONE
 * real path every test in this repo shares.
 */

/** The `resolveRepoRoot` CWD-ascent this file's own module-level `repoRoot` uses, re-derived
 *  independently rather than imported — `run-task.ts` does not export `repoRoot` itself, and a
 *  test asserting against production's OWN computed value would prove nothing if that value
 *  were wrong in the same way in both places. */
function realRepoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** The exact forged fixture the three culprit suites used, reproduced so this test drives the
 *  historical bug shape precisely rather than a generic failure. */
const forgedSpawn: PreflightSpawn = (file, args) => {
  const key = [file, ...args].join(" ");
  if (key.includes("commitlint")) return { status: 1, stdout: "", stderr: "header-max-length" };
  if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
  if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
  throw new Error(`forgedSpawn: no fixture matched ${key}`);
};

/** Snapshot + restore the real default summary path around a test, so driving `preflightCommand`
 *  against the real `repoRoot` never leaves this suite's own fixture behind in the tree it ran
 *  in — the exact property under test, applied reflexively to this file's own run. */
function withSavedDefaultSummary(fn: (defaultPath: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const defaultPath = preflightSummaryPath(realRepoRoot());
    const had = existsSync(defaultPath);
    const saved = had ? readFileSync(defaultPath) : undefined;
    try {
      await fn(defaultPath);
    } finally {
      if (had) writeFileSync(defaultPath, saved!);
      else rmSync(defaultPath, { force: true });
    }
  };
}

test(
  "running the preflight suite leaves no summary file behind in the tree it ran in",
  withSavedDefaultSummary(async (defaultPath) => {
    // Reproduce the EXACT call shape `test/preflight.test.ts` used before this fix — an
    // injected spawn, no `--summary-file` — against the real `repoRoot`. Delete any prior
    // summary first so "absent" is unambiguous, then prove the forged-failure call leaves it
    // absent rather than writing the fake `commitlint: FAIL` verdict into it.
    rmSync(defaultPath, { force: true });
    const restoreLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await preflightCommand([], { spawn: forgedSpawn });
    } finally {
      console.log = restoreLog;
    }
    assert.equal(code, 1, "the fixture's fake commitlint failure must actually be reached, or this proves nothing");
    assert.equal(
      existsSync(defaultPath),
      false,
      "a suite driving preflightCommand with an injected spawn must leave no trace at the orchestrator's summary path",
    );
  }),
);

test(
  "a preflight invoked with an injected spawn refuses to write to the default summary path",
  withSavedDefaultSummary(async (defaultPath) => {
    rmSync(defaultPath, { force: true });
    const lines: string[] = [];
    const restoreLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      await preflightCommand([], { spawn: forgedSpawn });
    } finally {
      console.log = restoreLog;
    }
    assert.ok(
      lines.some((l) => l.includes("summary NOT written") && l.includes("injected spawn")),
      "the refusal must be spoken, not silent, so an operator reading the transcript can tell a summary was withheld",
    );
    assert.equal(existsSync(defaultPath), false);

    // The refusal is about the DEFAULT path specifically — an injected spawn PAIRED WITH an
    // explicit --summary-file must still write, proving this is containment, not a blanket ban
    // on tests ever producing a summary.
    const explicitOut = join(mkdtempSync(join(tmpdir(), "rmd-preflight-containment-")), "summary.json");
    const code = await preflightCommand(["--summary-file", explicitOut], { spawn: forgedSpawn });
    assert.equal(code, 1);
    assert.ok(existsSync(explicitOut), "an explicit --summary-file must still be honoured even with an injected spawn");
    assert.equal(existsSync(defaultPath), false, "and the default path must still be untouched");
  }),
);

test(
  "a real preflight with no injected spawn still writes its summary where the orchestrator reads it",
  withSavedDefaultSummary(async (defaultPath) => {
    // No `deps.spawn` at all — this drives the REAL `defaultPreflightSpawn` leaf (real
    // commitlint, real `tsc --noEmit`, real `git log`) against the real repoRoot, exactly the
    // shape a worker's own `rmd preflight` invocation takes. The write must land at the
    // default path with no `--summary-file` needed, regardless of whether the run itself
    // passes — `buildPreflightSummary`'s doc is explicit that the write is unconditional on
    // `ok`, and this test would be vacuous if it only proved that for a passing run.
    rmSync(defaultPath, { force: true });
    const restoreLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await preflightCommand([]);
    } finally {
      console.log = restoreLog;
    }
    assert.ok(existsSync(defaultPath), "a real, non-injected preflight run must write the default summary path");
    const summary = JSON.parse(readFileSync(defaultPath, "utf8")) as PreflightSummary;
    const realHeadSha = execFileSync("git", ["-C", realRepoRoot(), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(summary.headSha, realHeadSha, "the summary must name the real HEAD this real run measured");
    assert.ok(summary.steps.length > 0, "the real run must record its real steps, not an empty shell");
    assert.equal(summary.ok, code === 0, "the persisted verdict must agree with the exit code this same run returned");
    assert.ok(statSync(defaultPath).isFile());
  }),
);
