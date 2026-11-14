import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";

test("appendLedger accepts canonical paths inside the temporary root and rejects symlinks outside it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ledger-canonical-temp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const ledger = join(realpathSync(root), "state", "ledger.ndjson");
  appendLedger(ledger, { run_id: "fixture", task_id: "W1-T12177", step: "run.start" });
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "run.start");

  const outside = join(root, "outside");
  symlinkSync(dirname(tmpdir()), outside, "dir");
  assert.throws(
    () => appendLedger(join(outside, "ledger.ndjson"), { run_id: "fixture", task_id: "W1-T12177", step: "run.start" }),
    /REFUSED test append outside the temporary root/,
  );
});
