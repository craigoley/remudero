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
import {
  implementPromptParts,
  renderImplementPrompt,
  renderImplementPromptWithParts,
} from "../src/lib/prompt-render.js";
import { commitWorkerEdits, harnessCommitForShellLessWorker } from "../src/run-task.js";
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
    // THE FIXTURE MUST CARRY ITS OWN IDENTITY. `commitWorkerEdits` shells `git commit` directly, so
    // it inherits the AMBIENT environment — which on a dev machine has a ~/.gitconfig and on a CI
    // runner has nothing ("fatal: empty ident name"). The shared helper's own env covers only the
    // calls it makes itself. Configuring the repo locally makes this test read the same on both.
    handle.git("config", "user.email", "harness@example.test");
    handle.git("config", "user.name", "harness fixture");
    handle.git("config", "commit.gpgsign", "false");
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

test("the harness contract reaches the RENDERED implement prompt, by every entry point", () => {
  // The contract lines are only worth anything if they survive prompt assembly. Asserting
  // `outputContractLines` alone proves the strings exist, not that a worker is ever shown them —
  // so this drives the three real entry points a dispatch uses: `implementPromptParts`,
  // `renderImplementPromptWithParts` and `renderImplementPrompt`.
  const task = {
    id: "W1-T1", title: "t", prompt: "do the thing",
    acceptance: [{ claim: "c", proof: "unit test: x" }],
    files: ["src/a.ts"], type: "implement", risk: "low",
  } as never;

  const shellPrompt = renderImplementPrompt(task, "", "run-1");
  const harnessPrompt = renderImplementPrompt(task, "", "run-1", "", "", "", "", true);

  // The shell arm is UNCHANGED — this is what every lane renders today.
  assert.match(shellPrompt, /stage the changed file\(s\) and commit/);
  assert.doesNotMatch(shellPrompt, /Do NOT run git or gh/);

  // The harness arm tells the worker the harness owns git, and asks for the subject instead.
  assert.match(harnessPrompt, /Do NOT run git or gh/);
  assert.match(harnessPrompt, /COMMIT_MESSAGE:/);
  assert.doesNotMatch(harnessPrompt, /stage the changed file\(s\) and commit/);

  // `renderImplementPromptWithParts` returns the SAME prompt it reports parts for, so a provenance
  // manifest built from the parts cannot describe a different string than the worker was sent.
  const withParts = renderImplementPromptWithParts(task, "", "run-1", "", "", "", "", true);
  assert.equal(withParts.prompt, harnessPrompt);

  // WHERE THE CONTRACT ACTUALLY LIVES, asserted rather than assumed: it is assembled in
  // `renderImplementPromptWithParts`, NOT in `implementPromptParts` — the parts are the CONTEXT
  // blocks the provenance manifest hashes, and the output contract is deliberately outside them
  // (`renderImplementPromptWithParts`'s own comment: "an output-only contract, deliberately
  // outside `# CONTEXT`"). Asserting the opposite would pin a shape this file does not have.
  const parts = implementPromptParts(task, "", "run-1", "", "", "", "", true);
  assert.equal(
    parts.some((p) => /Do NOT run git or gh/.test(p.value)),
    false,
    "the contract is output-only and stays out of the CONTEXT parts",
  );
  // The parts must still be the ones the prompt was built from, or a manifest describes a
  // different string than the worker was sent.
  for (const part of parts) assert.ok(harnessPrompt.includes(part.value), `part ${part.name} must ride the prompt`);
});

test("the harness commit step is driven end to end, every branch of it", () => {
  // COVERS THE BRANCH THAT DECIDES WHETHER A RUN PRODUCES A PULL REQUEST AT ALL. Inline in the
  // implement dispatch this was thirteen lines no test reached, and `diff-coverage` refused them by
  // name. Reasoning around a branch's edges is not the same as exercising it.
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const base = {
    harnessOwnsGit: true, worktreePath: "/w", declaredPaths: ["src"], commitCount: 0,
    log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra }),
    say: (msg: string) => said.push(msg),
  };

  // (a) NO ANCHORED SUBJECT: refused, nothing committed, the count is handed back untouched.
  let committedWith: string | undefined;
  const never = harnessCommitForShellLessWorker(
    { ...base, report: "REPORT\nno subject here" },
    { commit: (_w, _p, m) => { committedWith = m; return { committed: true, sha: "x", undeclared: [] }; } },
  );
  assert.equal(never, 0);
  assert.equal(committedWith, undefined, "no message must mean no commit — never an invented subject");
  assert.equal(lines.at(-1)?.step, "implement.harness_commit_refused");

  // (b) THE COMMIT REFUSES (everything outside the declared surface): the count stays, and the
  //     undeclared paths are named so an operator can see why nothing shipped.
  const refused = harnessCommitForShellLessWorker(
    { ...base, report: "REPORT\nCOMMIT_MESSAGE: feat(a): b" },
    { commit: () => ({ committed: false, undeclared: ["stray.txt"], reason: "all outside" }) },
  );
  assert.equal(refused, 0, "a refused commit must not move the caller's count");
  assert.equal(lines.at(-1)?.step, "implement.harness_commit_refused");
  assert.deepEqual(lines.at(-1)?.extra?.undeclared, ["stray.txt"]);
  assert.equal(said.length, 0, "nothing was committed, so nothing is announced");

  // (c) THE COMMIT LANDS: the count is RE-READ, which is what clears the no_pr guard and lets the
  //     existing fallback push and PR creation carry the run home.
  const landed = harnessCommitForShellLessWorker(
    { ...base, report: "REPORT\nCOMMIT_MESSAGE: feat(a): b" },
    { commit: (_w, _p, m) => { committedWith = m; return { committed: true, sha: "abcdef1234", undeclared: [] }; }, ahead: () => 1 },
  );
  assert.equal(landed, 1, "a landed commit re-reads the count, which is what clears the no_pr guard");
  assert.equal(committedWith, "feat(a): b", "the worker's own subject is what gets committed");
  assert.equal(lines.at(-1)?.step, "implement.harness_commit");
  assert.equal(lines.at(-1)?.extra?.sha, "abcdef1234");
  assert.match(said.at(-1)!, /had no shell of its own/);
});

test("the harness commit step declines outright for a worker that had its own shell", () => {
  // THE PRECONDITION LIVES WITH THE STEP, so the caller is one unconditional line and this branch
  // is exercised rather than inferred. A shell-capable worker keeps its long-standing verdict.
  let called = false;
  const commit = () => { called = true; return { committed: true, sha: "x", undeclared: [] }; };
  const log = () => {};
  const say = () => {};
  const shellful = harnessCommitForShellLessWorker(
    { harnessOwnsGit: false, commitCount: 0, report: "REPORT\nCOMMIT_MESSAGE: feat(a): b", worktreePath: "/w", declaredPaths: ["src"], log, say },
    { commit },
  );
  assert.equal(shellful, 0);
  assert.equal(called, false, "a worker with a shell commits for itself; the harness must not step in");

  // And a worker that ALREADY committed is left alone too — the step only rescues an empty branch.
  const already = harnessCommitForShellLessWorker(
    { harnessOwnsGit: true, commitCount: 3, report: "REPORT\nCOMMIT_MESSAGE: feat(a): b", worktreePath: "/w", declaredPaths: ["src"], log, say },
    { commit },
  );
  assert.equal(already, 3);
  assert.equal(called, false);
});
