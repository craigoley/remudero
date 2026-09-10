import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3320 — THE DOCTRINE BUDGET ROUTES A RULE IT CANNOT HOLD ───────────────────────────────
//
// Operator ruling, 2026-09-10: a gate repairs, routes, or closes; a stop is for harm, never for
// incompleteness. An over-budget doctrine file is incompleteness — the rule is right, the fold has
// not happened yet — so the change LANDS and the fold is FILED.
//
// MEASURED TWICE BEFORE THIS: a retro drafted +1374 bytes against 48 bytes of headroom and opened NO
// PR; a year later one landable rule measuring exactly 315 bytes was refused the same way. Both
// times the rule was simply lost, because a retro's output exists nowhere else.

const MOD = pathToFileURL(new URL("../scripts/claude-md-budget-ratchet.mjs", import.meta.url).pathname).href;
const load = async () =>
  (await import(MOD)) as {
    decideBudgetConsequence: (v: string[], bytes: number, ceiling: number | null) => { outcome: string; reason?: string; ceiling?: number; headroom?: number };
    foldDebtCeiling: (b: Record<string, unknown>) => number | null;
    foldDebtEntryId: (file: string, bytes: number) => string;
    renderFoldDebtEntry: (id: string, file: string, bytes: number, ceiling: number, v: string[], iso: string) => string;
    fileFoldDebt: (file: string, bytes: number, ceiling: number, v: string[], deps: Record<string, unknown>) => string | null;
    evaluateNetBytes: (head: number, base: number) => string[];
  };

const OVER = ["CLAUDE.md grew by 315 bytes (base 43685 -> head 44000) — MASTER-PLAN §8A"];

test("W1-T3320: a diff that cannot fit ROUTES — the change lands and the fold is filed, rather than the rule being lost", async () => {
  const m = await load();
  const d = m.decideBudgetConsequence(OVER, 44_000, 48_000);
  assert.equal(d.outcome, "route");
  assert.equal(d.headroom, 4_000);
  // AND THE CONTROL THAT KEEPS THIS FROM BEING VACUOUS: no finding is not a route.
  assert.equal(m.decideBudgetConsequence([], 44_000, 48_000).outcome, "clean");
});

test("W1-T3320: the debt is BOUNDED — past the fold-debt ceiling the run really refuses", async () => {
  const m = await load();
  const d = m.decideBudgetConsequence(OVER, 48_001, 48_000);
  assert.equal(d.outcome, "stop");
  assert.match(d.reason ?? "", /fold-debt ceiling/);
  // Exactly at the ceiling still routes — the bound is "past", not "at".
  assert.equal(m.decideBudgetConsequence(OVER, 48_000, 48_000).outcome, "route");
});

test("W1-T3320: an absent ceiling DISABLES routing rather than reading as an infinite one", async () => {
  const m = await load();
  assert.equal(m.foldDebtCeiling({}), null);
  assert.equal(m.foldDebtCeiling({ foldDebtCeilingBytes: 48_000 }), 48_000);
  assert.throws(() => m.foldDebtCeiling({ foldDebtCeilingBytes: "48000" }), /must be a number/);
  // FAIL CLOSED: a misconfigured baseline can only restore today's strictness, never relax past it.
  const d = m.decideBudgetConsequence(OVER, 44_000, null);
  assert.equal(d.outcome, "stop");
  assert.match(d.reason ?? "", /routing disabled/);
});

test("W1-T3320: the accounting survives — the filed follow-up carries the finding, the size and the ceiling", async () => {
  const m = await load();
  const id = m.foldDebtEntryId("CLAUDE.md", 44_000);
  const body = m.renderFoldDebtEntry(id, "CLAUDE.md", 44_000, 48_000, OVER, "2026-09-10T12:00:00.000Z");
  assert.match(body, /^id: fold-debt-CLAUDE-md-44000$/m);
  assert.match(body, /^status: new$/m);
  assert.match(body, /FINDING: CLAUDE\.md grew by 315 bytes/);
  assert.match(body, /Size 44000 bytes; fold-debt ceiling 48000; headroom 4000\./);
  // THE REMEDY THE FINDING NAMES, carried into the follow-up — a router that files "it is too big"
  // with no destination has moved the problem, not routed it.
  assert.match(body, /learnings\/\*\.yaml/);
  assert.match(body, /Do NOT raise the cap/);
});

test("W1-T3320: filing is IDEMPOTENT — a gate on every CI job opens one entry, not one per run", async () => {
  const m = await load();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fold-debt-`));
  try {
    const first = m.fileFoldDebt("CLAUDE.md", 44_000, 48_000, OVER, { dir });
    assert.ok(first);
    assert.equal(readdirSync(dir).length, 1);
    const second = m.fileFoldDebt("CLAUDE.md", 44_000, 48_000, OVER, { dir });
    assert.equal(second, first, "the same file at the same size must not refile");
    assert.equal(readdirSync(dir).length, 1, "a second run must not open a second entry");
    // COUNTING FILES CANNOT SEE A REFILE: rewriting the same path leaves the count at 1, so this is
    // asserted on the CONTENT instead. The entry stamps `ts` from `nowIso`; a second call with a
    // DIFFERENT stamp must leave the original untouched. If it re-wrote, the inbox could never tell
    // a fresh debt from one restamped by every CI job on the same PR.
    const stamped = m.fileFoldDebt("CLAUDE.md", 44_000, 48_000, OVER, { dir, nowIso: "2099-01-01T00:00:00.000Z" });
    assert.equal(stamped, first, "an already-filed debt reports the same id");
    const body = readFileSync(join(dir, `${first}.yaml`), "utf8");
    assert.doesNotMatch(body, /2099-01-01/, "an already-filed debt must not be re-stamped");
    // A DIFFERENT SIZE IS A DIFFERENT DEBT and does file — otherwise the first entry would mask
    // every later overage and the debt would stop being readable.
    m.fileFoldDebt("CLAUDE.md", 45_000, 48_000, OVER, { dir });
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3320: a run that cannot FILE the follow-up refuses — a router that loses its routing is the original defect", async () => {
  const m = await load();
  const failed = m.fileFoldDebt("CLAUDE.md", 44_000, 48_000, OVER, {
    dir: "/x",
    mkdir: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(failed, null, "an unwritable inbox must report failure, never a silent success");
  // AND THE FAILURE MUST BE DISTINGUISHABLE FROM SUCCESS BY THE CALLER, which is what turns it into
  // a refusal upstream: a filer that returns an id it never wrote lands the change and loses the fold.
  assert.notEqual(failed, m.foldDebtEntryId("CLAUDE.md", 44_000));
  // AND THE REAL DEFAULT IO IS EXERCISED, not only the fake: an unwritable root really fails.
  //
  // NOT /proc, AND THAT IS NOT A STYLE PREFERENCE. `mkdirSync` under procfs BLOCKS on this kernel
  // instead of returning EACCES — measured at exit 124 under a 20s bound. This one call stalled
  // coverage-shard (2/4) for 39.5 minutes until `timeout-minutes` killed the job, and a killed job
  // is labelled `cancelled`, which the required aggregators read as a shard failure. So a blocking
  // syscall in one assertion was reported to the operator as a broken diff, on PRs that never
  // touched this file.
  //
  // A FILE where a directory must be is the same test of the same real IO and fails at once with
  // ENOTDIR — no kernel-specific behaviour, no unbounded call.
  const unwritableRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}budget-unwritable-`));
  const notADirectory = join(unwritableRoot, "not-a-dir");
  writeFileSync(notADirectory, "x");
  try {
    assert.equal(m.fileFoldDebt("CLAUDE.md", 1, 2, OVER, { dir: join(notADirectory, "inbox") }), null);
  } finally {
    rmSync(unwritableRoot, { recursive: true, force: true });
  }
});

test("W1-T3320: the finding itself is unchanged — routing decides the consequence, never whether the file is over", async () => {
  const m = await load();
  // evaluateNetBytes is untouched by this task: same inputs, same violation, same wording.
  assert.equal(m.evaluateNetBytes(44_000, 43_685).length, 1);
  assert.equal(m.evaluateNetBytes(43_685, 43_685).length, 0);
  assert.equal(m.evaluateNetBytes(43_000, 43_685).length, 0);
  assert.match(m.evaluateNetBytes(44_000, 43_685)[0] as string, /MASTER-PLAN §8A/);
});

test("W1-T3320 END TO END: an over-budget file LANDS with an entry on disk, and past the ceiling it does not", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}budget-e2e-`));
  try {
    const m = await load();
    const inbox = join(root, "feedback");
    // Over the cap but inside the debt ceiling: routes, and the entry really lands on disk.
    const filed = m.fileFoldDebt("CLAUDE.md", 44_500, 48_000, OVER, { dir: inbox });
    assert.ok(filed);
    assert.ok(existsSync(join(inbox, `${filed}.yaml`)));
    assert.match(readFileSync(join(inbox, `${filed}.yaml`), "utf8"), /this is the follow-up, not a refusal/);
    // Past the ceiling the decision is stop, whatever the inbox does.
    assert.equal(m.decideBudgetConsequence(OVER, 60_000, 48_000).outcome, "stop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3320: a run NEVER writes outside --feedback-dir — a gate that writes must not touch the real inbox from a fixture", () => {
  // MEASURED, AND THIS IS WHY THE FLAG EXISTS. Before it, `fileFoldDebt` defaulted to plan/feedback
  // and the ratchet's own spawning suite filed TWO real entries into the repo's real inbox during a
  // single test run. A gate that only ever READ could not do that; this one writes, so where it
  // writes is now an argument rather than a constant.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}budget-cli-`));
  const inbox = join(dir, "inbox");
  const file = join(dir, "doctrine.md");
  const baseline = join(dir, "baseline.json");
  const before = readdirSync(new URL("../plan/feedback", import.meta.url).pathname).length;
  try {
    writeFileSync(file, "x".repeat(900));
    writeFileSync(baseline, JSON.stringify({ capBytes: 100, foldDebtCeilingBytes: 5_000 }));
    const run = spawnSync(
      process.execPath,
      [
        new URL("../scripts/claude-md-budget-ratchet.mjs", import.meta.url).pathname,
        "--file", file,
        "--baseline", baseline,
        "--feedback-dir", inbox,
      ],
      { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
    );
    // It ROUTED: over the cap, inside the debt ceiling, so the run does not fail.
    assert.equal(run.status, 0, `expected a routed run to land: ${run.stderr}`);
    assert.match(run.stderr, /ROUTED: fold filed as/);
    assert.equal(readdirSync(inbox).length, 1, "the follow-up must land in the directory it was given");
    // AND THE REAL INBOX IS UNTOUCHED — the assertion the leak would have failed.
    assert.equal(
      readdirSync(new URL("../plan/feedback", import.meta.url).pathname).length,
      before,
      "a fixture run must not write into the repo's real feedback inbox",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3320: when the follow-up cannot be filed the CLI REFUSES — the one routing failure that must not land silently", () => {
  // COVERS THE CLI'S OWN REFUSE BRANCH, not just fileFoldDebt returning null. Measured: the unit
  // test above exercised the filer and left seven lines of the command path — the branch that turns
  // a lost follow-up into a blocked run — uncovered. That branch is the whole safety property: if it
  // silently succeeded, the change would land and the fold would be remembered by nobody.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}budget-unfilable-`));
  try {
    const file = join(dir, "doctrine.md");
    const baseline = join(dir, "baseline.json");
    // A FILE where the inbox directory should be: mkdir under it fails ENOTDIR for every uid, on
    // every platform. A chmod 0o000 would be uid-DEPENDENT and root would sail through it —
    // test/host-capability-fixtures.test.ts refuses that fixture by name for exactly this reason.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    writeFileSync(file, "x".repeat(900));
    writeFileSync(baseline, JSON.stringify({ capBytes: 100, foldDebtCeilingBytes: 5_000 }));
    const run = spawnSync(
      process.execPath,
      [
        new URL("../scripts/claude-md-budget-ratchet.mjs", import.meta.url).pathname,
        "--file", file,
        "--baseline", baseline,
        "--feedback-dir", join(blocker, "inbox"),
      ],
      { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
    );
    assert.notEqual(run.status, 0, `an unfilable follow-up must refuse: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /the fold follow-up could not be filed/);
    // AND IT MUST NOT READ AS A ROUTED SUCCESS — the two outcomes have opposite consequences.
    assert.doesNotMatch(run.stderr, /ROUTED: fold filed as/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3320: filing is atomic — EEXIST reports the existing entry, any other error still refuses", async () => {
  const m = await load();
  const withWrite = (write: (p: string, d: string, o?: unknown) => void) =>
    m.fileFoldDebt("CLAUDE.md", 44_000, 48_000, OVER, { dir: "/tmp/never-used", mkdir: () => {}, write });
  // CodeQL flagged the previous shape as `js/file-system-race` (high): an existsSync followed by a
  // write is check-then-use, and two CI jobs on the same PR really can reach it at once. The `wx`
  // flag makes the OS decide. These two arms are what that costs: EEXIST means someone else filed
  // it (a success), everything else still fails closed.
  const eexist = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  const asExisting = withWrite(() => {
    throw eexist;
  });
  assert.equal(asExisting, "fold-debt-CLAUDE-md-44000", "EEXIST is an already-filed success");
  const asFailure = withWrite(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });
  assert.equal(asFailure, null, "any other write error must still refuse");
});
