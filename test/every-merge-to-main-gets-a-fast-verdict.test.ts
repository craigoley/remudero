/**
 * test/every-merge-to-main-gets-a-fast-verdict.test.ts — W1-T4472.
 *
 * MAIN'S OWN CI REPORTED A RED 50 MINUTES AFTER IT LANDED AND 19 MINUTES AFTER IT WAS FIXED.
 * ci.yml's push lane groups every push to `main` under ONE concurrency key
 * (`ci-${{ github.ref }}`), and GitHub keeps only one RUNNING plus one PENDING run per group,
 * superseding the rest while pending. MEASURED 2026-09-24 (the actions/runs API, ci.yml push runs
 * on main since 09:00Z): 40 runs; 25 cancelled (GitHub's pending-run replacement, not
 * cancel-in-progress), 11 success, 3 failure, 1 in progress; a surviving run took ~37-41 minutes.
 * #7005 merged a semantic skew at 16:52:30Z; ci.yml's own red on it did not land until 17:42Z —
 * after the fix (#7041, 17:23Z) had already merged past it, and `main-health` read "undetermined"
 * throughout because the newest head's required checks were always pending.
 *
 * THE FIX. `.github/workflows/main-tripwire.yml` — a new, non-required, per-commit workflow,
 * grouped so a push can NEVER supersede another push's tripwire run — runs the suites this
 * merge's own pushed range affects (W1-T4404's selector, used for real here, never in the required
 * `ci` lane it stays SHADOW in) against the MERGED tree. `src/lib/main-health-rung.ts` reads a RED
 * tripwire on main's newest head as main red at once, without waiting on the (possibly still-
 * pending, possibly minutes-away) full required run — the asymmetry is one-directional: a GREEN
 * tripwire is never read as evidence of green, only the full required run may report that.
 *
 * THE FIRST TEST'S OWN FALSIFIER (named in the task record): group the tripwire by
 * `github.ref` instead of `github.sha` and this test's own simulation of GitHub's real
 * one-running-plus-one-pending-per-group queueing finds a second push superseding the first
 * commit's run — exactly the defect measured above, reproduced here as a POSITIVE CONTROL against
 * the ref-keyed shape before asserting the shipped, sha-keyed shape never does that.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { IssueGateway } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  MAIN_TRIPWIRE_CHECK_NAME,
  withTripwireOverride,
  type MainHealthRungDeps,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { mainHealthFromRollup, type RollupCheckEntry } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "main-tripwire.yml");

type WorkflowJob = {
  name?: string;
  "timeout-minutes"?: number;
  steps?: Array<{ name?: string; run?: string }>;
};

type WorkflowDoc = {
  on: { push?: { branches?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

function loadWorkflow(): WorkflowDoc {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as WorkflowDoc;
}

// ── GitHub's own queueing rule, minimally reproduced ────────────────────────────────────────────
//
// At most one RUNNING and one PENDING run per concurrency group; a new arrival in a busy group
// cancels the existing PENDING run (never the RUNNING one) and takes its place. This is exactly
// the mechanism the task's rationale names ("GitHub keeps one running and one pending run and
// supersedes the rest ... The cancellations are GitHub's pending-run replacement, not
// cancel-in-progress") — reproduced here as a pure simulation so the shipped `concurrency.group`
// expression can be driven through it directly, rather than trusted by inspection alone.
function simulateSupersession(pushes: ReadonlyArray<{ id: string; group: string }>): Set<string> {
  const cancelled = new Set<string>();
  const state = new Map<string, { running?: string; pending?: string }>();
  for (const p of pushes) {
    const g = state.get(p.group) ?? {};
    if (!g.running) {
      g.running = p.id;
    } else if (!g.pending) {
      g.pending = p.id;
    } else {
      cancelled.add(g.pending);
      g.pending = p.id;
    }
    state.set(p.group, g);
  }
  return cancelled;
}

/** Renders `.github/workflows/`'s `${{ github.sha }}` / `${{ github.ref }}` tokens against a
 *  concrete push, the same substitution GitHub performs when it evaluates `concurrency.group`. */
function renderGroup(template: string, push: { sha: string; ref: string }): string {
  return template.replace(/\$\{\{\s*github\.sha\s*\}\}/g, push.sha).replace(/\$\{\{\s*github\.ref\s*\}\}/g, push.ref);
}

test("W1-T4472: the tripwire groups by commit and never supersedes a merge", () => {
  const doc = loadWorkflow();

  assert.deepEqual(doc.on.push?.branches, ["main"], "main-tripwire.yml must trigger on push to main");
  assert.equal(
    doc.concurrency?.["cancel-in-progress"],
    false,
    "the tripwire must never cancel an in-flight run of itself",
  );
  const groupTemplate = doc.concurrency?.group;
  assert.equal(typeof groupTemplate, "string", "main-tripwire.yml must declare concurrency.group");
  assert.match(
    groupTemplate!,
    /\$\{\{\s*github\.sha\s*\}\}/,
    "the group key must be keyed on github.sha (per-commit), never github.ref alone",
  );

  // A burst of five pushes to main: every real push shares the SAME ref but a DIFFERENT sha.
  const shas = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333", "4444444444444444444444444444444444444444",
    "5555555555555555555555555555555555555555"];
  const ref = "refs/heads/main";

  // POSITIVE CONTROL (the falsifier the task record names): the SAME burst, keyed by github.ref
  // alone — the shape ci.yml's own push lane uses and the shape that produced the 25-of-40
  // cancellations measured above. This must show real supersession, or the simulation below proves
  // nothing.
  const refKeyedPushes = shas.map((sha, i) => ({ id: `push-${i}`, group: renderGroup("ci-${{ github.ref }}", { sha, ref }) }));
  const refKeyedCancelled = simulateSupersession(refKeyedPushes);
  assert.ok(
    refKeyedCancelled.size > 0,
    "control failed: a ref-keyed group over a push burst must show at least one superseded run, " +
      "or this simulation cannot be trusted to detect the real defect",
  );

  // THE SHIPPED SHAPE: the real concurrency.group template from main-tripwire.yml, over the exact
  // same burst. Zero supersessions — every push gets its own group.
  const shaKeyedPushes = shas.map((sha, i) => ({ id: `push-${i}`, group: renderGroup(groupTemplate!, { sha, ref }) }));
  const shaKeyedCancelled = simulateSupersession(shaKeyedPushes);
  assert.deepEqual(
    [...shaKeyedCancelled],
    [],
    "main-tripwire.yml's own concurrency.group must never supersede a merge's tripwire run",
  );

  // Every job declares its own runtime bound (W1-T1009's own discipline, applied here too).
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    assert.ok(
      typeof job["timeout-minutes"] === "number" && job["timeout-minutes"]! > 0,
      `job '${jobId}' must declare a positive timeout-minutes`,
    );
  }
});

test("W1-T4472: the tripwire is never added to the required gate — a non-required, per-commit check", async () => {
  const raw = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  assert.doesNotMatch(
    raw,
    /main-tripwire/,
    "ci-gate.yml's REQUIRED list must never name main-tripwire — it is a best-effort subset run " +
      "(a plan/docs-only push affects zero suites; an unmodelled change falls back to the fast " +
      "tier only), and requiring it would deadlock merges on a check built to sometimes run nothing",
  );
});

test("W1-T4472: the selection step always includes every touched test file and falls back to the fast tier on a full-run trigger", () => {
  const doc = loadWorkflow();
  const job = doc.jobs["main-tripwire"];
  assert.ok(job, "main-tripwire.yml must declare the main-tripwire job");
  const selectStep = (job!.steps ?? []).find((s) => s.run?.includes("main-tripwire-select.mjs"));
  assert.ok(selectStep?.run, "expected a step that generates and runs the selection script");
  const body = selectStep!.run!;

  assert.match(body, /affectedSelectionOrFull/, "must call the real (non-shadow-only) selector library");
  assert.match(body, /readAffectedSuitesInput/);
  assert.match(
    body,
    /touchedTests/,
    "must compute the range's own touched test files, not rely on the selector alone",
  );
  assert.match(
    body,
    /suites\.add\(f\)/,
    "touched test files must be unioned into whatever the selector chose — always included",
  );
  assert.match(
    body,
    /selection\.fullRun/,
    "must branch on a full-run trigger",
  );
  assert.match(
    body,
    /tierFiles\(testFiles, manifest\)/,
    "a full-run trigger must fall back to the fast tier (test-tier-manifest.mjs's own tiering), " +
      "never the full ~37-41 minute run this workflow exists to avoid",
  );
});

// ── src/lib/main-health-rung.ts: a red tripwire reads main red at once ─────────────────────────

const OWNER = "o";
const REPO = "r";
const SHA = "4472".padEnd(40, "0");

type CheckRun = { name: string; status: "completed" | "in_progress"; conclusion?: "success" | "failure" };
const done = (name: string, conclusion: "success" | "failure"): CheckRun => ({ name, status: "completed", conclusion });
const pending = (name: string): CheckRun => ({ name, status: "in_progress" });

function fixture(checkRuns: CheckRun[], overrides: Partial<MainHealthRungDeps> = {}) {
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: SHA };
    if (path === `repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`) return { check_runs: checkRuns };
    if (path === `repos/${OWNER}/${REPO}/commits/${SHA}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) return { workflow_runs: [] };
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const issues: IssueGateway = {
    create: (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${created.length}`;
    },
    listOpen: () => [],
    comment: () => {},
    closeWithComment: () => {},
  };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4472-`));
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-T4472",
    log: (step, extra = {}) => logs.push({ step, extra }),
    readRequiredChecks: () => ["ci", "coverage-ratchet"],
    ...overrides,
  });
  return {
    run: async () => {
      try {
        await rung();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      return { created, logs, observed: logs.find((l) => l.step === "main.health.observed")?.extra };
    },
  };
}

test("W1-T4472: a red tripwire on the newest head reads main red", async () => {
  // The full required run has NOT concluded (both still in_progress) — exactly the "undetermined
  // for the better part of an hour" shape from the rationale — while the non-required tripwire has
  // already concluded red for the very same head.
  const { created, observed } = await fixture([
    pending("ci"),
    pending("coverage-ratchet"),
    done(MAIN_TRIPWIRE_CHECK_NAME, "failure"),
  ]).run();

  assert.equal(observed?.state, "red", "a red tripwire must read main red at once, ahead of the required run concluding");
  assert.ok(
    (observed?.failing_checks as string[] | undefined)?.includes(MAIN_TRIPWIRE_CHECK_NAME),
    "the tripwire's own check name must be named among the failing checks",
  );
  assert.equal(created.length, 1, "a red tripwire escalates exactly like any other red main");
});

test("W1-T4472: a green tripwire is not evidence of green — only the full required run decides that", async () => {
  // The required run is STILL PENDING and the tripwire is green: main must stay undetermined, not
  // flip to green on a subset's pass.
  const { observed } = await fixture([pending("ci"), pending("coverage-ratchet"), done(MAIN_TRIPWIRE_CHECK_NAME, "success")]).run();
  assert.equal(observed?.state, "undetermined", "a green tripwire must never be read as main being green");
});

test("W1-T4472: an absent tripwire leaves the gate-required judgment untouched", async () => {
  const { observed } = await fixture([done("ci", "success"), done("coverage-ratchet", "success")]).run();
  assert.equal(observed?.state, "green");
});

test("withTripwireOverride: pure — a red tripwire escalates an undetermined read, and idempotently folds into an already-red one", () => {
  const rollupRed: RollupCheckEntry[] = [
    { name: "ci", status: "completed", conclusion: "in_progress" },
    { name: MAIN_TRIPWIRE_CHECK_NAME, status: "completed", conclusion: "failure" },
  ];
  const undetermined = mainHealthFromRollup(SHA, rollupRed, new Set(["ci"]));
  assert.equal(undetermined.state, "undetermined");
  const overridden = withTripwireOverride(undetermined, rollupRed);
  assert.equal(overridden.state, "red");
  assert.deepEqual(overridden.failingChecks, [MAIN_TRIPWIRE_CHECK_NAME]);

  // Idempotent: calling it again (e.g. main-tripwire were ever added to `required`, so it is
  // already named) must not duplicate the entry or otherwise change the result.
  const again = withTripwireOverride(overridden, rollupRed);
  assert.deepEqual(again, overridden);
});

test("withTripwireOverride: pure — never downgrades on a green or absent tripwire", () => {
  const rollupGreen: RollupCheckEntry[] = [
    { name: "ci", status: "completed", conclusion: "in_progress" },
    { name: MAIN_TRIPWIRE_CHECK_NAME, status: "completed", conclusion: "success" },
  ];
  const base = mainHealthFromRollup(SHA, rollupGreen, new Set(["ci"]));
  assert.deepEqual(withTripwireOverride(base, rollupGreen), base, "a green tripwire must change nothing");

  const rollupAbsent: RollupCheckEntry[] = [{ name: "ci", status: "completed", conclusion: "in_progress" }];
  const baseAbsent = mainHealthFromRollup(SHA, rollupAbsent, new Set(["ci"]));
  assert.deepEqual(withTripwireOverride(baseAbsent, rollupAbsent), baseAbsent, "an absent tripwire must change nothing");
});
