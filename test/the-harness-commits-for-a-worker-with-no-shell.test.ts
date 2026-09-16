/**
 * W1-T3696 step (1), WIRED — THE ONLY MISSING VERB.
 *
 * A worker whose tool bound carries no shell cannot run `git commit`, so today it reaches the
 * silent-no-op guard with nothing ahead of `origin/main` and the run ends `no_pr`. Everything
 * AFTER the commit already exists: the fallback push fires when the branch is absent from origin,
 * and the orchestrator opens the pull request when the worker reported no `PR_URL`. So committing
 * is the whole gap, and these fixtures pin the four things that make closing it safe:
 *
 *   the predicate  — only a spawn BOUNDED WITHOUT A SHELL is harness-committed. An unbounded
 *                    worker could have committed and chose not to; committing for it would rewrite
 *                    a long-standing verdict rather than enable a new lane.
 *   the contract   — the worker is TOLD the harness commits, and is told not to run git. Read from
 *                    the same flag as the predicate, so it cannot be told one thing and judged by
 *                    another. The ANCHOR carries it too, or a compaction re-injects the old rule.
 *   the message    — the worker names the subject; the harness never invents one, and refuses a
 *                    subject commitlint would reject at push time.
 *   the surface    — only the task's DECLARED files are staged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  IMPLEMENT_CASH_TOOLS,
  anchoredCommitMessage,
  cashCanServeToolSurface,
  cashFallbackRefusal,
  harnessOwnsGitFor,
  implementToolBound,
  parseReport,
  spawnWorker,
} from "../src/lib/worker.js";
import { outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { commitWorkerEdits, implementPromptParts, renderImplementPrompt, renderImplementPromptWithParts } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
// The SHARED builder, not a hand-rolled `git init`: test/fixture-copy-census.test.ts holds the
// population of files that shell git themselves at a baseline, and one more copy of this fixture
// is exactly what it exists to refuse.
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

test("only a spawn bounded without a shell is harness-committed", () => {
  // THE WHOLE POINT OF THE PREDICATE. An unbounded spawn inherits Bash, so it is NOT harness
  // committed — that is today's every-lane answer and it must stay byte-identical.
  assert.equal(harnessOwnsGitFor(undefined), false, "an unbounded spawn keeps its own shell");
  assert.equal(harnessOwnsGitFor(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]), false);
  // The live generic-route bounds both declare Bash, so neither flips to harness-committed.
  assert.equal(harnessOwnsGitFor(["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"]), false);
  // A cash-serveable surface has no shell, so the harness owns git for it.
  assert.equal(harnessOwnsGitFor(["Read", "Write", "Edit", "Grep", "Glob", "RunCheck"]), true);
});

test("a worker with no shell is told the harness commits, and told not to run git", () => {
  const shell = outputContractLines("W1-T1").join("\n");
  const harness = outputContractLines("W1-T1", true).join("\n");

  // The shell contract is UNCHANGED — this is the arm every lane uses today.
  assert.match(shell, /stage the changed file\(s\) and commit/);
  assert.match(shell, /LAST line is exactly: PR_URL/);

  // The harness contract replaces both, and says so in terms a worker can act on.
  assert.doesNotMatch(harness, /stage the changed file\(s\) and commit/);
  assert.match(harness, /Do NOT run git or gh/);
  assert.match(harness, /COMMIT_MESSAGE:/);
  assert.doesNotMatch(harness, /LAST line is exactly: PR_URL/);

  // THE ANCHOR CARRIES IT TOO. It is re-injected verbatim after every compaction, so if it kept
  // the shell contract a compacted run would be told to `git commit` at the exact moment it is
  // most likely to act on re-injected text.
  const task = { id: "W1-T1", title: "t", prompt: "do it", acceptance: [] };
  assert.match(renderAnchorBlock(task, "run-1", "", true), /Do NOT run git or gh/);
  assert.doesNotMatch(renderAnchorBlock(task, "run-1", "", false), /Do NOT run git or gh/);
});

test("the flag reaches the rendered prompt through every layer between run-task.ts and outputContractLines", () => {
  // BEHAVIOURAL, NOT A MENTION. `harnessCommits` is the LAST positional argument on all three of
  // `implementPromptParts`, `renderImplementPromptWithParts` and `renderImplementPrompt` — proving
  // it actually reaches `outputContractLines` (asserted directly above) requires driving those
  // three call sites themselves, or a caller could add the parameter and forget to pass it down.
  const task: Task = {
    id: "W1-T3696",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "high",
    verify: "auto",
    status: "queued",
    attempts: 0,
    prompt: "do it",
  };

  // implementPromptParts itself carries no NAMED context part for this flag — it exists only to
  // steer the trailing contract lines — so the parts array must stay identical either way. A
  // regression that added a part here (rather than plumbing the flag through) would show up as a
  // deepEqual failure, not a silent extra row.
  const partsShell = implementPromptParts(task, "recon", "run-1", "learnings", "notes");
  const partsHarness = implementPromptParts(task, "recon", "run-1", "learnings", "notes", "", "", true);
  assert.deepEqual(partsHarness, partsShell, "the flag steers the trailing contract, not the CONTEXT parts");

  // renderImplementPromptWithParts: the SAME parts, a DIFFERENT trailing contract.
  const withParts = renderImplementPromptWithParts(task, "recon", "run-1", "learnings", "notes", "", "", true);
  assert.deepEqual(withParts.parts, partsHarness);
  assert.match(withParts.prompt, /Do NOT run git or gh/);
  assert.doesNotMatch(withParts.prompt, /LAST line is exactly: PR_URL/);

  // renderImplementPrompt (the `.prompt`-only caller run-task.ts's initial spawn actually uses):
  // the harness-owned contract only appears when the flag is true, and the two renders otherwise
  // agree everywhere except that trailing contract.
  const shellPrompt = renderImplementPrompt(task, "recon", "run-1", "learnings", "notes");
  const harnessPrompt = renderImplementPrompt(task, "recon", "run-1", "learnings", "notes", "", "", true);
  assert.notEqual(harnessPrompt, shellPrompt, "the flag must move at least one byte of the rendered prompt");
  assert.doesNotMatch(shellPrompt, /Do NOT run git or gh/);
  assert.match(shellPrompt, /LAST line is exactly: PR_URL/);
  assert.match(harnessPrompt, /Do NOT run git or gh/);
  assert.doesNotMatch(harnessPrompt, /LAST line is exactly: PR_URL/);
});

test("the commit subject is the worker's, and an unusable one is refused rather than invented", () => {
  assert.equal(anchoredCommitMessage("COMMIT_MESSAGE: feat(x): do a thing"), "feat(x): do a thing");
  // Anchored to a line start, exactly like PR_URL — a mention inside prose is inert.
  assert.equal(anchoredCommitMessage("I would write COMMIT_MESSAGE: nope here"), undefined);
  // Last one wins when the contract is honoured twice.
  assert.equal(anchoredCommitMessage("COMMIT_MESSAGE: first\nCOMMIT_MESSAGE: second"), "second");
  // REFUSED, NOT REPAIRED: commitlint's header ceiling is 100 CHARACTERS, so an over-long subject
  // must fail here rather than at push time, and an empty one must never become a default.
  assert.equal(anchoredCommitMessage(`COMMIT_MESSAGE: ${"x".repeat(101)}`), undefined);
  assert.equal(anchoredCommitMessage("COMMIT_MESSAGE:   "), undefined);
  // And it rides the parsed report, so the caller reads one shape.
  assert.equal(parseReport("REPORT\nCOMMIT_MESSAGE: fix(y): z")?.commitMessage, "fix(y): z");
  assert.equal(parseReport("REPORT\nnothing anchored")?.commitMessage, undefined);
});

test("the harness commits only the declared surface, and refuses when there is nothing it may stage", () => {
  let handle: GitRepo | undefined;
  try {
    handle = gitRepo({ kind: "harness-commit" });
    const root = handle.dir;
    const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const before = head();

    // Nothing changed at all: refused, and the tree is untouched.
    const idle = commitWorkerEdits(root, ["src"], "feat(a): nothing");
    assert.equal(idle.committed, false);
    assert.equal(head(), before, "a refusal must not move HEAD");

    // A change OUTSIDE the declared surface alone: refused, and named so the operator can see it.
    writeFileSync(join(root, "stray.txt"), "stray\n");
    const stray = commitWorkerEdits(root, ["src"], "feat(a): stray");
    assert.equal(stray.committed, false);
    assert.deepEqual(stray.undeclared, ["stray.txt"]);
    assert.equal(head(), before);

    // A declared change: committed, and the stray file is left OUT of it rather than swept in.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const done = commitWorkerEdits(root, ["src"], "feat(a): add a");
    assert.equal(done.committed, true, done.reason);
    assert.notEqual(head(), before, "the harness commit moves HEAD, which is what clears the no_pr guard");
    assert.deepEqual(done.undeclared, ["stray.txt"]);

    const named = execFileSync("git", ["-C", root, "show", "--name-only", "--format=%s", "HEAD"], { encoding: "utf8" });
    assert.match(named, /feat\(a\): add a/);
    assert.match(named, /src\/a\.ts/);
    assert.doesNotMatch(named, /stray\.txt/, "an undeclared path must never ride the commit");
  } finally {
    handle?.cleanup();
  }
});

test("implement chooses its surface from what is running it, and the chain reaches harness-owned git", () => {
  // CLAUDE IS UNTOUCHED, both shapes. Implement passes `undefined` (unrestricted) today, and
  // review/manual pass their declared bound — neither may change because a cash row now exists.
  assert.equal(implementToolBound(undefined, undefined), undefined, "a claude implement stays unrestricted");
  assert.equal(implementToolBound("claude", undefined), undefined);
  const generic = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"];
  assert.deepEqual(implementToolBound("claude", generic), generic, "review/manual keep their declared bound");
  assert.deepEqual(implementToolBound("codex", generic), generic, "and so does every non-cash provider");

  // A CASH MOUNT GETS THE BOUNDED, SHELL-LESS SURFACE — the whole point.
  assert.deepEqual(implementToolBound("cash", undefined), IMPLEMENT_CASH_TOOLS);
  // "openweight" is the deprecated spelling of the same provider (W1-T3607) and must not slip
  // through to the unrestricted arm, which would hand a cash worker a shell it cannot use.
  assert.deepEqual(implementToolBound("openweight", undefined), IMPLEMENT_CASH_TOOLS);

  // THE SURFACE MUST ACTUALLY BE SERVEABLE, or the adapter throws at spawn instead of running.
  assert.equal(cashCanServeToolSurface(IMPLEMENT_CASH_TOOLS), true, "every tool must be one the cash adapter implements");
  assert.equal(IMPLEMENT_CASH_TOOLS.includes("Bash"), false, "the forge verbs stay absent");

  // AND THE CHAIN CLOSES: a cash mount yields a bound with no shell, which is exactly the
  // condition that makes the harness commit. Asserting the composition, not just the parts.
  assert.equal(harnessOwnsGitFor(implementToolBound("cash", undefined)), true);
  assert.equal(harnessOwnsGitFor(implementToolBound("claude", undefined)), false);
});

test("a blocked auction diverts implement only when it was told the harness owns git", async () => {
  const config = {
    claudeBin: "/bin/true",
    root: ".",
    dailyCapUsd: 5,
    workerProviders: {
      enabled: ["claude", "codex", "cash"],
      cashFallbackWhenBlocked: true,
      cashEndpoint: "https://example.test/",
    },
  };

  // THE GAP, STATED AS AN ASSERTION. An UNRESTRICTED implement spawn is refused a divert, because
  // `cashCanServeToolSurface` refuses an unbounded surface by construction — which is why a Claude
  // implement run could not survive a blocked auction no matter how much cash headroom existed.
  const unbounded = cashFallbackRefusal(config as never, undefined);
  assert.ok(unbounded, "an unbounded spawn must still be refused a divert");
  assert.match(unbounded, /not implementable by cash/);

  // WITH the equivalent surface the divert is eligible. This is exactly what `cashTools` hands the
  // fallback in place of the unrestricted `tools`, and it is the whole unlock.
  assert.equal(cashFallbackRefusal(config as never, IMPLEMENT_CASH_TOOLS), undefined);

  // ELIGIBILITY IS NEVER CONSENT. The operator switch is still required, and a missing cap still
  // refuses, so a divert cannot become unbounded spend by accident.
  const noConsent = { ...config, workerProviders: { ...config.workerProviders, cashFallbackWhenBlocked: false } };
  assert.match(cashFallbackRefusal(noConsent as never, IMPLEMENT_CASH_TOOLS)!, /has not enabled/);
  const noCap = { ...config, dailyCapUsd: null };
  assert.match(cashFallbackRefusal(noCap as never, IMPLEMENT_CASH_TOOLS)!, /dailyCapUsd is unset/);
});

test("the diverted spawn really receives the cash surface, through spawnWorker's own fallback", async () => {
  // BEHAVIOURAL, NOT PREDICATE-ONLY. Asserting `cashFallbackRefusal` alone cannot see whether the
  // fallback actually USES `cashTools` — an earlier revision of this suite passed while the wiring
  // was deleted. This drives the real `spawnWorker`, blocks the auction, and reads what the
  // diverted spawn was handed.
  const unreadable = { readable: false, windows: [], detail: "exhausted" };
  const settings = gitRepo({ kind: "divert" });
  const settingsFile = join(settings.dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
  const config = {
    claudeBin: "/bin/true",
    root: "/tmp",
    dailyCapUsd: 20,
    workerProviders: {
      enabled: ["claude", "codex", "cash"],
      cashFallbackWhenBlocked: true,
      cashEndpoint: "https://example.test/",
    },
  };

  let divertedTools: readonly string[] | undefined;
  let diverted = 0;
  const routing = {
    readClaude: async () => ({ provider: "claude", ...unreadable }),
    readCodex: async () => ({ provider: "codex", ...unreadable }),
    writeStatus: () => {},
    spawnOpenWeight: async (a: { tools?: readonly string[] }) => {
      diverted += 1;
      divertedTools = a.tools;
      return { provider: "cash", text: "ok", isError: false, subtype: "success" };
    },
  };

  // A spawn declaring a cash equivalent diverts, AND lands on that equivalent rather than on the
  // unrestricted surface it started with.
  await spawnWorker({
    cwd: settings.dir, prompt: "p", config, settingsFile, tools: undefined, cashTools: IMPLEMENT_CASH_TOOLS, providerRouting: routing,
  } as never);
  assert.equal(diverted, 1, "a declared cash equivalent must make the blocked auction divert");
  assert.deepEqual(divertedTools, IMPLEMENT_CASH_TOOLS, "the diverted spawn runs the CASH surface, not the unrestricted one");

  // And with no equivalent declared, the same blocked auction refuses rather than diverting onto a
  // surface the adapter would throw on.
  diverted = 0;
  await spawnWorker({
    cwd: settings.dir, prompt: "p", config, settingsFile, tools: undefined, providerRouting: routing,
  } as never).catch(() => {});
  assert.equal(diverted, 0, "an unbounded spawn with no declared equivalent must not divert");
  settings.cleanup();
});
