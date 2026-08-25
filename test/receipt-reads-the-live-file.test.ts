import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildReceipt,
  resolveReceiptLedgerLines,
  type ReceiptField,
  type ReceiptLedgerLine,
} from "../src/lib/receipt.js";
import type { LedgerGrepFsDeps } from "../src/lib/ledger-grep.js";

// ── W1-T2257 ─────────────────────────────────────────────────────────────────────────────────
// `receiptCommand` used to hand `buildReceipt` the LIVE `ledger.ndjson` alone — exactly the slice
// ledger rotation empties (rotation keeps only the newest row per step and archives the rest), so
// the verb printed a receipt of null leaves. `resolveReceiptLedgerLines` (src/lib/receipt.ts)
// reads the archive∪live UNION instead, scoped to the nine `step`s `buildReceipt` reads, and
// REFUSES (never silently degrades) when that union itself can't be trusted.
//
// A second, independent defect survives the union unfixed on purpose: four of the five
// `log("pr.opened", ...)` call sites in src/run-task.ts write no `branch` field at all, only
// `run-task.ts:25305`'s `{ pr_url, branch, adopted }` does. That is a WRITER defect in
// src/run-task.ts's emitters — a separate concern from this task's READER fix (design (iii): "one
// a reader and one a writer... either can ship first"), deliberately left unfixed here (this
// task's `files:` names only src/lib/receipt.ts and this test — not the emitters). What IS tested
// below, against all five emitters' REAL payload shapes, is that the reader correctly surfaces a
// branch when an emitter recorded one and correctly names the absence when it did not — the
// reader has no blind spot across any of the five known shapes, whichever one ships next.
//
// Everything here drives `resolveReceiptLedgerLines` through an injected `LedgerGrepFsDeps` (the
// same injection seam `resolveLedgerUnion` itself exposes, `test/ledger-grep.test.ts`'s idiom) —
// no real state dir touched, no gzip needed since every fixture below is plain-form `.ndjson`.

const TASK_ID = "W1-T2257-DEMO";
const RUN_ID = `${TASK_ID}-1755000000000`;
const PR_URL = "https://github.com/craigoley/remudero/pull/9999";
const BRANCH = `run-${TASK_ID}-1755000000000`;

/** A full, ground-truth set of ledger rows for one run — the nine steps `buildReceipt` reads,
 *  modeled as what a real ARCHIVE (not the live file) would hold once rotation has run. */
function archiveRows(): ReceiptLedgerLine[] {
  return [
    { run_id: RUN_ID, task_id: TASK_ID, step: "run.start", lane: "run-task", repo: "remudero" },
    { run_id: RUN_ID, task_id: TASK_ID, step: "prompt.linted", provenance: "clean", prompt_template_hash: "cafebabe1234" },
    { run_id: RUN_ID, task_id: TASK_ID, step: "learnings.injected", matched: 1, matched_ids: ["cache-prefix-bytes"] },
    { run_id: RUN_ID, task_id: TASK_ID, step: "implement.done", model: "claude-opus-4", effort: "high", num_turns: 10, cost_usd: 1.23 },
    { run_id: RUN_ID, task_id: TASK_ID, step: "pr.opened", pr_url: PR_URL, branch: BRANCH },
    { run_id: RUN_ID, task_id: TASK_ID, step: "automerge.armed", at: "open", outcome: "armed" },
    { run_id: RUN_ID, task_id: TASK_ID, step: "review.posted", head_sha: "deadbeef", reviewer_outcome: "reviewer_completed" },
    { run_id: RUN_ID, task_id: TASK_ID, step: "pr.merged", state: "MERGED" },
    { run_id: "CORRECT-1", task_id: TASK_ID, step: "correction.provenance", by: "operator" },
  ];
}

function ndjson(rows: ReceiptLedgerLine[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** An in-memory {@link LedgerGrepFsDeps} — `files` keyed by the FULL path (built with the same
 *  `node:path` `join` `resolveLedgerUnion` uses internally), `names` the `readdirSync(stateDir)`
 *  listing (bare file names, any order — proving the union never depends on that order). */
function fakeFsDeps(files: Record<string, string>, names: string[]): LedgerGrepFsDeps {
  return {
    readdirSync: () => names,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT (fake fs): ${p}`);
      return Buffer.from(files[p], "utf8");
    },
    gunzipSync: (buf) => buf, // every fixture here is plain-form; never exercised
  };
}

// ── claim: "the verb reads a corpus rotation has not emptied" ──────────────────────────────────

test("resolveReceiptLedgerLines reads the archive union, recovering rows a rotation-emptied live file alone would miss", () => {
  const stateDir = "/fake/state-union";
  const archivePath = join(stateDir, "ledger.2026-07-01T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  // The live file post-rotation carries only an unrelated task's row — exactly what "rotation
  // keeps only the newest rows per step and archives the rest" looks like for OUR task: nothing.
  const files = {
    [archivePath]: ndjson(archiveRows()),
    [livePath]: ndjson([{ run_id: "OTHER-1", task_id: "W1-T1", step: "run.start" }]),
  };
  const fsDeps = fakeFsDeps(files, ["ledger.2026-07-01T00-00-00-000Z.ndjson", "ledger.ndjson"]);

  // Control: confirms the fixture actually models the defect — a live-file-only read (the OLD
  // `readLedgerLines(ledgerPathFor(config))` path) sees nothing for TASK_ID.
  const liveOnlyRows = files[livePath]
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ReceiptLedgerLine);
  assert.equal(liveOnlyRows.some((r) => r.task_id === TASK_ID), false);

  const resolved = resolveReceiptLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const forTask = resolved.lines.filter((l) => l.task_id === TASK_ID);
  assert.equal(forTask.length, archiveRows().length, "every archived row for this task must survive the union");

  const receipt = buildReceipt(resolved.lines, { taskId: TASK_ID, prUrl: PR_URL });
  assert.deepEqual(receipt.predicate.run.run_id, { value: RUN_ID });
  assert.deepEqual(receipt.predicate.pr.branch, { value: BRANCH });
  assert.deepEqual(receipt.predicate.merge.state, { value: "MERGED" });
  assert.deepEqual(receipt.predicate.prompt_template_hash, { value: "cafebabe1234" });
});

// ── claim: "a refused corpus read surfaces as a refusal rather than as absent leaves" ──────────

test("a zero-archive union refuses rather than resolving as zero lines found", () => {
  const stateDir = "/fake/state-no-archives";
  const livePath = join(stateDir, "ledger.ndjson");
  const files = { [livePath]: ndjson([{ task_id: TASK_ID, step: "run.start", run_id: RUN_ID }]) };
  const fsDeps = fakeFsDeps(files, ["ledger.ndjson"]); // zero archives on disk

  const resolved = resolveReceiptLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /zero ledger archive files matched/);
  // The refusal is a DISTINCT shape from "resolved with zero lines" — `lines` does not exist on
  // this branch at all, so a caller cannot mistake a refusal for "this run emitted nothing".
  assert.equal("lines" in resolved, false);
});

test("receiptCommand exits non-zero and prints no receipt when the ledger union is refused", async () => {
  const { receiptCommand } = await import("../src/run-task.js");
  const logs: string[] = [];
  const errors: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await receiptCommand("9010", ["--repo", "remudero"], {
      gh: () => ({
        number: 9010,
        html_url: PR_URL,
        head: { sha: "deadbeef", ref: BRANCH },
        body: `Remudero-Task: ${TASK_ID}\n`,
      }),
      config: { root: "/tmp/rmd-receipt-refusal-test" } as never,
      resolveReceiptLedgerLines: () => ({
        ok: false,
        reason: "zero ledger archive files matched under /tmp/rmd-receipt-refusal-test/state",
      }),
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.equal(code, 1);
  assert.equal(logs.length, 0, "a refusal must never print a receipt of null leaves");
  assert.ok(errors.some((e) => e.includes("zero ledger archive files matched")));
});

// ── claim: "every pr opened emitter records the branch it opened" ──────────────────────────────
// A branch a `pr.opened` emitter DID record for a given PR must survive to the receipt even when
// this task passes through MORE THAN ONE of the five known `log("pr.opened", ...)` call sites for
// the SAME `pr_url` — e.g. an initial open through one call site, then a later "adopted" event
// through `run-task.ts:25305`. Before this fix `buildReceipt` took the LAST `pr.opened` line for a
// `pr_url` unconditionally, so a branch one emitter genuinely recorded could be SHADOWED by a
// later, blanker emission for that exact same PR. `resolvePrOpened` (src/lib/receipt.ts) now
// prefers, within the exact-`pr_url` tier, whichever line actually carries `branch` — so whichever
// emitter recorded the branch it opened, for THIS pr_url, that record survives: never a different
// PR's branch, never a guess, only what a real emitter actually wrote down for the PR this receipt
// is about.

test("the branch an emitter recorded for this PR survives even when a LATER pr.opened emission for the same PR omits it", () => {
  // run-task.ts:25305's shape (branch) followed by run-task.ts:24601's shape (no branch) — the
  // exact "later, blanker emission for the same pr_url" case this fix targets.
  const earlyWithBranch: ReceiptLedgerLine = {
    run_id: RUN_ID,
    task_id: TASK_ID,
    step: "pr.opened",
    pr_url: PR_URL,
    branch: BRANCH,
    adopted: true,
  };
  const laterNoBranch: ReceiptLedgerLine = {
    run_id: RUN_ID,
    task_id: TASK_ID,
    step: "pr.opened",
    pr_url: PR_URL,
    plan_only: false,
    mode: "adopt",
  };
  const receipt = buildReceipt([earlyWithBranch, laterNoBranch], { taskId: TASK_ID, prUrl: PR_URL });
  assert.deepEqual(
    receipt.predicate.pr.branch,
    { value: BRANCH },
    "an earlier emitter's recorded branch for this exact PR must not be shadowed by a later, blanker one",
  );

  // The SAME two lines in the OPPOSITE order (the branch recorded LAST, not first) still resolve
  // identically — this is a genuine reconciliation across every pr.opened line for this pr_url,
  // never an accident of array/ledger order.
  const reversedReceipt = buildReceipt([laterNoBranch, earlyWithBranch], { taskId: TASK_ID, prUrl: PR_URL });
  assert.deepEqual(reversedReceipt.predicate.pr.branch, { value: BRANCH });
});

test("a branch recorded for a DIFFERENT pr_url never bleeds into this receipt's pr.branch", () => {
  // The fix only re-orders the search WITHIN the exact-pr_url tier; it never widens which tier is
  // searched — an exact pr_url match is still preferred wholesale over the task's OTHER pr.opened
  // lines, exactly as before this fix.
  const otherPr: ReceiptLedgerLine = {
    run_id: RUN_ID,
    task_id: TASK_ID,
    step: "pr.opened",
    pr_url: "https://github.com/craigoley/remudero/pull/1",
    branch: "run-some-other-pr",
  };
  const thisPrNoBranch: ReceiptLedgerLine = {
    run_id: RUN_ID,
    task_id: TASK_ID,
    step: "pr.opened",
    pr_url: PR_URL,
    plan_only: false,
  };
  const receipt = buildReceipt([otherPr, thisPrNoBranch], { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(
    receipt.predicate.pr.branch.value,
    null,
    "a DIFFERENT PR's branch must never be attributed to this one",
  );
  assert.equal(
    "reason" in receipt.predicate.pr.branch && receipt.predicate.pr.branch.reason,
    `"pr.opened" ledger line for ${PR_URL} carries no branch field`,
  );
});

// The five REAL `log("pr.opened", ...)` payload shapes in src/run-task.ts, copied verbatim (only
// `run-task.ts:25305`'s shape carries `branch` — the other four's writer-side gap is the second,
// OUT-OF-SCOPE defect this task names but does not fix, see this file's header note). Exercised
// one at a time (a task whose only `pr.opened` line came from that ONE call site) to prove the
// reader has no blind spot across any of the five real shapes, whichever ships a `branch` fix next.

const PR_OPENED_EMITTER_SHAPES: ReadonlyArray<{ site: string; extra: Record<string, unknown> }> = [
  { site: "run-task.ts:9387", extra: {} },
  { site: "run-task.ts:15343", extra: { plan_only: false } },
  { site: "run-task.ts:24189", extra: { plan_only: false, action: "opened" } },
  { site: "run-task.ts:24601", extra: { plan_only: false, mode: "adopt" } },
  { site: "run-task.ts:25305", extra: { branch: BRANCH, adopted: true } },
];

test("buildReceipt resolves pr.branch correctly against every known pr.opened emitter payload shape, one at a time", () => {
  for (const shape of PR_OPENED_EMITTER_SHAPES) {
    const line: ReceiptLedgerLine = { run_id: RUN_ID, task_id: TASK_ID, step: "pr.opened", pr_url: PR_URL, ...shape.extra };
    const receipt = buildReceipt([line], { taskId: TASK_ID, prUrl: PR_URL });
    if ("branch" in shape.extra) {
      assert.deepEqual(
        receipt.predicate.pr.branch,
        { value: shape.extra.branch },
        `${shape.site} carries a branch field — the receipt must surface it, never re-derive it`,
      );
    } else {
      assert.equal(receipt.predicate.pr.branch.value, null, `${shape.site} carries no branch field`);
      assert.equal(
        "reason" in receipt.predicate.pr.branch && receipt.predicate.pr.branch.reason,
        `"pr.opened" ledger line for ${PR_URL} carries no branch field`,
        `${shape.site}'s absence must be named, never guessed at`,
      );
    }
  }
});

// ── claim: "a leaf still missing after the widened read keeps its own reason" ──────────────────

test("a leaf still absent after the widened union read keeps its own reason, never a default", () => {
  const stateDir = "/fake/state-partial";
  const archivePath = join(stateDir, "ledger.2026-07-01T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  // pr.merged is never emitted anywhere in this corpus (archive or live) — the run is still open.
  // The union widens what CAN be found; it must not widen what is ASSUMED.
  const rows = archiveRows().filter((l) => l.step !== "pr.merged");
  const files = { [archivePath]: ndjson(rows), [livePath]: "" };
  const fsDeps = fakeFsDeps(files, ["ledger.2026-07-01T00-00-00-000Z.ndjson", "ledger.ndjson"]);

  const resolved = resolveReceiptLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const receipt = buildReceipt(resolved.lines, { taskId: TASK_ID, prUrl: PR_URL });
  assert.equal(receipt.predicate.merge.state.value, null);
  assert.equal(
    "reason" in receipt.predicate.merge.state && receipt.predicate.merge.state.reason,
    `no "pr.merged" ledger line found for task ${TASK_ID}`,
  );
  // Every OTHER leaf the corpus DOES carry still resolves — one absent step degrades only its own
  // field(s), the same discipline `test/receipt.test.ts` already pins for the un-widened reader.
  assert.deepEqual(receipt.predicate.run.run_id, { value: RUN_ID });
  assert.deepEqual(receipt.predicate.pr.branch, { value: BRANCH });
});

// ── claim: "no leaf is defaulted or guessed by the widened read" ───────────────────────────────

test("no leaf is defaulted or guessed by the widened read — an unrelated corpus resolves every leaf as absent-with-reason", () => {
  const stateDir = "/fake/state-empty-for-task";
  const archivePath = join(stateDir, "ledger.2026-07-01T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  // An archive exists (the union is healthy — `ok: true`) but carries nothing for THIS task; a
  // healthy union must not manufacture values just because it found *a* corpus to read.
  const files = { [archivePath]: ndjson([{ run_id: "OTHER", task_id: "W1-T1", step: "run.start" }]), [livePath]: "" };
  const fsDeps = fakeFsDeps(files, ["ledger.2026-07-01T00-00-00-000Z.ndjson", "ledger.ndjson"]);

  const resolved = resolveReceiptLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const receipt = buildReceipt(resolved.lines, { taskId: TASK_ID, prUrl: PR_URL });
  const leaves: ReceiptField<unknown>[] = [
    receipt.predicate.run.run_id,
    receipt.predicate.pr.branch,
    receipt.predicate.learnings.injected_ids,
    receipt.predicate.implement.model,
    receipt.predicate.implement.effort,
    receipt.predicate.implement.num_turns,
    receipt.predicate.implement.cost_usd,
    receipt.predicate.review.reviewer_outcome,
    receipt.predicate.merge.state,
    receipt.predicate.merge.automerge_outcome,
    receipt.predicate.prompt_template_hash,
  ];
  for (const leaf of leaves) {
    assert.equal(leaf.value, null, "nothing in this corpus is for this task — every leaf must read absent");
    assert.ok("reason" in leaf && typeof leaf.reason === "string" && leaf.reason.length > 0, "and must name why");
  }
  assert.equal(receipt.predicate.correction.present, false);
});

// ── claim: "the same ledger still yields byte identical receipt bytes" ─────────────────────────

test("the same ledger union still yields byte-identical receipt bytes, regardless of directory-enumeration order", () => {
  const stateDir = "/fake/state-determinism";
  const archivePath = join(stateDir, "ledger.2026-07-01T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  const files = { [archivePath]: ndjson(archiveRows()), [livePath]: "" };
  const inOrder = fakeFsDeps(files, ["ledger.2026-07-01T00-00-00-000Z.ndjson", "ledger.ndjson"]);
  const reversed = fakeFsDeps(files, ["ledger.ndjson", "ledger.2026-07-01T00-00-00-000Z.ndjson"]);

  const a = resolveReceiptLedgerLines(stateDir, inOrder);
  const b = resolveReceiptLedgerLines(stateDir, reversed);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  const receiptA = JSON.stringify(buildReceipt(a.lines, { taskId: TASK_ID, prUrl: PR_URL }));
  const receiptB = JSON.stringify(buildReceipt(b.lines, { taskId: TASK_ID, prUrl: PR_URL }));
  assert.equal(receiptA, receiptB, "a shuffled readdirSync order must not change the assembled receipt");

  // And re-running the identical read again is byte-identical too — no wall-clock, no random id,
  // no generation timestamp rides this payload.
  const c = resolveReceiptLedgerLines(stateDir, inOrder);
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const receiptC = JSON.stringify(buildReceipt(c.lines, { taskId: TASK_ID, prUrl: PR_URL }));
  assert.equal(receiptC, receiptA);
});

// ── claim: "the receipt still carries no signature key" ────────────────────────────────────────

test("a receipt built from the widened union still carries no signature key", () => {
  const stateDir = "/fake/state-signing";
  const archivePath = join(stateDir, "ledger.2026-07-01T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  const files = { [archivePath]: ndjson(archiveRows()), [livePath]: "" };
  const fsDeps = fakeFsDeps(files, ["ledger.2026-07-01T00-00-00-000Z.ndjson", "ledger.ndjson"]);

  const resolved = resolveReceiptLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const receipt = buildReceipt(resolved.lines, { taskId: TASK_ID, prUrl: PR_URL });
  const keys = JSON.stringify(Object.keys(receipt));
  assert.doesNotMatch(keys, /signature|sigstore|cosign/i);
});
