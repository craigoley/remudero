// test/every-blocked-escalation-is-judged.test.ts — W1-T3401.
//
// MEASURED over the ledger union since 2026-09-08 (task record W1-T3401): 72 BLOCKED-class task
// ids escalated, 23 judged, 49 NEVER JUDGED. The cause was not a broken judge (W1-T349's
// `escalateWithJudge`/`judgeEscalation` has run since 2026-09-08 with a 6.6% demotion rate) — it
// was that the daemon's OWN block-reasoning callback (`escalateBlock`, wired inside
// `daemonCommand`, `src/run-task.ts`) called bare `escalate()` and never consulted it at all.
//
// These fixtures drive the REAL `daemonCommand` — never a reimplementation of its escalation path
// — mirroring test/escalation-judge-is-wired.test.ts's own discipline for `runFixRung`. The ONLY
// injections are the pre-existing `runDaemon` loop-capture seam (identical to
// test/daemon-crashloop-wiring.test.ts/test/daemon-worker-home-sweep.test.ts) and the new
// `escalationJudge` seam this task adds to `daemonCommand`'s deps (the SAME shape
// `runFixRung`'s own `opts.escalationJudge ?? realEscalationJudge({...})` already uses) — so a
// passing run here proves the PRODUCTION `escalateBlock` closure now judges, not that a hand-built
// fixture would have.
//
// Criterion 3 ("every BLOCKED-class escalation site routes through escalateWithJudge, and a
// census names any that does not") is answered honestly, not aspirationally: this task's own
// SCOPE FENCE wires exactly ONE site (the daemon's task-scoped block path — the one the
// measurement above pins as the dominant cause). `src/lib/escalation-catalogue.ts` carries three
// OTHER BLOCKED-class producers (`escalateCircuitBreak`, `escalateLifetimeCapExceeded`,
// `escalateCrashLoop`) that call `tryEscalate`/`escalate` directly and have NO `judge` dependency
// in their own `ctx` type at all — structurally incapable of ever demoting. The census below drives
// all three for real and asserts exactly that: named, current, unconverted. Follow-up work, not
// this task's concern (its own scope fence: "this wires an EXISTING judge onto an EXISTING call
// site" — singular).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import {
  escalateCircuitBreak,
  escalateLifetimeCapExceeded,
  escalateCrashLoop,
} from "../src/lib/escalation-catalogue.js";
import { ESCALATION_JUDGED_STEP, FLEET_NOTICE_LABEL, NEEDS_HUMAN_LABEL } from "../src/lib/escalate.js";
import type { Escalation, EscalationJudgeVerdict, IssueGateway } from "../src/lib/escalate.js";
import type { Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// ── fixture plumbing — the same recipe test/daemon-crashloop-wiring.test.ts already established
// for driving daemonCommand's real self-target boot path without a live daemon loop ──────────────

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blocked-judge-wiring-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  // Stamped from the real clock, LAST — see daemon-crashloop-wiring.test.ts's identical comment:
  // this fixture's directory must not read as stale to the daemon's own boot-time temp-dir sweep.
  const now = new Date();
  utimesSync(home, now, now);
  return { home, root, planPath };
}

function ledgerLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPathFor({ root } as never), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function blockedResult(over: Partial<RunResult> = {}): RunResult {
  return {
    taskId: "W1-T9001",
    runId: "DAEMON-9001",
    merged: false,
    costUsd: 0.4,
    verdict: "blocked",
    prUrl: "https://github.com/craigoley/remudero/pull/9001",
    ...over,
  };
}

const BLOCKED_TASK = { id: "W1-T9001", title: "the blocked task" } as unknown as Task;

/** Drive the REAL `daemonCommand` far enough to capture the `escalateBlock` closure it actually
 *  builds, via the pre-existing `runDaemon` loop-capture seam — the daemon's own real loop never
 *  runs. Returns the closure so a test can invoke it directly against a controlled block/dependents
 *  payload, exactly the shape `daemon.ts`'s own `await deps.escalateBlock({...})` call site uses. */
async function wiredEscalateBlock(
  escalationJudge: (e: Escalation) => Promise<EscalationJudgeVerdict>,
): Promise<{ home: string; root: string; escalateBlock: NonNullable<DaemonDeps["escalateBlock"]> }> {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps["escalateBlock"];
  const loopStub = async (_plan: unknown, deps: DaemonDeps): Promise<DaemonSummary> => {
    captured = deps.escalateBlock;
    return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: loopStub,
      escalationJudge,
    });
    assert.equal(code, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
  assert.ok(captured, "daemonCommand must wire an escalateBlock hook for runDaemon to call");
  return { home, root, escalateBlock: captured! };
}

function recordingIssues(calls: Array<{ title: string; body: string; labels: string[]; comments: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels, comments: [] });
      return "https://github.com/craigoley/remudero/issues/9001";
    },
    ensureLabel: () => true,
    comment(_url, text) {
      calls[calls.length - 1]?.comments.push(text);
    },
  };
}

// ── criterion 1: the daemon's block escalation is judged, not delivered unconditionally ────────

test("W1-T3401: a DEMOTE verdict moves the daemon's block escalation off needs-human onto fleet-notice", async () => {
  const judged: Escalation[] = [];
  const { home, escalateBlock } = await wiredEscalateBlock(async (e) => {
    judged.push(e);
    return { decision: "demote", reason: "A is retrying on its own; nothing for a human yet" };
  });
  const shim = ghShim([
    { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/9002" },
    { when: "label create", exit: 0 },
    { when: "issue comment", exit: 0 },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    await withLiveWritesAllowed(() =>
      escalateBlock({ task: BLOCKED_TASK, result: blockedResult(), dependents: ["W1-T9002"] }),
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }

  assert.equal(judged.length, 1, "the block escalation reached the judge exactly once");
  assert.equal(judged[0]?.class, "BLOCKED");
  assert.equal(judged[0]?.taskId, "W1-T9001");
  // The escalation body is multi-line, and the shim logs raw argv text one physical line at a
  // time (see gh-shim.ts) — so one logical `gh issue create ... --label ...` invocation can span
  // several array entries. Joining them back reconstructs the argv in order. The DEDUP lookup that
  // runs before the judge is even consulted always queries `labels=needs-human` regardless of the
  // eventual decision, so the label check below matches the literal `--label <name>` FLAG form
  // `create()` passes — never the bare label name, which the dedup query also contains.
  const fullLog = shim.calls().join("\n");
  assert.ok(fullLog.includes("issue create"), "an issue was still opened — a demotion is never a suppression");
  assert.ok(fullLog.includes(`--label ${FLEET_NOTICE_LABEL}`), `expected --label ${FLEET_NOTICE_LABEL} in the gh invocations: ${fullLog}`);
  assert.ok(!fullLog.includes(`--label ${NEEDS_HUMAN_LABEL}`), "a demoted block escalation must NOT also carry --label needs-human");
});

test("W1-T3401: a DELIVER verdict still opens the needs-human issue, and the judged step proves the judge actually ran", async () => {
  const { home, root, escalateBlock } = await wiredEscalateBlock(async () => ({
    decision: "deliver",
    reason: "a human should look at this block",
  }));
  const shim = ghShim([
    { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/9003" },
    { when: "label create", exit: 0 },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    await withLiveWritesAllowed(() =>
      escalateBlock({ task: BLOCKED_TASK, result: blockedResult(), dependents: ["W1-T9002"] }),
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }

  const fullLog = shim.calls().join("\n");
  assert.ok(fullLog.includes("issue create"));
  assert.ok(fullLog.includes(`--label ${NEEDS_HUMAN_LABEL}`));

  const rows = ledgerLines(root).filter((r) => r.step === ESCALATION_JUDGED_STEP);
  rmSync(home, { recursive: true, force: true });
  assert.equal(rows.length, 1, `expected exactly one ${ESCALATION_JUDGED_STEP} row — before this task, ZERO ever existed for this callsite`);
  assert.equal(rows[0]?.class, "BLOCKED");
  assert.equal(rows[0]?.judge_decision, "deliver");
  assert.equal(rows[0]?.judge_reason, "a human should look at this block");
});

// ── criterion 2: a judge that throws still delivers — the halt path never loses an escalation ──

test("W1-T3401: a judge that THROWS still opens the needs-human issue — fail-open at the wired callsite", async () => {
  const { home, root, escalateBlock } = await wiredEscalateBlock(async () => {
    throw new Error("judge spawn refused");
  });
  const shim = ghShim([
    { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/9004" },
    { when: "label create", exit: 0 },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    // Must resolve, never reject: the daemon loop `await`s this, and a rejection here would be
    // the exact regression this task's fail-open reasoning rules out.
    await withLiveWritesAllowed(() =>
      escalateBlock({ task: BLOCKED_TASK, result: blockedResult(), dependents: ["W1-T9002"] }),
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }

  const fullLog = shim.calls().join("\n");
  assert.ok(fullLog.includes("issue create"));
  assert.ok(fullLog.includes(`--label ${NEEDS_HUMAN_LABEL}`), "an unreadable judge must never demote");
  assert.ok(!fullLog.includes(`--label ${FLEET_NOTICE_LABEL}`));

  const rows = ledgerLines(root).filter((r) => r.step === ESCALATION_JUDGED_STEP);
  rmSync(home, { recursive: true, force: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.judge_decision, "deliver");
  assert.match(String(rows[0]?.judge_reason ?? ""), /judge unavailable/);
});

// ── criterion 3: a census names every OTHER BLOCKED-class producer this task leaves unconverted ─

test("W1-T3401 census: the three sibling BLOCKED producers in escalation-catalogue.ts remain unjudged by construction — named, not silently left", () => {
  // Each of these three functions' own `ctx` type carries `issues?: IssueGateway` and NOTHING
  // shaped like a judge — there is no seam through which a demotion could ever reach them, unlike
  // the now-converted `escalateBlock`. Driven for real (never a source-text read of run-task.ts),
  // each with its OWN ledger, so this is a measurement of current behavior, not an assertion about
  // prose.
  const cases: Array<{ name: string; run: (issues: IssueGateway, ledgerPath: string) => void }> = [
    {
      name: "escalateCircuitBreak",
      run: (issues, ledgerPath) =>
        escalateCircuitBreak({ id: "W1-T9101" } as unknown as Task, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R1", issues }),
    },
    {
      name: "escalateLifetimeCapExceeded",
      run: (issues, ledgerPath) =>
        escalateLifetimeCapExceeded({ id: "W1-T9102" } as unknown as Task, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R2", issues }),
    },
    {
      name: "escalateCrashLoop",
      run: (issues, ledgerPath) =>
        escalateCrashLoop(
          { breached: true, windowBoots: ["2026-09-13T00:00:00.000Z", "2026-09-13T00:01:00.000Z"], windowMs: 600_000, maxBoots: 1 },
          { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R3", issues },
        ),
    },
  ];

  for (const c of cases) {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blocked-census-`)), "ledger.ndjson");
    const calls: Array<{ title: string; body: string; labels: string[]; comments: string[] }> = [];
    c.run(recordingIssues(calls), ledgerPath);
    assert.equal(calls.length, 1, `${c.name} must still open exactly one issue`);
    assert.ok(calls[0]?.labels.includes(NEEDS_HUMAN_LABEL), `${c.name} still delivers unconditionally to needs-human`);
    assert.ok(!calls[0]?.labels.includes(FLEET_NOTICE_LABEL), `${c.name} has no route to fleet-notice — it never consults a judge`);
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(
      rows.filter((r) => r.step === ESCALATION_JUDGED_STEP).length,
      0,
      `${c.name} must write no ${ESCALATION_JUDGED_STEP} row — named here as a KNOWN, unconverted BLOCKED producer, follow-up work outside this task's one-callsite scope fence`,
    );
  }
});
