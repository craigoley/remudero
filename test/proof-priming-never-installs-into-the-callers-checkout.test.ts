// W1-T4587: proof priming (ensureDeps) ran a real `npm ci` in WHATEVER checkout it was handed when a
// Vitest runner was absent. OBSERVED 2026-09-26: with Vitest no longer installed in core, a test that
// pointed execWhitelistedProof at this repository replaced its live node_modules mid-suite, and every
// file scheduled after it failed with "Cannot find package 'tsx'". An existing node_modules is now
// only ever replaced inside a checkout the reviewer created (registerReviewerCheckout).
import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDeps, pinnedVitestCli, registerReviewerCheckout } from "../src/lib/review.js";

function checkout(withNodeModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4587-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  if (withNodeModules) mkdirSync(join(dir, "node_modules", "tsx"), { recursive: true });
  return dir;
}

function recorder(): { calls: string[][]; exec: typeof execFileSync } {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[]) => {
    calls.push([file, ...args]);
    return "";
  }) as unknown as typeof execFileSync;
  return { calls, exec };
}

test("W1-T4587: a caller's live tree without the runner is reported unavailable, never reinstalled", () => {
  const dir = checkout(true);
  try {
    const { calls, exec } = recorder();
    assert.equal(ensureDeps(dir, exec, pinnedVitestCli(dir)), false, "the runner is absent, so the proof cannot run");
    assert.deepEqual(calls, [], "no npm ci over a node_modules the reviewer did not create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4587: a fresh checkout and a reviewer-created checkout are still primed", () => {
  const fresh = checkout(false);
  const owned = checkout(true);
  try {
    const a = recorder();
    ensureDeps(fresh, a.exec, pinnedVitestCli(fresh));
    assert.deepEqual(a.calls, [["npm", "ci"]], "a checkout with no node_modules gets its one install, as documented");

    registerReviewerCheckout(owned);
    const b = recorder();
    ensureDeps(owned, b.exec, pinnedVitestCli(owned));
    assert.deepEqual(b.calls, [["npm", "ci"]], "the reviewer's own proof checkout may replace a partial install");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
  }
});
