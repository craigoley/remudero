/**
 * test/credited-task-proof-visibility.test.ts — W1-T2280.
 *
 * A TASK IS CREDITED MERGED ON PROVENANCE AND NEVER ON SATISFACTION, AND NO INSTRUMENT CAN SEE
 * THE DIFFERENCE: `deriveStatus` credits an anchored `Remudero-Task:` trailer and never reads
 * `acceptance`; `proofQueueAudit` — the one instrument that resolves a task's proofs against the
 * real checkout — is scoped to OPEN+UNMERGED only, and exempts a whole-file test path from
 * report BY CONSTRUCTION, an exemption that is correct for a queued task (the test is not
 * written yet) and wrong for a credited one (there is no forward left to reference).
 *
 * This proves the additive, opt-in fix, one claim per section:
 *   1. the audit can be POINTED AT the merge-credited population, and the open+unmerged default
 *      is byte-unchanged when no such request is made.
 *   2. the forward-reference exemption becomes CONDITIONAL: reported for a credited task whose
 *      whole-file test path is absent, still silent for the identical shape on an uncredited one.
 *   3. a `grep-path-absent` candidate whose symbol is found at ANOTHER path the task itself
 *      declared is named RELOCATED — structurally separate from `offenders`, not merely relabeled.
 *   4/5. a credited task's own shard file changed after its earliest merge credit is named,
 *        UNLESS the amending commit also filed a new shard alongside it (the follow-up escape
 *        hatch, W1-T2217's shape).
 *   6. the amendment signal's own blind spot (declared inline in the monolith) is COUNTED and
 *      printed alongside what it can see, never implied.
 *   7. the credited population is read through `readMergeCreditedTaskIds`/`isMergeCreditLine`
 *      (lib/status.ts) — the SAME reader the dispatcher already trusts — never a second
 *      hand-copy of what a merge credit looks like.
 *   8. the pass writes NOTHING: no ledger line appended, no task `status` moved, and
 *      `src/lib/drain.ts`'s dispatch gate still reads `acceptance` nowhere but a comment.
 *   9. the verb exits 0 on every population it audits, offenders or not — a report, never a gate.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Task, Plan } from "../src/lib/plan.js";
import {
  proofQueueAudit,
  creditedAmendmentVisibility,
  CREDITED_PROOF_QUEUE_AUDIT_CAUSES,
  type CreditedAmendmentFact,
} from "../src/lib/proof-queue-audit.js";
import { proofQueueAuditCommand, creditedProofVisibility, type CreditedProofVisibilityResult } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: {},
    budget_usd: 10,
    risk: "low",
    origin: "architect",
    status: "queued",
    attempts: 0,
    ...overrides,
  } as Task;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

async function runAuditCapturing(
  args: string[],
  deps: Parameters<typeof proofQueueAuditCommand>[1] = {},
): Promise<{ exitCode: number; stdout: string }> {
  const origLog = console.log;
  const origError = console.error;
  const lines: string[] = [];
  console.log = (m: string) => lines.push(m);
  console.error = (m: string) => lines.push(m);
  try {
    const exitCode = await proofQueueAuditCommand(args, deps);
    return { exitCode, stdout: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

// ── (1) pointed at the credited population; the open+unmerged default is unchanged ──────────

test("W1-T2280(1): proofQueueAudit's DEFAULT (no opts.creditedIds) is byte-identical for a whole-file test-path proof, credited or not", () => {
  const credited = fixtureTask({
    id: "W9-C1",
    acceptance: [{ claim: "x", proof: "unit test: test/does-not-exist-w1-t2280.test.ts" }],
  });
  // No `creditedIds` supplied at all — the exact call shape every existing caller uses today.
  const report = proofQueueAudit([credited], { pathExists: () => false });
  assert.equal(report.offenders.length, 0, "absent opts.creditedIds must never report the forward-reference shape");
  assert.deepEqual(report.byCause["credited-test-path-absent"], []);
});

test("W1-T2280(1): proofQueueAuditCommand's default (no --credited) path is untouched by this task — still 'open+unmerged'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w1-t2280-default-path-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    const tasksPath = join(dir, "plan", "tasks.yaml");
    writeFileSync(
      tasksPath,
      [
        "- id: W9-DEFAULT-1",
        '  title: "fixture"',
        "  repo: remudero",
        "  origin: architect",
        "  depends_on: []",
        "  type: implement",
        "  verify: auto",
        "  status: queued",
        "  attempts: 0",
        "  acceptance:",
        '    - claim: "x"',
        '      proof: "trust me, it works"',
        "",
      ].join("\n"),
      "utf8",
    );
    const { exitCode, stdout } = await runAuditCapturing(["--plan", tasksPath], {
      readMergeEvidenceLog: () => ({ dump: "\x01", ref: "fixture-ref" }),
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /open\+unmerged task\(s\)/);
    assert.doesNotMatch(stdout, /--credited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2280(1): --credited points the SAME verb at the merge-credited population and names what it finds", async () => {
  const fakeResult: CreditedProofVisibilityResult = {
    creditedCount: 2,
    proof: {
      taskCount: 2,
      criterionCount: 2,
      offenders: [
        { taskId: "W9-CRED-X", criterionIndex: 0, cause: "credited-test-path-absent", claim: "c", proof: "unit test: test/gone.test.ts" },
      ],
      byCause: { "refused-parse": [], "name-filtered-zero-match": [], "grep-path-absent": [], "credited-test-path-absent": ["W9-CRED-X"] },
      relocated: [],
    },
    amendment: { measurable: 2, unmeasurable: 0, flagged: [] },
  };
  const { exitCode, stdout } = await runAuditCapturing(["--credited"], {
    creditedProofVisibility: () => fakeResult,
  });
  assert.equal(exitCode, 0);
  assert.match(stdout, /2 merge-credited task\(s\)/);
  assert.match(stdout, /credited-test-path-absent\s+1 task\(s\): W9-CRED-X/);
});

// ── (2) the forward-reference exemption is CONDITIONAL on credit, not deleted ────────────────

test("W1-T2280(2): a whole-file test-path proof IS reported when its file is absent and the task is credited", () => {
  const credited = fixtureTask({
    id: "W9-C2",
    acceptance: [{ claim: "x", proof: "unit test: test/does-not-exist-w1-t2280-a.test.ts" }],
  });
  const report = proofQueueAudit([credited], {
    pathExists: () => false,
    creditedIds: new Set(["W9-C2"]),
  });
  assert.equal(report.offenders.length, 1);
  assert.equal(report.offenders[0].cause, "credited-test-path-absent");
  assert.equal(report.offenders[0].taskId, "W9-C2");
});

test("W1-T2280(2): the IDENTICAL proof shape on an UNCREDITED task is still never reported", () => {
  const uncredited = fixtureTask({
    id: "W9-C3",
    acceptance: [{ claim: "x", proof: "unit test: test/does-not-exist-w1-t2280-b.test.ts" }],
  });
  // creditedIds is supplied (proving this isn't just "no predicate ⇒ no opinion") but does not
  // name this task.
  const report = proofQueueAudit([uncredited], {
    pathExists: () => false,
    creditedIds: new Set(["W9-SOME-OTHER-TASK"]),
  });
  assert.equal(report.offenders.length, 0, "an uncredited task's whole-file test path stays a legitimate forward reference");
});

test("W1-T2280(2): a credited task's whole-file test-path proof whose file EXISTS is still never reported", () => {
  const credited = fixtureTask({
    id: "W9-C4",
    acceptance: [{ claim: "x", proof: "unit test: test/real.test.ts" }],
  });
  const report = proofQueueAudit([credited], {
    pathExists: () => true,
    creditedIds: new Set(["W9-C4"]),
  });
  assert.equal(report.offenders.length, 0);
});

// ── (3) relocation is named, and kept structurally separate from "unsatisfied" ───────────────

test("W1-T2280(3): a grep proof whose symbol exists at ANOTHER path the task declared is RELOCATED, not reported as an offender", () => {
  const task = fixtureTask({
    id: "W9-C5",
    files: ["src/old-home.ts", "src/new-home.ts"],
    acceptance: [{ claim: "x", proof: "grep: myMovedSymbol( in src/old-home.ts" }],
  });
  const report = proofQueueAudit([task], {
    pathExists: (p) => p !== "src/old-home.ts",
    symbolFoundAt: (symbol, path) => symbol === "myMovedSymbol(" && path === "src/new-home.ts",
  });
  assert.equal(report.offenders.length, 0, "a relocated symbol must not also live in offenders");
  assert.deepEqual(report.byCause["grep-path-absent"], [], "nor in the cause bucket that counts real absences");
  assert.equal(report.relocated.length, 1);
  assert.equal(report.relocated[0].taskId, "W9-C5");
  assert.equal(report.relocated[0].relocatedTo, "src/new-home.ts");
});

test("W1-T2280(3): the identical absent path with NO relocation anywhere is still reported as grep-path-absent", () => {
  const task = fixtureTask({
    id: "W9-C6",
    files: ["src/old-home.ts", "src/unrelated.ts"],
    acceptance: [{ claim: "x", proof: "grep: neverMoved( in src/old-home.ts" }],
  });
  const report = proofQueueAudit([task], {
    pathExists: (p) => p !== "src/old-home.ts",
    symbolFoundAt: () => false,
  });
  assert.equal(report.relocated.length, 0);
  assert.deepEqual(report.byCause["grep-path-absent"], ["W9-C6"]);
});

test("W1-T2280(3): absent opts.symbolFoundAt never relocates — the conservative 'no predicate, no opinion' default", () => {
  const task = fixtureTask({
    id: "W9-C7",
    files: ["src/old-home.ts", "src/new-home.ts"],
    acceptance: [{ claim: "x", proof: "grep: myMovedSymbol( in src/old-home.ts" }],
  });
  const report = proofQueueAudit([task], { pathExists: (p) => p !== "src/old-home.ts" });
  assert.equal(report.relocated.length, 0);
  assert.deepEqual(report.byCause["grep-path-absent"], ["W9-C7"]);
});

// ── (4/5) amended-after-credit, with/without a follow-up filed alongside ────────────────────

test("W1-T2280(4): a credited task amended after its own credit, with NO follow-up filed alongside, is named", () => {
  const facts: CreditedAmendmentFact[] = [{ taskId: "W1-T9001", shardPath: "plan/tasks.d/W1-T9001-x.yaml" }];
  const report = creditedAmendmentVisibility(facts, {
    amendedSinceCredit: () => ({ amended: true, followUpFiled: false }),
  });
  assert.deepEqual(report.flagged, ["W1-T9001"]);
});

test("W1-T2280(5): a credited task whose amendment DID file a follow-up in the same change is NOT named", () => {
  const facts: CreditedAmendmentFact[] = [{ taskId: "W1-T2217", shardPath: "plan/tasks.d/W1-T2217-x.yaml" }];
  const report = creditedAmendmentVisibility(facts, {
    amendedSinceCredit: () => ({ amended: true, followUpFiled: true }),
  });
  assert.deepEqual(report.flagged, [], "the follow-up escape hatch (W1-T2217's own shape) must suppress the flag");
});

test("W1-T2280(4/5): a shard never touched since credit is not named, and unavailable evidence fails open rather than guessing", () => {
  const facts: CreditedAmendmentFact[] = [
    { taskId: "W1-T9002", shardPath: "plan/tasks.d/W1-T9002-x.yaml" },
    { taskId: "W1-T9003", shardPath: "plan/tasks.d/W1-T9003-x.yaml" },
  ];
  const report = creditedAmendmentVisibility(facts, {
    amendedSinceCredit: (taskId) =>
      taskId === "W1-T9002" ? { amended: false, followUpFiled: false } : undefined,
  });
  assert.deepEqual(report.flagged, [], "neither an untouched shard nor unreadable evidence is ever flagged");
});

// ── (6) the amendment signal's own coverage gap is measured and printed ─────────────────────

test("W1-T2280(6): credited tasks inline in the monolith (no shard) are counted as unmeasurable, never silently dropped", () => {
  const facts: CreditedAmendmentFact[] = [
    { taskId: "W1-T9004", shardPath: "plan/tasks.d/W1-T9004-x.yaml" },
    { taskId: "W1-T9005", shardPath: "plan/tasks.d/W1-T9005-x.yaml" },
    { taskId: "W1-T9006", shardPath: undefined }, // declared inline in plan/tasks.yaml
  ];
  const report = creditedAmendmentVisibility(facts, {
    amendedSinceCredit: () => ({ amended: false, followUpFiled: false }),
  });
  assert.equal(report.measurable, 2);
  assert.equal(report.unmeasurable, 1);
});

test("W1-T2280(6): the two counts are printed ALONGSIDE each other in the --credited report", async () => {
  const fakeResult: CreditedProofVisibilityResult = {
    creditedCount: 3,
    proof: { taskCount: 3, criterionCount: 0, offenders: [], byCause: { "refused-parse": [], "name-filtered-zero-match": [], "grep-path-absent": [], "credited-test-path-absent": [] }, relocated: [] },
    amendment: { measurable: 2, unmeasurable: 1, flagged: [] },
  };
  const { stdout } = await runAuditCapturing(["--credited"], { creditedProofVisibility: () => fakeResult });
  assert.match(stdout, /2 credited task\(s\) measurable via their own shard file/);
  assert.match(stdout, /1 unmeasurable \(declared inline in plan\/tasks\.yaml/);
});

// ── (7) the credited population comes from the reader the dispatcher already trusts ─────────

test("W1-T2280(7): the credited population is read via readMergeCreditedTaskIds/isMergeCreditLine's exact two shapes, over a REAL ledger file", () => {
  const dir = mkdtempSync(join(tmpdir(), "w1-t2280-ledger-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const lines = [
      // isMergeCreditLine shape 1: step === "verdict.merged"
      { task_id: "W9-SHAPE-A", step: "verdict.merged" },
      // isMergeCreditLine shape 2: step === "verdict" && verdict === "merged"
      { task_id: "W9-SHAPE-B", step: "verdict", verdict: "merged" },
      // NOT a credit under isMergeCreditLine — a similar-looking but non-matching shape must
      // never be read as a credit by a re-derived/looser check.
      { task_id: "W9-SHAPE-C", step: "note", verdict: "merged" },
      { task_id: "W9-SHAPE-D", step: "verdict", verdict: "open" },
    ];
    writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const plan = planOf([
      fixtureTask({ id: "W9-SHAPE-A", acceptance: [{ claim: "x", proof: "trust me" }] }),
      fixtureTask({ id: "W9-SHAPE-B", acceptance: [{ claim: "x", proof: "trust me" }] }),
      fixtureTask({ id: "W9-SHAPE-C", acceptance: [{ claim: "x", proof: "trust me" }] }),
      fixtureTask({ id: "W9-SHAPE-D", acceptance: [{ claim: "x", proof: "trust me" }] }),
    ]);
    const planPath = join(dir, "plan", "tasks.yaml");

    // Real readMergeCreditedTaskIds (no override), real ledger file — only the git-log-shaped
    // amendment evidence is stubbed out, since this test is about the POPULATION, not the
    // amendment signal.
    const result = creditedProofVisibility(planPath, plan, {
      ledgerPath,
      pathExists: () => true,
      amendedSinceCredit: () => undefined,
    });

    assert.equal(result.creditedCount, 2, "exactly the two lines isMergeCreditLine accepts are credited");
    assert.equal(result.proof.taskCount, 2, "the audited population is exactly the credited set, never the near-miss shapes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (8) writes nothing: no ledger append, no status move, dispatch gate reads no acceptance ──

test("W1-T2280(8): creditedProofVisibility appends NOTHING to the ledger file it reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "w1-t2280-no-write-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const before = JSON.stringify({ task_id: "W9-NOWRITE", step: "verdict.merged" }) + "\n";
    writeFileSync(ledgerPath, before, "utf8");
    const plan = planOf([fixtureTask({ id: "W9-NOWRITE", acceptance: [{ claim: "x", proof: "trust me" }] })]);

    creditedProofVisibility(join(dir, "plan", "tasks.yaml"), plan, {
      ledgerPath,
      pathExists: () => true,
      amendedSinceCredit: () => undefined,
    });

    assert.equal(readFileSync(ledgerPath, "utf8"), before, "the ledger file must be byte-identical after an audit pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2280(8): the input plan's task objects are never mutated — no status move", () => {
  const task = fixtureTask({ id: "W9-NOMOVE", status: "queued", acceptance: [{ claim: "x", proof: "trust me" }] });
  const snapshot = JSON.parse(JSON.stringify(task));
  const dir = mkdtempSync(join(tmpdir(), "w1-t2280-no-move-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, JSON.stringify({ task_id: "W9-NOMOVE", step: "verdict.merged" }) + "\n", "utf8");
    creditedProofVisibility(join(dir, "plan", "tasks.yaml"), planOf([task]), {
      ledgerPath,
      pathExists: () => true,
      amendedSinceCredit: () => undefined,
    });
    assert.deepEqual(task, snapshot, "no field on the task, least of all status, may change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2280(8): the dispatch gate (src/lib/drain.ts) still reads `acceptance` nowhere but a comment", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "drain.ts"), "utf8");
  const occurrences = source.match(/acceptance/g) ?? [];
  assert.equal(occurrences.length, 1, "src/lib/drain.ts is not in this task's files: — it must be untouched");
  const line = source.split("\n").find((l) => l.includes("acceptance"));
  assert.match(line ?? "", /\*/, "the one occurrence must sit inside a comment, never a field read");
});

test("W1-T2280(8): --credited itself declares, in its own output, that it appends no ledger line and moves no status", async () => {
  const fakeResult: CreditedProofVisibilityResult = {
    creditedCount: 0,
    proof: { taskCount: 0, criterionCount: 0, offenders: [], byCause: { "refused-parse": [], "name-filtered-zero-match": [], "grep-path-absent": [], "credited-test-path-absent": [] }, relocated: [] },
    amendment: { measurable: 0, unmeasurable: 0, flagged: [] },
  };
  const { stdout } = await runAuditCapturing(["--credited"], { creditedProofVisibility: () => fakeResult });
  assert.match(stdout, /no ledger line is appended and no status moves/);
});

// ── (9) the verb exits 0 unconditionally, on every population, offenders or not ─────────────

test("W1-T2280(9): --credited exits 0 even when every criterion offends", async () => {
  const fakeResult: CreditedProofVisibilityResult = {
    creditedCount: 1,
    proof: {
      taskCount: 1,
      criterionCount: 3,
      offenders: [
        { taskId: "W9-ALLBAD", criterionIndex: 0, cause: "refused-parse", claim: "a", proof: "grep: no in-path" },
        { taskId: "W9-ALLBAD", criterionIndex: 1, cause: "name-filtered-zero-match", claim: "b", proof: "unit test: nope" },
        { taskId: "W9-ALLBAD", criterionIndex: 2, cause: "credited-test-path-absent", claim: "c", proof: "unit test: test/gone.test.ts" },
      ],
      byCause: {
        "refused-parse": ["W9-ALLBAD"],
        "name-filtered-zero-match": ["W9-ALLBAD"],
        "grep-path-absent": [],
        "credited-test-path-absent": ["W9-ALLBAD"],
      },
      relocated: [],
    },
    amendment: { measurable: 1, unmeasurable: 0, flagged: ["W9-ALLBAD"] },
  };
  const { exitCode, stdout } = await runAuditCapturing(["--credited"], { creditedProofVisibility: () => fakeResult });
  assert.equal(exitCode, 0, "a report, never a gate — no count of offenders may fail the process");
  assert.match(stdout, /REPORT, not a gate/);
});

test("W1-T2280(9): every declared cause — including the credited-only fourth one — renders in the --credited output, W1-T2280's own accounting", () => {
  assert.deepEqual(CREDITED_PROOF_QUEUE_AUDIT_CAUSES, [
    "refused-parse",
    "name-filtered-zero-match",
    "grep-path-absent",
    "credited-test-path-absent",
  ]);
});

test("W1-T2280(9): a malformed invocation still refuses with a non-zero exit, unaffected by --credited's addition", async () => {
  const { exitCode } = await runAuditCapturing(["--bogus"]);
  assert.equal(exitCode, 2);
});
