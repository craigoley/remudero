import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderImplementPrompt, renderReconPrompt, runTask } from "../src/run-task.js";
import { IMPLEMENT_ROLE_LINES, outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { assertProvenance, contextBlocks } from "../src/lib/provenance.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

/**
 * THE IMPLEMENT PROMPT NEVER TOLD THE WORKER IT WAS IMPLEMENTING.
 *
 * MEASURED (state/recon-implement-acts-as-recon.md): `renderReconPrompt`'s first sentence is "You
 * are a RECON worker. Do NOT modify anything." `renderImplementPrompt` opened with the literal
 * string "# CONTEXT" and contained no role assignment at all. There is no system prompt on either
 * spawn, so the prompt text was the only thing distinguishing the two roles — and it did not.
 *
 * WHAT THE WORKER MET INSTEAD, top-down: recon's own OBSERVED lines stamped `[src: recon#<id>]`,
 * then a `# TASK` heading whose body is `task.prompt ?? task.title` — always the title, since zero
 * task records carry `prompt:` — which for a well-written shard is a DIAGNOSIS in the register a
 * recon report is written in. Five dispatches across the two best-specified tasks in the plan ended
 * in recon reports rather than code; one filed its own assignment as a `task:` follow-up.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY EACH IS NOT VACUOUS:
 *   1. THE SENTENCE REACHES A REAL WORKER — not a template. The behavioural tests drive the REAL
 *      `runTask` through an injected spawn and read `spawnCalls[N].prompt`, and each one first
 *      proves it reached ITS OWN branch (a healthy relay, or the degrade note) before reading the
 *      role line, so a fixture that silently took the other path cannot pass.
 *   2. RECON IS UNCHANGED. This is the load-bearing direction: a role sentence both spawns carried
 *      would distinguish nothing and the fix would be cosmetic.
 *   3. IT SURVIVES A COMPACTION. The failing runs were 43-109 turns, which is the regime the anchor
 *      exists for; a role that evaporates mid-run does not fix them.
 *   4. IT DOES NOT BREAK THE PROVENANCE GATE, which throws at RENDER TIME on an uncited CONTEXT
 *      block while a string unit test passes green.
 */

const ROLE = IMPLEMENT_ROLE_LINES.join("\n");

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T999",
    title: "the guard computes the count and throws it away",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "the row carries the count", proof: "unit test: test/x.test.ts" }],
    ...over,
  };
}

// ── THE DIRECTION THAT MAKES THE FIX A FIX: recon must NOT gain it ───────────────────────────

test("the RECON prompt is unchanged — it carries none of the implement role text", () => {
  const recon = renderReconPrompt("(plan index)", "");
  for (const line of IMPLEMENT_ROLE_LINES) {
    assert.ok(!recon.includes(line), `recon must not carry the implement role line: ${JSON.stringify(line)}`);
  }
  // …and still says what it always said, so this test cannot pass by recon losing its own role.
  assert.match(recon, /^You are a RECON worker\. Do NOT modify anything\./, "recon keeps its own first sentence");
});

test("the implement prompt LEADS with the role, mirroring where recon states its own", () => {
  const p = renderImplementPrompt(task(), "", "RUN-1");
  assert.ok(p.startsWith(ROLE), "the role is the FIRST thing in the prompt, not buried after the context");
  assert.match(p, /YOU write the code in this run/);
  assert.match(p, /not to investigate, summarise, or file as/, "it names the exact failure it exists to stop");
  assert.match(p, /report with no diff has FAILED/, "and says what a failed run looks like");
  // The old opening is still there, just no longer first.
  assert.match(p, /\n# CONTEXT\n/, "the CONTEXT section is unchanged");
});

// ── IT SURVIVES A COMPACTION, and the existing anchor invariant is untouched ─────────────────

test("the post-compaction ANCHOR carries the role too, so a long run cannot lose it", () => {
  const anchor = renderAnchorBlock(task(), "RUN-1");
  assert.ok(anchor.startsWith(ROLE), "a worker re-anchored at turn 80 is told who it is again");
  // W1-T36's existing invariant, re-asserted here because this change edits the same function.
  const contract = outputContractLines("W1-T999").join("\n");
  assert.equal(anchor.slice(anchor.length - contract.length), contract, "the hard-constraints tail is still byte-identical");
});

test("ONE constant feeds both renderings, so the turn-0 prompt and the anchor cannot drift apart", () => {
  assert.ok(renderImplementPrompt(task(), "", "R").includes(ROLE));
  assert.ok(renderAnchorBlock(task(), "R").includes(ROLE));
  assert.ok(IMPLEMENT_ROLE_LINES.length > 0, "sanity: the constant is not empty, which would make both checks vacuous");
});

// ── THE PROVENANCE GATE, which throws at RENDER time ─────────────────────────────────────────

test("the role sits ABOVE # CONTEXT, so the provenance linter never sees it and needs no citation", () => {
  const withRelay = renderImplementPrompt(task(), "- recon saw a thing [src: recon#W1-T999]", "RUN-1");

  // PRECONDITION: the linter really has something to look at here. Without this the next assertion
  // would pass on a prompt with no CONTEXT section at all, proving nothing.
  const blocks = contextBlocks(withRelay);
  assert.ok(blocks.length >= 2, `the CONTEXT block must be populated for this to be a real check, got ${blocks.length}`);
  assert.ok(
    blocks.every((b) => !b.join("\n").includes("You are an IMPLEMENT worker")),
    "no CONTEXT block may contain the role text — that is what would make it need a citation",
  );

  assert.doesNotThrow(() => assertProvenance(withRelay), "a rendered implement prompt must still pass the gate");
});

// ── BEHAVIOURAL: the sentence reaches a REAL worker, on BOTH recon outcomes ──────────────────

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const FIXTURE_PLAN = [
  "- id: T-ROLE",
  "  title: implement-role wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real bare origin plus a real clone, so `worktreeAdd` and the run's own git all work offline
 *  (mirrors test/recon-degrade.test.ts's `gitFixture`). */
function gitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "role-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "role-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "role-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "role-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "role-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "role-test"]);
}

function fakeGh(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "role-bin-"));
  const p = join(dir, "gh");
  writeFileSync(
    p,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      // W1-T2268 moved both poll loops off `gh pr view --json state,statusCheckRollup` onto REST,
      // so the three argv shapes below are what production now asks for. Answering them keeps this
      // fixture's ORIGINAL contract intact -- red CI on the first poll -- rather than changing what
      // the test asserts.
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"state\":\"failure\",\"statuses\":[]}'; exit 0 ;;",
      `    */pulls/*) echo '{"number":1,"state":"open","merged":false,"head":{"sha":"deadbee","ref":"${branch}"}}'; exit 0 ;;`,
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
  return dir;
}

async function runFixture(t: import("node:test").TestContext, spawn: typeof spawnWorker) {
  const root = mkdtempSync(join(tmpdir(), "role-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);
  const FIXED_TS = 1785100000000;
  const fakeBinDir = fakeGh(`run-T-ROLE-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-ROLE", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { res };
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test("BEHAVIOURAL: a REAL implement spawn receives the role — and the REAL recon spawn does not", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: the repo has a README.md\nINFERRED: -\nCOULDN'T-VERIFY: -\n" });
    }
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  assert.equal(spawnCalls.length, 2, "recon then implement — the shape the assertions below assume");

  const reconPrompt = String(spawnCalls[0].prompt);
  const implPrompt = String(spawnCalls[1].prompt);

  // REACHED ITS OWN BRANCH: this is the HEALTHY relay, not the degrade note.
  assert.match(implPrompt, /the repo has a README\.md/, "precondition: recon's OBSERVED line really was relayed");
  assert.doesNotMatch(implPrompt, /RECON CONTEXT ABSENT/, "precondition: this is the healthy path, not the degraded one");

  assert.ok(implPrompt.startsWith(ROLE), "THE FIX: a real implement worker is told who it is, first");
  for (const line of IMPLEMENT_ROLE_LINES) {
    assert.ok(!reconPrompt.includes(line), "and the real recon worker is NOT — the distinction is the point");
  }
  assert.match(reconPrompt, /^You are a RECON worker\./, "recon still states its own role");
});

test("BEHAVIOURAL: a DEGRADED recon still yields an implement worker that is told it implements", async (t) => {
  // THE RUN MOST AT RISK. A worker whose recon errored has no relay at all, so it has even less
  // reason to think it is the one building — and #1525's absence note was added on this path for
  // the same reason.
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length <= 2) {
      return result({ sessionId: `s-recon-${spawnCalls.length}`, subtype: "error_max_turns", isError: true, numTurns: 20 });
    }
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  assert.equal(spawnCalls.length, 3, "recon, bounded retry, implement");

  const implPrompt = String(spawnCalls[2].prompt);

  // REACHED ITS OWN BRANCH: the degrade note proves recon really failed twice.
  assert.match(implPrompt, /RECON CONTEXT ABSENT/, "precondition: this run really took the DEGRADED path");

  assert.ok(implPrompt.startsWith(ROLE), "the role leads here too — before the absence note, not instead of it");
});
