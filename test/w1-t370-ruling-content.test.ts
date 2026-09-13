/**
 * W1-T3392 — W1-T370's ATTRITION spend ruling, submitted through `rmd rule`.
 *
 * WHAT THIS DOES, AND DOES NOT, DO. W1-T370 asks the operator to rule between attrition, bulk
 * retirement, or scoping the linter, over the 136-then-166 merged tasks whose already-shipped
 * work carries unexecutable proofs. Its own text already recommends attrition; what changed on
 * 2026-09-08 (W1-T3212) is that an agent may now SUBMIT a ruling — behind `judgeRulingRisk` — for
 * the OPERATOR to have recorded or to see land in the inbox, where before the standing rule
 * (`fb-1785882211812-bafd8f`) let an agent recommend but never record.
 *
 * This suite proves TWO things about the ONE ruling this task authors, and only those two:
 *   1. the fixture below is well-formed, recommends ATTRITION, cites W1-T370's own evidence, and
 *      declares no `supersedes` (design: this ruling does not overturn anything);
 *   2. it routes correctly through BOTH of `routeRuling`'s judge arms — record lands exactly one
 *      `plan/decisions.d/` entry carrying the evidence and rollback, escalate lands nothing and
 *      stages exactly one inbox proposal — the same reusable pattern
 *      `an-agent-records-a-ruling-behind-a-judge.test.ts` established for W1-T3212 generically,
 *      applied here to this ruling's actual content.
 *
 * It deliberately does NOT touch `plan/tasks.d/W1-T370-...yaml` (that edit is W1-T3393's, gated
 * on whether a live run of this ruling actually records) and does NOT perform a live spawn or a
 * real `git`/`gh` landing — `routeRuling`'s judge, land and stageProposal are all injected, exactly
 * as design clause (iv) of W1-T3212 requires for this to be provable without a repo or a network.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  refusedRulingProposalId,
  rulingIsWellFormed,
  rulingRecordRelPath,
  type AgentRuling,
} from "../src/lib/ruling-judge.js";
import { fixedClock } from "../src/lib/clock.js";
import { routeRuling, ruleCommand, type RouteRulingDeps } from "../src/run-task.js";

const TASK_ID = "W1-T370";
/** `ruleCommand`'s own default when `--run` is omitted (`RULE-<taskId>`) — asserted against
 *  directly below, so this constant cannot silently drift from the real CLI's behavior. */
const RUN_ID = "RULE-W1-T370";

/**
 * THE RULING ITSELF. Recommends ATTRITION (W1-T370 option (a)): fix a row's proof only as part
 * of a diff that already touches it, rather than (b) bulk-rewriting all 391/440 proofs for
 * already-shipped work or (c) reopening how the linter grades changed tasks. Cites both figures
 * W1-T370 measured, W1-T369's closure of the population that actually stalls live runs, and the
 * two adjacent levers the operator and W1-T367 already declined. No `supersedes`: this ruling
 * overturns nothing standing.
 */
const RULING: AgentRuling = {
  taskId: TASK_ID,
  runId: RUN_ID,
  title: "attrition: fix a W1-T370 row's proofs only when a diff already touches it",
  ruling:
    "Recommend ATTRITION (W1-T370 option a) for the merged proof debt: change no rows now, and " +
    "fix a row's proofs only as part of a diff that already touches it, rather than (b) bulk-" +
    "rewriting all of them for work that already shipped or (c) reopening how the linter grades " +
    "a changed task. W1-T369 already closed the 39 open, unmerged tasks that actually stall live " +
    "runs; this debt is merged, shipped work that costs nothing until a future diff touches one " +
    "of its rows. Both adjacent levers that would have avoided grading it at all were already " +
    "declined by name, and this ruling reopens neither.",
  evidence: [
    "W1-T370, 2026-08-05 census: 136 merged tasks carry 391 blocking violations — 239 proof-dialect, 147 proof-resolvability, 5 headless-fitness",
    "W1-T370, 2026-09-02 re-measurement at origin/main 31288519: 166 merged tasks carry 440 comparable violations — 265 proof-dialect, 170 proof-resolvability, 5 headless-fitness; +49 (+12.5%) in 28 days, about +1.75 lines/day",
    "W1-T369 closed the 39 open (unmerged) tasks that actually stall live runs, leaving this merged debt live only when a future diff touches one of its rows",
    "the `status:` field lever was declined by the operator on 2026-08-05: the field is decorative by documented design and plan/tasks.yaml's own header says the runner never writes it back",
    "W1-T367 design (iii) declined turning `isOpenLintTask` into a derived projection, because `rmd lint-plan` stays an offline, deterministic linter and a projection would need a GitHub read",
  ],
  rollback:
    `delete ${rulingRecordRelPath(TASK_ID, RUN_ID)}; attrition changes no code, lint rule, or ` +
    "task shard, so removing the record fully undoes the ruling",
  author: "worker/W1-T3392",
};

/** The exact `rmd rule` invocation this ruling is submitted through — built FROM `RULING` so the
 *  CLI args and the fixture can never silently diverge from each other. */
const CLI_ARGS: string[] = [
  "--task", RULING.taskId,
  "--author", RULING.author,
  "--title", RULING.title,
  "--ruling", RULING.ruling,
  ...RULING.evidence.flatMap((e) => ["--evidence", e]),
  "--rollback", RULING.rollback,
];

// ── Criterion 1: the fixture is well formed, recommends ATTRITION, and cites its evidence ──────

test("W1-T3392: the W1-T370 ruling fixture is well-formed, recommends ATTRITION, and declares no supersedes", () => {
  assert.equal(rulingIsWellFormed(RULING), undefined);
  assert.equal(RULING.supersedes, undefined, "design: this ruling overturns nothing standing");
  assert.match(RULING.ruling, /ATTRITION/, "the ruling names the recommended option explicitly");
});

test("W1-T3392: the fixture cites W1-T370's own census, its re-measurement, W1-T369's closure and both declined levers", () => {
  const all = `${RULING.title}\n${RULING.ruling}\n${RULING.evidence.join("\n")}`;
  assert.match(all, /136/, "the 2026-08-05 merged-task count");
  assert.match(all, /391/, "the 2026-08-05 violation count");
  assert.match(all, /166/, "the 2026-09-02 merged-task count");
  assert.match(all, /440/, "the 2026-09-02 comparable violation count");
  assert.match(all, /1\.75/, "the measured growth rate");
  assert.match(all, /W1-T369/, "W1-T369's closure of the population that actually stalls live runs");
  assert.match(all, /status:/, "the declined `status:` field lever");
  assert.match(all, /W1-T367/, "the declined W1-T367 design (iii) lever");
  assert.match(all, /design \(iii\)/);
  assert.ok(RULING.rollback.trim().length > 0, "a concrete rollback is required by design clause (iv)");
});

test("W1-T3392: `rmd rule`'s own CLI parsing reproduces the authored fixture exactly", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t370-ruling-"));
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "mounts.yaml"), readFileSync(join(process.cwd(), ".remudero", "mounts.yaml")));
  let captured: AgentRuling | undefined;
  const code = await ruleCommand(CLI_ARGS, {
    root,
    config: { root } as never,
    route: async (ruling) => {
      captured = ruling;
      return { decision: "record", reason: "captured only — no real judge, land or ledger reached" };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(captured, RULING, "the CLI's own parsing must not drift from the authored fixture");
});

// ── Criterion 2: routed through both injected judge arms ───────────────────────────────────────

const RECORD_VERDICT = { decision: "record" as const, reason: "narrow, evidenced, reversible spend recommendation" };

/** A `routeRuling` harness whose every outward effect is captured rather than performed — the
 *  same shape `an-agent-records-a-ruling-behind-a-judge.test.ts` uses for W1-T3212 generically. */
function harness(overrides: Partial<RouteRulingDeps> = {}) {
  const landed = new Map<string, string>();
  const staged: { id: string; summary: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: RouteRulingDeps = {
    judge: async () => RECORD_VERDICT,
    standingDecisions: "## 2026-08-05 — status field kept\n- Operator-ruled: leave it, it is decorative.\n",
    land: (relPath, content) => void landed.set(relPath, content),
    stageProposal: (p) => void staged.push({ id: p.id, summary: p.summary }),
    appendRow: (row) => void rows.push(row),
    clock: fixedClock(Date.parse("2026-09-13T00:00:00.000Z")),
    ...overrides,
  };
  return { deps, landed, staged, rows };
}

test("W1-T3392: the judge's record arm lands the W1-T370 ruling under plan/decisions.d/, carrying its evidence and rollback", async () => {
  const h = harness();
  const result = await routeRuling(RULING, h.deps);

  assert.equal(result.decision, "record");
  assert.equal(h.staged.length, 0, "a recorded ruling asks the operator nothing");
  assert.deepEqual([...h.landed.keys()], [rulingRecordRelPath(TASK_ID, RUN_ID)]);

  const body = h.landed.get(rulingRecordRelPath(TASK_ID, RUN_ID))!;
  assert.match(body, /ATTRITION/);
  assert.match(body, /391/);
  assert.match(body, /440/);
  assert.match(body, /worker\/W1-T3392/, "the record attributes the ruling to its actual agent author");
  assert.ok(body.includes(RULING.rollback), "the exact stated rollback rides the record, not a paraphrase");
});

test("W1-T3392: the judge's escalate arm lands nothing and stages exactly one inbox proposal", async () => {
  const h = harness({ judge: async () => ({ decision: "escalate", reason: "a spend decision needs the operator's own bit" }) });
  const result = await routeRuling(RULING, h.deps);

  assert.equal(result.decision, "escalate");
  assert.equal(h.landed.size, 0, "nothing is recorded when the judge refuses");
  assert.deepEqual(h.staged.map((p) => p.id), [refusedRulingProposalId(RULING)]);
  assert.match(h.staged[0]!.summary, /a spend decision needs the operator's own bit/);
  assert.match(h.staged[0]!.summary, /ATTRITION/, "the operator reads the actual recommendation, not just that one exists");
});

test("W1-T3392: POSITIVE CONTROL — the landed corpus differs between the record and escalate arms", async () => {
  const recorded = harness();
  await routeRuling(RULING, recorded.deps);
  const escalated = harness({ judge: async () => ({ decision: "escalate", reason: "needs the operator" }) });
  await routeRuling(RULING, escalated.deps);

  assert.notDeepEqual([...recorded.landed.keys()], [...escalated.landed.keys()]);
  assert.equal(recorded.landed.size, 1);
  assert.equal(escalated.landed.size, 0);
  assert.equal(recorded.staged.length, 0);
  assert.equal(escalated.staged.length, 1);
});
