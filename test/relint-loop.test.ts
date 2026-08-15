/**
 * test/relint-loop.test.ts — impl-FU.
 *
 * THE CLASS (recon-FT). A worker prompt is written against the rules of its day; a blocking gate is
 * added later; nothing connects them. TRIAGE cost $1.48 filing W1-T286, which `lint-plan` then
 * rejected with six violations a human hand-edited away. PLAN drifted from `monolith-filing` for a
 * fortnight, undetected, because the lane has never run.
 *
 * THE FIX IS NOT A PROMPT RULE. A prompt rule restates a gate and goes stale when the gate moves —
 * measurably: BOTH known instances had their prompt edited AFTER the gate landed and still missed
 * it. This suite pins the reactive alternative: ask the REAL linter, hand back its REAL message.
 *
 * WHAT IS PROVEN BY EXECUTION vs BY INJECTION — stated up front because it is not symmetric:
 *   - the SHARED LOOP (`runRelintLoop`) is proven directly, by execution.
 *   - the PLAN LANE is driven end-to-end through the real `planCommand` with an injected worker.
 *     That lane has NEVER run in production, so injection is the only honest evidence available.
 *   - the TRIAGE LANE is likewise driven through the real `triageCommand` with an injected worker.
 *     Its production history is real, but its relint path is new here and has never fired live.
 *   None of this proves an LLM will FIX what it is handed — only that the loop hands it the real
 *   violations, bounds the attempts, and refuses legibly instead of opening a doomed PR.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseTasksFromYaml } from "../src/lib/plan.js";
import {
  MAX_RELINT_ATTEMPTS,
  allWorkerUnfixable,
  filedTaskRelintPrompt,
  lintFiledTasks,
  newMonolithIdsAgainstBase,
  relintGuidanceLines,
  relintRefusalMessage,
  runRelintLoop,
  type RelintViolation,
} from "../src/lib/relint.js";
import { lintTask } from "../src/lib/task-linter.js";
import type { WorkerResult } from "../src/lib/worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A task that lints CLEAN — every proof in the executable dialect, provenance present. */
const CLEAN_TASK = (id: string): string =>
  [
    `- id: ${id}`,
    `  title: "a clean task the linter accepts"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "  files: [test/relint-loop.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "unit test: test/relint-loop.test.ts"',
    "",
  ].join("\n");

/** The SAME task with a PROSE proof — `proof-dialect`, the exact class that failed W1-T286. */
const DIRTY_TASK = (id: string): string =>
  [
    `- id: ${id}`,
    `  title: "a task whose proof is prose"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "  files: [test/relint-loop.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "the existing suite passes unchanged and the behaviour is correct"',
    "",
  ].join("\n");

// ── THE SHARED LOOP, driven directly ─────────────────────────────────────────

const V = (check: string, message = "m"): RelintViolation => ({ check, severity: "block", message });

test("the loop relints a dirty filing and stops as soon as the next attempt is clean", async () => {
  const steps: string[] = [];
  let attempts = 0;
  const r = await runRelintLoop({
    lane: "triage",
    filedIds: ["W1-T900"],
    initialPrompt: "INITIAL",
    log: (s) => steps.push(s),
    run: async (prompt) => {
      attempts++;
      return { prompt };
    },
    filed: () => true,
    // dirty on attempt 1, clean on attempt 2
    lint: () => (attempts === 1 ? [V("proof-dialect")] : []),
  });

  assert.equal(r.stop, "clean");
  assert.equal(r.attempts, 2, "exactly one redraft — never a third paid turn once clean");
  assert.deepEqual(r.violations, []);
  assert.deepEqual(steps, ["triage.relint"], "the redraft is ledgered once");
  assert.match(r.decision.prompt, /FAILED the plan's own linter/, "attempt 2 received the RELINT prompt, not the original");
});

test("a CLEAR/GRILL files nothing, so the loop never lints and never buys a second turn", async () => {
  let lintCalls = 0;
  let runs = 0;
  const r = await runRelintLoop({
    lane: "plan",
    filedIds: ["W1-T900"],
    initialPrompt: "INITIAL",
    log: () => {},
    run: async () => {
      runs++;
      return {};
    },
    filed: () => false,
    lint: () => {
      lintCalls++;
      return [V("proof-dialect")];
    },
  });

  assert.equal(r.stop, "not-filed");
  assert.equal(runs, 1, "one turn only");
  assert.equal(lintCalls, 0, "nothing was filed — nothing to lint");
  assert.deepEqual(r.violations, []);
});

// ── (6) WORKER-UNFIXABLE VIOLATIONS STOP EARLY ───────────────────────────────

test("a violation a redraft cannot fix stops the loop IMMEDIATELY rather than buying its budget", async () => {
  let runs = 0;
  const steps: string[] = [];
  const r = await runRelintLoop({
    lane: "triage",
    filedIds: ["W1-T900"],
    initialPrompt: "INITIAL",
    log: (s) => steps.push(s),
    run: async () => {
      runs++;
      return {};
    },
    filed: () => true,
    lint: () => [V("post-merge-amendment", "already MERGED, criteria added")],
  });

  assert.equal(r.stop, "unfixable");
  assert.equal(runs, 1, `ONE paid turn, not ${MAX_RELINT_ATTEMPTS} — at ~$1/turn on the triage lane that is the whole point`);
  assert.deepEqual(steps, ["triage.relint_unfixable"]);
  assert.equal(r.violations.length, 1, "and the violation is carried out for the refusal message");
});

test("a MIX of fixable and unfixable still relints — the worker can fix its half", async () => {
  let runs = 0;
  const r = await runRelintLoop({
    lane: "triage",
    filedIds: ["W1-T900"],
    initialPrompt: "I",
    log: () => {},
    run: async () => {
      runs++;
      return {};
    },
    filed: () => true,
    lint: () => [V("post-merge-amendment"), V("proof-dialect")],
  });
  assert.equal(r.stop, "exhausted");
  assert.equal(runs, MAX_RELINT_ATTEMPTS, "a mixed set is not 'all unfixable' — it is worth retrying");
});

test("allWorkerUnfixable is false for an EMPTY set — nothing to fix is not nothing fixable", () => {
  assert.equal(allWorkerUnfixable([]), false);
  assert.equal(allWorkerUnfixable([V("post-merge-amendment")]), true);
  assert.equal(allWorkerUnfixable([V("proof-dialect")]), false);
});

// ── (7) THE BOUND, AND A LEGIBLE EXHAUSTION ──────────────────────────────────

test("the bound is enforced: an unfixable-by-the-worker filing costs exactly MAX_RELINT_ATTEMPTS turns", async () => {
  let runs = 0;
  const steps: string[] = [];
  const r = await runRelintLoop({
    lane: "plan",
    filedIds: ["W1-T900"],
    initialPrompt: "I",
    log: (s) => steps.push(s),
    run: async () => {
      runs++;
      return {};
    },
    filed: () => true,
    lint: () => [V("proof-dialect", "criterion 1 proof is prose")],
  });

  assert.equal(runs, MAX_RELINT_ATTEMPTS, "never unbounded — this rung spends real money unattended");
  assert.equal(r.stop, "exhausted");
  assert.equal(r.attempts, MAX_RELINT_ATTEMPTS);
  // The LAST attempt must not emit a relint line — there is no next attempt to prompt.
  assert.equal(steps.filter((s) => s === "plan.relint").length, MAX_RELINT_ATTEMPTS - 1);
});

test("the refusal message names the checks, the ids, and why — not just 'ci failure'", () => {
  const msg = relintRefusalMessage("triage", ["W1-T286"], [V("proof-dialect", "criterion 1 proof is prose"), V("proof-resolvability", "criterion 2 resolves to no test")], 3, "exhausted");

  assert.match(msg, /W1-T286/, "names the task");
  assert.match(msg, /proof-dialect, proof-resolvability/, "names the checks, deduped and sorted");
  assert.match(msg, /3 attempt\(s\) did not clear them/, "says how much was spent trying");
  assert.match(msg, /no PR opened \(CI would have rejected it\)/, "says what did NOT happen, and why");
  assert.match(msg, /criterion 1 proof is prose/, "carries the linter's OWN message, never a paraphrase");
});

test("an unfixable refusal says so instead of blaming the attempt count", () => {
  const msg = relintRefusalMessage("plan", ["W1-T900"], [V("post-merge-amendment")], 1, "unfixable");
  assert.match(msg, /cannot be fixed by rewriting the task/);
  assert.doesNotMatch(msg, /attempt\(s\) did not clear/);
});

// ── ONE IMPLEMENTATION, NOT TWO ──────────────────────────────────────────────

test("the relint doctrine has ONE definition — the inbox prompt is composed from the same lines", async () => {
  const { inboxDraftRelintPrompt } = await import("../src/lib/inbox.js");
  const violations = [V("sizing", "two subsystems")];
  const shared = relintGuidanceLines(violations).join("\n");

  const inboxText = inboxDraftRelintPrompt({ id: "P1" } as never, "- id: W1-T1\n", violations);
  const laneText = filedTaskRelintPrompt("triage", ["W1-T900"], violations);

  assert.ok(inboxText.includes(shared), "the inbox rung composes the shared doctrine verbatim");
  assert.ok(laneText.includes(shared), "and so does the worktree-lane prompt");
  assert.match(shared, /THE OPEN PAREN IS THE WHOLE POINT/, "the call-site doctrine lives in the shared copy");
  assert.match(shared, /#588 MERITS TEST/, "so does the sizing doctrine");
});

// ── lintFiledTasks: SCOPED to this run's ids ─────────────────────────────────

function planDir(): string {
  const root = mkdtempSync(join(tmpdir(), "fu-plan-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  return root;
}

test("lintFiledTasks lints ONLY the ids this run filed — never the plan's pre-existing violations", () => {
  const root = planDir();
  try {
    // W1-T1 is someone else's dirty task; W1-T900 is ours and clean.
    writeFileSync(join(root, "plan", "tasks.yaml"), DIRTY_TASK("W1-T1") + CLEAN_TASK("W1-T900"));
    assert.deepEqual(lintFiledTasks(root, ["W1-T900"]), [], "our clean task passes despite a dirty neighbour");
    assert.ok(lintFiledTasks(root, ["W1-T1"]).length > 0, "and the neighbour really is dirty — the fixture is not vacuous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lintFiledTasks reads SHARDS too, and a plan that will not load is itself one blocking violation", () => {
  const root = planDir();
  try {
    writeFileSync(join(root, "plan", "tasks.yaml"), CLEAN_TASK("W1-T1"));
    writeFileSync(join(root, "plan", "tasks.d", "W1-T900-x.yaml"), DIRTY_TASK("W1-T900"));
    const v = lintFiledTasks(root, ["W1-T900"]);
    assert.ok(v.length > 0, "a shard-filed task is linted");
    assert.ok(v.every((x) => x.severity === "block"));

    writeFileSync(join(root, "plan", "tasks.yaml"), "this: is: not: valid: [");
    const bad = lintFiledTasks(root, ["W1-T900"]);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].check, "plan-load");
    assert.equal(bad[0].severity, "block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── newMonolithIdsAgainstBase: the REAL shell-out, and its catch arm ─────────

test("newMonolithIdsAgainstBase really shells out to git and names only ids NEW to the monolith", () => {
  const root = mkdtempSync(join(tmpdir(), "fu-mono-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", root], { encoding: "utf8", env: GIT_ENV });
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), CLEAN_TASK("W1-T1"));
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    git(root, "branch", "-f", "origin/main", "HEAD"); // stand in for the remote-tracking ref

    // A task appended to the MONOLITH is new to it; a task filed as a SHARD is not.
    writeFileSync(join(root, "plan", "tasks.yaml"), CLEAN_TASK("W1-T1") + CLEAN_TASK("W1-T900"));
    writeFileSync(join(root, "plan", "tasks.d", "W1-T901-x.yaml"), CLEAN_TASK("W1-T901"));
    git(root, "add", "-A");

    const ids = newMonolithIdsAgainstBase(root, "origin/main");
    assert.deepEqual([...ids], ["W1-T900"], "the monolith append is named; the shard filing is not");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newMonolithIdsAgainstBase fails OPEN on an unreadable base rather than throwing inside a paid run", () => {
  // THE CATCH ARM. A lane must never die because a base ref could not be resolved — the check
  // simply does not fire. Exercised for real: this directory is not a git repo at all.
  const root = mkdtempSync(join(tmpdir(), "fu-nogit-"));
  try {
    assert.deepEqual([...newMonolithIdsAgainstBase(root, "origin/main")], [], "no throw, empty set");
    assert.deepEqual([...newMonolithIdsAgainstBase(root, "no-such-ref")], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (10) THE REPLAY: W1-T286, THE REAL INCIDENT ──────────────────────────────

test("THE REPLAY: W1-T286 as the triage worker actually wrote it is caught BEFORE a PR could open", () => {
  // Recovered verbatim from the filing commit (8e0d394, PR #1102) — not a reconstruction.
  const shard = readFileSync(join(__dirname, "fixtures", "w1-t286-as-filed.yaml"), "utf8");
  const root = planDir();
  try {
    writeFileSync(join(root, "plan", "tasks.yaml"), CLEAN_TASK("W1-T1"));
    writeFileSync(join(root, "plan", "tasks.d", "W1-T286-file-system-race-alerts-60-61.yaml"), shard);

    const violations = lintFiledTasks(root, ["W1-T286"]);

    // THE INCIDENT, EXACTLY: six blocking violations, four proof-dialect and two proof-resolvability —
    // PLUS a seventh, declared-scope (W1-T504), added by this suite: the shard's own `note:` says
    // its missing `files:` is deliberate (the alert API never named the flagged paths), but the new
    // check has no such carve-out, so the real W1-T286 record now also legitimately trips it.
    assert.equal(violations.length, 7, `expected the seven that now fail lint-plan; got ${JSON.stringify(violations.map((v) => v.check))}`);
    assert.equal(violations.filter((v) => v.check === "proof-dialect").length, 4);
    assert.equal(violations.filter((v) => v.check === "proof-resolvability").length, 2);
    assert.equal(violations.filter((v) => v.check === "declared-scope").length, 1);
    assert.ok(violations.every((v) => v.severity === "block"));

    // And it is worker-fixable, so the loop would have relinted rather than refused outright.
    assert.equal(allWorkerUnfixable(violations), false);

    // The operator would have seen this INSTEAD of "ci failure — PR left OPEN".
    const msg = relintRefusalMessage("triage", ["W1-T286"], violations, MAX_RELINT_ATTEMPTS, "exhausted");
    assert.match(msg, /W1-T286/);
    assert.match(msg, /proof-dialect, proof-resolvability/);
    assert.match(msg, /no PR opened/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("THE REPLAY, corrected: the same task with executable proofs lints clean — the loop CAN converge", () => {
  const shard = readFileSync(join(__dirname, "fixtures", "w1-t286-as-filed.yaml"), "utf8");
  // Replace every prose proof with the dialect the prompt now teaches; change nothing else, EXCEPT
  // also declaring files: (W1-T504) — the real record's `note:` documents that omission as
  // deliberate at FILING time (the alert API had not been read yet), but a "corrected" redraft is
  // exactly the moment the flagged site IS known, so a converged redraft also names it.
  const fixed = shard
    .replace(/^(\s+)proof: ".*"$/gm, '$1proof: "unit test: test/relint-loop.test.ts"')
    .replace(/^(- id: W1-T286)$/m, '$1\n  files: [src/lib/config.ts]');
  const tasks = parseTasksFromYaml(fixed, "w1-t286-fixed");
  const blocking = lintTask(tasks[0]).violations.filter((v) => v.severity === "block");

  assert.deepEqual(blocking.map((v) => v.check), [], `a redraft in the right dialect clears it; got ${JSON.stringify(blocking)}`);
});

// ── THE LANES, END TO END, with an injected worker ───────────────────────────

function writeGhShim(dir: string): void {
  writeFileSync(
    join(dir, "gh"),
    ["#!/bin/sh", 'case "$*" in', '  *"pr list"*) echo "[]" ;;', '  *"--json body"*) echo \'{"body":""}\' ;;', '  *"pr diff"*) echo "" ;;', "  *) exit 0 ;;", "esac", ""].join("\n"),
    { mode: 0o755 },
  );
}

function makeOrigin(seedExtra?: (seed: string) => void): string {
  const bare = mkdtempSync(join(tmpdir(), "fu-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "fu-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), CLEAN_TASK("W1-T4"));
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  seedExtra?.(seed);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

async function withLane(seedExtra: ((seed: string) => void) | undefined, body: (configRoot: string) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin(seedExtra);
  const home = mkdtempSync(join(tmpdir(), "fu-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "fu-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "fu-shim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@t"], { encoding: "utf8" });
    writeGhShim(shimDir);
    process.env.PATH = `${shimDir}:${savedPath}`;
    await body(configRoot);
    const p = join(configRoot, "state", "ledger.ndjson");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

/**
 * The reserved id a lane prompt hands its worker — the relint lints exactly those ids, so a fixture
 * filing any other id would lint NOTHING and pass vacuously.
 *
 * Keyed on the prompt's own reservation sentence, NOT on the first `W1-T…` in the text: the plan
 * prompt also names `plan/tasks.d/W1-T278-task-id-from-plan-history.yaml` as a STRUCTURE model, and
 * a naive first-match fixture silently filed under W1-T278, linted nothing, and passed a test that
 * proved nothing. That is exactly the vacuous-fixture trap this suite exists to avoid.
 */
function reservedFromPrompt(prompt: string, remembered?: string): string {
  const plan = /RESERVED these ids for this run: (W\d+-T\d+)/.exec(prompt);
  if (plan) return plan[1];
  const triage = /USE EXACTLY `(W\d+-T\d+)`/.exec(prompt);
  if (triage) return triage[1];
  // A RELINT prompt names the filed ids, not the reservation sentence — reuse what attempt 1 filed.
  const relint = /\(([^)]*)\) FAILED the plan's own linter/.exec(prompt);
  if (relint) {
    const m = /W\d+-T\d+/.exec(relint[1]);
    if (m) return m[0];
  }
  assert.ok(remembered, `the lane prompt must name its reserved id; got: ${prompt.slice(0, 240)}`);
  return remembered;
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "FU", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "", subtype: "success",
    isError: false, apiError: false, model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, totalCostUsd: 0,
    billingMode: "subscription", verdict: "success", qualitySuspect: false, compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

// ── (8) THE PLAN LANE — injection only; this lane has never executed ──────────

test("PLAN LANE: a dirty filing is relinted, and the clean redraft proceeds", async () => {
  let attempts = 0;
  const prompts: string[] = [];
  const ledger = await withLane(undefined, async () => {
    const { planCommand } = await import("../src/run-task.js");
    await planCommand(["--mode=create", "a", "fixture", "brief"], {
      spawn: async (args: { cwd: string; prompt: string }) => {
        attempts++;
        prompts.push(args.prompt);
        const dir = join(args.cwd, "plan", "tasks.d");
        mkdirSync(dir, { recursive: true });
        // File under a RESERVED id — the loop lints exactly the ids this run reserved, so a fixture
        // filing an arbitrary id would be linted as nothing and pass vacuously.
        const id = reservedFromPrompt(args.prompt);
        // Attempt 1 files a PROSE proof; attempt 2 (the relint) files the executable dialect.
        writeFileSync(join(dir, `${id}-x.yaml`), attempts === 1 ? DIRTY_TASK(id) : CLEAN_TASK(id));
        return fakeWorker(`PROPOSED: file ${id}`);
      },
    } as never).catch(() => undefined); // the push/PR steps have no network in this fixture
  });

  assert.equal(attempts, 2, "one redraft, then done");
  assert.match(prompts[1], /FAILED the plan's own linter/, "attempt 2 got the relint prompt");
  assert.match(prompts[1], /\[proof-dialect\]/, "carrying the REAL check name from the REAL linter");
  assert.equal(ledger.filter((l) => l.step === "plan.relint").length, 1, "and the redraft is on the ledger");
  assert.equal(ledger.filter((l) => l.step === "plan.relint_refused").length, 0, "a converged run refuses nothing");
});

test("PLAN LANE: an unconverged filing REFUSES before any PR, and ledgers why", async () => {
  let attempts = 0;
  const ledger = await withLane(undefined, async () => {
    const { planCommand } = await import("../src/run-task.js");
    await planCommand(["--mode=create", "a", "fixture", "brief"], {
      spawn: async (args: { cwd: string; prompt: string }) => {
        attempts++;
        const dir = join(args.cwd, "plan", "tasks.d");
        mkdirSync(dir, { recursive: true });
        const id = reservedFromPrompt(args.prompt);
        writeFileSync(join(dir, `${id}-x.yaml`), DIRTY_TASK(id)); // never fixes it
        return fakeWorker(`PROPOSED: file ${id}`);
      },
    } as never).catch(() => undefined);
  });

  assert.equal(attempts, MAX_RELINT_ATTEMPTS, "bounded — the lane cannot burn turns forever");
  const refused = ledger.filter((l) => l.step === "plan.relint_refused");
  assert.equal(refused.length, 1, "the refusal is ledgered exactly once");
  assert.equal(refused[0].stop, "exhausted");
  assert.deepEqual(refused[0].checks, ["proof-dialect"], "naming the check that actually blocked");
  assert.equal(ledger.filter((l) => l.step === "pr.opened").length, 0, "and NO PR was opened — the whole point");
});

// ── (5) THE TRIAGE LANE — the same, on the lane that actually runs ───────────

const FEEDBACK_ID = "fb-fixture-relint";
const seedFeedback = (seed: string): void => {
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(
    join(seed, "plan", "feedback", `${FEEDBACK_ID}.yaml`),
    // The REAL schema — `triagePrompt` reads entry.attachments.length, so an entry missing it
    // throws before the worker is even spawned (which is how this fixture first failed).
    [
      `id: ${FEEDBACK_ID}`,
      "ts: 2026-08-02T00:00:00.000Z",
      'raw: "a fixture feedback entry for the relint loop"',
      "origin: human",
      "attachments: []",
      "status: new",
      "",
    ].join("\n"),
  );
};

test("TRIAGE LANE: a dirty filing is relinted with the real violations, and the clean redraft proceeds", async () => {
  let attempts = 0;
  const prompts: string[] = [];
  const ledger = await withLane(seedFeedback, async () => {
    const { triageCommand } = await import("../src/run-task.js");
    await triageCommand([FEEDBACK_ID], {
      spawn: async (args: { cwd: string; prompt: string }) => {
        attempts++;
        prompts.push(args.prompt);
        const dir = join(args.cwd, "plan", "tasks.d");
        mkdirSync(dir, { recursive: true });
        const id = reservedFromPrompt(args.prompt);
        writeFileSync(join(dir, `${id}-x.yaml`), attempts === 1 ? DIRTY_TASK(id) : CLEAN_TASK(id));
        return fakeWorker(`PROPOSED: file ${id}`);
      },
    } as never).catch(() => undefined);
  });

  assert.equal(attempts, 2, "the dirty filing bought exactly one redraft");
  assert.match(prompts[1], /FAILED the plan's own linter/);
  assert.match(prompts[1], /\[proof-dialect\]/, "the worker is handed the linter's own finding");
  assert.equal(ledger.filter((l) => l.step === "triage.relint").length, 1);
  assert.equal(ledger.filter((l) => l.step === "triage.relint_refused").length, 0);
});

test("TRIAGE LANE: the AGGREGATE assertion — what the loop lets through has NO blocking violation at all", async () => {
  // Trap 3: a test that pins one rule passes while a different rule blocks the PR. This asserts the
  // whole linter's blocking set is empty for what the loop accepted, not that one check passed.
  let filedYaml = "";
  await withLane(seedFeedback, async () => {
    const { triageCommand } = await import("../src/run-task.js");
    await triageCommand([FEEDBACK_ID], {
      spawn: async (args: { cwd: string; prompt: string }) => {
        const id = reservedFromPrompt(args.prompt);
        const dir = join(args.cwd, "plan", "tasks.d");
        mkdirSync(dir, { recursive: true });
        filedYaml = CLEAN_TASK(id);
        writeFileSync(join(dir, `${id}-x.yaml`), filedYaml);
        return fakeWorker(`PROPOSED: file ${id}`);
      },
    } as never).catch(() => undefined);
  });

  const task = parseTasksFromYaml(filedYaml, "filed")[0];
  const blocking = lintTask(task).violations.filter((v) => v.severity === "block");
  assert.deepEqual(blocking.map((v) => v.check), [], `the accepted filing must have NO blocking violation; got ${JSON.stringify(blocking, null, 2)}`);
});

test("TRIAGE LANE: an unconverged filing refuses, ledgers the reason, and opens no PR", async () => {
  let attempts = 0;
  const ledger = await withLane(seedFeedback, async () => {
    const { triageCommand } = await import("../src/run-task.js");
    await triageCommand([FEEDBACK_ID], {
      spawn: async (args: { cwd: string; prompt: string }) => {
        attempts++;
        const id = reservedFromPrompt(args.prompt);
        const dir = join(args.cwd, "plan", "tasks.d");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}-x.yaml`), DIRTY_TASK(id));
        return fakeWorker(`PROPOSED: file ${id}`);
      },
    } as never).catch(() => undefined);
  });

  assert.equal(attempts, MAX_RELINT_ATTEMPTS, "bounded on the lane that fires unattended");
  const refused = ledger.filter((l) => l.step === "triage.relint_refused");
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0].checks, ["proof-dialect"]);
  assert.equal(ledger.filter((l) => l.step === "pr.opened").length, 0, "no PR — this is the $1.48 that is no longer spent on a doomed filing");
});
