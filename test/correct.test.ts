import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import { deriveStatus } from "../src/lib/status.js";
import { applyCorrection } from "../src/lib/correct.js";

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T20c",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

/** A fake GitHub gateway driven by fixture maps (mirrors test/status.test.ts). */
function fakeGitHub(opts: { byRef?: Record<string, PrRef>; readFailed?: boolean }): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prByRef(ref) {
      calls.push(`prByRef:${ref}`);
      return opts.byRef?.[String(ref)] ?? null;
    },
    findMergedByTrailer() {
      return null;
    },
    headRefName() {
      return undefined;
    },
    prBody() {
      return undefined;
    },
    readFailed() {
      calls.push("readFailed");
      return opts.readFailed ?? false;
    },
  };
}

function ledgerFile(lines: Array<Record<string, unknown>> = []): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-correct-"));
  const p = join(dir, "ledger.ndjson");
  if (lines.length > 0) writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

test("applyCorrection: writes the EXACT shape deriveStatus's latestActualPrUrl already parses, and re-deriving credits it", () => {
  const claimedUrl = "https://github.com/craigoley/remudero/pull/125";
  const actualUrl = "https://github.com/craigoley/remudero/pull/134";
  const github = fakeGitHub({
    byRef: {
      [claimedUrl]: { number: 125, url: claimedUrl, state: "CLOSED" },
      // Resolvable by BOTH the bare number (what `--pr 134` passes in) and the
      // full URL (what deriveStatus's correction rung re-resolves from the
      // written `actual_pr_url`) — the real `gh` gateway accepts either.
      "134": { number: 134, url: actualUrl, state: "MERGED" },
      [actualUrl]: { number: 134, url: actualUrl, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-T20c", pr_url: claimedUrl }]);
  const deps = { ledgerPath, github };

  const result = applyCorrection(task(), "134", deps, { reason: "hand-fixed on fix/*" });

  assert.equal(result.written, true);
  assert.equal(result.before.source, "ledger");
  assert.equal(result.before.merged, false); // the closed superseded run, pre-correction
  assert.equal(result.after.source, "correction");
  assert.equal(result.after.merged, true);
  assert.equal(result.after.prNumber, 134);

  const lines = readLines(ledgerPath);
  assert.equal(lines.length, 2, "append-only: the original line survives, one new line added");
  const written = lines[1];
  assert.equal(written.step, "correction.provenance");
  assert.equal(written.task_id, "W1-T20c");
  assert.equal(written.claimed_pr_url, claimedUrl); // whatever deriveStatus credited BEFORE the write
  assert.equal(written.actual_pr_url, actualUrl);
  assert.equal(written.reason, "hand-fixed on fix/*");
  assert.equal(typeof written.ts, "string");

  // Re-deriving directly (a fresh call, not the cached `result.after`) confirms
  // the written line alone is enough for deriveStatus to credit it — the
  // compatibility point with the existing hand-written #80->#91-era shape.
  const reDerived = deriveStatus(task(), deps);
  assert.equal(reDerived.source, "correction");
  assert.equal(reDerived.prNumber, 134);
});

test("applyCorrection: claimed_pr_url is null when deriveStatus credited nothing before the write", () => {
  const github = fakeGitHub({ byRef: { "9": { number: 9, url: "u/9", state: "MERGED" } } });
  const ledgerPath = ledgerFile();
  const result = applyCorrection(task({ id: "W1-TX" }), "9", { ledgerPath, github });
  assert.equal(result.written, true);
  const [written] = readLines(ledgerPath);
  assert.equal(written.claimed_pr_url, null);
  assert.equal(written.actual_pr_url, "u/9");
});

test("applyCorrection: an unresolvable PR reference writes NOTHING — written=false, ledger untouched", () => {
  const github = fakeGitHub({}); // gh cannot resolve anything
  const ledgerPath = ledgerFile([{ step: "run.start", task_id: "W1-TX" }]);
  const result = applyCorrection(task({ id: "W1-TX" }), "999", { ledgerPath, github });
  assert.equal(result.written, false);
  assert.equal(result.after, result.before);
  const lines = readLines(ledgerPath);
  assert.equal(lines.length, 1, "no correction line appended when the PR reference does not resolve");
});

test("W1-T119: an INDETERMINATE before-read (GitHub could not be consulted) refuses to write — written=false, prByRef never even consulted, nothing appended to the ledger", () => {
  // readFailed:true ⇒ deriveStatus's `before` comes back with source:"throttled"
  // / indeterminate:true — the underlying read genuinely FAILED rather than
  // resolving to a clean "no evidence". applyCorrection must not stand behind
  // that as a `claimed_pr_url` fact, so it refuses exactly like an
  // unresolvable PR reference: nothing written, nothing appended.
  const github = fakeGitHub({ readFailed: true, byRef: { "9": { number: 9, url: "u/9", state: "MERGED" } } });
  const ledgerPath = ledgerFile([{ step: "run.start", task_id: "W1-TX" }]);
  const result = applyCorrection(task({ id: "W1-TX" }), "9", { ledgerPath, github });

  assert.equal(result.written, false);
  assert.equal(result.after, result.before);
  assert.equal(result.before.indeterminate, true);
  assert.equal(result.before.source, "throttled");
  assert.ok(!github.calls.some((c) => c.startsWith("prByRef")), "the PR reference is never even resolved once the before-read is indeterminate");
  const lines = readLines(ledgerPath);
  assert.equal(lines.length, 1, "no correction line appended when the before-read is indeterminate");
});

test("applyCorrection: append-only — a second call adds a second line, never rewrites the first", () => {
  const github = fakeGitHub({
    byRef: {
      "1": { number: 1, url: "u/1", state: "MERGED" },
      "2": { number: 2, url: "u/2", state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile();
  applyCorrection(task({ id: "W1-TX" }), "1", { ledgerPath, github });
  applyCorrection(task({ id: "W1-TX" }), "2", { ledgerPath, github });
  const lines = readLines(ledgerPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].actual_pr_url, "u/1");
  assert.equal(lines[1].actual_pr_url, "u/2"); // last correction wins per deriveStatus, both preserved on disk
});
