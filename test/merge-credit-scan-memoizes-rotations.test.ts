import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { readMergeCreditedTaskIds } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * THE SYNCHRONOUS MERGE-CREDIT SCAN PARSES A ROTATION ONCE. `buildOpenPrViews` asks
 * readMergeCreditedTaskIds once per open PR whose dependencies are unmet, and an unmet dependency is
 * by definition uncredited, so every one of those calls walked and re-parsed the whole rotation
 * corpus on the daemon thread. A rotation is written once; its credit rows now come from the memo
 * the async scan (W1-T6275) already keeps, and only a new or changed rotation is parsed.
 * FIXTURES ONLY: every ledger and rotation lives in a throwaway directory.
 */

const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", ...o });
const credit = (taskId: string): string => row({ task_id: taskId, step: "verdict.merged", verdict: "merged" });

const ROTATION_A = "ledger.2026-10-05T00-00-00-000Z.ndjson";
const ROTATION_B = "ledger.2026-10-04T00-00-00-000Z.ndjson.gz";
const ROTATION_C = "ledger.2026-10-03T00-00-00-000Z.ndjson";

function creditCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}credit-memo-`));
  writeFileSync(join(dir, "ledger.ndjson"), `${credit("W1-T1")}\n`);
  writeFileSync(join(dir, ROTATION_A), `${row({ task_id: "W1-T9", step: "run.start" })}\n${credit("W1-T2")}\n`);
  writeFileSync(join(dir, ROTATION_B), gzipSync(Buffer.from(`${credit("W1-T3")}\n{"verdict": torn\n`)));
  writeFileSync(join(dir, ROTATION_C), `${credit("W1-T4")}\n`);
  return dir;
}

test("two consecutive merge-credit scans over an unchanged corpus parse each rotation once", () => {
  const dir = creditCorpus();
  try {
    const opened: string[] = [];
    const scan = () => readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), {
      candidates: ["NEVER-CREDITED"],
      readFileBuffer: (p) => {
        opened.push(p.split("/").pop()!);
        return readFileSync(p);
      },
    });
    const first = scan();
    assert.equal(opened.length, 3, "the first scan reads every rotation");
    opened.length = 0;
    const second = scan();
    assert.deepEqual(opened, [], "the second scan reads no rotation: each is answered from the memo");
    assert.deepEqual([...second.credited].sort(), ["W1-T1", "W1-T2", "W1-T3", "W1-T4"]);
    assert.deepEqual([...second.credited].sort(), [...first.credited].sort(), "the same answer");
    assert.equal(second.filesRead, first.filesRead, "the same walk");
    assert.equal(second.complete, first.complete);
    assert.equal(second.budgetExhausted, first.budgetExhausted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a merge-credit scan after the corpus changes answers from the new corpus, not the memo", () => {
  const dir = creditCorpus();
  try {
    const path = join(dir, "ledger.ndjson");
    const ids = () => [...readMergeCreditedTaskIds(path, { candidates: ["NEVER-CREDITED"] }).credited].sort();
    assert.deepEqual(ids(), ["W1-T1", "W1-T2", "W1-T3", "W1-T4"]);
    // A new rotation, a rewritten one (a new size, so a new memo key), a deleted one, and a live append.
    writeFileSync(join(dir, "ledger.2026-10-06T00-00-00-000Z.ndjson"), `${credit("W1-T5")}\n`);
    appendFileSync(join(dir, ROTATION_A), `${credit("W1-T6")}\n`);
    unlinkSync(join(dir, ROTATION_C));
    appendFileSync(path, `${credit("W1-T7")}\n`);
    assert.deepEqual(ids(), ["W1-T1", "W1-T2", "W1-T3", "W1-T5", "W1-T6", "W1-T7"], "every change is seen, and the deleted rotation's credit is gone");
    // An early stop still answers correctly from a partly-pruned memo.
    const early = readMergeCreditedTaskIds(path, { candidates: ["W1-T5"] });
    assert.equal(early.complete, true);
    assert.equal(early.filesRead, 2, "live, then the newest rotation that resolves the candidate");
    assert.deepEqual(ids(), ["W1-T1", "W1-T2", "W1-T3", "W1-T5", "W1-T6", "W1-T7"]);
    // A cap still hides what it hid before.
    const capped = readMergeCreditedTaskIds(path, { candidates: ["W1-T3"], maxRotations: 1 });
    assert.equal(capped.credited.has("W1-T3"), false, "a capped scan never reports credit from a rotation it did not open");
    assert.equal(capped.budgetExhausted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
