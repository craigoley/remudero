import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, ledgerExceedsRotationCeiling, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { CHECK_REQUEUE_DEFERRED_STEP, CHECK_REQUEUE_STEP, requeuedCheckKeysFromLedger } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5935. requeuedCheckKeysFromLedger (src/lib/sweep.ts) enforces W1-T1223's one requeue per
// (head, check) by reading `sweep.check_requeued` rows back from the LIVE ledger. That step was not
// in DECISION_RELEVANT_LEDGER_STEPS, so a rotation archived it and the same cancelled check on the
// same head could be requeued again. It escaped test/ledger-rotation.test.ts's census because the
// fold compares `l.step === CHECK_REQUEUE_STEP` — a CONSTANT, and that census reads only literals.
// The last test here closes that hole for every `*FromLedger` fold.

const HEAD = "a".repeat(40);
const SPENT = `${HEAD}@ci-gate`;
const VOIDED = `${HEAD}@lint`;

function noiseLine(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** A ledger holding one spent requeue, one requeue a later deferral voided, then enough noise to
 *  force a real rotation. Returns the path and the ceiling the rotation must run at. */
function paddedRequeueFile(dir: string): { ledgerPath: string; ceiling: number } {
  const ledgerPath = join(dir, "ledger.ndjson");
  const noCeiling = { ceilingBytes: Number.MAX_SAFE_INTEGER };
  const row = { run_id: "SWEEP-1", task_id: "PR-9001", pr_number: 9001, head_sha: HEAD };
  appendLedger(ledgerPath, { ...row, step: CHECK_REQUEUE_STEP, check_name: "ci-gate" } as LedgerLine, noCeiling);
  appendLedger(ledgerPath, { ...row, step: CHECK_REQUEUE_STEP, check_name: "lint" } as LedgerLine, noCeiling);
  appendLedger(ledgerPath, { ...row, step: CHECK_REQUEUE_DEFERRED_STEP, check_name: "lint", outcome: "deferred" } as LedgerLine, noCeiling);
  const ceiling = statSync(ledgerPath).size * 4;
  const padding = Math.ceil(ceiling / (noiseLine(0).length + 1)) + 50;
  for (let n = 0; n < padding; n++) writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
  assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "setup: padded past the ceiling");
  return { ledgerPath, ceiling };
}

test("W1-T5935: a sweep.check_requeued row survives a real ledger rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}requeue-rotation-`));
  try {
    const { ledgerPath, ceiling } = paddedRequeueFile(dir);
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: ceiling }).rotated, true);
    const live = readLedgerLines(ledgerPath);
    const requeued = live.filter((l) => l.step === CHECK_REQUEUE_STEP).map((l) => l.check_name);
    assert.deepEqual(requeued, ["ci-gate", "lint"], "every sweep.check_requeued row is still live after rotation");
    assert.equal(live.filter((l) => l.step === CHECK_REQUEUE_DEFERRED_STEP).length, 1, "the deferral that voids a key is live too");
    assert.equal(live.filter((l) => l.step === "ci.polling").length < 50, true, "the rotation really archived the noise");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5935: requeuedCheckKeysFromLedger still bounds the requeue after a rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}requeue-rotation-`));
  try {
    const { ledgerPath, ceiling } = paddedRequeueFile(dir);
    const before = requeuedCheckKeysFromLedger(readLedgerLines(ledgerPath));
    assert.deepEqual([...before], [SPENT], "sanity: the spent key is bounded and the deferred one voided before rotation");
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: ceiling }).rotated, true);
    const after = requeuedCheckKeysFromLedger(readLedgerLines(ledgerPath));
    assert.ok(after.has(SPENT), "the spent (head, check) pair is still bounded after rotation — no second requeue");
    assert.ok(!after.has(VOIDED), "a deferral-voided key stays voided after rotation");
    assert.deepEqual([...after], [...before], "the fold answers identically before and after rotation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every top-level `function <name>FromLedger(` in `src`, with each step it reads back through a
 *  string CONSTANT (`.step === X`, `.step !== X`, or `case X:`) that `retained` does not hold. */
function unretainedFoldReads(
  sources: ReadonlyMap<string, string>,
  retained: ReadonlySet<string>,
): Array<{ step: string; fold: string; constant: string }> {
  const values = new Map<string, Set<string>>();
  const constDecl = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*["']([^"']+)["']\s*(?:as\s+const\s*)?;/g;
  for (const src of sources.values()) {
    for (const m of src.matchAll(constDecl)) (values.get(m[1]) ?? values.set(m[1], new Set()).get(m[1])!).add(m[2]);
  }
  const read = /(?:\.step\s*(?:===|!==)\s*|\bcase\s+)([A-Z][A-Z0-9_]*)\b/g;
  const out: Array<{ step: string; fold: string; constant: string }> = [];
  for (const [file, src] of sources) {
    for (const fm of src.matchAll(/(?:^|\n)(?:export\s+)?function\s+(\w+FromLedger)\s*[(<]/g)) {
      const start = fm.index ?? 0;
      const end = src.indexOf("\n}", start + 1);
      const body = src.slice(start, end === -1 ? undefined : end);
      for (const m of body.matchAll(read)) {
        for (const step of values.get(m[1]) ?? []) {
          if (!retained.has(step)) out.push({ step, fold: `${file}:${fm[1]}`, constant: m[1] });
        }
      }
    }
  }
  return out;
}

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function srcSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.set(relative(SRC_ROOT, path), readFileSync(path, "utf8"));
    }
  };
  walk(SRC_ROOT);
  return out;
}

// Fold reads that were ALREADY unretained when this census landed (2026-10-06). W1-T5958 registered
// every one, so it is empty. A RATCHET: an entry here that the census no longer finds fails below,
// so the list only shrinks. Never add to it — register the step instead; a deliberately transient
// step may stand here only with its reason beside it.
const KNOWN_UNRETAINED_FOLD_READS: ReadonlySet<string> = new Set<string>([]);

test("W1-T5935: the rotation census names a step a FromLedger fold reads back through a constant but rotation does not retain", () => {
  const sources = srcSources();
  assert.ok(sources.size > 100, "sanity: the census read the src tree");

  // POSITIVE CONTROL: the census can see its corpus. requeuedCheckKeysFromLedger's own read is found
  // the moment its step is taken out of the retained set — exactly this task's falsifier.
  const withoutRequeue = new Set([...DECISION_RELEVANT_LEDGER_STEPS].filter((s) => s !== CHECK_REQUEUE_STEP));
  assert.ok(
    unretainedFoldReads(sources, withoutRequeue).some((r) => r.step === CHECK_REQUEUE_STEP && r.fold.endsWith(":requeuedCheckKeysFromLedger")),
    "the census names sweep.check_requeued when it is not retained",
  );

  // A synthetic fold reading an unretained constant is named; a retained one, a literal and a
  // non-fold function are not this census's to report.
  // (The fold name is interpolated so fixture-copy's ledgerHelperNames census does not count it.)
  const GHOST_FOLD = "ghostKeysFromLedger";
  const synthetic = new Map([[
    "lib/x.ts",
    [
      'export const GHOST_STEP = "x.ghost";',
      'const KEPT_STEP = "run.start";',
      `export function ${GHOST_FOLD}(lines) {`,
      "  for (const l of lines) { if (l.step === GHOST_STEP || l.step !== KEPT_STEP) continue; }",
      "}",
      "function notAFold(lines) { return lines.filter((l) => l.step === GHOST_STEP); }",
    ].join("\n"),
  ]]);
  assert.deepEqual(unretainedFoldReads(synthetic, DECISION_RELEVANT_LEDGER_STEPS), [
    { step: "x.ghost", fold: "lib/x.ts:ghostKeysFromLedger", constant: "GHOST_STEP" },
  ]);

  const found = unretainedFoldReads(sources, DECISION_RELEVANT_LEDGER_STEPS);
  const fresh = found.filter((r) => !KNOWN_UNRETAINED_FOLD_READS.has(r.step));
  assert.deepEqual(
    fresh,
    [],
    "a FromLedger fold reads back a step rotation archives — add it to DECISION_RELEVANT_LEDGER_STEPS",
  );
  const stale = [...KNOWN_UNRETAINED_FOLD_READS].filter((step) => !found.some((r) => r.step === step));
  assert.deepEqual(stale, [], "a known-unretained entry is now retained or unread — delete it from the list");
});
