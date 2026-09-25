// test/sre-runbooks.test.ts — W1-T4386: known failures heal themselves with a receipt.
//
// Acceptance (plan/tasks.d/W1-T4386-*.yaml):
//   - a matching runbook runs only after its precheck and records a before-and-after receipt
//   - a runbook that fails twice stops and escalates with the evidence
//   - an incident that is not a fast burn never interrupts the operator
//   - an escalation opens the needs-human issue assigned to the operator
//   - a runbook the governor holds in shadow records its action without taking it

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";
import type { Escalation } from "../src/lib/escalate.js";
import { listFeedback } from "../src/lib/feedback.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { runSreLanePass, type IncidentEvidence, type SreLaneInput } from "../src/lib/sre-lane.js";
import {
  FAST_BURN_PER_HOUR,
  SRE_RUNBOOK_STEP,
  daemonSreRunbookHost,
  daemonSreRunbookPass,
  incidentSubject,
  isFastBurn,
  readRunbookReceipts,
  receiptFromLedgerRow,
  runMatchingRunbook as runMatchingRunbookWithPorts,
  sreOperatorEscalation,
  sreRunbookCatalog,
  type RunbookObservation,
  type SreGovernorTier,
  type SreGovernorVerdict,
  type SreRunbook,
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

type RunbookHarness = {
  runbooks: readonly SreRunbook[];
  governorVerdict: (runbookId: string, incident: IncidentEvidence) => SreGovernorVerdict;
  receipts: () => SreRunbookReceipt[];
  escalate: (e: Escalation) => string | null;
  log: (step: string, extra?: Record<string, unknown>) => void;
  nowMs: () => number;
};

/** Test adapter: the production runner takes the narrow existing callbacks positionally. */
function runMatchingRunbook(incident: IncidentEvidence, harness: RunbookHarness) {
  return runMatchingRunbookWithPorts(
    incident,
    harness.runbooks,
    harness.governorVerdict,
    harness.receipts,
    harness.escalate,
    harness.log,
    harness.nowMs,
  );
}

/** Harness whose `log` feeds `receipts()` back, exactly as the ledger does in production. */
function deps(runbooks: SreRunbook[], tier: SreGovernorTier = "live"): {
  deps: RunbookHarness;
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
  const harness = deps([lane.runbook]);
  const laneLog = (step: string, extra?: Record<string, unknown>) => ledger.push({ step, ...extra });
  harness.deps.receipts = () => ledger.map((row) => receiptFromLedgerRow(row)).filter((x): x is SreRunbookReceipt => !!x);
  harness.deps.log = laneLog;
  const laneDeps: SreLaneInput = {
    stateDir: join(root, "state"),
    root,
    readEvents: () => [{ fingerprint: FP, ts: NOW - 60_000, kind: "invariant", name: "stale-managed-checkout", message: "behind=3", instance: "core" }],
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: () => [],
    mergedLastDay: () => 5,
    log: laneLog,
    runbookPass: (evidence) => runMatchingRunbook(evidence, harness.deps),
  };
  const pass = await runSreLanePass(laneDeps);
  assert.equal(pass.filed, undefined);
  assert.equal(pass.runbook?.outcome, "cleared");
  assert.equal(listFeedback(root).length, 0);
  assert.deepEqual(ledger.map((row) => row.step), [SRE_RUNBOOK_STEP]);
});

test("a throwing precheck or verifier becomes a readable failed observation", async () => {
  const precheckRunbook = {
    ...scripted({}).runbook,
    precheck: async () => { throw new Error("precheck offline"); },
  };
  const precheckHarness = deps([precheckRunbook]);
  const refused = await runMatchingRunbook(incident(), precheckHarness.deps);
  assert.equal(refused.outcome, "precheck_refused");
  assert.equal(precheckHarness.receipts[0].before, "precheck threw: precheck offline");

  const verifyRunbook = {
    ...scripted({}).runbook,
    verify: async () => { throw new Error("verify unavailable"); },
  };
  const verifyHarness = deps([verifyRunbook]);
  const failed = await runMatchingRunbook(incident(), verifyHarness.deps);
  assert.equal(failed.outcome, "failed");
  assert.equal(verifyHarness.receipts[0].after, "verify threw: verify unavailable");
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
    if (args[0] === "issue" && args[1] === "edit") throw new Error("assignment unavailable");
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
    assert.deepEqual(logged, ["sre.escalation_assign_failed"], "a delivered issue stays delivered when assignment fails");
  });
});

test("the daemon runbook pass remains in shadow until a governor is wired", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-daemon-pass-"));
  const ledgerPath = join(root, "ledger.jsonl");
  writeFileSync(ledgerPath, "");
  const { runbook, calls } = scripted({});
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = daemonSreRunbookPass([runbook], ledgerPath, "craigoley", "remudero", (step, extra) => logged.push({ step, extra }));

  const result = await pass(incident());
  assert.equal(result.outcome, "would_act");
  assert.equal(result.fileFeedback, true);
  assert.deepEqual(calls, ["precheck"], "the production daemon does not act before its governor exists");
  assert.equal(logged[0]?.extra?.reason, "no governor yet (W1-T4390): a new runbook starts in shadow");
});

test("failed escalation delivery is logged and returns null instead of escaping the daemon", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-escalation-failure-"));
  const ledgerPath = join(root, "ledger.jsonl");
  writeFileSync(ledgerPath, "");
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const escalateToOperator = sreOperatorEscalation({
    owner: "craigoley",
    repo: "remudero",
    ledgerPath,
    gh: (args) => {
      if (args[0] === "api") return "[]";
      if (args[0] === "issue" && args[1] === "create") throw new Error("GitHub unavailable");
      return "";
    },
    log: (step, extra) => logged.push({ step, extra }),
    nowMs: () => NOW,
  });
  const e = {
    taskId: "W1-T4386",
    class: "BLOCKED",
    summary: "SRE runbook failed",
    detail: "The incident remains unresolved",
    recommendation: "Inspect the failure receipt",
    consequence: "The incident stays visible to the fleet",
    options: [{ label: "inspect", detail: "Review the recorded evidence" }],
  } satisfies Escalation;

  const result = withLiveWritesAllowed(() => escalateToOperator(e));
  assert.equal(result, null);
  assert.deepEqual(logged.map((row) => row.step), ["sre.escalation_failed"]);
  assert.match(String(logged[0]?.extra?.reason), /GitHub unavailable/);
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
  const catalog = sreRunbookCatalog(host, () => receipts);
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

  const missingPr = await catalog[0]?.precheck(incident({ name: "ci-red-unrelated", sampleMessages: ["pr=0"] }));
  assert.deepEqual(missingPr, { ok: false, observed: "incident names no pr=<n>" });
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

test("an unreadable lock path is treated as unknown rather than a dead holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-unreadable-lock-"));
  const lockPath = join(root, "not-a-readable-file");
  mkdirSync(lockPath);
  const host = daemonSreRunbookHost({ root, repoDir: root, owner: "craigoley", repo: "remudero" });

  const result = await host.lock(lockPath);
  assert.equal(result.present, true);
  assert.equal(result.holderDead, false, "unreadable must not be interpreted as stale and deleted");
  assert.match(result.observed, /pid unknown/);
});

test("the real runbook host exercises bounded GitHub, checkout, and local action paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-host-"));
  const bin = join(root, "bin");
  const npmCalls = join(root, "npm-calls.log");
  const recycleArgs = join(root, "recycle-args.log");
  const state = join(root, "state");
  const inflight = join(state, "inflight");
  const lockPath = join(inflight, "stale.lock");
  const originalPath = process.env.PATH;
  const originalGhCache = process.env.RMD_GH_CACHE_HOME;

  try {
    mkdirSync(bin, { recursive: true });
    const bare = gitRepo({ bare: true, kind: "sre-host-origin" });
    const seed = gitRepo({ kind: "sre-host-seed" });
    writeFileSync(join(seed.dir, "seed.txt"), "first\n");
    mkdirSync(join(seed.dir, "deploy"), { recursive: true });
    writeFileSync(join(seed.dir, "deploy", "recycle-container.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${recycleArgs}'\n`);
    seed.git("add", "seed.txt");
    seed.git("add", "deploy/recycle-container.sh");
    seed.git("commit", "--quiet", "-m", "seed");
    seed.addRemote("origin", bare.dir);
    seed.git("push", "--quiet", "origin", "main");
    const checkout = gitRepo({ cloneFrom: bare.dir, kind: "sre-host-checkout" });
    const repoDir = checkout.dir;
    writeFileSync(join(seed.dir, "next.txt"), "second\n");
    seed.git("add", "next.txt");
    seed.git("commit", "--quiet", "-m", "advance main");
    seed.git("push", "--quiet", "origin", "main");

    mkdirSync(inflight, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, run_id: "stale-fixture" }));
    const gh = ghShim([
      {
        when: "pr view 77",
        stdout: JSON.stringify({
          headRefOid: "head-77",
          statusCheckRollup: [
            { name: "lint", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/1/job/71" },
            { name: "tests", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/1" },
          ],
        }),
      },
      {
        when: "pr view 78",
        stdout: JSON.stringify({ headRefOid: "head-78", statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS" }] }),
      },
      { when: "api", stdout: JSON.stringify([{ name: "lint", conclusion: "success" }, { name: "tests", conclusion: "success" }]) },
    ], { kind: "sre-host" });
    const npmShim = join(bin, "npm");
    writeFileSync(npmShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmCalls}'\n`);
    chmodSync(npmShim, 0o755);

    process.env.PATH = `${gh.dir}:${bin}:${originalPath ?? ""}`;
    process.env.RMD_GH_CACHE_HOME = join(root, "cache");
    const host = daemonSreRunbookHost({ root, repoDir, owner: "o", repo: "r", isInContainer: () => false });

    const failed = await host.failedCi(77);
    assert.deepEqual(failed, { headSha: "head-77", unrelated: true, jobIds: [71], observed: "red: lint, tests; green on main: true" });
    const clean = await host.failedCi(78);
    assert.deepEqual(clean, { headSha: "head-78", unrelated: false, jobIds: [], observed: "red: none; green on main: false" });
    await host.rerunJob(71);

    const beforeFastForward = await host.checkout();
    assert.deepEqual(beforeFastForward, { clean: true, behind: 1, borrowed: true, observed: "clean=true behind=1 borrowed=true" });
    await host.fastForward();
    const afterFastForward = await host.checkout();
    assert.deepEqual(afterFastForward, { clean: true, behind: 0, borrowed: true, observed: "clean=true behind=0 borrowed=true" });

    await host.reinstall();
    assert.deepEqual(await host.canRecycle("fixture-container"), { ok: true, observed: "fixture-container reported drifted" });
    await host.recycle("fixture-container");
    assert.deepEqual(readFileSync(recycleArgs, "utf8").trim().split("\n"), ["--container", "fixture-container"]);
    assert.deepEqual(await host.lock(lockPath), { present: true, holderDead: true, observed: `${lockPath} held by pid 2147483647 (dead)` });
    assert.equal(await host.reviewRequested(77), false);
    await host.requestReview(77);
    assert.equal(await host.reviewRequested(77), true);
    await host.removeLock(lockPath);
    assert.equal(existsSync(lockPath), false);

    const refusedHost = daemonSreRunbookHost({ root, repoDir, owner: "o", repo: "r", isInContainer: () => true });
    assert.deepEqual(await refusedHost.canRecycle("fixture-container"), {
      ok: false,
      observed: "recycle of fixture-container refused: this daemon runs inside a container",
    });
    const defaultHost = daemonSreRunbookHost({ root, repoDir, owner: "o", repo: "r" });
    assert.equal((await defaultHost.canRecycle("default-container")).ok, !existsSync("/.dockerenv"));

    const calls = gh.calls().join("\n");
    assert.match(calls, /pr view 77 --repo o\/r/);
    assert.match(calls, /api -X POST repos\/o\/r\/actions\/jobs\/71\/rerun/);
    assert.equal(readFileSync(npmCalls, "utf8").trim(), "ci");
  } finally {
    process.env.PATH = originalPath ?? "";
    if (originalGhCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = originalGhCache;
    rmSync(root, { recursive: true, force: true });
  }
});
