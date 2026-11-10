import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { readLedgerLines } from "#src/lib/status.js";
import { reviewCommand } from "#src/run-task.js";

const HEAD = "d".repeat(40);

async function drive(fetchHead: () => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-start-phases-"));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await reviewCommand("6012", ["--repo", "acme/remudero"], {
      fetchView: () => ({
        number: 6012, html_url: "https://github.com/acme/remudero/pull/6012",
        head: { ref: "fixture", sha: HEAD }, updated_at: new Date(0).toISOString(),
        body: "## Acceptance\n- the fixture holds | manual fixture",
      }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead,
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => ({ posted: false }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
      reviewStartFreshness: { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" },
      runReview: async () => ({
        state: "success", criteria: [], testTheater: false, summary: "fixture", floorDegraded: false,
        capped: false, keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "success",
        verdictWithheld: "fixture does not publish",
      }),
    }).catch(() => 1);
    return readLedgerLines(ledgerPathFor({ root } as Config));
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a review records its start before its first row", async () => {
  const rows = await drive(() => {});
  const i = rows.findIndex((r) => r.step === "review.start_phases");
  assert.ok(i >= 0, "a review.start_phases row is written");
  const row = rows[i]!;
  assert.equal(row.head_sha, HEAD);
  for (const k of ["config_load_ms", "ledger_read_ms", "fetch_head_ms", "total_ms"]) {
    assert.equal(typeof row[k], "number", k);
  }
  const prov = rows.findIndex((r) => r.step === "review.provider_provenance");
  if (prov >= 0) assert.ok(i < prov, "start_phases precedes provider_provenance");
});

test("a start step that throws still records its elapsed time and error class", async () => {
  class Boom extends Error {}
  const rows = await drive(() => { throw new Boom("fetch down"); });
  const row = rows.find((r) => r.step === "review.start_phases");
  assert.ok(row, "row written despite the throw");
  assert.equal(typeof row.fetch_head_ms, "number");
  assert.equal(row.fetch_head_error, "Boom");
});
