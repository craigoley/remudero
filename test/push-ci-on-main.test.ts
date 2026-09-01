import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { baseCausedCheckName, classifyRedCause, type CiFailure, type OpenPrView } from "../src/lib/sweep.js";

// ── W1-T1033: nothing ran the suite against `main` ──────────────────────────────────────────
//
// `ci.yml` and `ci-gate.yml` were BOTH `on: pull_request` and nothing else, so a broken merge
// was invisible until an unrelated PR failed for a reason its author could not explain. Three
// PRs merged red past a required check (admin bypass — `enforce_admins` reads `false`), and ten
// open PRs went red behind them for one inherited cause nothing attributed.
//
// THE FIX IS SCOPED TO `ci` ALONE (design note i): `ci-gate` must never gain a push trigger —
// its `SHA` env is `github.event.pull_request.head.sha`, empty on a push, and its
// `concurrency.group` collapses every push into one cancel-in-progress group. `coverage-ratchet`
// is excluded too — its diff-coverage half reads `github.event.pull_request.base.sha`, also
// empty on a push, and even wired to the previous commit it answers a different question. Every
// OTHER job in ci.yml shares that shape (either reads PR-scoped context directly, or is simply
// out of the measured minimum set) and stays PR-only via `if: github.event_name ==
// 'pull_request'` — see ci.yml's own `on:` block comment.
//
// Reads the real files on disk, never a copy-pasted fixture, so a later edit to either workflow
// is what this suite actually reads — same convention as test/workflow-job-timeouts.test.ts and
// test/workflow-playwright-install.test.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const CI_GATE_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CiJob = {
  name?: string;
  if?: string;
  steps?: Array<{ run?: string }>;
};

type CiDoc = {
  on: { pull_request?: unknown; push?: { branches?: string[] } };
  jobs: Record<string, CiJob>;
};

async function loadCiDoc(): Promise<CiDoc> {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  return parseYaml(raw) as CiDoc;
}

// ── acceptance 1: the suite runs against main on a push ─────────────────────────────────────

test("W1-T1033: the ci workflow runs the suite on a push to main", async () => {
  const doc = await loadCiDoc();

  assert.deepEqual(
    doc.on.push?.branches,
    ["main"],
    "ci.yml's `on:` must declare `push: branches: [main]` — the trigger that was entirely absent",
  );

  const ci = doc.jobs.ci;
  assert.ok(ci, "ci.yml must still define the `ci` job");
  assert.equal(
    ci!.if,
    undefined,
    "the `ci` job must carry no `if:` gate — it is the one job meant to run on BOTH the " +
      "pre-existing pull_request trigger and the new push trigger",
  );

  const runs = (ci!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runs.some((r) => r.includes("npm run test:ci -- --test-shard=${{ matrix.shard }}/4")),
    "the `ci` matrix must run every test shard through npm's existing retry entry point — that is what a push run observes",
  );

  // The job body itself must stay push-safe: zero references to PR-scoped context that would be
  // empty on a push (this is the rationale's own CONTROL: `coverage-ratchet`'s diff-coverage step
  // carries exactly one such reference, which is why that job — unlike `ci` — must stay gated).
  for (const run of runs) {
    for (const token of ["github.event", "pull_request", "BASE_SHA"]) {
      assert.ok(!run.includes(token), `the ci job's steps must not reference '${token}' — that would break on a push`);
    }
  }
});

// ── acceptance 2: ci-gate is never triggered by a push ──────────────────────────────────────

test("W1-T1033: ci-gate is never triggered by a push", async () => {
  const raw = await readFile(CI_GATE_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as { on: Record<string, unknown> };

  assert.ok(
    !("push" in doc.on),
    "ci-gate.yml must declare no `push` trigger — its SHA env " +
      "(github.event.pull_request.head.sha) is empty on a push and its concurrency.group " +
      "collapses every push into one cancel-in-progress group",
  );
  assert.deepEqual(Object.keys(doc.on), ["pull_request"], "ci-gate.yml's `on:` must stay pull_request-only");

  // Defensive positive control on the property this test protects: the env vars the rationale
  // cites as WHY a push would break ci-gate must still be present, so this assertion is proven
  // to be reading a live hazard rather than a stale/removed one.
  assert.ok(raw.includes("github.event.pull_request.head.sha"), "sanity: ci-gate.yml's SHA env should still read the PR head sha");
  assert.ok(raw.includes("ci-gate-${{ github.event.pull_request.number }}"), "sanity: ci-gate.yml's concurrency.group should still key on the PR number");
});

// ── acceptance 3: a red push run reaches a named reader ─────────────────────────────────────
//
// `files:` bars any src/ edit (Rule 25 — `.github/workflows/ci.yml` + `src/lib/sweep.ts` in one
// diff is entangled=TRUE), so the reader this proves against is the UNMODIFIED
// `classifyRedCause`/`baseCausedCheckName` (src/lib/sweep.ts) — design note (iii) names these as
// the existing, already-correct consumer; wiring a `main`-push-specific input into them is a
// separate, src/-touching task. What a fixture CAN prove without changing src/: the failing
// check name a red `ci` push run on `main` would carry is the exact same name
// (`baseCausedCheckName`'s cross-PR fact) the reader already attributes when every open PR
// carries it — so the signal a red main run emits reaches this named reader's own vocabulary,
// not a fourth mechanism nobody reads (design note iii's own "reason rides the EXISTING
// sweep.disposed line" point).
test("W1-T1033: a red main run reaches its named reader", async () => {
  const doc = await loadCiDoc();
  const ciJobName = Object.values(doc.jobs).find((job) => job.name === "ci")?.name;
  assert.equal(ciJobName, "ci", "the stable shard aggregator must retain the check-run name a push run on main reports under");

  function ciFailure(over: Partial<CiFailure> = {}): CiFailure {
    return { name: ciJobName!, logTail: "AssertionError: expected 1 to equal 2", ...over };
  }
  function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
    return {
      prNumber: 9001,
      prUrl: "https://github.com/craigoley/remudero/pull/9001",
      reviewState: "success",
      checksState: "red",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: "2026-08-19T18:00:00Z",
      headSha: "deadbeef",
      autoMergeArmed: false,
      ciFailures: [ciFailure()],
      ...over,
    };
  }

  // Two open PRs both carrying a `ci`-named failure — the shape a red push run on `main` would
  // leave behind on every PR built against it, since main's own `ci` run shares the check name.
  const a = redPr({ prNumber: 9001 });
  const b = redPr({ prNumber: 9002 });

  assert.equal(
    baseCausedCheckName(a, [a, b]),
    ciJobName,
    "the named reader must attribute the SAME check name a red main push run would carry",
  );
  assert.equal(
    classifyRedCause(a, [a, b]),
    "base-caused",
    "the reader must classify a main-shaped red as base-caused, not in-diff — a strike must not be spent chasing it",
  );

  // Falsifier: a survivor (not failing the ci-named check) refutes the base-caused reading — the
  // reader is not merely returning a constant.
  const survivor = redPr({ prNumber: 9003, ciFailures: [ciFailure({ name: "commitlint" })] });
  assert.equal(
    classifyRedCause(a, [a, b, survivor]),
    "in-diff",
    "one PR not failing the ci-named check must refute base-caused — proves the reader actually discriminates",
  );
});

// ── acceptance 4: the pull-request path is unchanged, so no PR gains or loses a check ───────

test("W1-T1033: the pull request trigger is byte-for-byte unchanged", async () => {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = await loadCiDoc();

  // The `pull_request:` trigger declaration itself is untouched: no branch/path filter was added
  // to it (unlike a hypothetical narrower push scope) — the exact two tokens that existed before
  // this task still open the `on:` block, byte-for-byte.
  assert.ok(
    raw.includes("on:\n  pull_request:\n"),
    "the `on:\\n  pull_request:\\n` prefix must remain byte-for-byte unchanged — proves no filter " +
      "was added to the pull_request trigger itself",
  );
  assert.equal(
    doc.on.pull_request,
    null,
    "on.pull_request must still parse to no filters at all (null), exactly as it did before this task",
  );

  // No PR gains or loses a check: every job in the file still registers UNCONDITIONALLY on a
  // pull_request event. A job may now carry `if: github.event_name == 'pull_request'` (gating it
  // OFF the new push trigger), but that condition is unconditionally TRUE for a pull_request
  // event — so it is not a path filter and cannot make the job's check run go silently absent
  // for a PR (the exact synthwatch #102 deadlock class ci-gate.yml exists to avoid).
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    // `ci` (must run on both triggers) and `coverage-ratchet` (test/diff-coverage.test.ts asserts
    // its job body carries no `if:` at all — see the next test) carry no gate; every other job
    // does. Either way nothing here narrows what a pull_request event registers.
    if (job.if === undefined) continue;
    if (jobId === "ci-required" || jobId === "coverage-ratchet-required") {
      assert.equal(job.if, "${{ always() }}", `aggregator '${jobId}' must register even when its shards fail`);
    } else {
      assert.equal(
        job.if,
        "github.event_name == 'pull_request'",
        `job '${jobId}' carries an if: condition other than the PR-always-true guard — ` +
          "this could skip its check run on some pull_request event, which would be a lost check",
      );
    }
  }
});

// ── supporting test: coverage-ratchet's own PR-only mechanism does not use `if:` ────────────
//
// coverage-ratchet needs the same PR-only scoping (design note i: its diff-coverage half reads
// `github.event.pull_request.base.sha`, empty on a push) but test/diff-coverage.test.ts already
// asserts its job body carries NO `if:` anywhere (the pre-existing #729/skipped-check-deadlock
// discipline for this specific job). So its four PR-scoped steps (everything after the
// Playwright install, which stays byte-identical to `ci`'s own copy per
// test/workflow-playwright-install.test.ts) open with a plain shell guard instead — this proves
// that mechanism is actually present, on every step design (i) says must not run for real on a
// push, without re-deriving test/diff-coverage.test.ts's own "no if:" assertion.
test("W1-T1033: coverage shards and their stable aggregator skip PR-only work on a push without losing either check", async () => {
  const doc = await loadCiDoc();
  const job = doc.jobs["coverage-ratchet"];
  assert.ok(job, "ci.yml must still declare a coverage-ratchet job");
  assert.equal(job!.if, undefined, "coverage-ratchet must carry no job-level if: (see test/diff-coverage.test.ts)");

  const steps = job!.steps ?? [];
  const guard = '[ "${GITHUB_EVENT_NAME}" = "pull_request" ]';
  const collection = steps.find((step) => step.run?.includes("--experimental-test-coverage"));
  assert.ok(collection?.run?.includes(guard), "each coverage shard must shell-guard its PR-only collection step");

  const aggregator = doc.jobs["coverage-ratchet-required"];
  assert.equal(aggregator.if, "${{ always() }}", "the stable coverage check must register after a failed shard");
  for (const step of aggregator.steps ?? []) {
    if (!step.run?.includes("GITHUB_EVENT_NAME")) continue;
    assert.ok(step.run.includes(guard), `aggregator PR-only step must shell-guard push events, got: ${step.run}`);
    assert.doesNotMatch(step.run, /\bif:/, "the guard must be shell, not a YAML if: key");
  }
});
