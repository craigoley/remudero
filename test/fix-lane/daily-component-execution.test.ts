import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl, fileURLToPath as __workspacePath } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { captureCiRemedyComponent, recordCiRemedyExecution } from "#src/lib/ci-remedy-execution.js";
const observerModule = existsSync(new URL("src/lib/ci-remedy-execution-observer.ts", __workspaceRootUrl))
  ? await import("#src/lib/ci-remedy-execution-observer.js") : undefined;
const { dailyRoutingReview } = await import(pathToFileURL(__workspacePath(new URL("scripts/private-routing-daily-review.mjs", __workspaceRootUrl))).href);
const asOf = "2026-10-13T14:00:00.000Z", start = "2026-10-12T14:00:00.000Z";
const at = "2026-10-13T10:00:00.000Z";
function receipts() {
  const caller = { state: "observed" as const, source: "module-import-git" as const,
    path: "src/run-task.ts", blob: "b".repeat(40), revision: "a".repeat(40), capturedAt: start };
  const identity = captureCiRemedyComponent(caller, (v: number) => v + 1, existsSync, join,
    { ...caller, path: "src/lib/ci-remedy-execution.ts" });
  const execution = recordCiRemedyExecution(identity, "caller-1",
    { failingChecks: 1, matchedPaths: 1, reachablePaths: 1, ownership: "compared" });
  assert.equal(execution.state, "observed");
  const e = { ...execution, at };
  const common = { ts: at, host: "host-1", run_id: "caller-1", prevention_execution: e,
    repair_pr_url: "https://github.com/acme/core/pull/10", repair_round_id: "round-1",
    worker_run_id: "worker-1", worker_rung: "fix", assignment_observed: true };
  return { invocation: { ...common, step: "fix.remedy_path_execution" },
    assignment: { ...common, step: "worker.assignment", worker_assignment: { id: "assignment-1" } },
    terminal: { ...common, step: "worker.attempt", ts: "2026-10-13T10:01:00.000Z",
      selection_assignment_id: "assignment-1", success: true } };
}
function requiredObserver() {
  assert.ok(observerModule, "the sole collector must retain a bounded component observer");
  return observerModule.ciRemedyExecutionObserver;
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-component-daily-")); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  return { stateDir, outDir: join(dir, "out"), sources: [{ label: "core", stateDir }] };
}
const ndjson = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("sole daily collector joins actual component receipts across all ledger forms before raw retention", async t => {
  const f = fixture(t), r = receipts();
  writeFileSync(join(f.stateDir, "ledger.2026-10-13T09-00-00-000Z.ndjson.gz"), gzipSync(ndjson([r.terminal])));
  writeFileSync(join(f.stateDir, "ledger.2026-10-13T10-00-00-000Z.ndjson"), ndjson([r.invocation, r.assignment]));
  writeFileSync(join(f.stateDir, "ledger.ndjson"), ndjson([r.assignment, r.terminal]));
  const { snapshot, text } = await dailyRoutingReview({ ...f, asOf });
  const source = snapshot.sources[0], component = source.selfImprovement.componentExecution;
  assert.deepEqual(source.forms, { gzip: 1, plain: 1, live: 1 });
  assert.equal(source.rowsRead, 3); assert.equal(source.retention.rawWindowRows, 0);
  assert.equal(component.records.length, 1); assert.equal(component.evidence.retainedRows, 3);
  assert.equal(component.evidence.scanComplete, true);
  assert.equal(component.records[0].laterWork.state, "observed");
  assert.equal(component.records[0].laterWork.outcomes[0].success, true);
  assert.equal(component.records[0].wholeFixAdoption, "not-certified");
  assert.equal(source.selfImprovement.sourceComplete, false); assert.equal(component.efficacyClaim, "none");
  assert.match(text, /component execution: 1 retained invocations; 1 joined worker outcomes/);
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8")).sources[0]
    .selfImprovement.componentExecution.records[0].laterWork.state, "observed");
});

test("component observer preserves conflicts missing terminals and scan gaps without qualifying later work", () => {
  const create = requiredObserver(), r = receipts();
  for (const end of [{ ...r.terminal, success: false }, { ...r.terminal, prevention_execution: undefined }]) {
    const o = create(asOf, start); [r.terminal, r.assignment, end].forEach(row => o.observe(row));
    assert.equal(o.report(true).records[0]!.laterWork.state, "unavailable");
  }
  const missing = create(asOf, start); missing.observe(r.assignment);
  assert.equal(missing.report(true).records[0]!.laterWork.state, "unavailable");
  const gap = create(asOf, start); [r.terminal, r.assignment].forEach(row => gap.observe(row));
  assert.equal(gap.report(false).records[0]!.laterWork.state, "unavailable");
  assert.equal(gap.report(false).reason, "component-source-incomplete");
});

test("component observer withholds joins at either resource bound and redacts unrelated raw payloads", () => {
  const create = requiredObserver(), r = receipts();
  for (const limits of [{ maxRows: 2, maxBytes: 2 * 1024 * 1024 }, { maxRows: 4096, maxBytes: 1 }]) {
    const o = create(asOf, start, limits);
    [r.assignment, r.terminal, { ...r.terminal, success: false }].forEach(row => o.observe(row));
    const result = o.report(true);
    assert.equal(result.reason, "component-evidence-retention-bound");
    assert.equal(result.evidence.scanComplete, false); assert.ok(result.evidence.omittedRows > 0);
    assert.ok(result.records.every(item => item.laterWork.state === "unavailable"));
    assert.ok(result.evidence.retainedBytes <= limits.maxBytes);
  }
  const o = create(asOf, start);
  for (let i = 0; i < 5000; i++) o.observe({ ts: at, step: "worker.attempt", worker_rung: "build", secret: "private-secret" });
  o.observe({ ...r.assignment, secret: "private-secret", worker_assignment: { id: "assignment-1", prompt: "private-secret" } });
  o.observe(r.terminal);
  const result = o.report(true);
  assert.equal(result.evidence.retainedRows, 2); assert.equal(result.records[0]!.laterWork.state, "observed");
  assert.doesNotMatch(JSON.stringify(result), /private-secret|prompt/);
});

test("component observer validates finite limits chronology scope and absent source availability", async t => {
  const create = requiredObserver(), r = receipts();
  for (const limits of [{ maxRows: 0, maxBytes: 10 }, { maxRows: 1.5, maxBytes: 10 },
    { maxRows: 4097, maxBytes: 10 }, { maxRows: 1, maxBytes: 0 },
    { maxRows: 1, maxBytes: 2 * 1024 * 1024 + 1 }, { maxRows: 1, maxBytes: NaN }])
    assert.throws(() => create(asOf, start, limits), RangeError);
  const o = create(asOf, start);
  for (const row of [{ ...r.assignment, ts: "bad" }, { ...r.assignment, ts: "2026-10-14T00:00:00Z" },
    { ...r.assignment, ts: "2026-10-11T00:00:00Z" }, { ...r.assignment, step: "daemon.boot" }]) o.observe(row);
  assert.equal(o.report(true).records.length, 0);
  for (const boundary of [["bad", start], [asOf, "bad"], [start, asOf]]) {
    const invalid = create(boundary[0]!, boundary[1]!); invalid.observe(r.assignment);
    assert.equal(invalid.report(true).reason, "invalid-observation-window");
  }
  const f = fixture(t); rmSync(f.stateDir, { recursive: true });
  const source = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0];
  assert.equal(source.selfImprovement.componentExecution.state, "unavailable");
  assert.equal(source.selfImprovement.componentExecution.evidence.scanComplete, false);
});
