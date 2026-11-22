/**
 * W1-T14042 — A PARKED PULL REQUEST REMEDY NEVER DRAFTS A TASK FILE THAT LOSES ITS INVARIANT PROOF.
 *
 * From 2026-11-16 to 2026-11-20 the fleet ledgers hold 79 split-follow-up rows and none was taken. 107 refused rows
 * name design-invariant-proof: a split moved an invariant criterion out of its task, copied INVARIANT lines into a
 * held follow-up that had no claim for them, or drafted a task filed before W1-T11746 that declares neither form.
 * The remedy now keeps each invariant with its task, lints its drafts before it reserves an id, and moves the ladder
 * on in the same call when a verdict on its own draft refuses it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";

import type { TaskFileInput } from "#src/lib/feedback-landing.js";
import { actOnParkedPr, PARKED_PR_REMEDY_STEP, parkedPrRemedy, remedyStalledCriterion, takeParkedPrRemedy,
  type ParkedPrContext, type ParkedPrDecision, type ParkedPrFacts, type ParkedPrHost, type ParkedPrObserved,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import type { Task } from "#src/lib/plan.js";
import { invariantSlugViolations } from "#src/lib/task-linter.js";

type Row = { step: string } & Record<string, unknown>;
type Criterion = { claim: string; proof: string };

const PR = 19767;
const PR_URL = `https://github.com/o/remudero/pull/${PR}`;
const HEAD = "1976700".padEnd(40, "0");
const NOW_ISO = "2026-11-20T16:05:00.000Z";
const LINT = { requireDesignInvariantDeclaration: true, taskRepoOwner: "o" } as const;

const criterion = (claim: string, file = "src/x.ts"): Criterion => ({ claim, proof: `grep: ${claim.slice(0, 40)} in ${file}` });

/** A task file shaped like the real shards: an implement task with a design and acceptance criteria. */
function shardText(id: string, design: string | undefined, acceptance: readonly Criterion[]): string {
  return stringify([{ id, title: `Fixture shaped like ${id}`, repo: "remudero", depends_on: [], type: "implement",
    files: ["src/x.ts", "test/x.test.ts"], status: "queued", attempts: 0, acceptance,
    rationale: "WHY: a fixture.\n", ...(design === undefined ? {} : { design }) }], { lineWidth: 0 });
}

const relOf = (id: string) => `plan/tasks.d/${id}-a-fixture-task.yaml`;
const taskOf = (text: string): Task => (parse(text) as Task[])[0]!;

type Landing = { prUrl?: string; error?: string; refusalChecks?: readonly string[] };

/** A remedy host for one task file; it counts reservations, landings and closes. */
function host(id: string, text: string, landing: () => Landing = () => ({ prUrl: "https://github.com/o/remudero/pull/99999" })) {
  const reserved: string[] = [], landed: TaskFileInput[][] = [], closed: string[] = [];
  let next = 99000;
  const h: ParkedPrHost = {
    readTaskShard: async (taskId) => taskId === id
      ? { outcome: "read", shard: { relPath: relOf(id), text }, target: { owner: "o", repo: "remudero", checkoutDir: "/unused" } }
      : { outcome: "refused", reason: "task-absent" },
    reserveTaskId: () => { const held = `W1-T${++next}`; reserved.push(held); return held; },
    landTaskFiles: async (files) => { landed.push([...files]); return landing(); },
    closePr: async (prUrl) => { closed.push(prUrl); },
  };
  return { h, reserved, landed, closed };
}

const subject = (id: string, unmet: readonly Criterion[]): ParkedPrSubject => ({ prNumber: PR, prUrl: PR_URL, headSha: HEAD, taskId: id,
  unmetCriteria: unmet.map(c => ({ claim: c.claim, proof: c.proof, reason: "it needs a design answer" })) });

function context(id: string, rows: Row[], observed?: ParkedPrObserved): ParkedPrContext {
  return { runId: "t14042", ledgerTaskId: id, nowIso: NOW_ISO, cause: "needs-design", text: "which store?",
    append: (row) => { rows.push(row); }, ...(observed === undefined ? {} : { observed }) };
}

const facts = (input: readonly Criterion[], taskCriteria: number, ladderSpent = true): ParkedPrFacts => ({ redChecks: [], isPlanFiling: false,
  taskCriteria, unmetCriteria: input.map(c => ({ claim: c.claim, needsInput: true, ladderSpent })) });

const remedyRows = (rows: readonly Row[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
const designLines = (task: Task, re: RegExp) => (task.design ?? "").split("\n").filter(line => re.test(line));

// The W1-T13865 shape: one INVARIANT line, and the criterion that maps it is the one that stalled.
const T13865 = "W1-T13865";
const T13865_INVARIANT = criterion("invariant:no-round-at-an-unchanged-ruling — no round runs at an unchanged ruling", "test/x.test.ts");
const T13865_CRITERIA = [criterion("the ruling is read once per pass"), T13865_INVARIANT, criterion("the row names the ruling")];
const T13865_DESIGN = "INVARIANT no-round-at-an-unchanged-ruling: no fix round runs while the ruling is unchanged.\n1. Read the ruling.\n";

test("W1-T14042 criterion 1: invariant:invariant-proof-stays, a criterion that maps an invariant is never split out; a stalled one is rebuilt whole", async () => {
  assert.equal(parkedPrRemedy(facts([T13865_INVARIANT], 3, false)).remedy, "fix-on-pr", "an invariant criterion is not split");
  assert.equal(parkedPrRemedy(facts([T13865_INVARIANT], 3, true)).remedy, "close-and-rebuild", "with the stall ladder spent it is rebuilt");
  assert.equal(parkedPrRemedy(facts([T13865_CRITERIA[0]!], 3, true)).remedy, "split-follow-up", "a criterion with no invariant still splits");

  const text = shardText(T13865, T13865_DESIGN, T13865_CRITERIA);
  const w = host(T13865, text);
  const rows: Row[] = [];
  const out = await remedyStalledCriterion(subject(T13865, [T13865_INVARIANT]), `review:${T13865_INVARIANT.claim}`, "fix stall",
    rows, w.h, { runId: "t14042", ledgerTaskId: T13865, nowIso: NOW_ISO, append: (row) => { rows.push(row); } });
  assert.equal(out.remedy, "close-and-rebuild", out.reason);
  assert.equal(out.heldTaskId, w.reserved[0]);
  assert.equal(w.landed.length, 1, "one landing");
  assert.equal(w.landed[0]!.length, 1, "the landing carries the held rebuild alone");
  const [held] = w.landed[0]!;
  assert.equal(held!.newFile, true);
  assert.notEqual(held!.relPath, relOf(T13865), "no parent task file is edited");
  const rebuilt = taskOf(held!.content), parent = taskOf(text);
  assert.equal(rebuilt.design, parent.design, "the held rebuild keeps the parent's design");
  assert.deepEqual(rebuilt.acceptance, parent.acceptance, "the held rebuild keeps the parent's criteria");
  assert.deepEqual(invariantSlugViolations(rebuilt, LINT), []);
  assert.deepEqual(w.closed, [PR_URL], "the pull request is closed");
  const remedies = remedyRows(rows);
  assert.equal(remedies.length, 1, JSON.stringify(remedies));
  assert.deepEqual([remedies[0]!.remedy, remedies[0]!.outcome], ["close-and-rebuild", "taken"]);
});

// The W1-T13859 and W1-T13829 shape: two INVARIANT lines; the criterion that needs input maps neither.
const T13859 = "W1-T13859";
const T13859_MOVED = criterion("the console names the lane that holds the task");
const T13859_CRITERIA = [criterion("invariant:one-line-per-shard — one census line per shard", "test/x.test.ts"),
  criterion("invariant:no-lost-row — no row is dropped", "test/y.test.ts"), T13859_MOVED, criterion("the census reads every shard")];
const T13859_DESIGN = "INVARIANT one-line-per-shard: the census writes one line per shard.\n" +
  "INVARIANT no-lost-row: no row is dropped on a rewrite.\n1. Read the shards.\n2. Write the census.\n";

test("W1-T14042 criterion 2: a split keeps every INVARIANT line and invariant criterion in the parent; the held follow-up names the parent", async () => {
  const text = shardText(T13859, T13859_DESIGN, T13859_CRITERIA);
  const w = host(T13859, text);
  const rows: Row[] = [];
  const decision = parkedPrRemedy(facts([T13859_MOVED], T13859_CRITERIA.length));
  assert.equal(decision.remedy, "split-follow-up");
  const out = await takeParkedPrRemedy(subject(T13859, [T13859_MOVED]), decision, rows, w.h, context(T13859, rows));
  assert.equal(out.error, undefined, out.reason);
  const files = w.landed[0]!;
  const held = taskOf(files.find(f => f.newFile === true)!.content);
  const parent = taskOf(files.find(f => f.relPath === relOf(T13859))!.content);
  assert.equal(parent.design, T13859_DESIGN, "the parent keeps its design unchanged");
  assert.deepEqual(parent.acceptance!.map(c => c.claim), T13859_CRITERIA.filter(c => c !== T13859_MOVED).map(c => c.claim),
    "the parent keeps every invariant criterion");
  assert.deepEqual(held.acceptance!.map(c => c.claim), [T13859_MOVED.claim]);
  assert.deepEqual(designLines(held, /^INVARIANT /), [], "the held follow-up has no INVARIANT line");
  const noInvariants = designLines(held, /^NO-INVARIANTS:/);
  assert.equal(noInvariants.length, 1);
  assert.match(noInvariants[0]!, new RegExp(`held follow-up of ${T13859}`));
  assert.deepEqual(invariantSlugViolations(held, LINT), [], "the held follow-up passes the rule");
  assert.deepEqual(invariantSlugViolations(parent, LINT), [], "the parent edit passes the rule");
});

// The W1-T10331 and W1-T12169 shape: filed before W1-T11746, its design declares neither form.
const T10331 = "W1-T10331";
const T10331_MOVED = criterion("the dashboard names the operator's ruling");
const T10331_CRITERIA = [criterion("the dashboard reads the ledger"), T10331_MOVED, criterion("the dashboard shows one row per lane")];
const T10331_DESIGN = "1. Read the ledger.\n2. Show one row per lane.\n";

test("W1-T14042 criterion 3: a task filed before declared invariants gains one filed-before NO-INVARIANTS line in each draft", async () => {
  const text = shardText(T10331, T10331_DESIGN, T10331_CRITERIA);
  const filedBefore = new RegExp(`^NO-INVARIANTS: ${T10331} was filed before declared invariants \\(W1-T11746\\)`);
  const splitHost = host(T10331, text);
  const rows: Row[] = [];
  const out = await takeParkedPrRemedy(subject(T10331, [T10331_MOVED]), parkedPrRemedy(facts([T10331_MOVED], 3)), rows, splitHost.h,
    context(T10331, rows));
  assert.equal(out.error, undefined, out.reason);
  const files = splitHost.landed[0]!;
  const held = taskOf(files.find(f => f.newFile === true)!.content);
  const parent = taskOf(files.find(f => f.relPath === relOf(T10331))!.content);
  for (const [name, task] of [["held follow-up", held], ["parent edit", parent]] as const) {
    const lines = designLines(task, /^NO-INVARIANTS:/);
    assert.equal(lines.length, 1, `${name}: one NO-INVARIANTS line`);
    assert.match(lines[0]!, filedBefore, name);
    assert.deepEqual(invariantSlugViolations(task, LINT), [], name);
  }
  assert.ok(parent.design!.startsWith(T10331_DESIGN), "the parent's design lines are unchanged");
  assert.deepEqual(parent.acceptance, T10331_CRITERIA.filter(c => c !== T10331_MOVED), "the parent's other criteria are unchanged");

  const rebuildHost = host(T10331, text);
  const rebuildRows: Row[] = [];
  const rebuild: ParkedPrDecision = { remedy: "close-and-rebuild", inputCriteria: [{ claim: T10331_MOVED.claim, needsInput: true, ladderSpent: true }],
    reason: "nothing can merge without input" };
  const rebuilt = await takeParkedPrRemedy(subject(T10331, [T10331_MOVED]), rebuild, rebuildRows, rebuildHost.h, context(T10331, rebuildRows));
  assert.equal(rebuilt.error, undefined, rebuilt.reason);
  assert.equal(rebuildHost.landed[0]!.length, 1);
  const rebuildTask = taskOf(rebuildHost.landed[0]![0]!.content);
  const lines = designLines(rebuildTask, /^NO-INVARIANTS:/);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, filedBefore);
  assert.deepEqual(invariantSlugViolations(rebuildTask, LINT), []);
  assert.deepEqual(rebuildTask.acceptance, T10331_CRITERIA, "the held rebuild keeps every criterion");
});

// The W1-T12270 shape: an INVARIANT line with no invariant: criterion, so no draft of it can pass the rule.
const T12270 = "W1-T12270";
const T12270_MOVED = criterion("the sweep names the stale lease");
const T12270_CRITERIA = [criterion("the sweep reads the lease"), T12270_MOVED, criterion("the lease is released once")];
const T12270_DESIGN = "INVARIANT one-release: a lease is released once.\n1. Read the lease.\n";

test("W1-T14042 criterion 4: invariant:no-refused-draft, a draft the invariant rule refuses reserves no id and lands nothing", async () => {
  const decisions: ParkedPrDecision[] = [parkedPrRemedy(facts([T12270_MOVED], 3)),
    { remedy: "close-and-rebuild", inputCriteria: [{ claim: T12270_MOVED.claim, needsInput: true, ladderSpent: true }], reason: "no part can merge" }];
  assert.equal(decisions[0]!.remedy, "split-follow-up");
  for (const decision of decisions) {
    const w = host(T12270, shardText(T12270, T12270_DESIGN, T12270_CRITERIA));
    const rows: Row[] = [];
    const out = await takeParkedPrRemedy(subject(T12270, [T12270_MOVED]), decision, rows, w.h, context(T12270, rows));
    assert.equal(out.unchanged, true, `${decision.remedy}: ${out.reason}`);
    assert.equal(w.reserved.length, 0, `${decision.remedy}: no id is reserved`);
    assert.equal(w.landed.length, 0, `${decision.remedy}: landTaskFiles is not called`);
    const remedies = remedyRows(rows);
    assert.equal(remedies.length, 1, `${decision.remedy}: one row`);
    assert.equal(remedies[0]!.outcome, "refused");
    assert.deepEqual(remedies[0]!.refusal_checks, ["design-invariant-proof"]);
    assert.equal(typeof remedies[0]!.input_digest, "string");
    assert.match(String(remedies[0]!.reason), /design-invariant-proof.*has no acceptance claim/);
  }
});

test("W1-T14042 criterion 5: invariant:a-verdict-moves-the-ladder, a remedy refused on its own draft is spent and the next one runs in the same call", async () => {
  // The in-process lint: the split and the rebuild of W1-T12270 are both refused, and fix-on-pr runs.
  const lintRows: Row[] = [];
  const lint = host(T12270, shardText(T12270, T12270_DESIGN, T12270_CRITERIA));
  const lintFacts = facts([T12270_MOVED], 3);
  const linted = await actOnParkedPr(subject(T12270, [T12270_MOVED]), parkedPrRemedy(lintFacts), lintFacts, lintRows, lint.h,
    context(T12270, lintRows));
  assert.equal(linted.remedy, "fix-on-pr", linted.reason);
  assert.deepEqual(remedyRows(lintRows).map(r => [r.remedy, r.outcome]),
    [["split-follow-up", "refused"], ["close-and-rebuild", "refused"], ["fix-on-pr", "taken"]]);
  assert.equal(lint.reserved.length + lint.landed.length + lint.closed.length, 0);

  // The W1-T13830 guard: the next pass at the same input reads the refused rows and goes straight to fix-on-pr.
  const again = host(T12270, shardText(T12270, T12270_DESIGN, T12270_CRITERIA));
  const before = lintRows.length;
  const guarded = await actOnParkedPr(subject(T12270, [T12270_MOVED]), parkedPrRemedy(lintFacts), lintFacts, lintRows, again.h,
    context(T12270, lintRows));
  assert.equal(guarded.remedy, "fix-on-pr");
  assert.equal(again.reserved.length + again.landed.length, 0);
  assert.ok(lintRows.length - before <= 1, "the guard writes no refused row");

  // A landing the plan preflight refused on the draft: actOnParkedPr and remedyStalledCriterion both take the next remedy.
  const refusing = () => ({ error: "the plan preflight refused it: [shard-census] W1-T10331", refusalChecks: ["shard-census"] });
  const text = shardText(T10331, T10331_DESIGN, T10331_CRITERIA);
  const landRows: Row[] = [];
  const land = host(T10331, text, refusing);
  const landFacts = facts([T10331_MOVED], 3);
  const landedOut = await actOnParkedPr(subject(T10331, [T10331_MOVED]), parkedPrRemedy(landFacts), landFacts, landRows, land.h,
    context(T10331, landRows));
  assert.equal(landedOut.remedy, "fix-on-pr", landedOut.reason);
  assert.equal(land.landed.length, 2, "the split and the rebuild each tried one landing");
  assert.deepEqual(remedyRows(landRows).map(r => r.remedy), ["split-follow-up", "close-and-rebuild", "fix-on-pr"]);

  const stallRows: Row[] = [];
  const stall = host(T10331, text, refusing);
  const stalled = await remedyStalledCriterion(subject(T10331, [T10331_MOVED]), `review:${T10331_MOVED.claim}`, "fix stall", stallRows,
    stall.h, { runId: "t14042", ledgerTaskId: T10331, nowIso: NOW_ISO, append: (row) => { stallRows.push(row); } });
  assert.equal(stalled.remedy, "fix-on-pr", stalled.reason);
  assert.deepEqual(remedyRows(stallRows).map(r => r.remedy), ["split-follow-up", "close-and-rebuild", "fix-on-pr"]);

  // With fix-on-pr already spent, the ladder ends in W1-T13361's one needs-human issue.
  const asked: string[] = [];
  const observed: ParkedPrObserved = { bodyDigest: "body-a", redChecks: [], refusalLine: () => undefined,
    escalate: (issue) => { asked.push(issue); }, issueOpen: () => false };
  const askRows: Row[] = [];
  const ask = host(T10331, text, refusing);
  await actOnParkedPr(subject(T10331, [T10331_MOVED]), parkedPrRemedy(landFacts), landFacts, askRows, ask.h,
    context(T10331, askRows, observed), ["fix-on-pr"]);
  assert.equal(asked.length, 1, "one needs-human issue is opened");
  assert.equal(remedyRows(askRows).filter(r => r.needs_human === true).length, 1);

  // A landing error with no refusalChecks is transient: the remedy returns its error and takes no next remedy.
  const transientRows: Row[] = [];
  const transient = host(T10331, text, () => ({ error: "git push timed out" }));
  const waited = await actOnParkedPr(subject(T10331, [T10331_MOVED]), parkedPrRemedy(landFacts), landFacts, transientRows, transient.h,
    context(T10331, transientRows));
  assert.equal(waited.remedy, "split-follow-up");
  assert.match(waited.error ?? "", /git push timed out/);
  assert.equal(waited.disposition, "wait");
  assert.equal(transient.landed.length, 1, "no next remedy lands anything");
  assert.deepEqual(remedyRows(transientRows).map(r => [r.remedy, r.outcome]), [["split-follow-up", "refused"]]);
});
