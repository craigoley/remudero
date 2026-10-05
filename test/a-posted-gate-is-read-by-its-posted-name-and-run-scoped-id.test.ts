// W1-T5802 — a posted gate is read by its posted name and by its run-scoped external id.
//
// W1-T5695 changes what ci.yml's checks-API reporter posts: each post's external_id becomes
// `run:<runId>:<attempt>:job:<id>`, and `rule-checks` is posted under its own name with no job of
// that name. Every reader must accept that shape BEFORE the reporter posts it: `checkJobId`
// (src/lib/sweep.ts) feeds the sweep's ci-gate rerun, `fetchCiFailures`' annotation and log reads
// and `cancelledRequiredChecks`; `derivePrCheckCandidates` (src/lib/ci-control-plane.ts) feeds the
// every-pr-check-is-required-or-advisory registry and scripts/ci-control-plane-precheck.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  derivePrCheckCandidates,
  findPrCheckRegistryGaps,
  loadCiGateLists,
  loadWorkflowDocuments,
  type WorkflowDoc,
} from "../src/lib/ci-control-plane.js";
import { checkJobId } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepEffects, cancelledRequiredChecks, fetchCiFailures } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner";
const REPO = "repo";
const SHA = "abc123";
const RUN_SCOPED = "run:777:2:job:12345";
/** A posted check as the REST rollup reader maps it: GitHub rewrote its detailsUrl to /runs/<id>. */
const POSTED = {
  name: "rule-checks",
  conclusion: "FAILURE",
  startedAt: "2026-10-05T06:00:00Z",
  detailsUrl: "https://github.com/owner/repo/runs/900",
  externalId: RUN_SCOPED,
};

test("checkJobId reads the job id from a run-scoped external id and from the bare job form, and from nothing else", () => {
  assert.equal(checkJobId({ externalId: RUN_SCOPED }), "12345");
  assert.equal(checkJobId({ externalId: "job:12345" }), "12345");
  assert.equal(checkJobId({ detailsUrl: POSTED.detailsUrl, externalId: RUN_SCOPED }), "12345");
  // detailsUrl's /job/<id> still wins over either external id form.
  assert.equal(checkJobId({ detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/55", externalId: RUN_SCOPED }), "55");
  for (const externalId of [
    "run:777:job:12345",
    "run:777:2:job:",
    "run:777:2:job:12345x",
    "xrun:777:2:job:12345",
    "run:777:2:job:12345:job:9",
    "run:a:2:job:12345",
    "run:777:2:check:12345",
    "job:12345:extra",
    "check:900",
    "",
  ]) {
    assert.equal(checkJobId({ detailsUrl: POSTED.detailsUrl, externalId }), undefined, externalId);
  }
  assert.equal(checkJobId({ detailsUrl: POSTED.detailsUrl }), undefined);
});

test("fetchCiFailures and cancelledRequiredChecks carry the job id of a run-scoped post", () => {
  const annotationReads: string[] = [];
  const logReads: string[] = [];
  const failures = fetchCiFailures(OWNER, REPO, [POSTED], 60, {
    fetchAnnotations: (_owner, _repo, jobId) => { annotationReads.push(jobId); return []; },
    fetchJobLog: (_owner, _repo, jobId) => { logReads.push(jobId); return `failed job ${jobId}`; },
  });
  assert.equal(failures[0]?.jobId, "12345");
  assert.deepEqual(annotationReads, ["12345"]);
  assert.deepEqual(logReads, ["12345"]);
  assert.match(failures[0]?.logTail ?? "", /failed job 12345/);
  assert.equal(failures[0]?.logUnavailable, undefined);

  const cancelled = cancelledRequiredChecks([{ ...POSTED, conclusion: "CANCELLED" }], [POSTED.name]);
  assert.deepEqual(cancelled, [{ name: POSTED.name, jobId: "12345" }]);
});

test("a stale ci-gate posted with a run-scoped external id is rerun by its job id", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-scoped-post-`));
  try {
    const calls: string[][] = [];
    const effects = buildSweepEffects({
      owner: OWNER,
      repo: REPO,
      config: { root } as never,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "test",
      plan: {} as never,
      log: () => {},
      readJsonImpl: async (args) => {
        if (args[1].includes("/check-runs?")) {
          return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "failure", details_url: POSTED.detailsUrl, external_id: RUN_SCOPED, started_at: POSTED.startedAt }] };
        }
        if (args[1].endsWith("/status")) return { statuses: [] };
        throw new Error(`unexpected read: ${args[1]}`);
      },
      ghRunImpl: (_file, args) => { calls.push([...args]); },
    });
    await effects.reaggregateCiGate?.(
      { prNumber: 1, headSha: SHA } as never,
      { siblingName: "rule-checks", siblingStartedAt: POSTED.startedAt, jobId: undefined } as never,
    );
    assert.deepEqual(calls, [["api", "-X", "POST", `repos/${OWNER}/${REPO}/actions/jobs/12345/rerun`]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const REPORTER_WORKFLOW = `
on:
  pull_request:
jobs:
  bundle:
    name: light-gates
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: say a report line without posting anything
        run: |
          report "said-but-never-posted" "\${OUTCOME}"
      - name: report gates
        run: |
          report() {
            local check_name="$1"
            gh api "repos/\${GITHUB_REPOSITORY}/check-runs" \\
              -f "name=\${check_name}" \\
              -f "external_id=run:\${RUN_ID}:\${RUN_ATTEMPT}:job:\${POSTING_JOB_ID}"
          }
          report "rule-checks" "\${OUTCOME_RULE_CHECKS}"
          report "light-gates" "\${OUTCOME_SELF}"
          report "gate-\${SUFFIX}" "\${OUTCOME_TEMPLATED}"
  reader:
    name: reader
    steps:
      - run: |
          gh api "repos/\${GITHUB_REPOSITORY}/commits/\${SHA}/check-runs"
          report "read-not-posted" "x"
  composite:
    uses: ./.github/workflows/elsewhere.yml
`;

test("derivePrCheckCandidates names a check a step posts with report even when no job carries that name", () => {
  const candidates = derivePrCheckCandidates("fixture.yml", parseYaml(REPORTER_WORKFLOW) as WorkflowDoc);
  assert.ok(candidates.includes("rule-checks"), `the posted-only name is derived: ${JSON.stringify(candidates)}`);
  assert.ok(candidates.includes("light-gates"));
  assert.ok(candidates.includes("reader"));
  // A posted name that equals its job's own name is one candidate, not two.
  assert.equal(candidates.filter((c) => c === "light-gates").length, 1);
  // A `report` line in a step that posts nothing is not derived — nor is a check-runs READ a post.
  assert.ok(!candidates.includes("said-but-never-posted"));
  assert.ok(!candidates.includes("read-not-posted"));
  // The `report()` definition is not a call line.
  assert.ok(!candidates.some((c) => c.startsWith("report")));
  // A name that still holds a shell template gets the unresolved-template marker, never a guess.
  const templated = candidates.filter((c) => c.includes("unresolved template"));
  assert.equal(templated.length, 1);
  assert.match(templated[0]!, /^fixture\.yml#bundle \(unresolved template in a posted check name: "gate-\$\{SUFFIX\}"\)$/);
  assert.ok(!candidates.includes("gate-${SUFFIX}"));

  const gaps = findPrCheckRegistryGaps(candidates, new Set(["light-gates", "reader"]), new Set(), new Set(candidates.filter((c) => c.includes("#"))));
  assert.deepEqual(gaps, ["rule-checks"]);

  const notOnPr = parseYaml(REPORTER_WORKFLOW.replace("pull_request:", "push:")) as WorkflowDoc;
  assert.deepEqual(derivePrCheckCandidates("fixture.yml", notOnPr), []);
});

test("the real tree's posted names are derived and its registry gaps stay empty", () => {
  const { required, advisory, ignore } = loadCiGateLists(REPO_ROOT);
  const workflows = loadWorkflowDocuments(REPO_ROOT);
  const candidates = workflows.flatMap(({ relPath, doc }) => derivePrCheckCandidates(relPath, doc));
  assert.deepEqual(findPrCheckRegistryGaps(candidates, required, advisory, ignore), []);

  const ci = workflows.find(({ relPath }) => relPath === "ci.yml");
  const steps = Object.values(ci?.doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const posted = steps
    .filter((step) => step.run?.includes("repos/${GITHUB_REPOSITORY}/check-runs"))
    .flatMap((step) => [...(step.run ?? "").matchAll(/^\s*report "([^"]+)"/gm)].map((m) => m[1]!));
  assert.ok(posted.length >= 10, `sanity: ci.yml's reporter posts real names: ${JSON.stringify(posted)}`);
  for (const name of posted) assert.ok(candidates.includes(name), `${name} is posted but not derived`);
});
