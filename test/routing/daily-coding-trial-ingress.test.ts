import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dailyRoutingReview } from "#scripts/private-routing-daily-review.mjs";
const codingLedger = existsSync(new URL("src/lib/model-canary-ledger.ts", __workspaceRootUrl))
  ? await import("#src/lib/model-canary-ledger.js") : undefined;
function requiredCodingSave() {
  assert.ok(codingLedger, "the coding receipt producer must exist before collector ingestion");
  return codingLedger.codingLedgerSave;
}
const codingCases = existsSync(new URL("src/lib/model-canary-coding.ts", __workspaceRootUrl))
  ? await import("#src/lib/model-canary-coding.js") : undefined;
function codingCaseRequests() {
  assert.ok(codingCases, "the real coding case producer must exist in this source tree");
  return codingCases.codingCaseRequests();
}
import type { CanaryRun } from "#src/lib/model-canary-metrics.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const asOf = "2026-10-13T14:00:00.000Z";
const run = (id: string): CanaryRun => ({ id, caseId: "coding-parser", suiteHash: codingCaseRequests()[0]!.suiteHash,
  model: "requested", route: "fixture-subscription", effort: "medium", family: "coding", verified: null,
  totalDurationMs: null, attempts: [] });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coding-ingress-`)); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); const state = join(dir, "state"); mkdirSync(state);
  return { state, path: join(state, "ledger.ndjson"), outDir: join(dir, "out"), sources: [{ label: "core", stateDir: state }] };
}

test("sole daily collector joins actual coding writer receipts across live plain and gzip forms once", async t => {
  const codingLedgerSave = requiredCodingSave();
  const f = fixture(t); await codingLedgerSave(f.path)(run("actual-receipt"), null);
  const original = JSON.parse(readFileSync(f.path, "utf8").trim()); original.ts = "2026-10-13T12:00:00Z";
  const text = JSON.stringify(original) + "\n";
  writeFileSync(f.path, text); writeFileSync(join(f.state, "ledger.2026-10-13T10-00-00-000Z.ndjson"), text);
  writeFileSync(join(f.state, "ledger.2026-10-13T11-00-00-000Z.ndjson.gz"), gzipSync(text));
  const snapshot = (await dailyRoutingReview({ ...f, asOf })).snapshot;
  const source = snapshot.sources[0]; assert.deepEqual(source.forms, { gzip: 1, plain: 1, live: 1 });
  assert.equal(source.rowsRead, 1); assert.equal(source.codingTrials.retainedRuns, 1);
  assert.equal(source.codingTrials.state, "observed"); assert.equal(source.codingTrials.measurements.uniqueRuns, 1);
  assert.equal(source.codingTrials.measurements.groups[0].passRate, null); assert.equal(source.codingTrials.efficacyClaim, "none");
  assert.equal(source.codingTrials.runDetails[0].id, "actual-receipt");
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8")).sources[0].codingTrials.retainedRuns, 1);
});

test("coding collector preserves unavailable sources and conflicting IDs without a healthy empty or winner claim", async t => {
  const codingLedgerSave = requiredCodingSave();
  const f = fixture(t); await codingLedgerSave(f.path)(run("same-id"), null);
  const original = JSON.parse(readFileSync(f.path, "utf8").trim()); original.ts = "2026-10-13T12:00:00Z";
  const conflicting = structuredClone(original); conflicting.canary_coding.run.model = "conflicting";
  writeFileSync(f.path, JSON.stringify(original) + "\n" + JSON.stringify(conflicting) + "\n");
  let source = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0];
  assert.equal(source.codingTrials.state, "observed-partial"); assert.equal(source.codingTrials.conflicts, 1);
  assert.equal(source.codingTrials.measurements, null);
  rmSync(f.state, { recursive: true });
  source = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0];
  assert.equal(source.state, "unavailable"); assert.equal(source.codingTrials.state, "unavailable");
  assert.equal(source.codingTrials.measurements, null);
});
