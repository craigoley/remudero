import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Plan } from "../src/lib/plan.js";
// W1-T5349's own symbols are read through the namespace, so this file still LOADS at a base
// that lacks them and fails per test instead of at import.
import * as sweep from "../src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

// W1-T5349 — a red machine-lane plan-only PR used to get only W1-T4351's `refused-escalate`, an issue
// per head that nobody answered. The rung repairs the three mechanical signatures from the failing
// check's OWN log, once per (PR, head sha), and never touches a PR a person authored.

const NOW = Date.parse("2026-10-02T12:00:00Z");
const HEAD = "a".repeat(40);
const MAIN_RED = "b".repeat(40);
const MAIN_GREEN = "c".repeat(40);
const FLEET = "remudero-fleet[bot]";
const LANE_HEAD = "ci-friction-garden-1790927000000";

// The #8558 job log (110752776526), verbatim in shape: the id the PR declares is HELD by a TRIAGE run.
const HELD_LOG = [
  "task-id-existence: FAILED -- the following added id(s) are HELD by a different reservation holder:",
  "",
  `  W1-T5209 -- reserved by run-TRIAGE-fb-1790926000000-abc123-1790927014697, while this filing is ${LANE_HEAD}`,
  "    plan/tasks.d/W1-T5209-ci-friction-fix.yaml:1",
].join("\n");

const TITLE_LOG = [
  "⧗   input: chore(plan): ratify followup ...",
  "✖   header must not be longer than 100 characters, current length is 105 [header-max-length]",
  "W1-T4399: reported commitlint = failure (step outcome(s): failure success); title: commitlint",
].join("\n");

const LONG_TITLE =
  "chore(plan): ratify the followup that reads the daemon's own dispatch census before it widens anything (W1-T5317)";

function failure(name: string, logTail: string, over: Partial<CiFailure> = {}): CiFailure {
  return { name, logTail, conclusion: "FAILURE", ...over };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8558,
    prUrl: "https://github.com/acme/remudero/pull/8558",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: LANE_HEAD,
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure("task-id-existence", HELD_LOG)],
    body: "Files W1-T5209.\n\n## Acceptance\n- W1-T5209 is filed | grep: W1-T5209 in plan/tasks.d",
    ...over,
  };
}

// A green peer keeps `classifyRedCause` off "base-caused": the red is on ONE PR, not every PR.
function greenPeer(): OpenPrView {
  return planPr({
    prNumber: 6900,
    prUrl: "https://github.com/acme/remudero/pull/6900",
    taskId: "W1-T4000",
    checksState: "green",
    reviewState: "success",
    headSha: "e".repeat(40),
    headRefName: "run-W1-T4000-1",
    isPlanFiling: false,
    ciFailures: undefined,
  });
}

function mainObserved(sha: string, state: string, failing: string[] = []): Record<string, unknown> {
  return { step: "main.health.observed", sha, state, failing_checks: failing };
}

interface Facts {
  authorLogin?: string;
  title?: string;
}

async function pass(prs: OpenPrView[], ledger: Record<string, unknown>[], facts: Facts | (() => Facts), over: Partial<SweepDeps> = {}) {
  const escalated: Array<{ pr: number; reason: string }> = [];
  const repairs: Array<{ pr: number; decision: Record<string, unknown> }> = [];
  const updated: number[] = [];
  const factReads: number[] = [];
  const dispatched: number[] = [];
  const deps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr: OpenPrView) => {
      dispatched.push(pr.prNumber);
    },
    escalate: (pr: OpenPrView, reason: string) => {
      escalated.push({ pr: pr.prNumber, reason });
    },
    postReview: async () => {},
    updateBranch: (pr: { prNumber: number }) => {
      updated.push(pr.prNumber);
      return "updated" as const;
    },
    readPlanRepairFacts: (pr: OpenPrView) => {
      factReads.push(pr.prNumber);
      return typeof facts === "function" ? facts() : facts;
    },
    repairPlanPr: (pr: OpenPrView, decision: Record<string, unknown>) => {
      repairs.push({ pr: pr.prNumber, decision });
      return { outcome: decision.action === "renumber" ? "renumbered" : "retitled" };
    },
    ledgerPath: "/dev/null/w1-t5349.ndjson",
    runId: "W1-T5349-test",
    readLedger: () => ledger,
    appendLine: (_path: string, line: Record<string, unknown>) => {
      ledger.push(line);
    },
    now: () => NOW,
    ...over,
  } as unknown as SweepDeps;
  await runSweep(prs, deps, DEFAULT_SWEEP_POLICY);
  const disposed = (n: number) => ledger.filter((l) => l.step === "sweep.disposed" && l.pr_number === n).at(-1);
  const repairRows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP);
  return { escalated, repairs, updated, factReads, dispatched, disposed, repairRows };
}

test("W1-T5349: a machine-lane plan PR red on a held task id is renumbered through the allocator, once per head", async () => {
  const ledger: Record<string, unknown>[] = [];
  const first = await pass([planPr(), greenPeer()], ledger, { authorLogin: FLEET, title: "chore(plan): file W1-T5209" });
  assert.deepEqual(first.escalated, [], "a held id with a deterministic cure is repaired, not escalated");
  assert.equal(first.repairs.length, 1);
  assert.equal(first.repairs[0]!.decision.signature, "held-task-id");
  assert.equal(first.repairs[0]!.decision.action, "renumber");
  assert.deepEqual(first.repairs[0]!.decision.heldIds, ["W1-T5209"]);
  assert.equal(first.repairs[0]!.decision.title, "chore(plan): file W1-T5209");
  assert.deepEqual(first.dispatched, [], "a plan-only PR never reaches the code-fix lane");
  const row = first.repairRows().at(-1)!;
  assert.equal(row.signature, "held-task-id");
  assert.equal(row.action, "renumber");
  assert.equal(row.outcome, "renumbered");
  assert.equal(row.pr_number, 8558);
  assert.equal(row.head_sha, HEAD);
  assert.equal(first.disposed(8558)?.disposition, "wait");

  // The SAME head red again: the rung already acted on it, so the PR escalates exactly as before.
  const again = await pass([planPr(), greenPeer()], ledger, { authorLogin: FLEET, title: "chore(plan): file W1-T5209" });
  assert.deepEqual(again.repairs, [], "at most one repair per signature per head");
  assert.equal(again.escalated.length, 1);
  assert.match(again.escalated[0]!.reason, /plan-only PR is red on task-id-existence/);
  assert.equal(again.disposed(8558)?.disposition, "refused-escalate");
});

test("W1-T5349: an operator-authored plan PR with the same reds is escalated untouched", async () => {
  // A lane-shaped head authored by a person: the author guard refuses.
  const lanePerson = await pass([planPr(), greenPeer()], [], { authorLogin: "cao825", title: "chore(plan): file W1-T5209" });
  assert.deepEqual(lanePerson.repairs, []);
  assert.deepEqual(lanePerson.updated, []);
  assert.equal(lanePerson.escalated.length, 1);
  assert.match(lanePerson.escalated[0]!.reason, /plan-only PR is red on task-id-existence/);

  // A session head, even one the fleet App pushed: the branch guard refuses before any read.
  for (const head of ["codex/plan-pr-repair", "run-unfiled-1790990900000", "run-W1-T5209-1790927014697", undefined]) {
    const session = await pass([planPr({ headRefName: head }), greenPeer()], [], { authorLogin: FLEET, title: "chore(plan): x" });
    assert.deepEqual(session.factReads, [], `${head}: never read`);
    assert.deepEqual(session.repairs, [], `${head}: never pushed to`);
    assert.equal(session.escalated.length, 1, `${head}: escalated as today`);
  }

  // A fact read that throws is not permission: it escalates as today and says why.
  const ledger: Record<string, unknown>[] = [];
  const unread = await pass([planPr(), greenPeer()], ledger, () => {
    throw new Error("HTTP 502");
  });
  assert.deepEqual(unread.repairs, []);
  assert.equal(unread.escalated.length, 1);
  assert.match(String(ledger.find((l) => l.step === "sweep.plan_repair.read_error")?.error), /HTTP 502/);
});

test("W1-T5349: a held id the rung cannot cure, or a repair that fails, still escalates", async () => {
  // Every other id-existence failure (an unreserved citation) is not a held id.
  const unreserved = failure(
    "task-id-existence",
    "task-id-existence: FAILED -- the following id(s) are cited under src, test but resolve to NEITHER a reservation ref NOR a declared plan record:\n  W1-T5209\n",
  );
  const other = await pass([planPr({ ciFailures: [unreserved] }), greenPeer()], [], { authorLogin: FLEET });
  assert.deepEqual(other.repairs, []);
  assert.equal(other.escalated.length, 1);

  // The collision and open-PR forms ARE held ids; a later "task-id-existence:" line ends the list.
  const collisions = failure(
    "commitlint",
    [
      "task-id-existence: FAILED -- the following id(s) are ALREADY DECLARED:",
      "  W1-T7001 -- the base declares it in plan/tasks.d/W1-T7001-x.yaml, so this change RE-ISSUED it",
      "task-id-existence: FAILED -- the following added id(s) are ALREADY CLAIMED by another OPEN PR:",
      "  W1-T7002 -- claimed by https://github.com/acme/remudero/pull/1",
      "task-id-existence: OK -- nothing else",
      "  W1-T7003 -- not in any failure list",
    ].join("\n"),
  );
  assert.deepEqual(sweep.heldTaskIdsFromCiFailures([collisions, failure("lint-plan", "")]), ["W1-T7001", "W1-T7002"]);

  // The effect reports a non-repair: the PR is escalated with the reason, and the head is spent.
  const ledger: Record<string, unknown>[] = [];
  const failed = await pass([planPr(), greenPeer()], ledger, { authorLogin: FLEET }, {
    repairPlanPr: () => ({ outcome: "not-declared", reason: "W1-T5209 is not declared by a plan file this PR adds" }),
  } as Partial<SweepDeps>);
  assert.equal(failed.escalated.length, 1);
  assert.match(failed.escalated[0]!.reason, /plan repair \(held-task-id\) did not take: not-declared — W1-T5209 is not declared/);
  assert.equal(failed.repairRows().at(-1)?.outcome, "not-declared");

  // A throwing effect is ledgered as an error, never as a repair.
  const thrown = await pass([planPr({ headSha: "d".repeat(40) }), greenPeer()], ledger, { authorLogin: FLEET }, {
    repairPlanPr: () => {
      throw new Error("push refused");
    },
  } as Partial<SweepDeps>);
  assert.equal(thrown.escalated.length, 1);
  assert.match(String(thrown.repairRows().at(-1)?.reason), /push refused/);

  // Unwired effects keep today's escalation.
  const unwired = await pass([planPr({ headSha: "f".repeat(40) }), greenPeer()], [], { authorLogin: FLEET }, {
    repairPlanPr: undefined,
  } as Partial<SweepDeps>);
  assert.equal(unwired.escalated.length, 1);
  assert.deepEqual(unwired.factReads, []);
});

test("W1-T5349: a red main also carries waits while main is red and refreshes once main is green", async () => {
  const pr = planPr({ headRefName: "backlog-garden-1790985598539", ciFailures: [failure("lint-plan", "shard lint debt grew")] });
  const ledger: Record<string, unknown>[] = [mainObserved(MAIN_RED, "red", ["lint-plan", "coverage"])];

  const waiting = await pass([pr, greenPeer()], ledger, { authorLogin: FLEET });
  assert.deepEqual(waiting.escalated, [], "a red main carries is not escalated while main is red");
  assert.deepEqual(waiting.updated, [], "refreshing onto a red main would only re-import the red");
  assert.equal(waiting.disposed(8558)?.disposition, "wait");
  assert.equal(waiting.repairRows().length, 1);
  assert.equal(waiting.repairRows()[0]!.action, "wait");

  // Still red: no second row for the same head.
  await pass([pr, greenPeer()], ledger, { authorLogin: FLEET });
  assert.equal(ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP).length, 1);

  // Main is green: ONE update-branch press.
  ledger.push(mainObserved(MAIN_GREEN, "green"));
  const refreshed = await pass([pr, greenPeer()], ledger, { authorLogin: FLEET });
  assert.deepEqual(refreshed.updated, [8558]);
  assert.deepEqual(refreshed.escalated, []);
  assert.equal(refreshed.repairRows().at(-1)?.action, "refresh");
  assert.equal(refreshed.repairRows().at(-1)?.outcome, "updated");

  // The same head still red after its one refresh: escalated as today.
  const after = await pass([pr, greenPeer()], ledger, { authorLogin: FLEET });
  assert.deepEqual(after.updated, []);
  assert.equal(after.escalated.length, 1);

  // A red the PR carries that main does NOT: its own, escalated.
  const own = await pass(
    [planPr({ headSha: "1".repeat(40), ciFailures: [failure("lint-plan", ""), failure("claims", "")] }), greenPeer()],
    [mainObserved(MAIN_RED, "red", ["lint-plan"])],
    { authorLogin: FLEET },
  );
  assert.deepEqual(own.updated, []);
  assert.equal(own.escalated.length, 1);

  // A refresh that errors is ledgered and escalated.
  const errLedger: Record<string, unknown>[] = [
    mainObserved(MAIN_RED, "red", ["lint-plan"]),
    { step: sweep.PLAN_REPAIR_STEP, pr_number: 8558, head_sha: HEAD, signature: "base-red", action: "wait" },
    mainObserved(MAIN_GREEN, "green"),
  ];
  const errored = await pass([pr, greenPeer()], errLedger, { authorLogin: FLEET }, {
    updateBranch: () => {
      throw new Error("422 conflict");
    },
  } as Partial<SweepDeps>);
  assert.equal(errored.escalated.length, 1);
  assert.match(String(errored.repairRows().at(-1)?.outcome), /error: 422 conflict/);
});

test("W1-T5349: a stale-base proof-discrimination red is refreshed once per PR, never once per head", async () => {
  const stale = (headSha: string) =>
    planPr({ headSha, headRefName: "run-RETRO-1790985475867", currentMergeBaseSha: MAIN_RED, ciFailures: [failure("proof-discrimination", "matches base")] });
  const ledger: Record<string, unknown>[] = [mainObserved(MAIN_GREEN, "green")];
  const first = await pass([stale(HEAD), greenPeer()], ledger, { authorLogin: FLEET });
  assert.deepEqual(first.updated, [8558]);
  assert.equal(first.repairRows().at(-1)?.cause, "stale-base");
  // The refresh made a new head that is still red: a generator defect, not a stale base. Escalate.
  const second = await pass([stale("2".repeat(40)), greenPeer()], ledger, { authorLogin: FLEET });
  assert.deepEqual(second.updated, []);
  assert.equal(second.escalated.length, 1);
  // A PR already on main's green head is not stale.
  const current = await pass(
    [planPr({ headRefName: "run-RETRO-1790985475867", currentMergeBaseSha: MAIN_GREEN, ciFailures: [failure("proof-discrimination", "")] }), greenPeer()],
    [mainObserved(MAIN_GREEN, "green")],
    { authorLogin: FLEET },
  );
  assert.deepEqual(current.updated, []);
});

test("W1-T5349: a red only on title length is retitled by the gardener's fit, and a census red in the commitlint check is not", async () => {
  const titled = planPr({ headRefName: "run-APPROVE-followup-DAEMON-1790086566017-0-1790989180492-9421a6676148", ciFailures: [failure("commitlint", TITLE_LOG, { jobId: "777" })] });
  const ledger: Record<string, unknown>[] = [];
  const first = await pass([titled, greenPeer()], ledger, { authorLogin: "app/remudero-fleet", title: LONG_TITLE });
  assert.equal(first.repairs.length, 1);
  const decision = first.repairs[0]!.decision;
  assert.equal(decision.signature, "title-length");
  assert.equal(decision.action, "retitle");
  assert.equal(decision.jobId, "777");
  const title = String(decision.title);
  assert.ok(title.length <= 100, `fits: ${title.length}`);
  assert.ok(title.endsWith(" (W1-T5317)"), "the trailing task id survives the fit");
  assert.ok(title.startsWith("chore(plan): ratify"));
  assert.deepEqual(first.escalated, []);

  // Same head, title still long (the re-run has not landed): spent, escalate.
  const again = await pass([titled, greenPeer()], ledger, { authorLogin: "app/remudero-fleet", title: LONG_TITLE });
  assert.deepEqual(again.repairs, []);
  assert.equal(again.escalated.length, 1);

  // CHECK-NAME TRAP: "success failure" — the title passed, the rule-checks census failed.
  const census = failure("commitlint", "W1-T4399: reported commitlint = failure (step outcome(s): success failure); title: rule-checks");
  const trap = await pass([planPr({ ciFailures: [census] }), greenPeer()], [], { authorLogin: FLEET, title: LONG_TITLE });
  assert.deepEqual(trap.repairs, []);
  assert.equal(trap.escalated.length, 1);
  // A header-max-length line beside a FAILED census step is not a title-only red either.
  const both = failure("commitlint", `${TITLE_LOG.split("\n")[1]}\nW1-T4399: reported commitlint = failure (step outcome(s): failure failure)`);
  assert.equal(sweep.titleOnlyCommitlintRed([both]), undefined);
  // A title already within the limit is not retitled, whatever the log says.
  const short = await pass([planPr({ ciFailures: [failure("commitlint", TITLE_LOG)] }), greenPeer()], [], { authorLogin: FLEET, title: "chore(plan): short" });
  assert.deepEqual(short.repairs, []);
  // No report line, but a header-max-length rule failure: the title step.
  assert.equal(sweep.titleOnlyCommitlintRed([failure("commitlint", TITLE_LOG.split("\n")[1]!)])?.name, "commitlint");
  assert.equal(sweep.titleOnlyCommitlintRed([failure("lint-plan", TITLE_LOG)]), undefined);
});

test("W1-T5349: lane heads, the fleet author, the title fit and the id rewrite", () => {
  for (const head of [
    "selector-shadow-garden-1790975599748",
    "ci-friction-garden-1790988846926",
    "machine-judge-garden-1790984122958",
    "run-TRIAGE-fb-1789304804534-e29e68-1790989363522",
    "run-APPROVE-followup-DAEMON-1790086566017-2026-09-22T15-04-25.385Z-0-1790989180492-9421a6676148",
    "run-RETRO-1790985475867",
    "feedback-landing",
    "plan-reconcile-landing-craigoley-remudero-measurement-cadence-9bf90913e941",
    "decisions-landing",
  ]) {
    assert.equal(sweep.isMachineLanePlanHead(head), true, head);
  }
  for (const head of ["codex/x", "run-unfiled-1", "run-W1-T5209-1", "fix/stale-ruling-pins-1", "my-garden-1", "plan-garden-x", undefined]) {
    assert.equal(sweep.isMachineLanePlanHead(head), false, String(head));
  }
  assert.equal(sweep.isFleetAppAuthor("remudero-fleet[bot]"), true);
  assert.equal(sweep.isFleetAppAuthor("app/remudero-fleet"), true);
  assert.equal(sweep.isFleetAppAuthor("cao825"), false);
  assert.equal(sweep.isFleetAppAuthor(undefined), false);

  assert.equal(sweep.fitPlanPrTitle("chore(plan): short (W1-T1)"), "chore(plan): short (W1-T1)");
  const noId = sweep.fitPlanPrTitle(`chore(plan): ${"word ".repeat(30)}`);
  assert.ok(noId.length <= 100);

  const renames = new Map([["W1-T5209", "W1-T5400"]]);
  assert.equal(
    sweep.rewriteTaskIds("id: W1-T5209\ndepends_on: [W1-T52090, W1-T5209]\nfile w1-t5209-x.yaml", renames),
    "id: W1-T5400\ndepends_on: [W1-T52090, W1-T5400]\nfile w1-t5400-x.yaml",
  );
});

// ── the production effects ─────────────────────────────────────────────────────────────────────

function fakeWorktree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5349-"));
  const wt = join(root, "wt");
  const calls: string[][] = [];
  const added: string[] = [];
  const removed: string[] = [];
  let head = HEAD;
  const git = (cwd: string, args: readonly string[]): string => {
    calls.push([cwd, ...args]);
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "diff") return `${Object.keys(files).join("\n")}\n`;
    if (args[0] === "commit") head = "9".repeat(40);
    if (args[0] === "mv") {
      const [from, to] = [args[1]!, args[2]!];
      writeFileSync(join(cwd, to), readFileSync(join(cwd, from)));
      rmSync(join(cwd, from));
    }
    return "";
  };
  const deps = {
    repoDir: join(root, "repo"),
    worktreePath: wt,
    git,
    worktreeAdd: (_repo: string, path: string, _branch: string, _base: string) => {
      added.push(_base);
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(path, rel)), { recursive: true });
        writeFileSync(join(path, rel), text);
      }
    },
    worktreeRemove: (_repo: string, path: string) => {
      removed.push(path);
    },
    reserveId: (_wt: string, branch: string) => {
      assert.equal(branch, LANE_HEAD, "the reservation names the lane's own branch as its filer");
      return "W1-T5400";
    },
    updatePr: async (_n: number, patch: { title?: string; body?: string }) => {
      patches.push(patch);
    },
  };
  const patches: Array<{ title?: string; body?: string }> = [];
  return { root, wt, deps, calls, added, removed, patches, setHead: (h: string) => (head = h) };
}

test("W1-T5349: the renumber effect re-mints, renames the shard, rewrites self-references and pushes with a lease", async () => {
  const f = fakeWorktree({
    "plan/tasks.d/W1-T5209-ci-friction-fix.yaml": "- id: W1-T5209\n  title: x\n",
    "plan/tasks.d/w1-t5210-selector-shadow-miss.yaml": "- id: W1-T5210\n  depends_on: [W1-T5209]\n",
  });
  try {
    const out = await withLiveWritesAllowed(() =>
      sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], "chore(plan): file W1-T5209", f.deps),
    );
    assert.equal(out.outcome, "renumbered");
    assert.deepEqual(out.renames, { "W1-T5209": "W1-T5400" });
    assert.equal(out.newHeadSha, "9".repeat(40));
    assert.deepEqual(f.added, [`origin/${LANE_HEAD}`]);
    assert.equal(readFileSync(join(f.wt, "plan/tasks.d/W1-T5400-ci-friction-fix.yaml"), "utf8"), "- id: W1-T5400\n  title: x\n");
    assert.equal(existsSync(join(f.wt, "plan/tasks.d/W1-T5209-ci-friction-fix.yaml")), false);
    assert.match(readFileSync(join(f.wt, "plan/tasks.d/w1-t5210-selector-shadow-miss.yaml"), "utf8"), /depends_on: \[W1-T5400\]/);
    const push = f.calls.find((c) => c[1] === "push")!;
    assert.deepEqual(push.slice(1), ["push", `--force-with-lease=refs/heads/${LANE_HEAD}:${HEAD}`, "origin", `HEAD:refs/heads/${LANE_HEAD}`]);
    const diff = f.calls.find((c) => c[1] === "diff")!;
    assert.ok(diff.includes("--diff-filter=A"), "only the plan files this PR ADDS are rewritten");
    assert.deepEqual(f.patches, [{ title: "chore(plan): file W1-T5400", body: planPr().body!.replace(/W1-T5209/g, "W1-T5400") }]);
    assert.deepEqual(f.removed, [f.wt], "the worktree is always removed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T5349: the renumber effect refuses a moved head, an id it does not declare, and an id declared twice", async () => {
  const moved = fakeWorktree({ "plan/tasks.d/W1-T5209-a.yaml": "- id: W1-T5209\n" });
  moved.setHead("8".repeat(40));
  try {
    const out = await sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], undefined, moved.deps);
    assert.equal(out.outcome, "lease-mismatch");
    assert.equal(moved.calls.some((c) => c[1] === "push"), false);
  } finally {
    rmSync(moved.root, { recursive: true, force: true });
  }
  const foreign = fakeWorktree({ "plan/tasks.d/W1-T5300-a.yaml": "- id: W1-T5300\n  depends_on: [W1-T5209]\n" });
  try {
    const out = await sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], undefined, foreign.deps);
    assert.equal(out.outcome, "not-declared");
    assert.equal(foreign.calls.some((c) => c[1] === "push"), false);
  } finally {
    rmSync(foreign.root, { recursive: true, force: true });
  }
  const twice = fakeWorktree({ "plan/tasks.d/W1-T5209-a.yaml": "- id: W1-T5209\n", "plan/tasks.d/W1-T5209-b.yaml": "- id: W1-T5209\n" });
  try {
    assert.equal((await sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], undefined, twice.deps)).outcome, "not-declared");
  } finally {
    rmSync(twice.root, { recursive: true, force: true });
  }
  const noHead = fakeWorktree({});
  try {
    assert.equal((await sweep.renumberPlanPrIds(planPr({ headRefName: undefined }), ["W1-T5209"], undefined, noHead.deps)).outcome, "error");
  } finally {
    rmSync(noHead.root, { recursive: true, force: true });
  }
  // A failing git call is an error outcome with the worktree still removed.
  const broken = fakeWorktree({ "plan/tasks.d/W1-T5209-a.yaml": "- id: W1-T5209\n" });
  const realGit = broken.deps.git;
  broken.deps.git = (cwd, args) => {
    if (args[0] === "commit") throw Object.assign(new Error("hook failed"), { stderr: "pre-commit: lint failed" });
    return realGit(cwd, args);
  };
  try {
    const out = await sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], "t", broken.deps);
    assert.equal(out.outcome, "error");
    assert.match(String(out.reason), /pre-commit: lint failed/);
    assert.deepEqual(broken.removed, [broken.wt]);
  } finally {
    rmSync(broken.root, { recursive: true, force: true });
  }
  // A worktree that could not be cut has nothing to remove, and a failed removal is swallowed.
  const uncut = fakeWorktree({});
  uncut.deps.worktreeAdd = () => {
    throw new Error("fetch failed");
  };
  uncut.deps.worktreeRemove = () => {
    throw new Error("must not be called");
  };
  try {
    assert.equal((await sweep.renumberPlanPrIds(planPr(), ["W1-T5209"], "t", uncut.deps)).outcome, "error");
  } finally {
    rmSync(uncut.root, { recursive: true, force: true });
  }
  const sticky = fakeWorktree({ "plan/tasks.d/W1-T5209-a.yaml": "- id: W1-T5209\n" });
  sticky.deps.worktreeRemove = () => {
    throw new Error("busy");
  };
  try {
    const out = await withLiveWritesAllowed(() => sweep.renumberPlanPrIds(planPr({ body: undefined }), ["W1-T5209"], undefined, sticky.deps));
    assert.equal(out.outcome, "renumbered");
    assert.deepEqual(sticky.patches, [], "nothing to patch when neither title nor body was read");
  } finally {
    rmSync(sticky.root, { recursive: true, force: true });
  }
});

function baseEffectsDeps(root: string, over: Record<string, unknown>) {
  return {
    owner: "acme",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-W1-T5349",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    ...over,
  } as unknown as Parameters<typeof sweep.buildSweepEffects>[0];
}

test("W1-T5349: the wired effects read the author and title, retitle with a job re-run, and renumber through the seams", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5349-effects-"));
  const gh: string[][] = [];
  const git: string[][] = [];
  const added: string[] = [];
  try {
    const effects = sweep.buildSweepEffects(
      baseEffectsDeps(root, {
        ghJsonImpl: (args: string[]) => {
          gh.push(args);
          return { user: { login: FLEET }, title: "chore(plan): file W1-T5209" };
        },
        planRepairGitImpl: (_file: string, args: readonly string[]) => {
          git.push([...args]);
          if (args.includes("rev-parse")) return `${HEAD}\n`;
          if (args.includes("diff")) return "plan/tasks.d/W1-T5209-x.yaml\n";
          return "";
        },
        worktreeAddImpl: (_repo: string, path: string) => {
          added.push(path);
          mkdirSync(join(path, "plan", "tasks.d"), { recursive: true });
          writeFileSync(join(path, "plan", "tasks.d", "W1-T5209-x.yaml"), "- id: W1-T5209\n");
        },
        worktreeRemoveImpl: () => {},
        planRepairReserveIdImpl: () => "W1-T5400",
      }),
    );
    const facts = await effects.readPlanRepairFacts!(planPr());
    assert.deepEqual(facts, { authorLogin: FLEET, title: "chore(plan): file W1-T5209" });
    assert.deepEqual(gh.at(-1), ["api", "repos/acme/remudero/pulls/8558"]);

    const retitled = await effects.repairPlanPr!(planPr(), { signature: "title-length", action: "retitle", check: "commitlint", title: "chore(plan): short", jobId: "777" });
    assert.equal(retitled.outcome, "retitled");
    assert.deepEqual(gh.at(-2), ["api", "-X", "PATCH", "repos/acme/remudero/pulls/8558", "-f", "title=chore(plan): short"]);
    assert.deepEqual(gh.at(-1), ["api", "-X", "POST", "repos/acme/remudero/actions/jobs/777/rerun"]);
    gh.length = 0;
    await effects.repairPlanPr!(planPr(), { signature: "title-length", action: "retitle", check: "commitlint", title: "chore(plan): short" });
    assert.equal(gh.length, 1, "no job id, no re-run to request");

    // The renumber path reaches git, the worktree and the reservation through the build's seams.
    gh.length = 0;
    const renumbered = await withLiveWritesAllowed(() =>
      effects.repairPlanPr!(planPr(), { signature: "held-task-id", action: "renumber", check: "task-id-existence", heldIds: ["W1-T5209"], title: "chore(plan): file W1-T5209" }),
    );
    assert.equal(renumbered.outcome, "renumbered");
    assert.deepEqual(renumbered.renames, { "W1-T5209": "W1-T5400" });
    assert.ok(git.some((a) => a.includes("diff")), "the diff was read through planRepairGitImpl");
    assert.ok(git.some((a) => a.includes("push")), "the push went through planRepairGitImpl");
    assert.deepEqual(gh.at(-1)!.slice(0, 4), ["api", "-X", "PATCH", "repos/acme/remudero/pulls/8558"]);
    assert.ok(gh.at(-1)!.includes("title=chore(plan): file W1-T5400"));
    assert.ok(added.length === 1 && added[0]!.includes("plan-renumber-8558-"), "the worktree is cut under the worktrees dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(sweep.SWEEP_EFFECT_SURFACE.includes("repairPlanPr" as never));
  assert.ok(sweep.SWEEP_EFFECT_SURFACE.includes("readPlanRepairFacts" as never));
});

test("W1-T5349: the default reservation mints from the worktree's plan and reserves on the lane's branch", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5349-reserve-"));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T10\n");
    writeFileSync(join(root, "plan", "tasks.d", "W1-T12-x.yaml"), "- id: W1-T12\n");
    const argv: string[][] = [];
    const id = sweep.reservePlanRepairTaskId(root, LANE_HEAD, (args) => {
      argv.push(args);
      return { status: 0, stdout: "", stderr: "" };
    });
    assert.match(id, /^W1-T\d+$/);
    assert.ok(Number(id.slice(4)) >= 13, `minted above the plan's ceiling: ${id}`);
    assert.ok(argv.length > 0, "the reservation went through git");
    // The default runner really shells out.
    const r = sweep.planRepairGitRun(root)(["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /git version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
