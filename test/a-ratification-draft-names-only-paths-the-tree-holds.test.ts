import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorFingerprint, beginFragmentPass, blockingLintMessages, checkoutRepoFacts, classifyProposal, createFragmentMemo, inboxDraftPrompt,
  lintDraftedFragment, parseDraftedCandidate, runDraftRung, MAX_DRAFT_LINT_ATTEMPTS,
  type DraftedCandidate, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import { loadPlan, loadPlanFromYaml } from "../src/lib/plan.js";
import { approveCommand } from "../src/run-task.js";
import { repoRoot } from "../src/lib/repo-location.js";
import { ledgerPathFor } from "../src/lib/ledger-path.js";
import { ghShim } from "./helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const parkedYaml = `- id: W1-T1041
  title: release the existing shard
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: medium
  status: queued
  files: [src/lib/plan.ts]
  acceptance:
    - claim: the shard implements the operator direction
      proof: "unit test: the shard implements the operator direction"
`;
const plan = loadPlanFromYaml(parkedYaml, "fixture");
const proposal: Proposal = { id: "machine-judge:W1-T1041", summary: "release the shard", evidenceAnchors: [] };
const fragment = `- id: NEW-1
  title: check declared paths
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/plan.ts]
  acceptance:
    - claim: the declared path guard refuses missing paths
      proof: "unit test: the declared path guard refuses missing paths"
`;
const draft = (fragmentYaml = fragment): DraftedCandidate => ({ proposalId: proposal.id, fragmentYaml,
  stampLine: "check declared paths", anchorFingerprint: anchorFingerprint([]) });
const facts = { moduleExists: (path: string) => ["src", "test", "src/lib/plan.ts"].includes(path),
  readGrepProofFile: () => undefined, pathExistsAtBase: () => false };
const context = (): ReadinessContext => ({ plan, isMerged: () => false, grepAnchorTrue: () => true,
  openProposalIds: new Set(), isRatified: () => false, draftRepoFacts: facts });

const worker = (text: string) => ({ text, blocks: [], costUsd: 0, sessionId: "fixture", subtype: "success",
  stderr: "", childEnvKeys: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }) as never;

test("W1-T9062: a draft naming a src file the tree does not hold is not READY", async () => {
  const missing = fragment.replace("files: [src/lib/plan.ts]", "files: [src/lib/plan.ts, src/lib/fixWorker.ts]");
  const floor = lintDraftedFragment(missing, proposal.id, undefined, undefined, facts.moduleExists, facts.readGrepProofFile);
  assert.ok(floor.some((v) => v.check === "draft-path-missing" && v.message.includes("src/lib/fixWorker.ts")));
  const classified = classifyProposal(proposal, draft(missing), context());
  assert.equal(classified.state, "not_ready");
  assert.ok(classified.reasons.some((r) => r.detail.includes("[draft-path-missing]")));
  assert.equal(classifyProposal(proposal, draft(), context()).state, "ready", "existing path control");
  const messages: string[] = [];
  const [outcome] = await runDraftRung([proposal], parkedYaml, {
    spawn: async (_p, prompt) => { messages.push(prompt); return worker(`=== FRAGMENT START ===\n${missing.trim()}\n=== FRAGMENT END ===\nSTAMP: check paths`); }, log: () => {},
  }, "fixture");
  assert.equal(messages.length, MAX_DRAFT_LINT_ATTEMPTS);
  assert.ok(messages[1].includes("draft-path-missing"));
  assert.ok(outcome.ok);
  assert.equal(classifyProposal(proposal, outcome.candidate, context()).state, "not_ready");
  let exists = true;
  const memoContext = { ...context(), fragmentMemo: createFragmentMemo(),
    draftRepoFacts: { ...facts, moduleExists: () => exists } };
  assert.equal(classifyProposal(proposal, draft(), memoContext).state, "ready");
  exists = false;
  beginFragmentPass(memoContext.fragmentMemo);
  assert.equal(classifyProposal(proposal, draft(), memoContext).state, "not_ready", "path facts are refreshed even when the fragment is memoized");
});

test("W1-T9062: a slug-named new test and a CREATES path keep a draft READY", () => {
  const allowed = fragment.replace("files: [src/lib/plan.ts]", "files: [src/lib/plan.ts, test/plan/check-declared-paths.test.ts, src/lib/new-path.ts]\n  design: |\n    CREATES: src/lib/new-path.ts");
  const withCaller = allowed.replace("risk: medium", "risk: high\n  band_meaning: span") + '    - claim: the existing caller reaches the new module\n      proof: "grep: newPath( in src/lib/plan.ts"\n';
  const classified = classifyProposal(proposal, draft(withCaller), context());
  assert.equal(classified.state, "ready", JSON.stringify(classified.reasons));
  assert.deepEqual(lintDraftedFragment(withCaller, proposal.id, undefined, undefined, facts.moduleExists, facts.readGrepProofFile), []);
  assert.deepEqual(lintDraftedFragment(withCaller, proposal.id, undefined, undefined, facts.moduleExists,
    facts.readGrepProofFile, () => false, () => { throw new Error("allowed new paths need no base lookup"); }), []);
  const newDirectory = withCaller.replaceAll("src/lib/new-path.ts", "new-directory/new-path.ts");
  assert.deepEqual(lintDraftedFragment(newDirectory, proposal.id, undefined, undefined, facts.moduleExists, facts.readGrepProofFile), []);
  const noCaller = classifyProposal(proposal, draft(withCaller.replace("newPath( in src/lib/plan.ts", "newPath( in src/lib/new-path.ts")), context());
  assert.equal(noCaller.state, "not_ready", "a CREATES path cannot supply its own call site");
  assert.ok(noCaller.reasons.some((r) => r.detail.includes("call-site")));
  for (const dirty of [withCaller.replace("test/plan/check-declared-paths.test.ts", "test/plan/unrelated.test.ts"),
    withCaller.replace("CREATES: src/lib/new-path.ts", "create src/lib/new-path.ts")]) {
    const refused = classifyProposal(proposal, draft(dirty), context());
    assert.equal(refused.state, "not_ready");
    assert.ok(refused.reasons.some((r) => r.detail.includes("draft-path-missing")));
  }
  const baseOnly = { ...facts, pathExistsAtBase: (p: string) => p === "docs/base-only.md" };
  const parsed = loadPlanFromYaml(fragment.replace("files: [src/lib/plan.ts]", "files: [src/lib/plan.ts, docs/base-only.md]")
    .replace("risk: medium", "risk: high\n  band_meaning: span"), "fragment");
  assert.deepEqual(blockingLintMessages(plan, parsed, undefined, baseOnly), []);
});

test("W1-T9062: a checkout without git metadata still refuses missing draft paths", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9062-paths-`));
  try {
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(join(root, "src/lib/plan.ts"), "");
    const checkout = checkoutRepoFacts(root);
    assert.equal(checkout.moduleExists("src/lib/plan.ts"), true);
    assert.equal(checkout.pathExistsAtBase!("src/lib/fixWorker.ts"), false);
    const lint = (yaml: string) => lintDraftedFragment(yaml, proposal.id, undefined, undefined,
      checkout.moduleExists, checkout.readGrepProofFile, checkout.pathIsDirectory, checkout.pathExistsAtBase);
    assert.deepEqual(lint(fragment), []);
    const missing = fragment.replace("src/lib/plan.ts]", "src/lib/plan.ts, src/lib/fixWorker.ts]")
      .replace("risk: medium", "risk: high\n  band_meaning: span") +
      '    - claim: the existing caller reaches the new module\n      proof: "grep: fixWorker( in src/lib/plan.ts"\n';
    const violations = lint(missing);
    assert.deepEqual(violations.map((v) => v.check), ["draft-path-missing"]);
    assert.match(violations[0].message, /src\/lib\/fixWorker\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9062: a parked-task proposal prompt shows the shard files and offers the release", () => {
  for (const kind of ["machine-judge", "verify-human", "verify-human-automate"]) {
    const prompt = inboxDraftPrompt({ ...proposal, id: `${kind}:W1-T1041`, reframeHistory: [{ feedback: "keep the existing design" }] }, parkedYaml, "fixture");
    assert.ok(prompt.includes("files:"));
    assert.ok(prompt.includes("src/lib/plan.ts"));
    assert.ok(prompt.includes("the shard implements the operator direction"));
    assert.ok(prompt.includes("RELEASE: W1-T1041"));
    assert.ok(prompt.includes("Glob"));
    assert.ok(prompt.includes("CREATES:"));
    assert.ok(prompt.includes("fail on main"));
    assert.ok(prompt.includes("every reframe round"));
  }
});

test("W1-T9062: a release draft of a parked shard files no new task and approve releases it", async (t) => {
  const shim = ghShim([{ when: "api", stdout: "[]" }]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const parsed = parseDraftedCandidate("RELEASE: W1-T1041", proposal, parkedYaml);
  assert.ok(parsed);
  assert.equal(parsed.fragmentYaml, "");
  assert.equal(parsed.releaseTaskId, "W1-T1041");
  const candidate = { ...draft(""), ...parsed };
  const classified = classifyProposal(proposal, candidate, context());
  assert.equal(classified.state, "ready");
  assert.equal(classified.releaseTaskId, "W1-T1041");
  assert.equal(classified.draft, undefined);
  const [rung] = await runDraftRung([proposal], parkedYaml, {
    spawn: async () => worker("RELEASE: W1-T1041"),
    log: () => {},
  }, "fixture");
  assert.ok(rung.ok, JSON.stringify(rung));
  assert.equal(rung.candidate.releaseTaskId, "W1-T1041");
  assert.equal(parseDraftedCandidate("RELEASE: W1-T9999", proposal, parkedYaml), null);
  assert.equal(parseDraftedCandidate("RELEASE: W1-T1041", { ...proposal, id: "P1" }, parkedYaml), null);
  assert.equal(parseDraftedCandidate("RELEASE: W1-T1041", proposal, parkedYaml.replace("verify: human", "verify: auto")), null);
  assert.equal(parseDraftedCandidate("RELEASE: W1-T1041\nRELEASE: W1-T1041", proposal, parkedYaml), null);
  assert.equal(parseDraftedCandidate("RELEASE: W1-T1041\n=== FRAGMENT START ===", proposal, parkedYaml), null);
  assert.equal(parseDraftedCandidate("RELEASE: W1-T1041", proposal, parkedYaml + "  dispatch_hold: true\n"), null);
  assert.equal(classifyProposal(proposal, { ...candidate, releaseTaskId: "W1-T9999" }, context()).state, "not_ready");
  assert.equal(classifyProposal({ ...proposal, conflictsWith: ["P1"] }, candidate,
    { ...context(), openProposalIds: new Set(["P1"]) }).state, "not_ready");
  assert.equal(classifyProposal(proposal, { ...candidate, anchorFingerprint: "stale" }, context()).state, "not_ready");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9062-`));
  try {
    mkdirSync(join(root, "plan")); mkdirSync(join(root, "state"));
    writeFileSync(join(root, "plan/tasks.yaml"), parkedYaml);
    writeFileSync(join(root, "state/inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
    writeFileSync(join(root, "state/inbox-drafts.json"), JSON.stringify({ [proposal.id]: candidate }));
    const config = { root } as never;
    assert.equal(await approveCommand([proposal.id], { config, planPath: join(root, "plan/tasks.yaml") }), 0);
    const rows = readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.task_id === "W1-T1041" && r.released === "verify-human"));
    assert.ok(rows.some((r) => r.task_id === proposal.id && r.step === "ratify.approved"));
    assert.deepEqual(readdirSync(join(root, "plan")), ["tasks.yaml"]);
    assert.equal(await approveCommand([proposal.id], { config, planPath: join(root, "plan/tasks.yaml") }), 1);
    const again = readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(again.filter((r) => r.task_id === "W1-T1041" && r.released === "verify-human").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9062: approve of a parked task id reads the plan from the repo root", async () => {
  const current = loadPlan(join(repoRoot, "plan/tasks.yaml"));
  const task = current.tasks.find((t) => t.verify === "human" && t.status === "queued" && !t.dispatch_hold);
  assert.ok(task, "the repo holds a parked task as the positive control");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9062-state-`));
  try {
    mkdirSync(join(root, "state"));
    const config = { root } as never;
    assert.equal(await approveCommand([task.id], { config }), 0);
    const rows = readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.task_id === task.id && r.released === "verify-human"));
    assert.equal(checkoutRepoFacts(repoRoot).moduleExists("src/lib/plan.ts"), true);
    assert.equal(checkoutRepoFacts(repoRoot).pathExistsAtBase!("src/lib/plan.ts"), true);
    assert.equal(checkoutRepoFacts(repoRoot).pathExistsAtBase!("src/lib/fixWorker.ts"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
