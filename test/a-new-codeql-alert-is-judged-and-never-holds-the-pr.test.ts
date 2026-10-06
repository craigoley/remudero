import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace reads, never named imports: at a base without this task the suite must still LOAD and
// fail subtest by subtest, which is what makes the proof discriminate.
import * as sweepModule from "../src/lib/sweep.js";
import * as restModule from "../src/lib/open-prs-rest.js";
import * as riskModule from "../src/lib/risk-judge.js";
import type { CodeScanningJudgment, OpenPrView, SweepDeps } from "../src/lib/sweep.js";
import type { RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5633 — GitHub's `CodeQL` results check failed on #9034 ("1 new alert including 1 high") and the PR
// merged 31 minutes later: ci-gate never waits on that check and nothing in the sweep read it. A head
// whose CodeQL check failed on a readable high alert is now judged once before its arm. A fix ruling
// dispatches the fix lane; a false-positive ruling records its reason, comments, and arms; an
// unavailable judge, a judgment past its bound, or a full pool dispatches the fix lane rather than
// holding. A PR with no failing CodeQL check arms as it always did.

const NOW = Date.parse("2026-10-04T12:00:00Z");
const N = 56330;
const HEAD = `${N}aaaa`;

const ALERT = {
  alertNumber: 311,
  ruleId: "js/incomplete-sanitization",
  severity: "high",
  path: "src/lib/gate-gardener.ts",
  line: 42,
  message: "This replaces only the first occurrence of ...",
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: N,
    prUrl: `https://github.com/craigoley/remudero/pull/${N}`,
    taskId: `W1-T${N}`,
    headRefName: `run-W1-T${N}-1791259610820`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-04T11:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    codeqlHeadAlerts: { headSha: HEAD, alerts: [ALERT] },
    ...over,
  };
}

interface Harness {
  deps: SweepDeps;
  lines: Array<Record<string, unknown>>;
  armed: string[];
  fixes: Array<{ pr: number; failures: string[] }>;
  comments: string[];
  judged: number[];
  escalated: string[];
  dir: string;
}

function harness(
  judge: SweepDeps["judgeCodeScanningAlerts"],
  over: Partial<SweepDeps> = {},
): Harness {
  const lines: Array<Record<string, unknown>> = [];
  const armed: string[] = [];
  const fixes: Harness["fixes"] = [];
  const comments: string[] = [];
  const judged: number[] = [];
  const escalated: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5633-`));
  return {
    lines, armed, fixes, comments, judged, escalated, dir,
    deps: {
      arm: (p) => {
        armed.push(`${p.prNumber}@${p.headSha}`);
      },
      close: () => {},
      dispatchFix: (p, evidence) => {
        fixes.push({ pr: p.prNumber, failures: (evidence as { ciFailures: Array<{ logTail: string }> }).ciFailures.map((f) => f.logTail) });
      },
      escalate: (_p, reason) => {
        escalated.push(reason);
      },
      ledgerPath: join(dir, "ledger.ndjson"),
      runId: "SWEEP-5633",
      now: () => NOW,
      readLedger: () => lines,
      appendLine: (_path, line) => {
        lines.push(line);
      },
      log: (step, extra = {}) => {
        lines.push({ run_id: "SWEEP-5633", step, ...extra });
      },
      handedOffHeadJudgments: sweepModule.handedOffHeadJudgmentPool({ schedule: () => () => {} }),
      judgeCodeScanningAlerts: judge === undefined ? undefined : (p, alerts) => {
        judged.push(p.prNumber);
        return judge(p, alerts);
      },
      postCodeScanningRuling: (_p, body) => {
        comments.push(body);
      },
      ...over,
    },
  };
}

const rows = (h: Harness, step: string) => h.lines.filter((l) => l.step === step);
const settleTurns = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

test("a new high codeql alert ruled a fix dispatches the fix lane with the alert as the failure log and does not arm", async () => {
  const h = harness(async () => ({ ruling: "fix", reason: "the replace is not global, so a crafted input survives" }));
  try {
    const summary = await sweepModule.runSweep([pr()], h.deps);
    assert.deepEqual(h.armed, [], "a head ruled a fix is not armed");
    assert.deepEqual(h.judged, [N], "the head was judged exactly once");
    assert.equal(h.fixes.length, 1, "the fix lane was dispatched once");
    assert.match(h.fixes[0].failures[0], /js\/incomplete-sanitization/);
    assert.match(h.fixes[0].failures[0], /src\/lib\/gate-gardener\.ts:42/);
    assert.equal(rows(h, sweepModule.CODE_SCANNING_FIX_STEP).length, 1, "the ruling is ledgered");
    assert.equal(rows(h, sweepModule.CODE_SCANNING_FIX_DISPATCH_STEP).length, 1, "the dispatch is ledgered before it is spent");
    assert.equal(summary.actions.length, 1);

    // The same head on the next pass starts no second judgment and no second fix.
    await sweepModule.runSweep([pr()], h.deps);
    assert.deepEqual(h.judged, [N]);
    assert.equal(h.fixes.length, 1, "an unchanged head dispatches no second fix");
    assert.deepEqual(h.armed, []);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a new high codeql alert ruled a false positive records its reason, comments naming it, and arms the head", async () => {
  const h = harness(async () => ({ ruling: "false_positive", reason: "the input is a constant, never user data" }));
  try {
    await sweepModule.runSweep([pr()], h.deps);
    await settleTurns();
    assert.deepEqual(h.armed, [`${N}@${HEAD}`], "the head arms on the false-positive ruling");
    assert.equal(h.fixes.length, 0, "no fix is dispatched for a false positive");
    const row = rows(h, sweepModule.CODE_SCANNING_FALSE_POSITIVE_STEP);
    assert.equal(row.length, 1, "the ruling row is written");
    assert.equal(row[0].reason, "the input is a constant, never user data");
    assert.equal(row[0].head_sha, HEAD);
    assert.deepEqual(row[0].alert_numbers, [311]);
    assert.equal(h.comments.length, 1, "one PR comment names the ruling");
    assert.match(h.comments[0], /false positive/);
    assert.match(h.comments[0], /js\/incomplete-sanitization/);
    assert.match(h.comments[0], /the input is a constant/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a head already ruled a false positive is armed on a later pass without a second judgment", async () => {
  const h = harness(async () => ({ ruling: "false_positive", reason: "constant" }));
  try {
    await sweepModule.runSweep([pr()], h.deps);
    await settleTurns();
    await sweepModule.runSweep([pr({ autoMergeArmed: false })], h.deps);
    assert.deepEqual(h.judged, [N], "judged once per head");
    assert.equal(h.comments.length, 1, "commented once per head");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("an unavailable or escalating or throwing judge dispatches the fix lane rather than holding the head", async () => {
  const cases: Array<[string, SweepDeps["judgeCodeScanningAlerts"]]> = [
    ["unavailable", async (): Promise<CodeScanningJudgment> => ({ ruling: "unavailable", reason: "judge down" })],
    ["escalate", async (): Promise<CodeScanningJudgment> => ({ ruling: "escalate", reason: "low confidence" })],
    ["rejects", () => Promise.reject(new Error("boom"))],
    ["throws", () => { throw new Error("sync boom"); }],
    ["no judge wired", undefined],
  ];
  for (const [label, judge] of cases) {
    const h = harness(judge);
    try {
      await sweepModule.runSweep([pr()], h.deps);
      assert.equal(h.fixes.length, 1, `${label}: the fix lane is dispatched`);
      assert.deepEqual(h.armed, [], `${label}: the head is not armed`);
      assert.equal(rows(h, sweepModule.CODE_SCANNING_FIX_STEP).length, 1, `${label}: the cause is ledgered`);
      assert.equal(rows(h, sweepModule.CODE_SCANNING_FALSE_POSITIVE_STEP).length, 0, `${label}: never read as a false positive`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test("a judgment past the pool's bound ends as a fix on the next pass, and a full pool sends the head to the fix lane", async () => {
  // A judge that never answers: the pool's own bound fires it unavailable.
  let fire: (() => void) | undefined;
  const pool = sweepModule.handedOffHeadJudgmentPool({
    schedule: (_ms, f) => {
      fire = f;
      return () => {};
    },
  });
  const h = harness(() => new Promise<CodeScanningJudgment>(() => {}), { handedOffHeadJudgments: pool });
  try {
    await sweepModule.runSweep([pr()], h.deps);
    assert.equal(h.fixes.length, 0, "an in-flight judgment holds only while it is in flight");
    assert.deepEqual(h.armed, []);
    await sweepModule.runSweep([pr()], h.deps);
    assert.deepEqual(h.judged, [N], "an in-flight judgment is not started twice");
    fire!();
    await sweepModule.runSweep([pr()], h.deps);
    assert.equal(h.fixes.length, 1, "past its bound the head goes to the fix lane");
    assert.match(String(rows(h, sweepModule.CODE_SCANNING_FIX_STEP)[0].reason), /outlived its/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }

  const full = sweepModule.handedOffHeadJudgmentPool({ limit: 0 });
  const h2 = harness(async () => ({ ruling: "false_positive", reason: "x" }), { handedOffHeadJudgments: full });
  try {
    await sweepModule.runSweep([pr()], h2.deps);
    assert.deepEqual(h2.judged, [], "no judgment starts past the cap");
    assert.equal(h2.fixes.length, 1, "a head over the cap goes to the fix lane");
  } finally {
    rmSync(h2.dir, { recursive: true, force: true });
  }
});

test("a fix that cannot be dispatched is escalated once and never armed", async () => {
  const h = harness(async () => ({ ruling: "fix", reason: "real" }));
  try {
    await sweepModule.runSweep([pr({ headRefName: "someone-elses-branch", taskId: undefined })], h.deps);
    assert.equal(h.fixes.length, 0);
    assert.deepEqual(h.armed, []);
    assert.equal(h.escalated.length, 1, "one escalation names the unfixable alert");
    await sweepModule.runSweep([pr({ headRefName: "someone-elses-branch", taskId: undefined })], h.deps);
    assert.equal(h.escalated.length, 1, "asked once per head");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a pr with no codeql alert observation arms as today and never reaches the judge", async () => {
  const h = harness(async () => ({ ruling: "fix", reason: "unused" }));
  try {
    await sweepModule.runSweep([pr({ codeqlHeadAlerts: undefined })], h.deps);
    assert.deepEqual(h.armed, [`${N}@${HEAD}`]);
    assert.deepEqual(h.judged, []);
    assert.equal(h.fixes.length, 0);
    assert.equal(rows(h, sweepModule.CODE_SCANNING_FIX_STEP).length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the real code-scanning judge maps a confident low verdict to a false positive and a high or doubtful one to a fix", async () => {
  const verdictFor = (v: RiskJudgeVerdict) =>
    sweepModule.riskJudgeCodeScanning((p, alerts) => ({
      input: {
        change: { description: p.prUrl },
        gatesState: {},
        planContext: {},
        codeScanning: { alerts: alerts.map((a) => ({ ...a })) },
      },
      orchestrator: { judge: async () => v, escalate: () => "", log: () => {} },
    }))(pr(), [ALERT]);
  assert.equal((await verdictFor({ verdict: "low", confidence: 0.95, reasons: ["safe"] })).ruling, "false_positive");
  assert.equal((await verdictFor({ verdict: "high", confidence: 0.95, reasons: ["real"] })).ruling, "fix");
  assert.equal((await verdictFor({ verdict: "low", confidence: 0.2, reasons: ["unsure"] })).ruling, "escalate");
  assert.equal(
    (await verdictFor({ verdict: "low", confidence: 0, reasons: ["down"], availability: "unavailable" })).ruling,
    "unavailable",
  );
});

test("the code-scanning input kind renders the alert and its diff hunk in a prompt that asks for a false-positive or fix ruling", () => {
  const prompt = riskModule.buildRiskJudgePrompt({
    change: { description: "fix the thing" },
    gatesState: {},
    planContext: {},
    codeScanning: { alerts: [{ ...ALERT, hunk: "@@ -1 +1 @@\n-a\n+b.replace('x', 'y')" }] },
  });
  assert.match(prompt, /CODE-SCANNING JUDGE/);
  assert.match(prompt, /js\/incomplete-sanitization/);
  assert.match(prompt, /gate-gardener\.ts:42/);
  assert.match(prompt, /replace\('x', 'y'\)/);
  assert.match(prompt, /RISK_VERDICT: <low\|high>/);
});

test("the failing codeql check is read deduped by its latest attempt, and only high alerts analysed at this head count", () => {
  const failed = (startedAt: string, conclusion: string) => ({ name: "CodeQL", status: "COMPLETED", conclusion, startedAt });
  assert.equal(restModule.codeqlCheckFailed([failed("2026-10-04T04:00:00Z", "FAILURE")]), true);
  assert.equal(
    restModule.codeqlCheckFailed([failed("2026-10-04T04:00:00Z", "FAILURE"), failed("2026-10-04T04:10:00Z", "SUCCESS")]),
    false,
    "a re-run that went green is not a failure",
  );
  assert.equal(restModule.codeqlCheckFailed([{ name: "ci-gate", conclusion: "FAILURE", startedAt: "x" }]), false, "an absent CodeQL check is not a failed one");
  assert.equal(restModule.codeqlCheckFailed(undefined), false);

  const row = (over: Record<string, unknown> = {}) => ({
    number: 311,
    rule: { id: "js/incomplete-sanitization", security_severity_level: "high" },
    tool: { name: "CodeQL" },
    most_recent_instance: { commit_sha: HEAD, message: { text: "m" }, location: { path: "a.ts", start_line: 3 } },
    ...over,
  });
  const seen = restModule.classifyCodeqlHeadAlerts(HEAD, [row()]);
  assert.deepEqual(seen?.alerts.map((a) => [a.alertNumber, a.severity, a.path, a.line]), [[311, "high", "a.ts", 3]]);
  assert.equal(restModule.classifyCodeqlHeadAlerts(HEAD, [row({ rule: { id: "r", security_severity_level: "low", severity: "note" } })]), undefined);
  assert.equal(
    restModule.classifyCodeqlHeadAlerts("other", [row()]),
    undefined,
    "an alert analysed at another head is not this head's",
  );
  assert.equal(restModule.classifyCodeqlHeadAlerts(HEAD, "not a listing"), undefined);

  const hydrated = restModule.hydrateCodeqlHeadAlerts("o", "r", [{ number: 1, headSha: HEAD }, { number: 2, headSha: HEAD }], (args) => {
    if (String(args[1]).includes("refs/pull/2/head")) throw new Error("gh down");
    assert.match(String(args[1]), /code-scanning\/alerts\?ref=refs\/pull\/1\/head&state=open/);
    return [row()];
  });
  assert.deepEqual([...hydrated.keys()], [1], "a failed read leaves that head unobserved, never judged");
});
