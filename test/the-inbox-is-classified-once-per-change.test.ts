// test/the-inbox-is-classified-once-per-change.test.ts — W1-T4261.
//
// MEASURED 2026-09-23 on the fleet gateway: remudero-serve pinned one CPU reclassifying 693
// proposals on every inbox read — a `git grep` spawn per proposal, a plan lint per proposal, and a
// registry-wide id set copied per proposal — so GET /v1/status timed out at 15 s on an idle host.
// These tests pin the memo that replaces that: an unchanged input set is answered from the previous
// pass, every input that classification reads invalidates it, an anchor is grepped once per main
// commit, and — the one that matters most — the memoised answer is deep-equal to the uncached one.
//
// Hermetic: temp directories for the inbox state and plan, an injected sha resolver and grep
// runner, the shared fake GitHub gateway. No git process runs here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPanelGraphRoutes,
  classifyAllProposalsMemo,
  classifyAllProposalsSliced,
  INBOX_CLASSIFY_SLICE,
  type PanelGraphDeps,
} from "../src/lib/panel-graph.js";
import {
  ANCHOR_GREP_CACHE_MAX_ENTRIES,
  cachedAnchorGrep,
  classifyProposal,
  createAnchorGrepCache,
  createFragmentMemo,
  declinedReasonInLedger,
  isRatifiedInLedger,
  ledgerProposalVerdicts,
  parseDraftCache,
  parseDraftInFlightCache,
  parseProposalRegistry,
  readOriginMainSha,
  type EvidenceAnchor,
  type InboxClassification,
} from "../src/lib/inbox.js";
import { adoptionFindingGone, adoptionLatestPath, readAdoptionLatest } from "../src/lib/measurement-cadence.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { projectPlan, readLedgerLines, type PrRef } from "../src/lib/status.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BASE_PLAN = `
- id: W1-T100
  title: "a base task that has merged"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  files: [src/lib/base-one.ts]
  acceptance:
    - claim: "base one"
      proof: "unit test: base one works"
- id: W1-T101
  title: "a base task still open"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  files: [src/lib/base-two.ts]
  acceptance:
    - claim: "base two"
      proof: "unit test: base two works"
`;

/** A lint-clean fragment filing one task that depends on `deps`. */
function fragment(taskId: string, deps: string[]): string {
  return `
- id: ${taskId}
  title: "drafted task ${taskId}"
  repo: remudero
  depends_on: [${deps.join(", ")}]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/drafted-${taskId.toLowerCase()}.ts]
  acceptance:
    - claim: "the drafted task does its thing"
      proof: "unit test: drafted ${taskId} does its thing"
`;
}

interface World {
  root: string;
  stateDir: string;
  planPath: string;
  ledgerPath: string;
  plan: Plan;
  merged: Set<string>;
  sha: { value: string | undefined };
  greps: Array<{ ref: string; anchor: EvidenceAnchor }>;
  deps: PanelGraphDeps;
}

/** Grep answer: an anchor whose pattern says "gone" has drifted; every other anchor holds. */
const grepAnswer = (anchor: EvidenceAnchor): boolean => !anchor.pattern.includes("gone");

/**
 * A realistic inbox: 48 proposals across every classification the read routes render — drafted
 * and ready, dep-unmet, draft-unclean, undrafted, drafting, trigger-deferred, drifted anchors,
 * conflicts, ratified and declined off the ledger, adoption-retired, and superseded.
 */
function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-memo-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, BASE_PLAN);
  const ledgerPath = join(stateDir, "ledger.ndjson");

  const proposals: Array<Record<string, unknown>> = [];
  const drafts: Record<string, unknown> = {};
  const inflight: Record<string, string> = {};
  const ledgerRows: Array<Record<string, unknown>> = [];
  const anchorsFor = (i: number): EvidenceAnchor[] =>
    i % 4 === 0 ? [] : [{ description: `anchor ${i % 5}`, pattern: i % 9 === 0 ? `gone${i % 5}` : `present${i % 5}`, path: `src/lib/f${i % 3}.ts` }];
  for (let i = 0; i < 40; i++) {
    const id = `P${i}`;
    const anchors = anchorsFor(i);
    const proposal: Record<string, unknown> = { id, summary: `proposal ${i}`, evidenceAnchors: anchors };
    if (i % 7 === 3) proposal.conflictsWith = [`P${i + 1}`, "P-not-in-registry"];
    if (i % 13 === 5) proposal.trigger = { description: "after the next release", fired: false };
    proposals.push(proposal);
    if (i % 6 !== 5) {
      const fragmentYaml = i % 8 === 7 ? "- id: [not yaml a task\n" : fragment(`W1-T${900 + i}`, i % 3 === 0 ? ["W1-T101"] : i % 3 === 1 ? ["W1-T100"] : []);
      const fingerprintAnchors = i % 10 === 9 ? [{ pattern: "an-older-anchor-set" }] : anchors;
      drafts[id] = {
        proposalId: id,
        fragmentYaml,
        stampLine: `- ${id} — RATIFIED`,
        anchorFingerprint: fingerprintAnchors.map((a) => `${a.pattern}::${"path" in a ? (a.path ?? "") : ""}`).sort().join("|"),
      };
    }
    if (i % 11 === 2) inflight[id] = "2026-09-23T10:00:00Z";
    if (i % 12 === 1) ledgerRows.push({ step: "ratify.approved", task_id: id });
    if (i % 10 === 4) ledgerRows.push({ step: "panel.proposal_declined", task_id: id, reason: `dup of P${i - 1}` });
  }
  // A decline that was taken back, and one that was re-entered after a restore.
  ledgerRows.push({ step: "panel.proposal_declined", task_id: "P6", reason: "first" }, { step: "panel.proposal_restored", task_id: "P6" });
  ledgerRows.push({ step: "panel.proposal_restored", task_id: "P8" }, { step: "panel.proposal_declined", task_id: "P8" });
  // Adoption proposals: the scan still reports two, no longer reports two (retired).
  for (let i = 0; i < 4; i++) proposals.push({ id: `adoption:symbol-no-caller:src/lib/a${i}.ts:sym${i}`, summary: `adoption ${i}`, evidenceAnchors: [] });
  writeFileSync(
    adoptionLatestPath(stateDir),
    JSON.stringify({ generatedAt: "2026-09-23T00:00:00Z", shapesObserved: ["symbol-no-caller"], proposalIds: ["adoption:symbol-no-caller:src/lib/a0.ts:sym0", "adoption:symbol-no-caller:src/lib/a1.ts:sym1"] }),
  );
  // A consolidated successor retires its numbered predecessors.
  proposals.push(
    { id: "proof-debt:w1-t100", summary: "consolidated", evidenceAnchors: [] },
    { id: "proof-debt:w1-t100:1", summary: "predecessor 1", evidenceAnchors: [] },
    { id: "proof-debt:w1-t100:2", summary: "predecessor 2", evidenceAnchors: [] },
    { id: "proof-debt:w1-t999:1", summary: "no successor open", evidenceAnchors: [] },
  );
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(drafts));
  writeFileSync(join(stateDir, "inbox-draft-inflight.json"), JSON.stringify(inflight));
  writeFileSync(ledgerPath, ledgerRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const merged = new Set(["W1-T100"]);
  // One merged PR per task, carrying the trailer and run branch the ownership rungs re-assert.
  const prUrl = (taskId: string) => `https://github.com/o/r/pull/${taskId.replace(/\D/g, "")}`;
  const taskOf = (url: string) => [...merged].find((id) => prUrl(id) === url);
  const statusGithub = fakeGitHub({
    findMergedByTrailer: (taskId: string): PrRef | null => (merged.has(taskId) ? { number: 7, url: prUrl(taskId), state: "MERGED" } : null),
    headRefName: (url: string) => (taskOf(url) ? `run-${taskOf(url)}-1790000000000` : undefined),
    prBody: (url: string) => (taskOf(url) ? `Remudero-Task: ${taskOf(url)}\n` : undefined),
  });
  const sha = { value: SHA_A as string | undefined };
  const greps: World["greps"] = [];
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath,
    github: { prView: () => null },
    statusGithub,
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => sha.value,
    inboxGrepAnchor: (_root, ref, anchor) => {
      greps.push({ ref, anchor });
      return grepAnswer(anchor);
    },
  };
  return { root, stateDir, planPath, ledgerPath, plan: loadPlan(planPath), merged, sha, greps, deps };
}

/** The pre-W1-T4261 classifier, verbatim in shape: every predicate rebuilt per proposal, no memo. */
function uncachedClassify(w: World, plan: Plan): InboxClassification[] {
  const read = (name: string) => readFileSync(join(w.stateDir, name), "utf8");
  const proposals = parseProposalRegistry(read("inbox-proposals.json"));
  const drafts = parseDraftCache(read("inbox-drafts.json"));
  const inflight = parseDraftInFlightCache(read("inbox-draft-inflight.json"));
  const projection = projectPlan(plan, { ledgerPath: w.ledgerPath, github: w.deps.statusGithub });
  const allIds = new Set(proposals.map((p) => p.id));
  const ledgerLines = readLedgerLines(w.ledgerPath);
  const adoptionLatest = readAdoptionLatest(adoptionLatestPath(w.stateDir));
  return proposals.map((proposal) =>
    classifyProposal(proposal, drafts[proposal.id], {
      plan,
      isMerged: (t) => projection.get(t.id)?.merged ?? false,
      depsUnobservable: (taskId) => {
        const p = projection.get(taskId);
        return p?.indeterminate ? (p.unavailableReason ?? "unknown") : undefined;
      },
      grepAnchorTrue: grepAnswer,
      openProposalIds: new Set([...allIds].filter((id) => id !== proposal.id)),
      isRatified: (id) => isRatifiedInLedger(ledgerLines, id),
      isDeclined: (id) => declinedReasonInLedger(ledgerLines, id),
      adoptionFindingGone: (id) => adoptionFindingGone(id, adoptionLatest),
      draftSpawnedAt: (id) => inflight[id],
    }),
  );
}

test("classifications are identical to the uncached path for the same inputs", async () => {
  const w = makeWorld();
  const expected = uncachedClassify(w, w.plan);
  const states = new Set(expected.map((c) => c.state));
  for (const s of ["ready", "not_ready", "drafting", "deferred_with_trigger", "ratified", "declined", "retired"]) {
    assert.ok(states.has(s as InboxClassification["state"]), `the fixture must exercise the ${s} state (saw ${[...states].join(", ")})`);
  }
  const reasons = new Set(expected.flatMap((c) => c.reasons.map((r) => r.predicate)));
  for (const r of ["drafted", "deps_merged", "lint_clean", "evidence_anchors", "no_conflict"]) {
    assert.ok(reasons.has(r as never), `the fixture must exercise the ${r} predicate (saw ${[...reasons].join(", ")})`);
  }
  assert.equal(expected.length, 48);

  const memo = classifyAllProposalsMemo(w.deps, () => w.plan);
  assert.deepStrictEqual(memo.classifications, expected, "the memoised pass");
  assert.deepStrictEqual(classifyAllProposalsMemo(w.deps, () => w.plan).classifications, expected, "the reused pass");
  const sliced = await classifyAllProposalsSliced({ ...w.deps }, () => w.plan);
  assert.deepStrictEqual(sliced.classifications, expected, "the sliced pass");
  const fromDisk = classifyAllProposalsMemo({ ...w.deps });
  assert.deepStrictEqual(fromDisk.classifications, uncachedClassify(w, loadPlan(w.planPath)), "the plan read off disk");

  // After an input change the recompute (fragment verdicts and anchor greps now warm) still matches.
  w.merged.add("W1-T101");
  appendFileSync(w.ledgerPath, JSON.stringify({ step: "panel.proposal_restored", task_id: "P4" }) + "\n");
  assert.deepStrictEqual(classifyAllProposalsMemo(w.deps, () => w.plan).classifications, uncachedClassify(w, w.plan), "the recompute after a change");
});

test("an unchanged input fingerprint reuses the previous classification without recomputing", async () => {
  const w = makeWorld();
  const first = classifyAllProposalsMemo(w.deps, () => w.plan);
  const grepsAfterFirst = w.greps.length;
  assert.ok(grepsAfterFirst > 0, "the first pass must actually grep, or reuse below proves nothing");

  const second = classifyAllProposalsMemo(w.deps, () => w.plan);
  assert.equal(second.classifications, first.classifications, "the SAME classification array — nothing was recomputed");
  assert.equal(w.greps.length, grepsAfterFirst, "no grep ran on the reused pass");

  // An unrelated ledger row moves the ledger's stamp but not what classification reads from it.
  appendFileSync(w.ledgerPath, JSON.stringify({ step: "daemon.poll", task_id: "W1-T100" }) + "\n");
  const third = classifyAllProposalsMemo(w.deps, () => w.plan);
  assert.equal(third.classifications, first.classifications, "an unrelated ledger row reuses the classification");
  assert.equal(third.ledgerLines.length, first.ledgerLines.length + 1, "while the ledger rows handed back are this pass's");

  const sliced = await classifyAllProposalsSliced(w.deps, () => w.plan);
  assert.equal(sliced.classifications, first.classifications, "the sliced path reuses the same memo entry");

  // An unresolvable main commit can never vouch for an unchanged grep, so it always recomputes.
  w.sha.value = undefined;
  const a = classifyAllProposalsMemo(w.deps, () => w.plan);
  const b = classifyAllProposalsMemo(w.deps, () => w.plan);
  assert.notEqual(b.classifications, a.classifications);
  assert.ok(w.greps.slice(grepsAfterFirst).every((g) => g.ref === "origin/main"), "with no sha the grep runs against origin/main, uncached");
});

test("any changed input invalidates the classification", () => {
  const w = makeWorld();
  let plan = w.plan;
  let previous = classifyAllProposalsMemo(w.deps, () => plan);
  const stateOf = (r: typeof previous, id: string) => r.classifications.find((c) => c.proposalId === id);
  const changes: Array<[string, () => void, (r: typeof previous) => void]> = [
    [
      "the registry",
      () => {
        const path = join(w.stateDir, "inbox-proposals.json");
        const reg = JSON.parse(readFileSync(path, "utf8"));
        reg.proposals.push({ id: "P-new", summary: "new", evidenceAnchors: [] });
        writeFileSync(path, JSON.stringify(reg));
      },
      (r) => assert.equal(stateOf(r, "P-new")?.state, "not_ready"),
    ],
    [
      "the drafts",
      () => {
        const path = join(w.stateDir, "inbox-drafts.json");
        const drafts = JSON.parse(readFileSync(path, "utf8"));
        drafts["P-new"] = { proposalId: "P-new", fragmentYaml: fragment("W1-T990", []), stampLine: "- P-new", anchorFingerprint: "" };
        writeFileSync(path, JSON.stringify(drafts));
      },
      (r) => assert.equal(stateOf(r, "P-new")?.state, "ready"),
    ],
    [
      "the in-flight drafts",
      () => writeFileSync(join(w.stateDir, "inbox-draft-inflight.json"), JSON.stringify({ "P-new": "2026-09-23T11:00:00Z" })),
      (r) => assert.equal(stateOf(r, "P-new")?.state, "drafting"),
    ],
    [
      "the adoption scan",
      () =>
        writeFileSync(
          adoptionLatestPath(w.stateDir),
          JSON.stringify({ generatedAt: "2026-09-23T01:00:00Z", shapesObserved: ["symbol-no-caller"], proposalIds: [] }),
        ),
      (r) => assert.equal(stateOf(r, "adoption:symbol-no-caller:src/lib/a0.ts:sym0")?.state, "retired"),
    ],
    [
      "a ledger decline",
      () => appendFileSync(w.ledgerPath, JSON.stringify({ step: "panel.proposal_declined", task_id: "P-new", reason: "no" }) + "\n"),
      (r) => assert.equal(stateOf(r, "P-new")?.state, "declined"),
    ],
    [
      "a ledger ratification",
      () => appendFileSync(w.ledgerPath, JSON.stringify({ step: "ratify.approved", task_id: "P0" }) + "\n"),
      (r) => assert.equal(stateOf(r, "P0")?.state, "ratified"),
    ],
    [
      "a dependency merging on GitHub",
      () => w.merged.add("W1-T101"),
      (r) => assert.ok(!stateOf(r, "P3")?.reasons.some((x) => x.predicate === "deps_merged"), "P3's dependency is merged now"),
    ],
    [
      "the plan snapshot",
      () => {
        plan = loadPlan(w.planPath);
      },
      () => undefined,
    ],
    [
      "the main commit",
      () => {
        w.sha.value = SHA_B;
      },
      () => undefined,
    ],
  ];
  for (const [what, change, check] of changes) {
    change();
    const next = classifyAllProposalsMemo(w.deps, () => plan);
    assert.notEqual(next.classifications, previous.classifications, `changing ${what} must recompute`);
    check(next);
    assert.deepStrictEqual(next.classifications, uncachedClassify(w, plan), `the recompute after changing ${what} is the uncached answer`);
    previous = next;
  }
});

test("any changed input invalidates the classification — including the plan files when no snapshot is supplied", () => {
  const w = makeWorld();
  const first = classifyAllProposalsMemo(w.deps);
  assert.equal(classifyAllProposalsMemo(w.deps).classifications, first.classifications, "an unchanged tasks.yaml reuses");
  mkdirSync(join(w.root, "plan", "tasks.d"));
  writeFileSync(join(w.root, "plan", "tasks.d", "W1-T102.yaml"), BASE_PLAN.replaceAll("W1-T100", "W1-T102").split("- id: W1-T101")[0]);
  const second = classifyAllProposalsMemo(w.deps);
  assert.notEqual(second.classifications, first.classifications, "a new shard recomputes");
  assert.equal(classifyAllProposalsMemo(w.deps).classifications, second.classifications, "an unchanged shard dir reuses");
});

test("an unstattable input is stamped as unreadable rather than failing the pass", () => {
  const w = makeWorld();
  // A NUL byte makes every fs call on the path throw; the readers already treat that as absent.
  const deps: PanelGraphDeps = { ...w.deps, inboxRoot: `${w.root}\u0000` };
  const first = classifyAllProposalsMemo(deps, () => w.plan);
  assert.deepStrictEqual(first.proposals, []);
  assert.equal(classifyAllProposalsMemo(deps, () => w.plan).classifications, first.classifications);
});

test("an anchor grep runs once per main commit", () => {
  const w = makeWorld();
  classifyAllProposalsMemo(w.deps, () => w.plan);
  const keyOf = (a: EvidenceAnchor) => `${a.pattern}::${a.path}`;
  const onA = w.greps.map((g) => keyOf(g.anchor));
  assert.ok(onA.length > 0);
  assert.equal(new Set(onA).size, onA.length, "each distinct anchor grepped exactly once on commit A");
  assert.ok(w.greps.every((g) => g.ref === SHA_A), "grepped at the commit the pass was keyed on");

  // A registry change recomputes the classification on the same commit — every anchor is a cache hit.
  appendFileSync(join(w.stateDir, "inbox-draft-inflight.json"), " ");
  classifyAllProposalsMemo(w.deps, () => w.plan);
  assert.equal(w.greps.length, onA.length, "no anchor re-grepped on the same commit");

  w.sha.value = SHA_B;
  classifyAllProposalsMemo(w.deps, () => w.plan);
  const onB = w.greps.slice(onA.length);
  assert.deepStrictEqual(onB.map((g) => keyOf(g.anchor)).sort(), [...onA].sort(), "a new commit re-greps each anchor once");
  assert.ok(onB.every((g) => g.ref === SHA_B));
});

test("an anchor grep runs once per main commit — the cache's own edges", () => {
  const cache = createAnchorGrepCache();
  const anchor: EvidenceAnchor = { description: "d", pattern: "p" };
  let calls = 0;
  const grep = () => {
    calls++;
    return true;
  };
  assert.equal(cachedAnchorGrep(cache, SHA_A, anchor, grep), true);
  assert.equal(cachedAnchorGrep(cache, SHA_A, { ...anchor, description: "renamed" }, grep), true);
  assert.equal(calls, 1, "the description is not part of what git greps");

  // A throwing grep is never cached: the next call runs it again and sees the same error.
  const failing = () => {
    throw new Error("git grep exploded");
  };
  const other: EvidenceAnchor = { description: "o", pattern: "o", path: "x.ts" };
  assert.throws(() => cachedAnchorGrep(cache, SHA_A, other, failing), /exploded/);
  assert.throws(() => cachedAnchorGrep(cache, SHA_A, other, failing), /exploded/);

  // BACKSTOP: a full map is emptied rather than grown.
  for (let i = cache.results.size; i < ANCHOR_GREP_CACHE_MAX_ENTRIES; i++) cache.results.set(`k${i}`, true);
  cachedAnchorGrep(cache, SHA_A, { description: "n", pattern: "new" }, grep);
  assert.equal(cache.results.size, 1);
});

test("an unchanged input fingerprint reuses the previous classification without recomputing — a sliced refresh yields and is shared", async () => {
  const w = makeWorld();
  let yields = 0;
  const yieldNow = async () => {
    yields++;
  };
  const [a, b] = await Promise.all([classifyAllProposalsSliced(w.deps, () => w.plan, yieldNow), classifyAllProposalsSliced(w.deps, () => w.plan, yieldNow)]);
  assert.equal(a, b, "a second caller over the same inputs awaits the running refresh");
  assert.equal(yields, Math.ceil(48 / INBOX_CLASSIFY_SLICE) - 1, "one yield between each slice");
  assert.deepStrictEqual(a.classifications, uncachedClassify(w, w.plan));
  assert.equal(classifyAllProposalsMemo(w.deps, () => w.plan).classifications, a.classifications, "the sliced result is the memo entry");
});

test("GET /v1/inbox classifies through the memo", async () => {
  const w = makeWorld();
  const stamped: string[] = [];
  const deps: PanelGraphDeps = {
    ...w.deps,
    inboxStatFile: (path) => (stamped.push(path), `${readFileSync(path, "utf8").length}`),
  };
  const route = buildPanelGraphRoutes(deps, () => w.plan).find((r) => r.method === "GET" && r.path === "/v1/inbox");
  assert.ok(route);
  const bodies: string[] = [];
  const res = { writeHead: () => undefined, end: (body: string) => bodies.push(body) };
  await route.handler({ url: "/v1/inbox", headers: {} } as never, res as never, { params: {} });
  assert.ok(stamped.includes(join(w.stateDir, "inbox-proposals.json")), "the route stamped its inputs — it went through the memo");
  const entry = classifyAllProposalsMemo(deps, () => w.plan);
  await route.handler({ url: "/v1/inbox", headers: {} } as never, res as never, { params: {} });
  assert.equal(classifyAllProposalsMemo(deps, () => w.plan).classifications, entry.classifications, "the second read reused the memo entry");
  assert.equal(bodies[0], bodies[1]);
  const expected = uncachedClassify(w, w.plan);
  assert.equal(JSON.parse(bodies[0]).declined.length, expected.filter((c) => c.state === "declined").length);
});

test("ledgerProposalVerdicts answers what isRatifiedInLedger and declinedReasonInLedger answer", () => {
  const rows = [
    { step: "ratify.approved", task_id: "A" },
    { step: "panel.proposal_declined", task_id: "B", reason: "dup" },
    { step: "panel.proposal_declined", task_id: "C" },
    { step: "panel.proposal_restored", task_id: "C" },
    { step: "panel.proposal_restored", task_id: "D" },
    { step: "panel.proposal_declined", task_id: "D", reason: 7 },
    { step: "ratify.approved", task_id: 3 },
    { step: "panel.proposal_declined" },
  ];
  const v = ledgerProposalVerdicts(rows);
  for (const id of ["A", "B", "C", "D", "E", "3"]) {
    assert.equal(v.isRatified(id), isRatifiedInLedger(rows, id), `ratified ${id}`);
    assert.equal(v.isDeclined(id), declinedReasonInLedger(rows, id), `declined ${id}`);
  }
});

test("a fragment verdict is reused only against the same plan object", () => {
  const w = makeWorld();
  const memo = createFragmentMemo();
  const proposal = { id: "P1", summary: "s", evidenceAnchors: [] };
  const draft = { proposalId: "P1", fragmentYaml: fragment("W1-T950", ["W1-T100"]), stampLine: "- P1", anchorFingerprint: "" };
  const ctx = {
    plan: w.plan,
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set<string>(),
    isRatified: () => false,
    fragmentMemo: memo,
  };
  const first = classifyProposal(proposal, draft, ctx);
  assert.equal(memo.current.size, 1);
  const other = loadPlan(w.planPath);
  const second = classifyProposal(proposal, draft, { ...ctx, plan: other });
  assert.equal(memo.plan, other, "a different plan object resets the memo");
  assert.deepStrictEqual(second, first);
});

test("readOriginMainSha reads the loose ref, packed-refs, and a linked checkout's common dir", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-inbox-sha-"));
  const loose = join(base, "loose");
  mkdirSync(join(loose, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(loose, ".git", "refs", "remotes", "origin", "main"), `${SHA_A}\n`);
  assert.equal(readOriginMainSha(loose), SHA_A);

  const packed = join(base, "packed");
  mkdirSync(join(packed, ".git"), { recursive: true });
  writeFileSync(join(packed, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/remotes/origin/feature\n${SHA_A} refs/remotes/origin/main\n`);
  assert.equal(readOriginMainSha(packed), SHA_A);

  const linked = join(base, "linked");
  mkdirSync(join(loose, ".git", "worktrees", "linked"), { recursive: true });
  writeFileSync(join(loose, ".git", "worktrees", "linked", "commondir"), "../..\n");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(loose, ".git", "worktrees", "linked")}\n`);
  assert.equal(readOriginMainSha(linked), SHA_A);

  const symbolic = join(base, "symbolic");
  mkdirSync(join(symbolic, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(symbolic, ".git", "refs", "remotes", "origin", "main"), "ref: refs/remotes/origin/trunk\n");
  assert.equal(readOriginMainSha(symbolic), undefined, "a layout this does not recognise resolves nothing");
  assert.equal(readOriginMainSha(join(base, "absent")), undefined);
});

test("with no sha seam the memo keys on the ref files it reads", () => {
  const w = makeWorld();
  mkdirSync(join(w.root, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(w.root, ".git", "refs", "remotes", "origin", "main"), `${SHA_A}\n`);
  const deps: PanelGraphDeps = { ...w.deps, inboxMainSha: undefined, inboxStatFile: undefined, inboxListDir: undefined };
  const first = classifyAllProposalsMemo(deps, () => w.plan);
  assert.equal(classifyAllProposalsMemo(deps, () => w.plan).classifications, first.classifications);
  writeFileSync(join(w.root, ".git", "refs", "remotes", "origin", "main"), `${SHA_B}\n`);
  assert.notEqual(classifyAllProposalsMemo(deps, () => w.plan).classifications, first.classifications);
  assert.equal(w.greps.at(-1)?.ref, SHA_B);
});
