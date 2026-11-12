// W1-T10355. MEASURED by the ci-friction gardener: check:proof-discrimination cost 32.2 PR minutes across 14 fix
// rounds on 9 PRs, and the rounds came from the daemon publishing a PR its OWN pre-open check already knew was red:
// an exit-1 proof was opened with a "Pre-open proof failure" note, and the hosted gate then refused it. These cases
// drive the REAL runTask against a local origin (criterion 1), the real stale-proof correction against a real git
// history (criterion 2), and the daemon's real opener (criterion 3).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import * as prOpen from "#src/lib/pr-open.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult, spawnWorker } from "#src/lib/worker.js";
import * as runTaskModule from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK_ID = "W1-T990355";
/** A registered suite owner: an unregistered one parses no `unit test:` proof, so no title could ever be proposed. */
const OWNER = "craigoley";
const FAILING_PROOF = "grep: NEVER_WRITTEN_MARK in README.md";
const NEW_TITLE = "the new behaviour holds after the change";

type Row = Record<string, unknown>;

function planFor(proof: string, files: readonly string[]): string {
  return [
    `- id: ${TASK_ID}`,
    "  title: a known-red proof never opens a pr",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    `  files: [${files.join(", ")}]`,
    "  origin: test",
    "  status: queued",
    "  acceptance:",
    "    - claim: the readme carries the mark",
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "test-session", costUsd: 0.02, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

/** Recon succeeds; the implement worker writes `files` and commits, reporting no PR, so the harness pushes and opens. */
function committingSpawn(files: Record<string, string>): typeof spawnWorker {
  let calls = 0;
  return (async (args: { cwd: string }) => {
    calls += 1;
    if (calls % 2 === 1) return workerResult("RECON REPORT\nOBSERVED: fixture\n");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(args.cwd, rel, ".."), { recursive: true });
      writeFileSync(join(args.cwd, rel), content);
    }
    execFileSync("git", ["-C", args.cwd, "add", "-A"]);
    execFileSync("git", ["-C", args.cwd, "-c", "user.email=w@remudero.invalid", "-c", "user.name=w", "commit", "-qm", "fix: the worker's change"]);
    return workerResult("REPORT\ncommitted, no PR opened\n");
  }) as unknown as typeof spawnWorker;
}

interface DaemonBuild {
  rows: Row[];
  created: string[][];
  issues: Array<{ title: string; body: string }>;
  origin: string;
  verdict: string;
}

/** One real runTask build against a bare origin seeded with `seed`, its pre-open proofs answered by `answer`. */
async function daemonBuild(
  t: TestContext,
  plan: string,
  seed: Record<string, string>,
  change: Record<string, string>,
  answer: prOpen.AsyncOpenPullRequestProofRunner,
): Promise<DaemonBuild> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}known-red-root-`));
  const origin = gitRepo({ bare: true, kind: "known-red-origin" });
  const seedRepo = gitRepo({ cloneFrom: origin.dir, kind: "known-red-seed" });
  t.after(() => {
    origin.cleanup();
    seedRepo.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, plan);
  for (const [rel, content] of Object.entries({ ...seed, "plan/tasks.yaml": plan })) {
    mkdirSync(join(seedRepo.dir, rel, ".."), { recursive: true });
    writeFileSync(join(seedRepo.dir, rel), content);
  }
  seedRepo.git("add", "-A");
  seedRepo.git("commit", "-q", "-m", "seed");
  seedRepo.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  const created: string[][] = [];
  const issues: Array<{ title: string; body: string }> = [];
  const gateway: IssueGateway = {
    create: (title, body) => {
      issues.push({ title, body });
      return `https://github.com/${OWNER}/remudero/issues/${issues.length}`;
    },
    listOpen: () => [],
    ensureLabel: () => true,
  };
  const result = await withLiveWritesAllowed(() =>
    runTaskModule.runTask(TASK_ID, {
      skipGitSync: true,
      owner: OWNER,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn: committingSpawn(change),
      containmentExec: holdingContainmentExec,
      isolationExec: cleanIsolationExec,
      otherOpenPrReader: async () => [],
      prOpenProofRunner: answer,
      prOpenRefusalIssues: gateway,
      prCreateExec: (_command, args) => {
        created.push(args);
        return "";
      },
    }),
  );
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  return { rows, created, issues, origin: origin.dir, verdict: result.verdict };
}

function originHead(origin: string, branch: string): string {
  return execFileSync("git", ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
}

const STALE_OUTPUT = "discrimination: executed_stale — this proof matches BOTH head and base";
const FAIL_OUTPUT = "verdict:    fail\ncause:      grep finds no match for NEVER_WRITTEN_MARK";

for (const [status, stdout, refusalClass] of [[1, FAIL_OUTPUT, "branch-gap"], [5, STALE_OUTPUT, "stale-proof"]] as const) {
  test(`a daemon build whose filed proof exits ${status} at pre-open is refused, never created, and keeps its branch`, async (t) => {
    const proofRuns: string[] = [];
    const build = await daemonBuild(t, planFor(FAILING_PROOF, ["README.md"]), { "README.md": "seed\n" }, { "README.md": "seed\nchange\n" },
      async (proof) => {
        proofRuns.push(proof);
        return { status, stdout, stderr: "" };
      });
    assert.deepEqual(proofRuns, [FAILING_PROOF], "the filed proof ran once; a conclusive answer is never re-run");
    assert.deepEqual(build.created, [], "the PR create was never sent");
    assert.equal(build.rows.filter((row) => row.step === "pr.opened_with_failing_proof").length, 0);
    const refused = build.rows.filter((row) => row.step === "pr.open_refused");
    assert.equal(refused.length, 1, "the refusal is ledgered once");
    const row = refused[0]!;
    assert.equal(row.refusal_class, refusalClass);
    assert.match(String(row.branch), new RegExp(`^run-${TASK_ID}-\\d+$`));
    assert.match(String(row.head_sha), /^[0-9a-f]{40}$/);
    assert.equal(row.proof, FAILING_PROOF, "the row names the proof");
    assert.equal(row.proof_status, status, "and its check-proof exit");
    assert.ok(String(row.proof_output).includes(stdout.split("\n").at(-1)!), "and its check-proof output");
    assert.ok(String(row.proof_output).length <= prOpen.REFUSED_PROOF_DETAIL_MAX + 1, "bounded");
    assert.equal(originHead(build.origin, String(row.branch)), row.head_sha, "the branch is kept on origin at the refused head");
    const verdict = build.rows.find((r) => r.step === "verdict") ?? {};
    assert.equal(verdict.verdict, "failed");
    assert.equal(verdict.stage, "pr_open.refused");
    assert.equal(verdict.cause, "base-proof-refused");
    assert.equal(build.verdict, "failed");
    assert.equal(build.issues.length, status === 5 ? 1 : 0, "only a stale proof escalates for an amendment");
  });
}

test("a bounded check-proof output on the refusal row keeps the tail of a long run", () => {
  const rows: Array<{ step: string; extra?: Row }> = [];
  const long = `${"x".repeat(5000)}\nverdict:    fail`;
  prOpen.recordRefusedPrOpen(
    new prOpen.PrOpenRefusedError("branch-gap", "W1-T1 proof did not pass", undefined, undefined, undefined, { proof: "grep: a in b", status: 1, detail: long }),
    { taskId: "W1-T1", branch: "run-W1-T1-1", headSha: "a".repeat(40) },
    (step, extra) => rows.push({ step, extra }),
    { issues: { create: () => assert.fail("a branch gap raises no issue") }, ledgerPath: join(tmpdir(), "unused-ledger.ndjson"), runId: "W1-T1-1" },
  );
  const output = String(rows[0]?.extra?.proof_output);
  assert.equal(output.length, prOpen.REFUSED_PROOF_DETAIL_MAX + 1);
  assert.match(output, /verdict: {4}fail$/);
});

// ---- criterion 2: the deterministic stale-proof correction -------------------------------------------------------

const DECLARED = "test/a-new-surface.test.ts";

/** A checkout whose origin/main holds `base`, and whose HEAD adds `head` on top. */
function history(t: TestContext, base: Record<string, string>, head: Record<string, string>): string {
  const repo = gitRepo({ kind: "stale-proof-correction", scope: t });
  const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(repo.dir, rel, ".."), { recursive: true });
      writeFileSync(join(repo.dir, rel), content);
    }
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "fixture");
  };
  write({ "README.md": "seed\n", ...base });
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  write({ "README.md": "seed\nchange\n", ...head });
  return repo.dir;
}

const staleRefusal = () =>
  new prOpen.PrOpenRefusedError("stale-proof", `${TASK_ID} proof did not pass against merge base (grep: seed in README.md): executed_stale`,
    undefined, undefined, undefined, { proof: "grep: seed in README.md", status: 5, detail: STALE_OUTPUT });

/** A proof runner passing exactly the titles in `passing`, recording every proof and base it was asked for. */
function passingTitles(passing: readonly string[]): { run: prOpen.AsyncOpenPullRequestProofRunner; asked: Array<[string, string | undefined]> } {
  const asked: Array<[string, string | undefined]> = [];
  return {
    asked,
    run: async (proof, base) => {
      asked.push([proof, base]);
      return passing.some((title) => proof === `unit test: ${title}`) ? { status: 0, stdout: "verdict:    pass" } : { status: 5, stdout: STALE_OUTPUT };
    },
  };
}

const AT = { changedFiles: ["README.md", DECLARED], declaredFiles: ["README.md", DECLARED] };

test("W1-T10355 criterion 2: exactly one qualifying title that passes check-proof --base is proposed", async (t) => {
  const dir = history(t, { "test/old.test.ts": 'test("an old title already on main", () => {});\n' }, {
    [DECLARED]: [
      `test(${JSON.stringify(NEW_TITLE)}, () => {});`,
      'test("an old title already on main", () => {});',
      "test(`a template ${'title'} never qualifies`, () => {});",
      'it("a second new title the re-check fails", () => {});',
      "",
    ].join("\n"),
  });
  const runner = passingTitles([NEW_TITLE]);
  const correction = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, dir, runner.run);
  assert.equal(correction?.outcome, "proposed");
  assert.equal(correction?.proposedProof, `unit test: ${NEW_TITLE}`);
  assert.deepEqual(correction?.candidates, [NEW_TITLE, "a second new title the re-check fails"],
    "a title present at the merge base and a template title are never candidates");
  const mergeBase = execFileSync("git", ["-C", dir, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  assert.ok(runner.asked.every(([, base]) => base === mergeBase), "every candidate is re-checked against the merge base");
});

test("W1-T10355 criterion 2: the proposal goes only to the amend-proof escalation as its named proposal", async (t) => {
  const dir = history(t, {}, { [DECLARED]: `test(${JSON.stringify(NEW_TITLE)}, () => {});\n` });
  const proofCorrection = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, dir, passingTitles([NEW_TITLE]).run);
  const rows: Array<{ step: string; extra?: Row }> = [];
  const raised: Array<{ title: string; body: string }> = [];
  const url = prOpen.recordRefusedPrOpen(
    staleRefusal(),
    { taskId: TASK_ID, branch: `run-${TASK_ID}-1`, headSha: "d".repeat(40), ...AT, proofCorrection },
    (step, extra) => rows.push({ step, extra }),
    {
      issues: { create: (title, body) => (raised.push({ title, body }), "https://example.invalid/issues/1"), listOpen: () => [], ensureLabel: () => true },
      ledgerPath: join(tmpdir(), "unused-ledger.ndjson"),
      runId: `${TASK_ID}-1`,
    },
  );
  assert.equal(url, "https://example.invalid/issues/1");
  const amendment = rows.find((row) => row.step === prOpen.PR_OPEN_STALE_PROOF_AMENDMENT_STEP)?.extra ?? {};
  assert.equal(amendment.proposed_proof, `unit test: ${NEW_TITLE}`);
  assert.equal(amendment.proof, "grep: seed in README.md");
  assert.equal(rows.find((row) => row.step === "pr.open_refused")?.extra?.proof_correction, "proposed");
  assert.equal(raised.length, 1);
  assert.ok(raised[0]!.body.includes(`unit test: ${NEW_TITLE}`), "the escalation names the proposal");
  assert.match(raised[0]!.body, /amend-proof/);
});

test("W1-T10355 criterion 2: zero or several candidates, or a failing re-check, propose nothing", async (t) => {
  const two = [`test(${JSON.stringify(NEW_TITLE)}, () => {});`, 'test("another new title", () => {});', ""].join("\n");
  const several = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, history(t, {}, { [DECLARED]: two }),
    passingTitles([NEW_TITLE, "another new title"]).run);
  assert.equal(several?.outcome, "several-candidates");
  assert.equal(several?.proposedProof, undefined);

  const failing = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, history(t, {}, { [DECLARED]: two }), passingTitles([]).run);
  assert.equal(failing?.outcome, "no-candidate");
  assert.equal(failing?.proposedProof, undefined);

  // Not unique at head: the title also sits in another test file. Not declared: the title is in an undeclared file.
  const zeroRunner = passingTitles([NEW_TITLE, "an undeclared title"]);
  const zero = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, history(t, {}, {
    [DECLARED]: `test(${JSON.stringify(NEW_TITLE)}, () => {});\n`,
    "test/elsewhere.test.ts": `// ${NEW_TITLE}\ntest("an undeclared title", () => {});\n`,
  }), zeroRunner.run);
  assert.equal(zero?.outcome, "no-candidate");
  assert.deepEqual(zero?.candidates, []);
  assert.deepEqual(zeroRunner.asked, [], "no candidate means no check-proof run");

  const rows: string[] = [];
  const raised: string[] = [];
  prOpen.recordRefusedPrOpen(staleRefusal(), { taskId: TASK_ID, branch: `run-${TASK_ID}-1`, headSha: "e".repeat(40), ...AT, proofCorrection: several },
    (step) => rows.push(step),
    { issues: { create: (_t, body) => (raised.push(body), "u"), listOpen: () => [], ensureLabel: () => true }, ledgerPath: join(tmpdir(), "unused-ledger.ndjson"), runId: "r" });
  assert.ok(!rows.includes(prOpen.PR_OPEN_STALE_PROOF_AMENDMENT_STEP));
  assert.doesNotMatch(raised[0] ?? "", /Proposed proof/, "the escalation stays as it was");
});

test("W1-T10355 criterion 2: only an escalating stale-proof refusal is corrected", async (t) => {
  const dir = history(t, {}, { [DECLARED]: `test(${JSON.stringify(NEW_TITLE)}, () => {});\n` });
  const runner = passingTitles([NEW_TITLE]);
  const gap = new prOpen.PrOpenRefusedError("branch-gap", "proof did not pass");
  assert.equal(await prOpen.proposeStaleProofReplacement(gap, AT, dir, runner.run), undefined, "a red proof is a code defect, never corrected");
  assert.equal(await prOpen.proposeStaleProofReplacement(staleRefusal(), { changedFiles: [DECLARED], declaredFiles: AT.declaredFiles }, dir, runner.run),
    undefined, "a test-only build is retired as satisfied by main");
  assert.equal(await prOpen.proposeStaleProofReplacement(staleRefusal(), { changedFiles: AT.changedFiles, declaredFiles: [DECLARED] }, dir, runner.run),
    undefined, "a guard task keeps its own guard-proof amendment");
  assert.deepEqual(runner.asked, []);
  const many = Array.from({ length: prOpen.STALE_PROOF_CANDIDATE_LIMIT + 1 }, (_, i) => `test("bounded title ${String.fromCharCode(97 + i)}", () => {});`);
  const bounded = await prOpen.proposeStaleProofReplacement(staleRefusal(), AT, history(t, {}, { [DECLARED]: `${many.join("\n")}\n` }), runner.run);
  assert.equal(bounded?.outcome, "too-many-candidates");
  assert.deepEqual(runner.asked, [], "past the bound no check-proof is spent");
});

test("W1-T10355 criterion 2: a daemon build's stale proof names its one replacement, never in a pr body or the branch", async (t) => {
  const plan = planFor("grep: seed in README.md", ["README.md", DECLARED]);
  const build = await daemonBuild(t, plan, { "README.md": "seed\n" },
    { "README.md": "seed\nchange\n", [DECLARED]: `test(${JSON.stringify(NEW_TITLE)}, () => {});\n` },
    async (proof) => proof === `unit test: ${NEW_TITLE}` ? { status: 0, stdout: "verdict:    pass" } : { status: 5, stdout: STALE_OUTPUT });
  assert.deepEqual(build.created, [], "no PR is created on a stale proof, corrected or not");
  const amendment = build.rows.find((row) => row.step === prOpen.PR_OPEN_STALE_PROOF_AMENDMENT_STEP) ?? {};
  assert.equal(amendment.proposed_proof, `unit test: ${NEW_TITLE}`);
  assert.equal(build.issues.length, 1);
  assert.ok(build.issues[0]!.body.includes(`unit test: ${NEW_TITLE}`));
  const refused = build.rows.find((row) => row.step === "pr.open_refused") ?? {};
  const head = originHead(build.origin, String(refused.branch));
  assert.equal(head, refused.head_sha, "the branch was not rewritten after the refusal");
  const branchPlan = execFileSync("git", ["--git-dir", build.origin, "show", `${head}:plan/tasks.yaml`], { encoding: "utf8" });
  assert.equal(branchPlan, plan, "the build branch's plan still carries the filed proof");
});

// ---- criterion 3: W1-T10742's inconclusive open stands, a conclusive failure does not open -------------------------

const OPEN_BRANCH = "run-W1-T9-1";
const OPEN_PROOF = "grep: marker in note.md";

function filedRunBranch(t: TestContext): string {
  const repo = gitRepo({ kind: "known-red-open", scope: t });
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), [
    "- id: W1-T9", "  title: fixture", "  repo: remudero", "  type: implement", "  acceptance:",
    "    - claim: the fixture claim", `      proof: ${JSON.stringify(OPEN_PROOF)}`, "",
  ].join("\n"));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  writeFileSync(join(repo.dir, "note.md"), "marker\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: change");
  return repo.dir;
}

const answering = (statuses: readonly number[]): prOpen.AsyncOpenPullRequestProofRunner => {
  let calls = 0;
  return async () => {
    const status = statuses[Math.min(calls++, statuses.length - 1)]!;
    return { status, stdout: status === 4 ? "verdict:    exec_error — truncated" : "verdict:    fail", stderr: "" };
  };
};

const openAsDaemon = (dir: string, runner: prOpen.AsyncOpenPullRequestProofRunner) =>
  withLiveWritesAllowed(() => runTaskModule.ghPrCreateFillCommandAsync(dir, "o", "r", OPEN_BRANCH, "feat(x): a subject", runner, true));

test("W1-T10355 criterion 3: an inconclusive proof still opens with its note while a conclusive failure is refused", async (t) => {
  const dir = filedRunBranch(t);
  const inconclusive = await openAsDaemon(dir, answering([4, 4]));
  const body = inconclusive.args.find((arg) => arg.startsWith("body=")) ?? "";
  assert.match(body, /## Pre-open proof inconclusive/);
  assert.ok((inconclusive.diagnostics ?? []).some((d) => d.step === "pr.opened_with_inconclusive_proof"));
  for (const statuses of [[1], [4, 1]]) {
    await assert.rejects(() => openAsDaemon(dir, answering(statuses)), (err: unknown) => {
      assert.ok(err instanceof prOpen.PrOpenRefusedError);
      assert.equal(err.refusalClass, "branch-gap");
      assert.equal(err.failingProof?.proof, OPEN_PROOF);
      assert.equal(err.refusedProof?.status, 1);
      return true;
    }, `statuses ${JSON.stringify(statuses)}`);
  }
});
