// test/sre-runbooks.test.ts — W1-T4386: known failures heal themselves with a receipt.
//
// Acceptance (plan/tasks.d/W1-T4386-*.yaml):
//   - a matching runbook runs only after its precheck and records a before-and-after receipt
//   - a runbook that fails twice stops and escalates with the evidence
//   - an incident that is not a fast burn never interrupts the operator
//   - an escalation opens the needs-human issue assigned to the operator
//   - a runbook the governor holds in shadow records its action without taking it

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Escalation } from "../src/lib/escalate.js";
import { listFeedback } from "../src/lib/feedback.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { runSreLanePass, type IncidentEvidence, type SreLaneInput } from "../src/lib/sre-lane.js";
import {
  FAST_BURN_PER_HOUR,
  SRE_RUNBOOK_STEP,
  incidentSubject,
  isFastBurn,
  readRunbookReceipts,
  receiptFromLedgerRow,
  runMatchingRunbook,
  sreOperatorEscalation,
  sreRunbookCatalog,
  type RunbookObservation,
  type SreGovernorTier,
  type SreRunbook,
  type SreRunbookDeps,
  type SreRunbookHost,
  type SreRunbookReceipt,
} from "../src/lib/sre-runbooks.js";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const FP = "c".repeat(64);

function incident(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    fingerprint: FP,
    kind: "invariant",
    name: "stale-managed-checkout",
    sampleMessages: ["behind=3"],
    firstSeenMs: NOW - 10 * 60_000,
    lastSeenMs: NOW - 60_000,
    count: 2,
    burnPerHour: 2,
    deployShas: ["dep1"],
    instances: ["core"],
    ...overrides,
  };
}

/** A scripted runbook: records every call in `calls`, answers from the given scripts. */
function scripted(opts: {
  precheck?: RunbookObservation;
  verify?: RunbookObservation[];
  actThrows?: string;
  reversible?: boolean;
}): { runbook: SreRunbook; calls: string[] } {
  const calls: string[] = [];
  const verifies = [...(opts.verify ?? [{ ok: true, observed: "behind=0" }])];
  const runbook: SreRunbook = {
    id: "catch-up-managed-checkout",
    reversible: opts.reversible ?? true,
    blastRadius: "checkout",
    matches: (i) => i.name === "stale-managed-checkout",
    precheck: async () => {
      calls.push("precheck");
      return opts.precheck ?? { ok: true, observed: "behind=3 clean" };
    },
    act: async () => {
      calls.push("act");
      if (opts.actThrows) throw new Error(opts.actThrows);
    },
    verify: async () => {
      calls.push("verify");
      return verifies.length > 1 ? (verifies.shift() as RunbookObservation) : verifies[0];
    },
  };
  return { runbook, calls };
}

/** Deps whose `log` feeds `receipts()` back, exactly as the ledger does in production. */
function deps(runbooks: SreRunbook[], tier: SreGovernorTier = "live"): {
  deps: SreRunbookDeps;
  receipts: SreRunbookReceipt[];
  escalations: Escalation[];
} {
  const receipts: SreRunbookReceipt[] = [];
  const escalations: Escalation[] = [];
  return {
    receipts,
    escalations,
    deps: {
      runbooks,
      governorVerdict: () => ({ tier, reason: `governor says ${tier}` }),
      receipts: () => [...receipts],
      escalate: (e) => {
        escalations.push(e);
        return `https://github.com/o/r/issues/${escalations.length}`;
      },
      log: (step, extra) => {
        if (step === SRE_RUNBOOK_STEP) receipts.push(receiptFromLedgerRow({ step, ...extra }) as SreRunbookReceipt);
      },
      nowMs: () => NOW,
    },
  };
}

test("a matching runbook runs only after its precheck and records a before-and-after receipt", async () => {
  const { runbook, calls } = scripted({});
  const d = deps([runbook]);
  const result = await runMatchingRunbook(incident(), d.deps);

  assert.deepEqual(calls, ["precheck", "act", "verify"], "precheck first, then act, then verify");
  assert.equal(result.outcome, "cleared");
  assert.equal(result.fileFeedback, false, "a healed incident is not filed");
  assert.equal(d.receipts.length, 1);
  assert.deepEqual(
    { id: d.receipts[0].id, fingerprint: d.receipts[0].fingerprint, mode: d.receipts[0].mode, before: d.receipts[0].before, after: d.receipts[0].after, outcome: d.receipts[0].outcome },
    { id: "catch-up-managed-checkout", fingerprint: FP, mode: "live", before: "behind=3 clean", after: "behind=0", outcome: "cleared" },
  );

  // A precheck that does not hold stops the runbook before it acts — and the refusal is receipted.
  const refused = scripted({ precheck: { ok: false, observed: "dirty checkout" } });
  const r = deps([refused.runbook]);
  const refusedResult = await runMatchingRunbook(incident(), r.deps);
  assert.deepEqual(refused.calls, ["precheck"], "no act and no verify without a holding precheck");
  assert.equal(refusedResult.outcome, "precheck_refused");
  assert.equal(refusedResult.fileFeedback, true, "an incident no runbook may fix goes to the fleet");
  assert.equal(r.receipts[0].before, "dirty checkout");

  // An irreversible runbook is never on the allowlist, however well it matches.
  const irreversible = scripted({ reversible: false });
  const noMatch = await runMatchingRunbook(incident(), deps([irreversible.runbook]).deps);
  assert.equal(noMatch.outcome, "no_match");
  assert.deepEqual(irreversible.calls, []);

  // Through the lane: a live cleared runbook keeps the incident out of the feedback store, and the
  // receipt reaches the ledger as an `sre.runbook` row.
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-runbooks-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger: Array<Record<string, unknown>> = [];
  const lane = scripted({});
  const laneDeps: SreLaneInput = {
    stateDir: join(root, "state"),
    root,
    readEvents: () => [{ fingerprint: FP, ts: NOW - 60_000, kind: "invariant", name: "stale-managed-checkout", message: "behind=3", instance: "core" }],
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: () => [],
    mergedLastDay: () => 5,
    log: (step, extra) => ledger.push({ step, ...extra }),
    runbooks: { ...deps([lane.runbook]).deps, receipts: () => ledger.map((row) => receiptFromLedgerRow(row)).filter((x): x is SreRunbookReceipt => !!x) },
  };
  const pass = await runSreLanePass(laneDeps);
  assert.equal(pass.filed, undefined);
  assert.equal(pass.runbook?.outcome, "cleared");
  assert.equal(listFeedback(root).length, 0);
  assert.deepEqual(ledger.map((row) => row.step), [SRE_RUNBOOK_STEP]);
});

test("a runbook that fails twice stops and escalates with the evidence", async () => {
  const { runbook, calls } = scripted({ verify: [{ ok: false, observed: "still behind=3" }, { ok: false, observed: "still behind=2" }] });
  const d = deps([runbook]);

  const first = await runMatchingRunbook(incident(), d.deps);
  assert.equal(first.outcome, "failed");
  assert.equal(first.fileFeedback, false, "the runbook still owns the incident after one failure");
  assert.equal(d.escalations.length, 0, "one failure never interrupts the operator");

  // No new evidence, no second attempt.
  const unchanged = await runMatchingRunbook(incident(), d.deps);
  assert.equal(unchanged.outcome, "no_new_evidence");
  assert.equal(calls.filter((c) => c === "act").length, 1);

  const second = await runMatchingRunbook(incident({ lastSeenMs: NOW - 30_000 }), d.deps);
  assert.equal(second.outcome, "escalated");
  assert.equal(second.fileFeedback, true);
  assert.equal(d.escalations.length, 1);
  const detail = d.escalations[0].detail;
  assert.ok(detail.includes("still behind=3") && detail.includes("still behind=2"), "both failed receipts ride as evidence");
  assert.ok(detail.includes("behind=3 clean"), "the before reading rides too");
  assert.ok(d.escalations[0].summary.includes("failed 2 times"));

  // Stopped: a third burn never acts again and never re-pages.
  const third = await runMatchingRunbook(incident({ lastSeenMs: NOW - 10_000 }), d.deps);
  assert.equal(third.outcome, "escalated");
  assert.equal(calls.filter((c) => c === "act").length, 2, "the runbook stops after its second failure");
  assert.equal(d.escalations.length, 1, "one escalation per fingerprint");

  // An act that throws is a failure with its reason, not a thrown pass.
  const thrower = scripted({ actThrows: "merge refused" });
  const t = deps([thrower.runbook]);
  const threw = await runMatchingRunbook(incident(), t.deps);
  assert.equal(threw.outcome, "failed");
  assert.equal(t.receipts[0].after, "act threw: merge refused");
});

test("an incident that is not a fast burn never interrupts the operator", async () => {
  const slowBurn = incident({ kind: "http_5xx", name: "GET /v1/board", burnPerHour: FAST_BURN_PER_HOUR - 1 });
  assert.equal(isFastBurn(slowBurn, NOW), false);
  assert.equal(isFastBurn({ ...slowBurn, burnPerHour: FAST_BURN_PER_HOUR }, NOW), true);
  assert.equal(isFastBurn({ ...slowBurn, burnPerHour: FAST_BURN_PER_HOUR, lastSeenMs: NOW - 60 * 60_000 }, NOW), false, "a burn that stopped is not fast");
  assert.equal(isFastBurn(incident({ name: "dispatch-stall" }), NOW), true, "the fleet built nothing for hours");
  assert.equal(isFastBurn(incident({ name: "loop-lag" }), NOW), false);
  assert.equal(isFastBurn(incident({ kind: "exception", name: "TypeError", burnPerHour: 500 }), NOW), false, "an exception is not user-visible on its own");

  // Every non-paging path, not a fast burn: no runbook, a refused precheck, a shadow, one failure.
  const none = deps([]);
  await runMatchingRunbook(slowBurn, none.deps);
  const refused = deps([scripted({ precheck: { ok: false, observed: "dirty" } }).runbook]);
  await runMatchingRunbook(incident(), refused.deps);
  const shadow = deps([scripted({}).runbook], "shadow");
  await runMatchingRunbook(incident(), shadow.deps);
  const failedOnce = deps([scripted({ verify: [{ ok: false, observed: "still behind" }] }).runbook]);
  await runMatchingRunbook(incident(), failedOnce.deps);
  for (const d of [none, refused, shadow, failedOnce]) assert.deepEqual(d.escalations, []);

  // The contrast: the same no-runbook path on a fast burn pages the operator, once.
  const fast = deps([]);
  const burning = { ...slowBurn, burnPerHour: FAST_BURN_PER_HOUR * 2 };
  await runMatchingRunbook(burning, fast.deps);
  await runMatchingRunbook(burning, fast.deps);
  assert.equal(fast.escalations.length, 1);
  assert.ok(fast.escalations[0].summary.includes("fast burn"));
});

test("an escalation opens the needs-human issue assigned to the operator", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-escalate-"));
  const ledgerPath = join(root, "ledger.jsonl");
  writeFileSync(ledgerPath, "");
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return "[]";
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/craigoley/remudero/issues/9\n";
    return "";
  };
  const logged: string[] = [];
  const escalateToOperator = sreOperatorEscalation({ owner: "craigoley", repo: "remudero", ledgerPath, gh, log: (s) => logged.push(s), nowMs: () => NOW });

  // Drive it through the real matcher, so the escalation carries the matcher's own evidence.
  const d = deps([]);
  const url = withLiveWritesAllowed(() => {
    let opened: string | null = null;
    const e = { ...d.deps, escalate: (x: Escalation) => (opened = escalateToOperator(x)) };
    return runMatchingRunbook(incident({ name: "dispatch-stall" }), e).then(() => opened);
  });
  return url.then((opened) => {
    assert.equal(opened, "https://github.com/craigoley/remudero/issues/9");
    const create = calls.find((a) => a[0] === "issue" && a[1] === "create");
    assert.ok(create, "an issue is created");
    assert.equal(create[create.indexOf("--label") + 1], "needs-human", "on the needs-human queue");
    assert.deepEqual(
      calls.find((a) => a[0] === "issue" && a[1] === "edit"),
      ["issue", "edit", "https://github.com/craigoley/remudero/issues/9", "--repo", "craigoley/remudero", "--add-assignee", "craigoley"],
      "assigned to the operator, so GitHub emails and pushes",
    );
    const body = create[create.indexOf("--body") + 1];
    assert.ok(body.includes("dispatch-stall") && body.includes("fast burn"), "the issue carries the incident's evidence");
    assert.ok(readFileSync(ledgerPath, "utf8").includes("escalation.issue_opened"));
    assert.deepEqual(logged, []);
  });
});

test("a runbook the governor holds in shadow records its action without taking it", async () => {
  const { runbook, calls } = scripted({});
  const d = deps([runbook], "shadow");
  const result = await runMatchingRunbook(incident(), d.deps);

  assert.deepEqual(calls, ["precheck"], "shadow never acts and never verifies");
  assert.equal(result.outcome, "would_act");
  assert.equal(result.fileFeedback, true, "an unhealed incident still goes to the fleet");
  assert.equal(d.receipts.length, 1);
  assert.equal(d.receipts[0].mode, "shadow");
  assert.equal(d.receipts[0].outcome, "would_act");
  assert.equal(d.receipts[0].before, "behind=3 clean", "the receipt records what it saw and would have fixed");

  // slow holds (the runbook keeps the incident); stopped holds and hands it to the fleet.
  const slow = scripted({});
  const slowResult = await runMatchingRunbook(incident(), deps([slow.runbook], "slow").deps);
  assert.deepEqual([slowResult.outcome, slowResult.fileFeedback, slow.calls], ["held", false, ["precheck"]]);
  const stopped = scripted({});
  const stoppedResult = await runMatchingRunbook(incident(), deps([stopped.runbook], "stopped").deps);
  assert.deepEqual([stoppedResult.outcome, stoppedResult.fileFeedback, stopped.calls], ["held", true, ["precheck"]]);
});

test("the catalog's four runbooks answer their own incidents through an injected host", async () => {
  const acted: string[] = [];
  let behind = 2;
  let lockPresent = true;
  let reviewRequested = false;
  let red = [11, 12];
  const host: SreRunbookHost = {
    failedCi: async () => ({ headSha: "h1", unrelated: true, jobIds: red, observed: `red=${red.length}` }),
    rerunJob: async (job) => { acted.push(`rerun ${job}`); red = []; },
    checkout: async () => ({ clean: true, behind, borrowed: false, observed: `behind=${behind}` }),
    fastForward: async () => { acted.push("ff"); behind = 0; },
    reinstall: async () => { acted.push("npm ci"); },
    canRecycle: async (c) => ({ ok: acted.every((a) => a !== `recycle ${c}`), observed: c }),
    recycle: async (c) => { acted.push(`recycle ${c}`); },
    lock: async (p) => ({ present: lockPresent, holderDead: true, observed: p }),
    removeLock: async (p) => { acted.push(`rm ${p}`); lockPresent = false; },
    reviewRequested: async () => reviewRequested,
    requestReview: async (pr) => { acted.push(`review ${pr}`); reviewRequested = true; },
  };
  const receipts: SreRunbookReceipt[] = [];
  const catalog = sreRunbookCatalog({ host, receipts: () => receipts });
  assert.deepEqual(catalog.map((r) => r.id), ["rerun-failed-ci-once", "catch-up-managed-checkout", "recycle-stale-container", "clear-stale-lock-or-nudge"]);
  assert.ok(catalog.every((r) => r.reversible));

  const cases: Array<[string, string]> = [
    ["ci-red-unrelated", "pr=7"],
    ["stale-managed-checkout", "behind=2"],
    ["stale-container", "container=remudero-daemon"],
    ["stale-lock", "lock=/tmp/x.lock"],
    ["stale-review", "pr=8"],
  ];
  for (const [name, message] of cases) {
    const d = deps(catalog);
    d.deps.receipts = () => receipts;
    d.deps.log = (step, extra) => { if (step === SRE_RUNBOOK_STEP) receipts.push(receiptFromLedgerRow({ step, ...extra }) as SreRunbookReceipt); };
    const result = await runMatchingRunbook(incident({ fingerprint: name.padEnd(64, "0"), name, sampleMessages: [message] }), d.deps);
    assert.equal(result.outcome, "cleared", `${name} clears`);
  }
  assert.deepEqual(acted, ["rerun 11", "rerun 12", "ff", "npm ci", "recycle remudero-daemon", "rm /tmp/x.lock", "review 8"]);

  // At most once per head sha: the same PR at the same head never re-runs a second time.
  red = [13];
  const again = deps(catalog);
  again.deps.receipts = () => receipts;
  const second = await runMatchingRunbook(incident({ fingerprint: "e".repeat(64), name: "ci-red-unrelated", sampleMessages: ["pr=7"] }), again.deps);
  assert.equal(second.outcome, "precheck_refused");
  assert.ok(!acted.includes("rerun 13"));

  assert.equal(incidentSubject(incident({ sampleMessages: ["pr=1", "x pr=2"] }), "pr"), "2", "the newest sample names the subject");
  assert.equal(incidentSubject(incident({ sampleMessages: ["nothing"] }), "pr"), undefined);
});

test("receipts are read back from the ledger, and a torn row is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-receipts-"));
  const ledgerPath = join(root, "ledger.jsonl");
  writeFileSync(ledgerPath, [
    { ts: "2026-09-25T11:00:00.000Z", step: SRE_RUNBOOK_STEP, id: "a", fingerprint: FP, mode: "live", outcome: "failed", before: "b", after: "x", seen_ms: 5 },
    { ts: "2026-09-25T11:01:00.000Z", step: SRE_RUNBOOK_STEP, id: "a", fingerprint: FP, mode: "sideways", outcome: "failed" },
    { ts: "2026-09-25T11:02:00.000Z", step: "run.start", id: "a", fingerprint: FP, mode: "live", outcome: "failed" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.deepEqual(readRunbookReceipts(ledgerPath), [
    { id: "a", fingerprint: FP, mode: "live", outcome: "failed", subject: undefined, before: "b", after: "x", seen_ms: 5 },
  ]);
});
