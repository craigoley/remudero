/**
 * test/a-run-branch-for-an-ineligible-task-refuses-before-its-first-push.test.ts — W1-T3600.
 *
 * Replay of the #5603/W1-T3598 incident (2026-09-15): a session built W1-T3598 while its declared
 * dependency W1-T3597 was still an open PR, drove #5603 through a full build, a review-ready body
 * and every CI round, and only THEN was it closed by the sweep's `currentPlanIneligibilityReason`
 * (src/lib/sweep.ts) — correctly, but after everything spendable had already been spent. This is
 * the regression lock for the earlier refusal: a first push to a `run-<taskId>-*` branch whose task
 * has an unmet dependency in the CURRENT plan is refused before any of that cost is incurred.
 *
 * `scripts/run-branch-eligibility-check.mjs` is a plain `.mjs` file that imports `src/lib/*.ts`
 * directly (design (i): reuse the sweep's own predicate, never a second copy), so — like
 * `scripts/head-identity-gate.mjs`'s own suite — it is exercised here via a dynamic `import()`
 * rather than a static one, keeping `scripts/**` (outside tsconfig's `include`) out of typecheck.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

import type { Plan, Task } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "run-branch-eligibility-check.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateRunBranchEligibility: (input: {
    headRef: string | undefined;
    plan: Plan;
    projectionsById?: Map<string, { merged?: boolean; source?: "trailer" | "head-branch"; prNumber?: number }>;
    reachable?: boolean;
  }) => { applicable: boolean; taskId?: string; admitted?: boolean; reason?: string; unknown?: boolean; taskNotFound?: boolean };
  main: (argv: string[]) => void;
};
const { evaluateRunBranchEligibility, main } = mod;

const TASK_ID = "W1-T9001";
const DEP_ID = "W1-T9000";

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "the dependent build",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planWith(depends_on: string[]): Plan {
  const dep: Task = baseTask({ id: DEP_ID, title: "the dependency", depends_on: [] });
  const task = baseTask({ depends_on });
  return { tasks: [task, dep], byId: new Map([[task.id, task], [dep.id, dep]]) };
}

const BRANCH = `run-${TASK_ID}-1789232400000`;

test("W1-T3600: a run branch for a task with an unmet dependency refuses and names it, on its FIRST push", () => {
  const plan = planWith([DEP_ID]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, true);
  assert.equal(verdict.admitted, false, "an unmet dependency must refuse the first push");
  assert.match(verdict.reason ?? "", /unmet dependency in the current plan: W1-T9000/);
});

test("W1-T3600: a run branch for a fully eligible task is admitted", () => {
  // FALSIFIER: this arm must be able to fail. If the check refused every run-branch it would pass
  // this assertion trivially only by refusing — asserting admitted===true against a task with NO
  // dependency at all is what a blanket-refuse implementation cannot satisfy.
  const plan = planWith([]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, true);
  assert.equal(verdict.admitted, true, "a task with no dependency must be admitted, not refused");
  assert.equal(verdict.reason, undefined);
});

test("W1-T3600: a dependency merged by head branch alone still counts as merged, with no trailer anywhere", () => {
  // FALSIFIER: the fixture credits ONLY via `source: "head-branch"` — no trailer entry exists for
  // this dependency anywhere — so a resolver that reads trailers alone must fail this assertion.
  const plan = planWith([DEP_ID]);
  const projectionsById = new Map([[DEP_ID, { merged: true, source: "head-branch" as const, prNumber: 1657 }]]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById, reachable: true });

  assert.equal(verdict.admitted, true, "a head-branch-only credited dependency must not read as unmet");
  assert.equal(verdict.reason, undefined);
});

test("W1-T3600: an unreadable merged surface degrades to unknown and does not refuse", () => {
  // FALSIFIER: the dependency is genuinely unmerged here (empty projection) AND the surface is
  // unreachable — a fail-closed degradation would refuse on the unmet dependency it cannot rule
  // out; this asserts the opposite, so an inverted implementation fails this exact line.
  const plan = planWith([DEP_ID]);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: false });

  assert.equal(verdict.admitted, true, "an unreadable merged surface must admit, never refuse");
  assert.equal(verdict.unknown, true, "the verdict must say the surface was unknown, not silently clean");
});

test("W1-T3600: a branch that names no task is not this check's business", () => {
  const plan = planWith([]);
  const verdict = evaluateRunBranchEligibility({ headRef: "chore/tidy-things", plan, projectionsById: new Map(), reachable: true });

  assert.equal(verdict.applicable, false, "a non-run-shaped branch must pass through untouched");
});

// ── main(): the CLI half ────────────────────────────────────────────────────────────────────────
//
// `evaluateRunBranchEligibility` above is the predicate; everything that DECIDES WHAT TO ASK IT
// lives in `main` — which head ref to read, which plan to load, whether the merged surface is even
// reachable, and which of those outcomes is a refusal rather than an admission. `diff-coverage`
// named that half as added lines with zero covering tests, and it was right: a pre-push gate whose
// refusal path never runs in a test is a gate nobody has watched refuse.
//
// Every case below drives the REAL `main` against a REAL git repo and reads its real exit code. No
// case touches the network: the two that would (a dependency projection, and `gh auth status`) are
// reached instead through a stubbed `gh` on PATH, so the same branch is taken on a runner that has
// gh authenticated and in a container that has no gh at all.

const MADE: string[] = [];
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** A real git repo whose `plan/tasks.yaml` declares exactly `tasks`, committed and pinned at
 *  `refs/remotes/origin/main` so `loadPlanAtRef`'s own `git show` runs for real.
 *
 *  Built on test/helpers/git-repo.ts rather than a local `git init`. test/fixture-copy-census.ts
 *  counts the files that hand-roll this shape and refuses growth, and it is right to: the helper
 *  already carries the fixture's own identity env, which is the half a hand-rolled copy forgets
 *  and which then fails on every runner (`actions/checkout` sets neither repo nor global git
 *  identity) while passing on every dev machine. */
function repoWithTasks(tasks: { id: string; dependsOn?: string[]; status?: string }[]): string {
  const repo = gitRepo({ branch: "main", kind: "w1t3600-main" });
  const dir = repo.dir;
  const g = (args: string[]) => repo.git(...args);
  mkdirSync(join(dir, "plan"), { recursive: true });
  const yaml = tasks
    .map((t) =>
      [
        `- id: ${t.id}`,
        `  title: "fixture ${t.id}"`,
        `  repo: remudero`,
        `  depends_on: [${(t.dependsOn ?? []).join(", ")}]`,
        `  type: implement`,
        `  verify: auto`,
        `  risk: medium`,
        `  status: ${t.status ?? "queued"}`,
        `  attempts: 0`,
      ].join("\n"),
    )
    .join("\n");
  writeFileSync(join(dir, "plan", "tasks.yaml"), `${yaml}\n`);
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

/** Decide the reachability probe HERE rather than by whether the machine running the suite happens
 *  to have the CLI installed and authenticated. Built on test/helpers/gh-shim.ts for the same
 *  reason repoWithTasks uses the git helper: the copy census counts hand-written shims.
 *
 *  ONLY THE PROBE IS ROUTED. Every other invocation falls through the shim's default (exit 0, no
 *  stdout), which is what lets the projection read an EMPTY merged surface rather than an
 *  unreadable one — the exact distinction the two dependency cases below turn on. */
function withStubGh(probeExit: number, fn: () => void) {
  const shim = ghShim([{ when: "auth status", exit: probeExit }], { kind: "w1t3600-gh" });
  const realPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${realPath ?? ""}`;
  try {
    fn();
  } finally {
    process.env.PATH = realPath;
  }
}

/** Run `main` capturing what it printed and the exit code it set, restoring both afterwards. */
function run(argv: string[]): { out: string; err: string; code: number } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const priorCode = process.exitCode;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    main(argv);
    return { out: out.join("\n"), err: err.join("\n"), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exitCode = priorCode;
  }
}

test("W1-T3600 main: a head ref that names no task is not this check's business", () => {
  const r = run(["--head-ref", "chore/some-branch"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /names no task, not this check's business/);
});

test("W1-T3600 main: a plan that cannot be read at the base ref admits rather than refusing", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "w1t3600-bare-"));
  MADE.push(notARepo);
  const r = run(["--head-ref", BRANCH, "--cwd", notARepo, "--base", "origin/main"]);
  assert.equal(r.code, 0, "an unreadable surface must never manufacture a refusal");
  assert.match(r.out, /UNKNOWN -- could not read the current plan/);
});

test("W1-T3600 main: a task the current plan does not declare is admitted", () => {
  const dir = repoWithTasks([{ id: DEP_ID }]);
  const r = run(["--head-ref", BRANCH, "--cwd", dir]);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`${TASK_ID} is not declared in the current plan`));
});

test("W1-T3600 main: a declared task with every dependency met is admitted", () => {
  const dir = repoWithTasks([{ id: TASK_ID }, { id: DEP_ID }]);
  // No dependency, so the gh probe is never reached — proven by stubbing gh to FAIL: if the probe
  // ran, this would print the UNKNOWN warning instead of a clean admission.
  withStubGh(1, () => {
    const r = run(["--head-ref", BRANCH, "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`${TASK_ID} is runnable in the current plan`));
    assert.doesNotMatch(r.out, /UNKNOWN|WARNING/, "a task with no dependencies must not probe the merged surface at all");
  });
});

test("W1-T3600 main: a blocked task's first push is refused, and the refusal names the reason", () => {
  const dir = repoWithTasks([{ id: TASK_ID, status: "blocked" }, { id: DEP_ID }]);
  const r = run(["--head-ref", BRANCH, "--cwd", dir]);
  assert.equal(r.code, 1, "this is the refusal the whole task exists to produce");
  assert.match(r.err, /FAILED -- W1-T9001's first push is refused: blocked in the current plan/);
  assert.match(r.err, /Rebase onto a plan where the dependency has actually merged/);
});

test("W1-T3600 main: an unreadable merged surface degrades an unmet dependency to UNKNOWN, never a refusal", () => {
  const dir = repoWithTasks([{ id: TASK_ID, dependsOn: [DEP_ID] }, { id: DEP_ID }]);
  withStubGh(1, () => {
    const r = run(["--head-ref", BRANCH, "--cwd", dir]);
    assert.equal(r.code, 0, "failing open is the contract: a network hiccup must not refuse a push");
    assert.match(r.out, /WARNING -- `gh auth status` failed/);
    assert.match(r.out, /UNKNOWN: merged surface unreadable, admitted rather than refused/);
  });
});

test("W1-T3600: a run-branch naming an id the current plan no longer declares is admitted, not refused", () => {
  // The predicate's own arm for it, distinct from main's earlier short-circuit above: a branch may
  // outlive the record it names (a retired or renumbered id), and that is an absent subject rather
  // than an ineligible one — there is nothing to refuse against.
  const plan = planWith([]);
  plan.byId.delete(TASK_ID);
  const verdict = evaluateRunBranchEligibility({ headRef: BRANCH, plan, projectionsById: new Map(), reachable: true });
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.taskNotFound, true);
  assert.equal(verdict.admitted, true, "an id the plan does not declare cannot be ineligible");
  assert.equal(verdict.reason, undefined);
});

test("W1-T3600 main: with no --head-ref it reads the checked-out branch", () => {
  const dir = repoWithTasks([{ id: TASK_ID }, { id: DEP_ID }]);
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", BRANCH], { env: { ...process.env, ...GIT_ENV } });
  const priorHeadRef = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    const r = run(["--cwd", dir]);
    assert.equal(r.code, 0);
    // The branch was never passed in — resolving it from the checkout is the only way this id appears.
    assert.match(r.out, new RegExp(`${TASK_ID} is runnable in the current plan`));
  } finally {
    if (priorHeadRef === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = priorHeadRef;
  }
});

test("W1-T3600 main: owner/repo comes from the git remote, and a readable surface refuses an unmet dependency", () => {
  const dir = repoWithTasks([{ id: TASK_ID, dependsOn: [DEP_ID] }, { id: DEP_ID }]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:craigoley/remudero.git"], {
    env: { ...process.env, ...GIT_ENV },
  });
  // The probe answers clean, so owner/repo IS resolved from the remote added above and the
  // projection is attempted -- the arm the failing-probe case never reaches, and the only thing
  // this case exists to pin.
  //
  // IT DELIBERATELY DOES NOT ASSERT THE VERDICT. Once the probe passes, the projection runs
  // against the real transport, and whether that transport answers or throws is a property of the
  // MACHINE, not of this diff: in a container with no credentials it reads an empty surface and
  // the run refuses, on a runner it can degrade to UNKNOWN instead. An earlier revision of this
  // case asserted the refusal and duly passed here and failed in CI -- the git-plumbing fixture
  // trap in a gh flavour. The refusal itself is pinned deterministically by the first test in this
  // file, which drives the predicate with an injected projection and no transport at all.
  //
  // What IS invariant, and what this case actually claims: owner/repo came from the git remote, so
  // the resolver never reported that it could not find one. Its mirror is the next case, where no
  // remote exists and that exact message MUST appear.
  withStubGh(0, () => {
    const r = run(["--cwd", dir, "--head-ref", BRANCH]);
    assert.doesNotMatch(
      `${r.out}\n${r.err}`,
      /could not resolve owner\/repo from remote/,
      "owner/repo must be read from the configured remote, not reported unresolvable",
    );
    assert.ok(r.code === 0 || r.code === 1, "either verdict is legitimate here; only the resolution above is pinned");
  });
});

test("W1-T3600: the script runs as a real CLI, not only as an imported module", () => {
  // The module-entry guard is the difference between a gate and a library nobody invokes: every
  // test above imports `main` directly, so none of them would notice if the file stopped running
  // itself. This spawns it the way the npm script does.
  const r = execFileSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--head-ref", "chore/not-a-run-branch"],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } },
  );
  assert.match(r, /run-branch-eligibility: OK/);
  assert.match(r, /names no task, not this check's business/);
});

test("W1-T3600 main: a surface that cannot be identified at all degrades to UNKNOWN, never a refusal", () => {
  // The third way the merged surface can be unreadable, and the only one neither case above
  // reaches: the probe answers clean, so the projection is attempted, but the repo has no remote to
  // resolve owner/repo from and the attempt throws before any request is made. The distinction that
  // matters is against the case directly above, where the surface WAS readable and said "nothing
  // merged" \u2014 that one refuses; this one cannot tell, so it admits.
  const dir = repoWithTasks([{ id: TASK_ID, dependsOn: [DEP_ID] }, { id: DEP_ID }]);
  withStubGh(0, () => {
    const r = run(["--cwd", dir, "--head-ref", BRANCH]);
    assert.equal(r.code, 0, "an unidentifiable surface must admit, not refuse");
    assert.match(r.out, /WARNING -- could not read the merged surface for W1-T9001's dependencies/);
    assert.match(r.out, /could not resolve owner\/repo from remote "origin"/);
    assert.match(r.out, /UNKNOWN: merged surface unreadable, admitted rather than refused/);
  });
});
