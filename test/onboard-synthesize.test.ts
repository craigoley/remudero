import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
// The DEFAULT export — see synthesize.ts's own header comment for why: `t.mock.method`
// cannot intercept ESM named bindings off `node:fs` (non-configurable), so the write-spy
// tests below spy on the REAL module the same way test/onboard-recon.test.ts already does.
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lintPlan } from "../src/lib/task-linter.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import type { Inventory } from "../src/lib/onboard/inventory.js";
import type { Candidate } from "../src/lib/onboard/recon.js";
import { generateOnboardQuestions, type OnboardAnswer } from "../src/lib/onboard/session.js";
import {
  assertAnswersComplete,
  draftPlanUntilClean,
  MAX_DRAFT_ATTEMPTS,
  parseSynthesizeArgs,
  realSynthesizeFsDeps,
  realSynthesizeGhGateway,
  realSynthesizeGitGateway,
  runOnboardSynthesize,
  SYNTHESIZE_PHASE,
  SynthesizeError,
  unansweredQuestions,
  type SynthesizeDraft,
  type SynthesizeDraftFn,
  type SynthesizeDraftInput,
  type SynthesizeFsDeps,
  type SynthesizeGhGateway,
  type SynthesizeGitGateway,
} from "../src/lib/onboard/synthesize.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fully-resolved fixture Inventory — same shape as onboard-session.test.ts's own
 *  `resolvedInventory`, so {@link generateOnboardQuestions} over it yields ONLY the fixed
 *  goal-elicitation set (no gap questions), a small/stable set to fully answer in fixtures. */
function fixtureInventory(): Inventory {
  return {
    generatedAt: "2026-07-23T00:00:00.000Z",
    target: { owner: "acme-corp", repo: "widget-fixture" },
    languages: ["typescript"],
    buildSystems: ["npm"],
    ciSystems: ["github-actions"],
    docs: { readme: true },
    testSignals: ["node:test"],
    github: { repoExists: true, defaultBranch: "main", branchProtected: true, openIssueCount: 3, milestoneCount: 1 },
  };
}

function fixtureCandidates(): Candidate[] {
  return [
    { text: "Ship the widget catalog search", source: { kind: "file", path: "ROADMAP.md", line: 3 }, confidence: "mined" },
  ];
}

function fixtureFindings(): string {
  return "# rmd onboard — recon findings\n\n## Mined candidates (1)\n\n- Ship the widget catalog search (source: ROADMAP.md:3)\n";
}

/** Every phase-3 question, fully answered — the "complete" fixture acceptance 1's refusal
 *  test then knocks ONE entry out of. */
function completeAnswers(): Record<string, OnboardAnswer> {
  const questions = generateOnboardQuestions(fixtureInventory());
  return Object.fromEntries(
    questions.map((q, i) => [q.id, { id: q.id, decision: q.decision, question: q.question, answer: `fixture-answer-${i}` }]),
  );
}

function writeOnboardingArtifacts(
  targetDir: string,
  opts: { inventory?: Inventory; answers?: Record<string, OnboardAnswer>; candidates?: Candidate[]; findings?: string } = {},
): void {
  const dir = join(targetDir, "plan", "onboarding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), JSON.stringify(opts.inventory ?? fixtureInventory(), null, 2));
  if (opts.answers !== undefined) writeFileSync(join(dir, "answers.json"), JSON.stringify(opts.answers, null, 2));
  writeFileSync(join(dir, "candidates.json"), JSON.stringify(opts.candidates ?? fixtureCandidates(), null, 2));
  writeFileSync(join(dir, "findings.md"), opts.findings ?? fixtureFindings());
}

/** A lint-plan-CLEAN drafted tasks.yaml — `unit test:` dialect proof (executable), an
 *  `origin:` citing the fixture's `elicit-priorities` answer (provenance), no live-context
 *  lexicon hits, single subsystem. */
const CLEAN_TASKS_YAML = `
- id: T-1
  title: "Ship the widget catalog search"
  repo: widget-fixture
  type: implement
  verify: auto
  risk: medium
  origin: "onboard:elicit-priorities"
  acceptance:
    - claim: "the widget catalog search ships"
      proof: "unit test: widget catalog search returns results"
`.trim();

/** A DIRTY drafted tasks.yaml — a live-context ("operator confirms") proof: fails BOTH
 *  headless-fitness (Rule 18) and proof-dialect (the dead proof floor) as a BLOCKING
 *  violation. The "seeded draft with a live-verb proof" acceptance-2 fixture. */
const DIRTY_TASKS_YAML = `
- id: T-1
  title: "Ship the widget catalog search"
  repo: widget-fixture
  type: implement
  verify: auto
  risk: medium
  origin: "onboard:elicit-priorities"
  acceptance:
    - claim: "the widget catalog search ships"
      proof: "operator confirms it works end to end"
`.trim();

function cleanDraft(): SynthesizeDraft {
  return {
    masterPlan: "# MASTER-PLAN.md\n\nMission: ship the widget catalog.\n",
    tasksYaml: CLEAN_TASKS_YAML,
    agentsMd: "# AGENTS.md\n\nFollow the conventions found in this repo.\n",
  };
}

function dirtyDraft(): SynthesizeDraft {
  return { masterPlan: "# MASTER-PLAN.md\n", tasksYaml: DIRTY_TASKS_YAML, agentsMd: "# AGENTS.md\n" };
}

function recordingGit(): { gateway: SynthesizeGitGateway; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return { gateway: { exec: (args, cwd) => { calls.push({ args, cwd }); return ""; } }, calls };
}

function recordingGh(prUrl = "https://github.com/acme-corp/widget-fixture/pull/1"): {
  gateway: SynthesizeGhGateway;
  calls: Array<Parameters<SynthesizeGhGateway["openPr"]>[0]>;
} {
  const calls: Array<Parameters<SynthesizeGhGateway["openPr"]>[0]> = [];
  return { gateway: { openPr: (opts) => { calls.push(opts); return prUrl; } }, calls };
}

const NEVER_CALLED_DRAFT: SynthesizeDraftFn = async () => {
  throw new Error("must not be called — the completeness gate must refuse before any draft");
};

// ── Acceptance 1: synthesis refuses without complete answers ───────────────────────────────
// proof: "unit test: partial-answers fixture -> non-zero exit naming the unanswered question
// ids; no branch, no PR"

test("acceptance 1: unansweredQuestions returns exactly the questions missing from a partial answers fixture", () => {
  const inventory = fixtureInventory();
  const all = completeAnswers();
  const partial = { ...all };
  delete partial["elicit-priorities"];

  const unanswered = unansweredQuestions(inventory, partial);
  assert.deepEqual(unanswered.map((q) => q.id), ["elicit-priorities"]);
});

test("acceptance 1: assertAnswersComplete throws SynthesizeError naming every unanswered question id", () => {
  const inventory = fixtureInventory();
  const partial = completeAnswers();
  delete partial["elicit-priorities"];
  delete partial["elicit-no-touch-zones"];

  assert.throws(
    () => assertAnswersComplete(inventory, partial, "/some/target"),
    (e: unknown) =>
      e instanceof SynthesizeError &&
      /elicit-priorities/.test(e.message) &&
      /elicit-no-touch-zones/.test(e.message) &&
      /goals are never guessed/.test(e.message),
  );
});

test("acceptance 1: assertAnswersComplete does not throw once every question is answered", () => {
  assert.doesNotThrow(() => assertAnswersComplete(fixtureInventory(), completeAnswers(), "/some/target"));
});

test("acceptance 1: partial-answers fixture -> runOnboardSynthesize rejects with SynthesizeError naming the unanswered ids; no branch, no PR, no write, no draft call", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-synth-partial-");
  const partial = completeAnswers();
  delete partial["elicit-priorities"];
  writeOnboardingArtifacts(targetDir, { answers: partial });

  const git = recordingGit();
  const gh = recordingGh();
  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: git.gateway,
        gh: gh.gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /elicit-priorities/.test(e.message) && /unanswered question/.test(e.message),
  );

  assert.equal(git.calls.length, 0, "no branch (or any other git call) is ever attempted");
  assert.equal(gh.calls.length, 0, "no PR is ever opened");
  assert.equal(writeSpy.mock.calls.length, 0, "no write happens once the gate refuses");
  assert.equal(renameSpy.mock.calls.length, 0);
});

test("acceptance 1: a target with NO answers.json at all names the FULL question set as unanswered", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-no-answers-");
  writeOnboardingArtifacts(targetDir, { answers: undefined });
  const allIds = generateOnboardQuestions(fixtureInventory()).map((q) => q.id);

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => {
      if (!(e instanceof SynthesizeError)) return false;
      return allIds.every((id) => e.message.includes(id));
    },
  );
});

test("runOnboardSynthesize refuses (SynthesizeError) when the phase-1 inventory artifact is missing", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-no-inventory-");
  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /--phase inventory/.test((e as Error).message),
  );
});

test("runOnboardSynthesize refuses (SynthesizeError) when inventory.json exists but is not valid JSON", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-bad-inventory-json-");
  mkdirSync(join(targetDir, "plan", "onboarding"), { recursive: true });
  writeFileSync(join(targetDir, "plan", "onboarding", "inventory.json"), "{ not json");

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /inventory\.json exists but is not valid JSON/.test((e as Error).message),
  );
});

test("runOnboardSynthesize refuses (SynthesizeError) when answers.json exists but is not valid JSON", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-bad-answers-json-");
  const dir = join(targetDir, "plan", "onboarding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), JSON.stringify(fixtureInventory(), null, 2));
  writeFileSync(join(dir, "answers.json"), "{ not json");

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /answers\.json exists but is not valid JSON/.test((e as Error).message),
  );
});

test("runOnboardSynthesize refuses (SynthesizeError) when candidates.json exists but is not valid JSON (past both gates, before drafting)", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-bad-candidates-json-");
  const dir = join(targetDir, "plan", "onboarding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), JSON.stringify(fixtureInventory(), null, 2));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(completeAnswers(), null, 2));
  writeFileSync(join(dir, "candidates.json"), "{ not json");

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /candidates\.json exists but is not valid JSON/.test((e as Error).message),
  );
});

test("runOnboardSynthesize refuses when the target directory itself does not exist", async () => {
  const parentDir = tmpRoot("rmd-onboard-synth-missing-parent-");
  const missingTargetDir = join(parentDir, "does-not-exist");
  await assert.rejects(
    () =>
      runOnboardSynthesize(missingTargetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /does not exist/.test((e as Error).message),
  );
});

test("runOnboardSynthesize refuses when the resolved target owner/repo is still \"unknown\"", async () => {
  const targetDir = tmpRoot("rmd-onboard-synth-unknown-target-");
  const inventory: Inventory = { ...fixtureInventory(), target: { owner: "unknown", repo: "unknown" } };
  writeOnboardingArtifacts(targetDir, { inventory, answers: completeAnswers() });

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: recordingGit().gateway,
        gh: recordingGh().gateway,
        draft: NEVER_CALLED_DRAFT,
      }),
    (e: unknown) => e instanceof SynthesizeError && /unresolved/.test((e as Error).message),
  );
});

test("SynthesizeError carries the standard Error name", () => {
  assert.equal(new SynthesizeError("x").name, "SynthesizeError");
});

// ── Acceptance 2: every generated task is lint-plan-clean at birth ─────────────────────────
// proof: "unit test: the fixture flow's drafted tasks.yaml passes the real linter; a seeded
// draft with a live-verb proof is caught and regenerated before PR"

test("acceptance 2: the fixture flow's drafted tasks.yaml passes the real linter (lintPlan reports zero blocking violations)", () => {
  const tasks = parseTasksFromYaml(CLEAN_TASKS_YAML, "fixture");
  const plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const results = lintPlan(plan);
  const blocking = [...results.values()].flatMap((r) => r.violations.filter((v) => v.severity === "block"));
  assert.deepEqual(blocking, [], "the clean fixture draft must carry zero blocking lint-plan violations");
});

test("acceptance 2: the DIRTY fixture (a live-verb proof) is in fact caught by the real linter — sanity check for the fixture itself", () => {
  const tasks = parseTasksFromYaml(DIRTY_TASKS_YAML, "fixture");
  const plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const results = lintPlan(plan);
  const blocking = [...results.values()].flatMap((r) => r.violations.filter((v) => v.severity === "block"));
  assert.ok(blocking.length > 0, "the dirty fixture must actually fail lint-plan, or it proves nothing about the regenerate path");
  assert.ok(blocking.some((v) => v.check === "headless-fitness"), "the dirty fixture's live-verb proof must trip headless-fitness");
});

test("acceptance 2: draftPlanUntilClean returns the first attempt when it is already clean, calling draft exactly once with no feedback", async () => {
  let calls = 0;
  const draft: SynthesizeDraftFn = async (_input, feedback) => {
    calls += 1;
    assert.equal(feedback, undefined);
    return cleanDraft();
  };
  const input = {} as SynthesizeDraftInput;
  const result = await draftPlanUntilClean(input, draft);
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.tasks.length, 1);
});

test("acceptance 2: a seeded draft with a live-verb proof is caught by lint-plan and regenerated — draftPlanUntilClean re-drafts with the violation as feedback, returning the CLEAN attempt", async () => {
  const seenFeedback: (string[] | undefined)[] = [];
  let calls = 0;
  const draft: SynthesizeDraftFn = async (_input, feedback) => {
    calls += 1;
    seenFeedback.push(feedback);
    return calls === 1 ? dirtyDraft() : cleanDraft();
  };

  const result = await draftPlanUntilClean({} as SynthesizeDraftInput, draft);

  assert.equal(calls, 2, "the dirty first attempt must trigger exactly one re-draft");
  assert.equal(result.attempts, 2);
  assert.equal(seenFeedback[0], undefined, "the FIRST attempt gets no feedback");
  assert.ok(seenFeedback[1] && seenFeedback[1].length > 0, "the SECOND attempt is fed the first attempt's lint violations");
  assert.ok(seenFeedback[1]!.some((m) => /headless-fitness|live-context/.test(m) || /operator/.test(m)), "feedback names the actual violation");
  assert.equal(result.draft.tasksYaml, CLEAN_TASKS_YAML, "the FINAL returned draft is the clean one, never the dirty attempt");
});

test("acceptance 2: draftPlanUntilClean throws SynthesizeError after the retry cap when every attempt stays dirty — never returns a dirty draft", async () => {
  let calls = 0;
  const draft: SynthesizeDraftFn = async () => {
    calls += 1;
    return dirtyDraft();
  };

  await assert.rejects(
    () => draftPlanUntilClean({} as SynthesizeDraftInput, draft),
    (e: unknown) => e instanceof SynthesizeError && /lint-plan/.test((e as Error).message),
  );
  assert.equal(calls, MAX_DRAFT_ATTEMPTS, "exactly the bounded retry cap, no more, no fewer");
});

test("acceptance 2: draftPlanUntilClean folds an unparseable tasksYaml into feedback and retries, rather than throwing immediately", async () => {
  let calls = 0;
  const draft: SynthesizeDraftFn = async () => {
    calls += 1;
    return calls === 1 ? { masterPlan: "", tasksYaml: "not: valid: yaml: [", agentsMd: "" } : cleanDraft();
  };
  const result = await draftPlanUntilClean({} as SynthesizeDraftInput, draft);
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
});

test("acceptance 2: a custom maxAttempts is honored", async () => {
  let calls = 0;
  const draft: SynthesizeDraftFn = async () => {
    calls += 1;
    return dirtyDraft();
  };
  await assert.rejects(() => draftPlanUntilClean({} as SynthesizeDraftInput, draft, 1));
  assert.equal(calls, 1);
});

// ── Acceptance 3: exactly one draft PR; zero writes outside its branch ─────────────────────
// proof: "unit test over injected git/gh deps: one branch, one PR call, write-spy clean
// elsewhere; drafted tasks carry provenance to answers/candidates"

test("acceptance 3: the complete-answers fixture flow opens exactly one branch and one draft PR, writes land ONLY under <target-dir> (never plan/onboarding/), and the drafted task carries provenance to its answer", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-synth-happy-");
  writeOnboardingArtifacts(targetDir, { answers: completeAnswers() });
  const onboardingPrefix = join(targetDir, "plan", "onboarding");

  const git = recordingGit();
  const gh = recordingGh("https://github.com/acme-corp/widget-fixture/pull/42");
  let draftCalls = 0;
  const draft: SynthesizeDraftFn = async () => {
    draftCalls += 1;
    return cleanDraft();
  };

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");
  const mkdirSpy = t.mock.method(fsDefault, "mkdirSync");

  const result = await runOnboardSynthesize(targetDir, { fs: realSynthesizeFsDeps, git: git.gateway, gh: gh.gateway, draft });

  // Exactly one branch.
  const checkoutCalls = git.calls.filter((c) => c.args[0] === "checkout" && c.args[1] === "-b");
  assert.equal(checkoutCalls.length, 1, "exactly one branch is created");
  assert.equal(checkoutCalls[0]!.args[2], "onboard/widget-fixture-plan");
  assert.equal(result.branch, "onboard/widget-fixture-plan");

  // Exactly one draft PR.
  assert.equal(gh.calls.length, 1, "exactly one gh pr create call");
  assert.equal(gh.calls[0]!.branch, "onboard/widget-fixture-plan");
  assert.equal(result.prUrl, "https://github.com/acme-corp/widget-fixture/pull/42");
  assert.equal(draftCalls, 1, "the fixture draft was already clean — no re-draft needed");

  // Write-spy: nothing lands under plan/onboarding/ — only the three drafted files, under <target-dir>.
  const writeTargets = writeSpy.mock.calls.map((c) => c.arguments[0] as string);
  const renameTargets = renameSpy.mock.calls.map((c) => c.arguments[1] as string);
  for (const target of [...writeTargets, ...renameTargets]) {
    assert.ok(target.startsWith(targetDir), `write target "${target}" must live under the target dir`);
    assert.ok(!target.startsWith(onboardingPrefix), `write target "${target}" must NEVER land under plan/onboarding/`);
  }
  for (const call of mkdirSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(!target.startsWith(onboardingPrefix), `mkdir target "${target}" must never touch plan/onboarding/`);
  }
  assert.deepEqual(
    renameTargets.sort(),
    [result.masterPlanPath, result.tasksYamlPath, result.agentsMdPath].sort(),
    "exactly the three drafted files are written, nothing else",
  );

  // The three files actually exist with the drafted content.
  assert.equal(readFileSync(result.masterPlanPath, "utf8"), cleanDraft().masterPlan);
  assert.equal(readFileSync(result.tasksYamlPath, "utf8"), cleanDraft().tasksYaml);
  assert.equal(readFileSync(result.agentsMdPath, "utf8"), cleanDraft().agentsMd);

  // The phase 1-3 artifacts are untouched (still exactly what the fixture wrote).
  const inventoryOnDisk = JSON.parse(readFileSync(join(onboardingPrefix, "inventory.json"), "utf8"));
  assert.deepEqual(inventoryOnDisk, fixtureInventory());

  // Provenance: the drafted task cites the answer that justified it.
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]!.origin, "onboard:elicit-priorities");
  assert.ok(
    Object.keys(completeAnswers()).includes("elicit-priorities"),
    "sanity: the cited id is a real answer id from the fixture's own answers.json",
  );

  // git add/commit/push each happened exactly once, after the branch and before the PR.
  assert.equal(git.calls.filter((c) => c.args[0] === "add").length, 1);
  assert.equal(git.calls.filter((c) => c.args[0] === "commit").length, 1);
  assert.equal(git.calls.filter((c) => c.args[0] === "push").length, 1);
});

test("acceptance 3: the regenerate-then-clean flow opens the PR with the CLEAN drafted content, never the dirty attempt", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-synth-regen-");
  writeOnboardingArtifacts(targetDir, { answers: completeAnswers() });

  const git = recordingGit();
  const gh = recordingGh();
  let calls = 0;
  const draft: SynthesizeDraftFn = async () => {
    calls += 1;
    return calls === 1 ? dirtyDraft() : cleanDraft();
  };

  const result = await runOnboardSynthesize(targetDir, { fs: realSynthesizeFsDeps, git: git.gateway, gh: gh.gateway, draft });

  assert.equal(calls, 2);
  assert.equal(gh.calls.length, 1, "still exactly one PR, opened only once regeneration succeeded");
  assert.equal(readFileSync(result.tasksYamlPath, "utf8"), CLEAN_TASKS_YAML, "the file on disk is the CLEAN draft, never the dirty one");
  const checkoutCalls = git.calls.filter((c) => c.args[0] === "checkout");
  assert.equal(checkoutCalls.length, 1, "still exactly one branch — the dirty attempt never touched git at all");
});

test("acceptance 3: a draft that never becomes clean opens no branch and no PR (the retry cap fails loud first)", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-synth-never-clean-");
  writeOnboardingArtifacts(targetDir, { answers: completeAnswers() });

  const git = recordingGit();
  const gh = recordingGh();
  const writeSpy = t.mock.method(fsDefault, "writeFileSync");

  await assert.rejects(
    () =>
      runOnboardSynthesize(targetDir, {
        fs: realSynthesizeFsDeps,
        git: git.gateway,
        gh: gh.gateway,
        draft: async () => dirtyDraft(),
      }),
    SynthesizeError,
  );

  assert.equal(git.calls.length, 0);
  assert.equal(gh.calls.length, 0);
  assert.equal(writeSpy.mock.calls.length, 0);
});

// ── Real gateways (git/gh) — the injectable exec seam, mirroring inventory.ts's/recon.ts's ─
// own realOnboardGhGateway/realReconGhGateway tests: proves the SHAPE without shelling a real
// process (a fake `exec` is injected).

test("realSynthesizeGitGateway with no opts.exec still returns a usable gateway shape", () => {
  const gateway = realSynthesizeGitGateway();
  assert.equal(typeof gateway.exec, "function");
});

test("realSynthesizeGitGateway delegates to the injected exec verbatim", () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const gateway = realSynthesizeGitGateway({
    exec: (args, cwd) => {
      calls.push({ args, cwd });
      return "ok";
    },
  });
  const out = gateway.exec(["checkout", "-b", "onboard/x-plan"], "/some/target");
  assert.equal(out, "ok");
  assert.deepEqual(calls, [{ args: ["checkout", "-b", "onboard/x-plan"], cwd: "/some/target" }]);
});

test("realSynthesizeGhGateway.openPr builds a `gh pr create --draft` call naming repo/head/title/body, trimming the result", () => {
  let seenArgs: string[] = [];
  const gateway = realSynthesizeGhGateway({
    exec: (args) => {
      seenArgs = args;
      return "https://github.com/acme-corp/widget-fixture/pull/9\n";
    },
  });
  const url = gateway.openPr({ owner: "acme-corp", repo: "widget-fixture", branch: "onboard/widget-fixture-plan", title: "t", body: "b" });
  assert.equal(url, "https://github.com/acme-corp/widget-fixture/pull/9");
  assert.deepEqual(seenArgs, [
    "pr",
    "create",
    "--repo",
    "acme-corp/widget-fixture",
    "--draft",
    "--head",
    "onboard/widget-fixture-plan",
    "--title",
    "t",
    "--body",
    "b",
  ]);
});

test("realSynthesizeGhGateway with no opts.exec still returns a usable gateway shape", () => {
  const gateway = realSynthesizeGhGateway();
  assert.equal(typeof gateway.openPr, "function");
});

// ── CLI arg parsing (pure) ───────────────────────────────────────────────────────────────

test("parseSynthesizeArgs requires <target-dir> as the first positional argument", () => {
  const result = parseSynthesizeArgs(["--phase", "synthesize"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /<target-dir> is required/);
});

test("parseSynthesizeArgs requires --phase to be exactly \"synthesize\"", () => {
  const result = parseSynthesizeArgs(["/some/dir", "--phase", "session"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /--phase must be "synthesize"/);
});

test("parseSynthesizeArgs rejects an unrecognized flag", () => {
  const result = parseSynthesizeArgs(["/some/dir", "--phase", "synthesize", "--bogus"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unrecognized argument/);
});

test("parseSynthesizeArgs accepts the target dir + --phase synthesize", () => {
  const result = parseSynthesizeArgs(["/some/dir", "--phase", "synthesize"]);
  assert.deepEqual(result, { ok: true, args: { targetDir: "/some/dir" } });
});

test("SYNTHESIZE_PHASE is the literal \"synthesize\"", () => {
  assert.equal(SYNTHESIZE_PHASE, "synthesize");
});

// ── Injected fs deps sanity (mirrors onboard-session.test.ts's own realSessionFsDeps check) ─

test("realSynthesizeFsDeps round-trips a write/read/rename through a real tmp dir", () => {
  const dir = tmpRoot("rmd-onboard-synth-fsdeps-");
  const deps: SynthesizeFsDeps = realSynthesizeFsDeps;
  const tmpPath = join(dir, "x.tmp");
  const finalPath = join(dir, "x.md");
  deps.mkdirSync(dir, { recursive: true });
  deps.writeFileSync(tmpPath, "hello");
  deps.renameSync(tmpPath, finalPath);
  assert.equal(deps.existsSync(finalPath), true);
  assert.equal(deps.readFileSync(finalPath), "hello");
});
