import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const BODY = "## Acceptance\n- the fixture holds | manual fixture";

interface DriveOptions {
  fetchHeadThrows?: boolean;
  configThrows?: boolean;
  ledgerReadThrows?: boolean;
  resolveMissingTask?: boolean;
}

function drive(options: DriveOptions = {}): Record<string, unknown>[] {
  const script = `
    import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const load = (parts) => import(parts.join(""));
    const { reviewCommand } = await load(["#src/", "run-task.js"]);
    const { ledgerPathFor } = await load(["#src/lib/", "ledger-path.js"]);
    const { readLedgerLines } = await load(["#src/lib/", "status.js"]);
    const head = ${JSON.stringify(HEAD)};
    const body = ${JSON.stringify(options.resolveMissingTask ? `${BODY}\n\nRemudero-Task: W9-START-PHASE-MISSING` : BODY)};
    const root = mkdtempSync(join(tmpdir(), "rmd-start-phases-"));
    const startPhasesLedgerPath = join(root, "state", "start-phases.ndjson");
    if (${Boolean(options.ledgerReadThrows)}) mkdirSync(join(root, "state", "ledger.ndjson"), { recursive: true });
    console.log = () => {};
    try {
      const fetchHead = ${options.fetchHeadThrows ? '() => { class Boom extends Error {}; throw new Boom("fetch down"); }' : "() => {}"};
      await reviewCommand("6012", ["--repo", "acme/remudero"], {
        fetchView: () => ({
          number: 6012, html_url: "https://github.com/acme/remudero/pull/6012",
          head: { ref: "fixture", sha: head }, updated_at: new Date(0).toISOString(), body,
        }),
        loadConfig: ${options.configThrows ? '() => { class Boom extends Error {}; throw new Boom("config down"); }' : '() => ({ root, claudeBin: "/bin/true" })'},
        startPhasesLedgerPath,
        fetchHead,
        materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
        postReviewPending: async () => ({ posted: false }),
        reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
        reviewStartFreshness: { status: "fresh", codeSha: head, originMainSha: head, advance: "none" },
        runReview: async () => ({
          state: "success", criteria: [], testTheater: false, summary: "fixture", floorDegraded: false,
          capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "success",
          verdictWithheld: "fixture does not publish",
        }),
      }).catch(() => 1);
      const resultPath = ${options.configThrows || options.ledgerReadThrows ? "startPhasesLedgerPath" : "ledgerPathFor({ root })"};
      process.stdout.write(JSON.stringify(readLedgerLines(resultPath)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
  assert.equal(child.status, 0, `review probe failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, unknown>[];
}

test("a review records its start before its first row", () => {
  const rows = drive();
  const i = rows.findIndex(r => r.step === "review.start_phases");
  assert.ok(i >= 0, "a review.start_phases row is written");
  const row = rows[i]!;
  assert.equal(row.head_sha, HEAD);
  for (const key of ["config_load_ms", "ledger_read_ms", "fetch_head_ms", "total_ms"]) {
    assert.equal(typeof row[key], "number", key);
  }
  const provenance = rows.findIndex(r => r.step === "review.provider_provenance");
  if (provenance >= 0) assert.ok(i < provenance, "start_phases precedes provider_provenance");
  const taskRow = drive({ resolveMissingTask: true }).find(r => r.step === "review.start_phases");
  assert.ok(taskRow, "start phases are written when both task resolvers run");
  assert.equal(typeof taskRow.head_criteria_ms, "number");
  assert.equal(typeof taskRow.main_criteria_ms, "number");
});

test("a start step that throws still records its elapsed time and error class", () => {
  const row = drive({ fetchHeadThrows: true }).find(r => r.step === "review.start_phases");
  assert.ok(row, "row written despite the throw");
  assert.equal(typeof row.fetch_head_ms, "number");
  assert.equal(row.fetch_head_error, "Boom");
});

test("config-load and ledger-read failures persist the partial start phases", () => {
  const configRow = drive({ configThrows: true }).find(r => r.step === "review.start_phases");
  assert.ok(configRow, "config failure still writes the start row to its fallback ledger");
  assert.equal(typeof configRow.config_load_ms, "number");
  assert.equal(configRow.config_load_error, "Boom");

  const ledgerRow = drive({ ledgerReadThrows: true }).find(r => r.step === "review.start_phases");
  assert.ok(ledgerRow, "ledger-read failure writes the start row to its fallback ledger");
  assert.equal(typeof ledgerRow.config_load_ms, "number");
  assert.equal(typeof ledgerRow.ledger_read_ms, "number");
  assert.equal(typeof ledgerRow.ledger_read_error, "string");
});
