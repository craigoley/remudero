/**
 * test/a-capped-digest-read-keeps-the-newest-rows.test.ts
 *
 * `readDigestWindow`'s row cap is the bound that binds (docs/forensics/digest.md, the OOM incident), and
 * its stated intent is that "the rows kept are the most recent ones". The read used to open the live
 * ledger LAST and walk each file oldest-first, so a cap that bit dropped the live file — the newest rows
 * in the window — first.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readDigestWindow } from "../src/lib/digest.js";

/** Three rows stamped inside `hour`, tagged `<tag>0..2`. */
function rows(tag: string, hour: number): string {
  const hh = String(hour).padStart(2, "0");
  return Array.from({ length: 3 }, (_, i) => JSON.stringify({ ts: `2026-09-23T${hh}:0${i}:00.000Z`, run_id: `${tag}${i}`, step: "x" })).join("\n") + "\n";
}

function corpus(): { dir: string; live: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-digest-cap-"));
  writeFileSync(join(dir, "ledger.2026-09-23T02-00-00-000Z.ndjson"), rows("old", 1));
  writeFileSync(join(dir, "ledger.2026-09-23T04-00-00-000Z.ndjson"), rows("mid", 3));
  const live = join(dir, "ledger.ndjson");
  writeFileSync(live, rows("live", 5));
  return { dir, live };
}

test("a capped digest read keeps the newest rows, the live file's first", () => {
  const { dir, live } = corpus();
  try {
    const r = readDigestWindow(live, "2026-09-23T00:00:00.000Z", { maxRows: 4 });
    assert.deepEqual(
      r.lines.map((l) => l.run_id),
      ["mid2", "live0", "live1", "live2"],
      "the four newest rows survive the cap, returned oldest-first",
    );
    assert.equal(r.rowsTruncated, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an uncapped digest read returns every in-window row in time order", () => {
  const { dir, live } = corpus();
  try {
    const r = readDigestWindow(live, "2026-09-23T02:00:00.000Z");
    // The 01:xx archive is stamped 02:00, inside the window, but its rows precede `since` and are dropped.
    assert.deepEqual(
      r.lines.map((l) => l.run_id),
      ["mid0", "mid1", "mid2", "live0", "live1", "live2"],
    );
    assert.equal(r.rowsTruncated, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
