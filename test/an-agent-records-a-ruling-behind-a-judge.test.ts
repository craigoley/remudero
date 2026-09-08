/**
 * W1-T3212 — AN AGENT MAY RECORD A RULING, BEHIND A JUDGE.
 *
 * THE POLARITY THIS SUITE EXISTS TO PIN. escalate.ts's judge fails OPEN; this one fails CLOSED,
 * and a reviewer's instinct will be to make them match. Every unreadable-verdict path below
 * asserts `escalate`, and each says why in its own message, so a future edit that "fixes the
 * inconsistency" fails here with the reason rather than passing quietly.
 *
 * POSITIVE CONTROL, per the shard's falsifier: the suite drives BOTH arms through the real
 * callsite (`routeRuling`, run-task.ts) and asserts the recorded corpus DIFFERS between them. A
 * suite exercising only the pass arm cannot distinguish "the judge gates" from "the judge is
 * decorative".
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_RULING_PROVENANCE,
  FAIL_CLOSED_RULING_VERDICT,
  RULING_JUDGED_STEP,
  RULING_JUDGE_TOOLS,
  type AgentRuling,
  type RulingJudgeVerdict,
  buildRulingJudgePrompt,
  buildRulingJudgeSpawnArgs,
  contradictsStandingDecision,
  judgeRulingRisk,
  parseRulingJudgeVerdict,
  proposalFromRefusedRuling,
  refusedRulingProposalId,
  rulingIsWellFormed,
  rulingRecordContent,
  rulingRecordRelPath,
  realRulingJudge,
  spawnRulingJudgeWorker,
  STANDING_ANCHOR_RE,
  standingAnchorsCited,
} from "../src/lib/ruling-judge.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { fixedClock } from "../src/lib/clock.js";
import { recordRuling } from "../src/lib/feedback-landing.js";
import { readStandingDecisions, routeRuling, ruleCommand, type RouteRulingDeps } from "../src/run-task.js";

const RULING: AgentRuling = {
  taskId: "W1-T4242",
  runId: "RUN-1",
  title: "the sweep dedups on head sha, not task id",
  ruling: "Duplicate escalations for one task are expected when each carries a distinct head sha; the dedup is correct and W1-T3179 is the follow-up, not a defect here.",
  evidence: ["src/lib/escalate.ts:812 — the dedup key is the head sha", "measured: all six duplicates carry distinct shas"],
  rollback: "revert this record; the dedup code is unchanged either way",
  author: "worker/W1-T4242",
};

const PASS: RulingJudgeVerdict = { decision: "record", reason: "narrow, evidenced, reversible" };

/** A `routeRuling` harness whose every outward effect is captured rather than performed. */
function harness(overrides: Partial<RouteRulingDeps> = {}) {
  const landed = new Map<string, string>();
  const staged: { id: string; summary: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: RouteRulingDeps = {
    judge: async () => PASS,
    standingDecisions: "## 2026-01-01 — something unrelated\n- Operator-ruled: nothing to do with this.\n",
    land: (relPath, content) => void landed.set(relPath, content),
    stageProposal: (p) => void staged.push({ id: p.id, summary: p.summary }),
    appendRow: (row) => void rows.push(row),
    clock: fixedClock(Date.parse("2026-09-08T00:00:00.000Z")),
    ...overrides,
  };
  return { deps, landed, staged, rows };
}

// ── Criterion 1: the pass arm lands an attributed, evidenced, revertible record ────────────────

test("W1-T3212: a ruling the judge passes lands, attributed to the agent, with its evidence and a rollback line", async () => {
  const h = harness();
  const result = await routeRuling(RULING, h.deps);

  assert.equal(result.decision, "record");
  assert.equal(h.staged.length, 0, "a recorded ruling asks the operator nothing");
  assert.deepEqual([...h.landed.keys()], [rulingRecordRelPath("W1-T4242", "RUN-1")]);

  const body = h.landed.get(rulingRecordRelPath("W1-T4242", "RUN-1"))!;
  assert.match(body, /Agent-ruled, judged/, "design (iv): a reader must be able to attribute the entry");
  assert.match(body, /worker\/W1-T4242/, "and to the specific author, not just 'an agent'");
  assert.match(body, /escalate\.ts:812/, "the evidence rides the record, not just the prompt");
  assert.match(body, /- Rollback: revert this record/, "and so does the rollback line");
  assert.match(body, /- Judge: record — narrow, evidenced, reversible/, "the record says on what basis it was allowed to land");
});

// ── Criterion 2: the refuse arm lands NOTHING and routes to the inbox ──────────────────────────

test("W1-T3212: a ruling the judge finds risky does NOT land, and becomes a proposal the operator can ratify", async () => {
  const h = harness({ judge: async () => ({ decision: "escalate", reason: "sets broad policy on the operator's own risk appetite" }) });
  const result = await routeRuling(RULING, h.deps);

  assert.equal(result.decision, "escalate");
  assert.equal(h.landed.size, 0, "NOTHING is recorded when the judge refuses — this is the whole safety argument");
  assert.deepEqual(h.staged.map((p) => p.id), [refusedRulingProposalId(RULING)]);
  assert.match(h.staged[0]!.summary, /sets broad policy on the operator's own risk appetite/, "the operator reads WHY it reached him");
  assert.match(h.staged[0]!.summary, /Nothing is recorded until you do/, "and that his bit is what records it");
});

test("W1-T3212: POSITIVE CONTROL — the recorded corpus DIFFERS between the pass and refuse arms", async () => {
  // The falsifier's own requirement: a suite where both arms produce the same corpus cannot tell
  // "the judge gates" from "the judge is decorative".
  const pass = harness();
  await routeRuling(RULING, pass.deps);
  const refuse = harness({ judge: async () => ({ decision: "escalate", reason: "needs the operator" }) });
  await routeRuling(RULING, refuse.deps);

  assert.notDeepEqual([...pass.landed.keys()], [...refuse.landed.keys()]);
  assert.equal(pass.landed.size, 1);
  assert.equal(refuse.landed.size, 0);
  assert.equal(pass.staged.length, 0);
  assert.equal(refuse.staged.length, 1);
});

// ── Criterion 3: fail CLOSED, proven at the callsite ───────────────────────────────────────────

test("W1-T3212: a THROWING judge routes to the inbox — fail closed, at the callsite", async () => {
  const h = harness({ judge: async () => { throw new Error("spawn refused by the governor"); } });
  const result = await routeRuling(RULING, h.deps);
  assert.equal(result.decision, "escalate", "the OPPOSITE of escalate.ts's fail-open judge — a judge we cannot hear must never land a governance decision");
  assert.equal(h.landed.size, 0);
  assert.equal(h.staged.length, 1);
  assert.match(result.reason, /spawn refused by the governor/, "the operator is told what went wrong, not just that something did");
});

test("W1-T3212: an UNPARSEABLE verdict routes to the inbox — fail closed", async () => {
  const h = harness({ judge: async () => parseRulingJudgeVerdict("I think this is probably fine, honestly.") });
  const result = await routeRuling(RULING, h.deps);
  assert.equal(result.decision, "escalate");
  assert.equal(h.landed.size, 0, "prose with no machine-readable verdict must never be read as consent");
});

test("W1-T3212: the fail-closed default is `escalate`, and a verdict naming an unknown decision takes it", () => {
  assert.equal(FAIL_CLOSED_RULING_VERDICT.decision, "escalate");
  assert.equal(parseRulingJudgeVerdict("RULING_JUDGE_DECISION: approve").decision, "escalate", "an unrecognised word is not a permissive one");
  assert.equal(parseRulingJudgeVerdict("RULING_JUDGE_DECISION: record").decision, "record", "and the suite still proves the permissive arm is REACHABLE");
});

// ── Criterion 4: a standing record is never silently overturned ────────────────────────────────

test("W1-T3212: a ruling that supersedes a standing record routes to the operator REGARDLESS of the judge", async () => {
  const overturning: AgentRuling = { ...RULING, supersedes: ["fb-1785882211812-bafd8f"] };
  // The judge is stubbed to the MOST permissive answer available; the outcome must not depend on it.
  const h = harness({ judge: async () => PASS });
  const result = await routeRuling(overturning, h.deps);
  assert.equal(result.decision, "escalate");
  assert.equal(h.landed.size, 0);
  assert.match(result.reason, /supersedes fb-1785882211812-bafd8f/);
  assert.match(result.reason, /the operator's call, never the judge's/);
});

test("W1-T3212: the standing-record check runs BEFORE the judge is called, not after", async () => {
  let asked = 0;
  const h = harness({ judge: async () => { asked += 1; return PASS; } });
  await routeRuling({ ...RULING, supersedes: ["fb-1785882211812-bafd8f"] }, h.deps);
  assert.equal(asked, 0, "a judge that is never asked cannot be argued into overturning a standing decision");
});

test("W1-T3212: reversal language about a record that STANDS escalates; a mere citation does not", () => {
  const standing = "## 2026-08-20 — decision authority\n- Operator-ruled: see fb-1785882211812-bafd8f.\n";
  const reversing = { ...RULING, ruling: "This supersedes fb-1785882211812-bafd8f entirely." };
  assert.match(contradictsStandingDecision(reversing, standing) ?? "", /stands in the decision record/);

  const citing = { ...RULING, ruling: "Consistent with fb-1785882211812-bafd8f, the dedup is correct." };
  assert.equal(
    contradictsStandingDecision(citing, standing),
    undefined,
    "nearly every good ruling cites a standing rule it AGREES with — escalating those makes the judge decorative in the other direction",
  );

  const unresolvable = { ...RULING, ruling: "This supersedes rule 99, which I cannot find." };
  assert.equal(contradictsStandingDecision(unresolvable, standing), undefined, "reversal language about nothing in the record is not a contradiction with it");
});

test("W1-T3212: an anchor the standing record does not contain still escalates when DECLARED", () => {
  // Asymmetric on purpose: the author believes they are overturning something and we cannot
  // confirm what. That is strictly worse than a resolvable reversal, never better.
  const r = { ...RULING, supersedes: ["fb-0000000000000-nosuch"] };
  assert.match(contradictsStandingDecision(r, "## nothing here\n") ?? "", /supersedes fb-0000000000000-nosuch/);
});

test("W1-T3212: STANDING_ANCHOR_RE REFUSES what is not a governance anchor", () => {
  // Negative reachability, per negative-reachability-ratchet.test.ts: a validator nothing ever
  // proves REJECTS anything is indistinguishable from one that accepts everything.
  assert.equal(STANDING_ANCHOR_RE.test("fb-1785882211812-bafd8f"), true, "a feedback id IS an anchor — the positive control");
  assert.equal(STANDING_ANCHOR_RE.test("Standing rule 15"), true, "and so is a numbered standing rule");
  assert.equal(STANDING_ANCHOR_RE.test("W1-T3212"), false, "a task id is not a governance anchor — a ruling names its own task constantly");
  assert.equal(STANDING_ANCHOR_RE.test("PR #4715"), false, "nor is a PR number");
  assert.equal(STANDING_ANCHOR_RE.test("the rule about naming"), false, "nor is the bare word 'rule' with no number after it");
  assert.equal(STANDING_ANCHOR_RE.test("fb-notdigits-bafd8f"), false, "nor a feedback-shaped token whose epoch is not digits");
});

test("W1-T3212: standingAnchorsCited reads feedback ids and numbered rules, and nothing else", () => {
  assert.deepEqual(
    standingAnchorsCited("Per fb-1785882211812-bafd8f and Standing rule 15, but not W1-T3212 or PR #4715."),
    ["fb-1785882211812-bafd8f", "standing rule 15"],
  );
});

// ── Criterion 5: BOTH arms ledger the decision and reason, and the step survives rotation ───────

test("W1-T3212: every verdict writes one ruling.judged row naming decision and reason — on BOTH arms", async () => {
  const pass = harness();
  await routeRuling(RULING, pass.deps);
  assert.equal(pass.rows.length, 1);
  assert.equal(pass.rows[0]!.step, RULING_JUDGED_STEP);
  assert.equal(pass.rows[0]!.judge_decision, "record");
  assert.equal(pass.rows[0]!.judge_reason, "narrow, evidenced, reversible");
  assert.equal(pass.rows[0]!.task_id, "W1-T4242");

  const refuse = harness({ judge: async () => ({ decision: "escalate", reason: "needs the operator" }) });
  await routeRuling(RULING, refuse.deps);
  assert.equal(refuse.rows.length, 1, "the refused arm is ledgered too — proving the escalation judge had never run took three reads because its arm was not");
  assert.equal(refuse.rows[0]!.judge_decision, "escalate");
  assert.equal(refuse.rows[0]!.judge_reason, "needs the operator");
});

test("W1-T3212: ruling.judged survives ledger rotation", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(RULING_JUDGED_STEP),
    "a verdict history rotated away cannot settle whether the judge calibrates well — which is the only thing that will",
  );
});

// ── Well-formedness: refused before a spawn is spent, and refused in the safe direction ────────

test("W1-T3212: an unattributed, unevidenced or unrevertible ruling is refused WITHOUT asking the judge", async () => {
  for (const [field, bad] of [
    ["author", { ...RULING, author: "  " }],
    ["evidence", { ...RULING, evidence: [] }],
    ["rollback", { ...RULING, rollback: "" }],
    ["title", { ...RULING, title: "" }],
    ["body", { ...RULING, ruling: "" }],
  ] as const) {
    let asked = 0;
    const h = harness({ judge: async () => { asked += 1; return PASS; } });
    const result = await routeRuling(bad, h.deps);
    assert.equal(result.decision, "escalate", `a ruling with no ${field} must not land`);
    assert.equal(asked, 0, `well-formedness is not a risk question — no spawn is spent on a missing ${field}`);
    assert.equal(h.landed.size, 0);
  }
  assert.equal(rulingIsWellFormed(RULING), undefined, "and the well-formed fixture passes, so the check is not vacuous");
});

test("W1-T3212: judgeRulingRisk is the pure decision, reachable without the callsite's seams", async () => {
  const verdict = await judgeRulingRisk(RULING, { judge: async () => PASS, standingDecisions: "" });
  assert.deepEqual(verdict, PASS);
});

// ── The prompt and the spawn: read-only by construction, and carries its own polarity ──────────

test("W1-T3212: the judge is spawned with NO tools, so it can neither explore nor act", () => {
  assert.deepEqual(RULING_JUDGE_TOOLS, []);
  const args = buildRulingJudgeSpawnArgs({
    ruling: RULING,
    mount: { model: "claude-haiku-4-5-20251001", effort: "low", maxTurns: 4 } as never,
    cwd: "/w",
    settingsFile: "/s.json",
  });
  assert.deepEqual(args.tools, []);
  assert.equal(args.cwd, "/w");
});

test("W1-T3212: the real judge adapter uses the cheapest mount, invokes the injected worker once, and parses its verdict", async () => {
  const calls: Array<{ model: string; tools?: string[] }> = [];
  const cheap = { model: "cheap", effort: "low", maxTurns: 2, contextBudget: 1_000 };
  const expensive = { model: "expensive", effort: "high", maxTurns: 4, contextBudget: 2_000 };
  const mounts = {
    tiers: { cheap: 1, expensive: 2 },
    efforts: { low: 1, high: 2 },
    routes: { implement: { low: { src: expensive }, medium: { src: cheap } } },
  } as never;
  const spawn = async (args: { model: string; tools?: string[] }) => {
    calls.push(args);
    return { text: "RULING_JUDGE_DECISION: record\nRULING_JUDGE_REASON: bounded and reversible" } as never;
  };

  const direct = await spawnRulingJudgeWorker({
    ruling: RULING,
    mount: cheap,
    cwd: "/worktree",
    settingsFile: "/settings.json",
    spawn: spawn as never,
  });
  assert.match(direct.text, /DECISION: record/);

  const judge = realRulingJudge({ mounts, cwd: "/worktree", settingsFile: "/settings.json", spawn: spawn as never });
  assert.deepEqual(await judge(RULING), { decision: "record", reason: "bounded and reversible" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.model), ["cheap", "cheap"]);
  assert.deepEqual(calls.map((c) => c.tools), [[], []]);
});

test("W1-T3212: the prompt states the asymmetry in the ESCALATE direction and carries the ruling's own evidence", () => {
  const p = buildRulingJudgePrompt(RULING);
  assert.match(p, /WHEN IN DOUBT, ESCALATE/, "the opposite of the escalation judge's WHEN IN DOUBT, DELIVER");
  assert.match(p, /YOU ARE NOT ASKED WHETHER THE RULING IS RIGHT/, "risk and quality, never correctness of the decision");
  assert.match(p, /escalate\.ts:812/, "the evidence the judge is asked to weigh is actually in front of it");
  assert.match(p, /RULING_JUDGE_DECISION: <record\|escalate>/);
});

test("W1-T3212: the recorded body's provenance mark is DISTINCT from the operator's own", () => {
  const body = rulingRecordContent(RULING, PASS, "2026-09-08T00:00:00.000Z");
  assert.match(body, new RegExp(AGENT_RULING_PROVENANCE));
  assert.doesNotMatch(body, /Operator-ruled/, "an agent's ruling must never read as the operator's word");
  assert.doesNotMatch(body, /Chosen \(RECOMMENDED, auto\)/, "nor as an auto-choose decision record");
});

test("W1-T3212: a refused ruling's proposal id is derived, so staging it twice asks the operator once", () => {
  const a = proposalFromRefusedRuling(RULING, { decision: "escalate", reason: "x" });
  const b = proposalFromRefusedRuling(RULING, { decision: "escalate", reason: "y" });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.evidenceAnchors, [], "a ruling depends on nothing having landed on main — anchors would tier it not-ready forever");
});

test("W1-T3212: standing decisions include the root record and markdown shards, while unrelated files are ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ruling-standing-"));
  writeFileSync(join(root, "DECISIONS.md"), "root decision");
  mkdirSync(join(root, "plan", "decisions.d"), { recursive: true });
  writeFileSync(join(root, "plan", "decisions.d", "one.md"), "shard decision");
  writeFileSync(join(root, "plan", "decisions.d", "ignore.txt"), "not governance");
  assert.equal(readStandingDecisions(root), "root decision\nshard decision");

  const rootOnly = mkdtempSync(join(tmpdir(), "rmd-ruling-root-only-"));
  writeFileSync(join(rootOnly, "DECISIONS.md"), "only root");
  assert.equal(readStandingDecisions(rootOnly), "only root");
});

test("W1-T3212: rmd rule parses the authored ruling and renders both routed outcomes", async () => {
  const args = [
    "--task", "W1-T4242", "--author", "worker/W1-T4242", "--title", "narrow ruling",
    "--ruling", "keep the bounded behavior", "--evidence", "test: green", "--rollback", "revert it",
  ];
  const seen: AgentRuling[] = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-rule-command-"));
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, ".remudero", "mounts.yaml"), readFileSync(join(process.cwd(), ".remudero", "mounts.yaml")));
  const record = await ruleCommand(args, {
    root,
    route: async (ruling, deps) => {
      seen.push(ruling);
      deps.land("plan/decisions.d/ruling.md", "recorded ruling");
      return { decision: "record", reason: "safe", landedPath: "plan/decisions.d/ruling.md" };
    },
  });
  assert.equal(record, 0);
  assert.equal(seen[0]?.taskId, "W1-T4242");
  assert.deepEqual(seen[0]?.evidence, ["test: green"]);

  const escalate = await ruleCommand([...args, "--supersedes", "rule 15"], {
    root,
    route: async (ruling, deps) => {
      seen.push(ruling);
      deps.stageProposal({ id: "ruling:W1-T4242", summary: "operator-owned", evidenceAnchors: [] });
      return { decision: "escalate", reason: "operator-owned", proposalId: "ruling:W1-T4242" };
    },
  });
  assert.equal(escalate, 0);
  assert.deepEqual(seen[1]?.supersedes, ["rule 15"]);
  assert.equal(await ruleCommand([], { route: async () => { throw new Error("unreachable"); } }), 2);
});

test("W1-T3212: the executable CLI dispatches the rule verb instead of falling through to unknown-command usage", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/run-task.ts", "rule"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
  });
  assert.equal(child.status, 2, "a rule invocation without --task is a rule usage error");
  assert.match(child.stderr, /rmd rule: --task/);
  assert.doesNotMatch(child.stderr, /^usage:/, "the top-level unknown-command fallthrough did not own this invocation");
});

test("W1-T3212: recordRuling delegates to the decision landing bridge and preserves its best-effort failure contract", () => {
  const result = recordRuling("/not-used", "plan/decisions.d/x.md", "ruling", {
    git: () => { throw new Error("offline"); },
    gh: () => { throw new Error("must not reach GitHub"); },
  });
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /offline/);
});
