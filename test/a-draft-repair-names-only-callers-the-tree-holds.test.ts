/**
 * test/a-draft-repair-names-only-callers-the-tree-holds.test.ts — W1-T9307.
 *
 * OBSERVED 2026-10-13: the standing-debt:5 redraft was a docs-only recon task that declared src/app.ts and
 * `grep: checkOwnership( in src/app.ts`; neither exists. The repair loop's remedies ("Add a criterion ... in <the src
 * file that calls it>", "Add <path> to files:") told a drafter that cannot see the tree to name a caller and add it,
 * and the stamp read "Added src/app.ts to files to satisfy proof scope". A caller the tree does not hold is not a call
 * site, and the remedies now offer real paths or a drop, never an invention.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  inboxDraftRelintPrompt,
  lintDraftedFragment,
  runDraftRung,
  type DraftRepoFacts,
  type Proposal,
} from "#src/lib/inbox.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { callSiteCandidates } from "#src/lib/relint.js";
import { callSiteViolations, proofScopeViolations } from "#src/lib/task-linter.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const KNOWN = new Set(["remudero", "none"]);
const PROPOSAL_ID = "standing-debt:5";

// A fixture checkout: an existing module, one real caller of its symbol, and a test.
const repo = gitRepo({ kind: "w1-t9307", seedCommit: false });
const ROOT = repo.dir;
mkdirSync(join(ROOT, "src", "lib"), { recursive: true });
mkdirSync(join(ROOT, "test"), { recursive: true });
writeFileSync(join(ROOT, "src", "lib", "ledger.ts"), "export function rowActorOf(row: unknown): string {\n  return String(row);\n}\n");
writeFileSync(join(ROOT, "src", "lib", "panel.ts"), "import { rowActorOf } from './ledger.js';\nrowActorOf(1);\n");
writeFileSync(join(ROOT, "test", "ledger.test.ts"), "// fixture\n");
repo.git("add", "-A");
after(() => repo.cleanup());

const exists = (path: string): boolean => existsSync(join(ROOT, path));
const facts: DraftRepoFacts = {
  moduleExists: exists,
  readGrepProofFile: (path) => (exists(path) ? readFileSync(join(ROOT, path), "utf8") : undefined),
};

function draft(files: string[], proofs: string[], design?: string): string {
  return [
    "- id: NEW-1",
    '  title: "Record who owns the assertion blocker"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  status: queued",
    "  attempts: 0",
    ...(design ? ["  design: |", `    ${design}`] : []),
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    ...proofs.flatMap((p, i) => [`    - claim: ${JSON.stringify(`claim ${i}`)}`, `      proof: ${JSON.stringify(p)}`]),
    '  origin: "architect"',
    "",
  ].join("\n");
}

const lint = (yaml: string) => lintDraftedFragment(yaml, PROPOSAL_ID, undefined, KNOWN, facts.moduleExists, facts.readGrepProofFile);
const absentChecks = (yaml: string) => lint(yaml).filter((v) => v.check === "draft-call-site-absent");

test("W1-T9307: a call-site proof naming a path the tree does not hold blocks the draft", () => {
  const ghost = draft(["src/lib/ledger.ts", "test/ledger.test.ts"], ["unit test: the actor is named", "grep: checkOwnership( in src/app.ts"]);
  const found = absentChecks(ghost);
  assert.equal(found.length, 1, JSON.stringify(lint(ghost)));
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /src\/app\.ts/);
  assert.match(found[0].message, /never invent a caller file/);

  // Control: the same proof against a caller the tree DOES hold is not this check's business.
  const held = draft(["src/lib/ledger.ts", "test/ledger.test.ts"], ["unit test: the actor is named", "grep: rowActorOf( in src/lib/panel.ts"]);
  assert.deepEqual(absentChecks(held), []);

  // The plan-wide rule agrees: an absent caller satisfies nothing, a held one does.
  const [task] = parseTasksFromYaml(draft(["src/lib/newmod.ts"], ["grep: newThing( in src/app.ts"]), "fixture");
  assert.equal(callSiteViolations(task, { moduleExists: exists }).length, 1, "an absent caller is not a call site");
  const [heldTask] = parseTasksFromYaml(draft(["src/lib/newmod.ts"], ["grep: newThing( in src/lib/panel.ts"]), "fixture");
  assert.deepEqual(callSiteViolations(heldTask, { moduleExists: exists }), [], "a caller the tree holds still counts");
});

test("W1-T9307: a CREATES-declared path is never a call site", () => {
  const created = draft(
    ["src/lib/ledger.ts", "src/lib/caller.ts", "test/ledger.test.ts"],
    ["unit test: the actor is named", "grep: rowActorOf( in src/lib/caller.ts"],
    "CREATES: src/lib/caller.ts",
  );
  const violations = lint(created);
  assert.ok(!violations.some((v) => v.check === "draft-path-missing"), "precondition: CREATES exempts the path floor");
  const found = violations.filter((v) => v.check === "draft-call-site-absent");
  assert.equal(found.length, 1, JSON.stringify(violations));
  assert.match(found[0].message, /declared on a CREATES: line/);

  // Even a CREATES line naming a path that already exists does not make it evidence of a call.
  const existing = draft(["src/lib/ledger.ts", "test/ledger.test.ts"],
    ["unit test: the actor is named", "grep: rowActorOf( in src/lib/panel.ts"], "CREATES: src/lib/panel.ts");
  assert.equal(absentChecks(existing).length, 1);
});

test("W1-T9307: the call-site relint lists real callers from the tree and says drop the claim when there are none", () => {
  const proposal: Proposal = { id: PROPOSAL_ID, summary: "own the blocker", evidenceAnchors: [] };
  const violation = (message: string) => ({ check: "call-site", severity: "block" as const, message });

  assert.deepEqual(callSiteCandidates(ROOT, "rowActorOf", { exclude: "src/lib/ledger.ts" }), ["src/lib/panel.ts"]);
  assert.deepEqual(callSiteCandidates(ROOT, "noSuchSymbolAnywhere", {}), []);

  // An added export: the prompt names the file that already calls the symbol.
  const withCaller = inboxDraftRelintPrompt(proposal, draft(["src/lib/ledger.ts"], []), [
    violation("task NEW-1 adds new exported value rowActorOf in src/lib/ledger.ts but no acceptance criterion proves a CALL SITE"),
  ], ROOT);
  assert.match(withCaller, /Existing src files that already call rowActorOf\( .*src\/lib\/panel\.ts/);

  // No caller anywhere: the prompt says drop the claim and never offers a path.
  const none = inboxDraftRelintPrompt(proposal, draft(["src/lib/ledger.ts"], []), [
    violation("task NEW-1 adds new exported value brandNewThing in src/lib/ledger.ts but no acceptance criterion proves a CALL SITE"),
  ], ROOT);
  assert.match(none, /No existing src file calls brandNewThing\( — remove the claim/);
  assert.match(none, /do NOT invent a caller file/);

  // A new module: only declared files the tree holds are offered; with none, the claim is dropped.
  const newModule = violation("task NEW-1 adds new module src/lib/newmod.ts but no acceptance criterion proves a CALL SITE");
  const offered = inboxDraftRelintPrompt(proposal, draft(["src/lib/newmod.ts", "src/lib/panel.ts"], []), [newModule], ROOT);
  assert.match(offered, /may name as the caller of src\/lib\/newmod\.ts: src\/lib\/panel\.ts/);
  const dropped = inboxDraftRelintPrompt(proposal, draft(["src/lib/newmod.ts"], []), [newModule], ROOT);
  assert.match(dropped, /drop the call-site claim/);
  assert.doesNotMatch(dropped, /may name as the caller/);
});

test("W1-T9307: a proof-scope remedy for an absent path never says add it to files", () => {
  const [task] = parseTasksFromYaml(draft(["src/lib/ledger.ts"], ["grep: checkOwnership( in src/app.ts"]), "fixture");
  const [absent] = proofScopeViolations(task, { moduleExists: exists });
  assert.equal(absent.severity, "block");
  assert.doesNotMatch(absent.message, /Add "[^"]*" to files:/);
  assert.match(absent.message, /does not exist in the tree/);
  assert.match(absent.message, /drop the criterion/);

  // Control: a path the tree holds keeps the unchanged remedy.
  const [heldTask] = parseTasksFromYaml(draft(["src/lib/ledger.ts"], ["grep: rowActorOf( in src/lib/panel.ts"]), "fixture");
  const [present] = proofScopeViolations(heldTask, { moduleExists: exists });
  assert.match(present.message, /Add "src\/lib\/panel\.ts" to files: or rewrite the proof/);
});

test("call-site candidates use the real checkout and refuse an unreadable git tree", () => {
  assert.deepEqual(callSiteCandidates(ROOT, "rowActorOf"), ["src/lib/ledger.ts", "src/lib/panel.ts"]);
  assert.deepEqual(callSiteCandidates(ROOT, undefined), []);
  assert.deepEqual(callSiteCandidates(ROOT, undefined, {
    exclude: "src/lib/ledger.ts",
    declared: ["src/lib/ledger.ts", "src/lib/*.ts", "test/ledger.test.ts", "src/app.ts", "src/lib/panel.ts"],
  }), ["src/lib/panel.ts"]);
  assert.deepEqual(callSiteCandidates(ROOT, "rowActorOf", { limit: 1 }), ["src/lib/ledger.ts"]);
  const unreadable = mkdtempSync(join(tmpdir(), "rmd-callers-no-git-"));
  try {
    assert.throws(() => callSiteCandidates(unreadable, "rowActorOf"), /worktree-git: refusing/);
  } finally {
    rmSync(unreadable, { recursive: true, force: true });
  }
});

test("a malformed redraft still gets call-site guidance without invented declared paths", () => {
  const prompt = inboxDraftRelintPrompt({ id: PROPOSAL_ID, summary: "repair", evidenceAnchors: [] }, "[broken", [
    { check: "call-site", severity: "block", message: "task NEW-1 adds new module src/lib/newmod.ts but no acceptance criterion proves a CALL SITE" },
    { check: "draft-parse", severity: "block", message: "invalid yaml" },
  ], ROOT);
  assert.match(prompt, /drop the call-site claim/);
  assert.doesNotMatch(prompt, /may name as the caller/);
});

function worker(text: string): WorkerResult {
  return {
    sessionId: "S-1", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "m", routedModel: "m", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T9307: the standing-debt:5 repair that invents an app caller stays NOT READY", async () => {
  const round1 = draft(["docs/recon/ownership-assertion-blocker-2026-10.md", "src/ownership.ts", "test/ledger.test.ts"],
    ["unit test: the blocker is recorded", "grep: checkOwnership( in src/ownership.ts"]);
  // Round 2 obeys the old remedy: it adds src/app.ts as the "caller", declared CREATES so the path floor lets it through.
  const round2 = draft(["docs/recon/ownership-assertion-blocker-2026-10.md", "src/ownership.ts", "src/app.ts", "test/ledger.test.ts"],
    ["unit test: the blocker is recorded", "grep: checkOwnership( in src/app.ts"], "CREATES: src/ownership.ts, src/app.ts");
  const round2Lines = round2.replace("CREATES: src/ownership.ts, src/app.ts", "CREATES: src/ownership.ts\n    CREATES: src/app.ts");
  const rounds = [round1, round2Lines, round2Lines];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let call = 0;
  const [outcome] = await runDraftRung([{ id: PROPOSAL_ID, summary: "record the blocker", evidenceAnchors: [] }], "- id: W1-T1\n", {
    clock: fixedClock(Date.parse("2026-10-13T12:00:00Z")),
    spawn: async () => worker(`=== FRAGMENT START ===\n${rounds[Math.min(call++, rounds.length - 1)]}=== FRAGMENT END ===\nSTAMP: record the blocker`),
    log: (step, extra) => events.push({ step, extra }),
    repoFacts: facts,
  }, "run-9307");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const drafted = events.find((e) => e.step === "inbox.drafted");
  assert.equal(drafted?.extra?.lint_clean, false, "the invented caller never reaches a clean lint");
  assert.match((drafted?.extra?.unresolved_violations as string[]).join("\n"), /call-site proof .*src\/app\.ts.*CREATES/);
  assert.equal(call, 3, "bounded by the existing relint attempts");
});
