import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RISK_POLICY,
  parseRiskPolicy,
  planRiskJudgeAction,
  readRiskPolicy,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";
import { RELEASE_LEDGER_STEP, type Plan, type Task } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveParkedTask, productionVerifyHumanRelease, verifyHumanReleaseProposalId } from "../src/run-task.js";

/**
 * W1-T4050 — RISK LEVELS ARE HARD-CODED, NOT CONFIGURED.
 *
 * OPERATOR'S WORDS: "I don't want strictness, I want risk levels and rules that can be
 * configured in the console." Before this task, `planRiskJudgeAction`'s confidence threshold
 * was a module literal (`DEFAULT_CONFIDENCE_THRESHOLD = 0.7`) no unattended caller ever fed from
 * `plan/policy.yaml`, and the verify-human release arm (`approveParkedTask`) had no switch an
 * operator could reach without a source PR. This suite proves both are now runtime policy.
 */

function verdict(partial: Partial<RiskJudgeVerdict>): RiskJudgeVerdict {
  return { verdict: "low", reasons: ["well-trodden change, gates clean"], confidence: 0.8, ...partial };
}

const parked = (id: string, over: Record<string, unknown> = {}): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", verify: "human", status: "queued", depends_on: [], ...over }) as unknown as Task;

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

test("W1-T4050: an absent risk section changes nothing", () => {
  // (i): parsing an absent `risk:` section reproduces DEFAULT_RISK_POLICY exactly — 0.7 and
  // releases enabled, the SAME values the pre-existing hard-coded literal and the always-on
  // release path already produced.
  const resolved = parseRiskPolicy(undefined);
  assert.deepEqual(resolved, DEFAULT_RISK_POLICY);
  assert.equal(resolved.confidenceThreshold, 0.7);
  assert.equal(resolved.verifyHumanReleaseEnabled, true);

  // The risk judge itself: a verdict that reads a proceed at the hard-coded 0.7 threshold
  // still reads a proceed when the ABSENT section is threaded through explicitly — nothing
  // about the decision changes when the config comes from an absent policy row.
  const withoutConfig = planRiskJudgeAction(verdict({ confidence: 0.71 }));
  const withAbsentPolicy = planRiskJudgeAction(verdict({ confidence: 0.71 }), {
    confidenceThreshold: resolved.confidenceThreshold,
  });
  assert.equal(withoutConfig.kind, "proceed");
  assert.equal(withAbsentPolicy.kind, "proceed");
  assert.equal(withoutConfig.kind, withAbsentPolicy.kind);

  // The verify-human release arm: no `riskPolicy` dep at all (an old caller, or a fresh checkout
  // with no risk section) still releases directly — a door added, never a wall raised.
  const written: [string, Record<string, unknown>][] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/nonexistent/ledger.jsonl",
    runId: "APPROVE-W1-T1041",
    ledgerLines: [],
    append: ((path: string, r: Record<string, unknown>) => void written.push([path, r])) as never,
  });
  assert.equal(out.code, 0);
  assert.equal(written.length, 1, "an absent risk policy still releases directly, exactly as before this task");
  assert.equal(written[0]![1].step, RELEASE_LEDGER_STEP);
});

test("W1-T4050: the configured threshold is the one applied", () => {
  // A `risk.confidenceThreshold` row raised above the module default changes which verdicts
  // escalate — the SAME verdict/confidence pair reads differently once the configured value,
  // not the 0.7 literal, is what `planRiskJudgeAction` is handed.
  const raisedPolicy = parseRiskPolicy({ confidenceThreshold: { value: 0.95, origin: "net-new" } });
  assert.equal(raisedPolicy.confidenceThreshold, 0.95);

  const atDefaultThreshold = planRiskJudgeAction(verdict({ confidence: 0.8 }));
  assert.equal(atDefaultThreshold.kind, "proceed", "0.8 clears the hard-coded 0.7 default");

  const atConfiguredThreshold = planRiskJudgeAction(verdict({ confidence: 0.8 }), {
    confidenceThreshold: raisedPolicy.confidenceThreshold,
  });
  assert.equal(atConfiguredThreshold.kind, "escalate", "the SAME 0.8 no longer clears the configured 0.95");
  assert.match(atConfiguredThreshold.reason, /0\.80 < 0\.95/);

  // Lowering it has the opposite, symmetric effect — this is not a one-directional clamp.
  const loweredPolicy = parseRiskPolicy({ confidenceThreshold: { value: 0.5, origin: "net-new" } });
  const atLoweredThreshold = planRiskJudgeAction(verdict({ confidence: 0.6 }), {
    confidenceThreshold: loweredPolicy.confidenceThreshold,
  });
  assert.equal(atLoweredThreshold.kind, "proceed", "0.6 fails the 0.7 default but clears the configured 0.5");
});

test("W1-T4050: a disabled release stages proposals instead", () => {
  // (design i/iii): `risk.verifyHumanReleaseEnabled: false` stops `approveParkedTask` from
  // writing the direct `ratify.approved` row and routes the SAME release through a staged
  // proposal instead — the operator's bit is still recorded, just via the reviewed path.
  const disabledPolicy = parseRiskPolicy({ verifyHumanReleaseEnabled: { value: false, origin: "net-new" } });
  assert.equal(disabledPolicy.verifyHumanReleaseEnabled, false);
  assert.equal(disabledPolicy.confidenceThreshold, DEFAULT_RISK_POLICY.confidenceThreshold, "one field's presence never resets its sibling");

  const written: unknown[] = [];
  const staged: unknown[] = [];
  const out = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/nonexistent/ledger.jsonl",
    runId: "APPROVE-W1-T1041",
    ledgerLines: [],
    append: (() => void written.push(1)) as never,
    riskPolicy: disabledPolicy,
    stageProposal: (proposal) => void staged.push(proposal),
  });
  assert.equal(out.code, 0, "staging a proposal is a success, not a refusal");
  assert.equal(written.length, 0, "the direct ratify.approved row is NEVER written while disabled");
  assert.equal(staged.length, 1, "exactly one proposal is staged instead");
  assert.equal((staged[0] as { id: string }).id, verifyHumanReleaseProposalId("W1-T1041"));
  assert.match(out.message, /DISABLED by policy/);
  assert.match(out.message, new RegExp(verifyHumanReleaseProposalId("W1-T1041").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Re-enabling it (the default) restores the direct release — the switch travels both ways.
  const written2: unknown[] = [];
  const out2 = approveParkedTask("W1-T1041", {
    plan: planOf([parked("W1-T1041")]),
    ledgerPath: "/nonexistent/ledger.jsonl",
    runId: "APPROVE-W1-T1041",
    ledgerLines: [],
    append: (() => void written2.push(1)) as never,
    riskPolicy: { ...disabledPolicy, verifyHumanReleaseEnabled: true },
  });
  assert.equal(out2.code, 0);
  assert.equal(written2.length, 1, "enabled once more, the direct release fires again");
});

test("W1-T4050: a policy change takes effect without a restart", () => {
  // (design iii): LIVE RE-READ, NOT BOOT-TIME. `readRiskPolicy` must re-read and re-parse the
  // file on every call — a process that cached it at first read (the `loadDefaultPolicy` shape
  // this task deliberately does NOT reuse) would still report the OLD value after a merged
  // `plan/policy.yaml` edit, and only a restart would ever see the new one.
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4050-`));
  const policyPath = join(tmp, "policy.yaml");
  try {
    writeFileSync(
      policyPath,
      "risk:\n  confidenceThreshold:\n    value: 0.7\n    origin: net-new\n  verifyHumanReleaseEnabled:\n    value: true\n    origin: net-new\n",
      "utf8",
    );
    const before = readRiskPolicy(policyPath);
    assert.equal(before.confidenceThreshold, 0.7);
    assert.equal(before.verifyHumanReleaseEnabled, true);

    // Simulate a merged plan PR changing the policy — no process restart happens here.
    writeFileSync(
      policyPath,
      "risk:\n  confidenceThreshold:\n    value: 0.95\n    origin: net-new\n  verifyHumanReleaseEnabled:\n    value: false\n    origin: net-new\n",
      "utf8",
    );
    const after = readRiskPolicy(policyPath);
    assert.equal(after.confidenceThreshold, 0.95, "the SAME live reader sees the edited value with no restart");
    assert.equal(after.verifyHumanReleaseEnabled, false);
    assert.notDeepEqual(before, after, "the reader is not returning a memoized snapshot from its first call");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("W1-T4050: the automated release path reads the live risk policy", async () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4050-release-`));
  const policyDir = join(tmp, "plan");
  const policyFile = join(policyDir, "policy.yaml");
  const ledgerPath = join(tmp, "ledger.ndjson");
  const policy = (threshold: number, enabled: boolean) =>
    `risk:\n  confidenceThreshold:\n    value: ${threshold}\n    origin: net-new\n  verifyHumanReleaseEnabled:\n    value: ${enabled}\n    origin: net-new\n`;
  const task = parked("W1-T1041");
  const plan = planOf([task]);
  const shard = {
    id: task.id,
    title: task.title,
    rationale: "",
    acceptance: [],
    ageDays: 1,
    depsAllMerged: true,
    citedInSrc: false,
  };
  try {
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(policyFile, policy(0.95, true), "utf8");
    const hook = productionVerifyHumanRelease(plan, tmp, ledgerPath, "RUN-LIVE", {
      riskJudge: async () => verdict({ confidence: 0.8 }),
    });

    const aboveConfiguredThreshold = await hook(shard, { decision: "automate", reason: "safe" });
    assert.equal(aboveConfiguredThreshold.kind, "escalated", "0.8 must not clear a live 0.95 threshold");
    assert.equal(existsSync(ledgerPath), false, "an escalated release writes no release row");

    writeFileSync(policyFile, policy(0.7, false), "utf8");
    const disabled = await hook(shard, { decision: "automate", reason: "safe" });
    assert.equal(disabled.kind, "escalated", "disabled policy must not be reported as released");
    assert.match(disabled.reason, /DISABLED by policy/);
    assert.equal(existsSync(ledgerPath), false, "a disabled policy writes no release row");

    writeFileSync(policyFile, policy(0.7, true), "utf8");
    const enabledAgain = await hook(shard, { decision: "automate", reason: "safe" });
    assert.equal(enabledAgain.kind, "released", "the same hook sees the re-enabled policy without restart");
    assert.match(readFileSync(ledgerPath, "utf8"), new RegExp(RELEASE_LEDGER_STEP));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * THE REFUSAL ARMS, ONE TEST PER THROW. `diff-coverage` flagged six throw sites in
 * `parseRiskPolicy`/`readRiskPolicy` and the `catch` in the production release hook as added
 * lines with zero covering tests. They are the "fail loud on a typo" half of this feature: a
 * policy row an operator mistypes must stop the read, never resolve to a default that quietly
 * re-enables an automated release. A validator whose refusal arm is never executed is a
 * validator nobody has checked.
 */

test("W1-T4050: a risk section that is not a mapping is refused", () => {
  for (const bad of ["a string", 42, ["a", "list"]]) {
    assert.throws(() => parseRiskPolicy(bad), /'risk' must be a mapping/);
  }
});

test("W1-T4050: a number row that is not a mapping, or carries no finite value, is refused", () => {
  for (const bad of ["0.9", 0.9, [0.9]]) {
    assert.throws(
      () => parseRiskPolicy({ confidenceThreshold: bad }),
      /'risk\.confidenceThreshold' must be a mapping with 'value'\/'origin'/,
    );
  }
  for (const bad of [{ value: "0.9" }, { value: Number.NaN }, { value: Number.POSITIVE_INFINITY }, { origin: "net-new" }]) {
    assert.throws(
      () => parseRiskPolicy({ confidenceThreshold: bad }),
      /'risk\.confidenceThreshold\.value' must be a finite number/,
    );
  }
});

test("W1-T4050: a boolean row that is not a mapping, or carries a non-boolean value, is refused", () => {
  for (const bad of ["true", true, [true]]) {
    assert.throws(
      () => parseRiskPolicy({ verifyHumanReleaseEnabled: bad }),
      /'risk\.verifyHumanReleaseEnabled' must be a mapping with 'value'\/'origin'/,
    );
  }
  for (const bad of [{ value: "true" }, { value: 1 }, { origin: "net-new" }]) {
    assert.throws(
      () => parseRiskPolicy({ verifyHumanReleaseEnabled: bad }),
      /'risk\.verifyHumanReleaseEnabled\.value' must be a boolean/,
    );
  }
});

test("W1-T4050: a policy.yaml whose root is not a mapping is refused by the live reader", () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4050-badroot-`));
  const policyFile = join(tmp, "policy.yaml");
  try {
    for (const bad of ["just a string\n", "- a\n- list\n"]) {
      writeFileSync(policyFile, bad, "utf8");
      assert.throws(() => readRiskPolicy(policyFile), /policy\.yaml must be a mapping/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("W1-T4050: an unreadable risk policy makes the release UNAVAILABLE, never a silent release", async () => {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4050-unavailable-`));
  const policyDir = join(tmp, "plan");
  const policyFile = join(policyDir, "policy.yaml");
  const ledgerPath = join(tmp, "ledger.ndjson");
  const task = parked("W1-T1042");
  const shard = {
    id: task.id, title: task.title, rationale: "", acceptance: [],
    ageDays: 1, depsAllMerged: true, citedInSrc: false,
  };
  try {
    mkdirSync(policyDir, { recursive: true });
    // A typo an operator could really make: the row is a bare scalar, not a value/origin mapping.
    writeFileSync(policyFile, "risk:\n  confidenceThreshold: 0.7\n", "utf8");
    const hook = productionVerifyHumanRelease(planOf([parked("W1-T1042")]), tmp, ledgerPath, "RUN-UNAVAIL", {
      riskJudge: async () => verdict({ confidence: 0.99 }),
    });
    const out = await hook(shard, { decision: "automate", reason: "safe" });
    assert.equal(out.kind, "unavailable", "an unreadable policy must not fall through to a release");
    assert.match(out.reason, /risk policy unavailable/);
    assert.match(out.reason, /must be a mapping with 'value'\/'origin'/, "the refusal names the row it could not read");
    assert.equal(existsSync(ledgerPath), false, "nothing is released while the policy cannot be read");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
