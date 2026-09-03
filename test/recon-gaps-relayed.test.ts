import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RECON_UNVERIFIED_PREFIX, renderReconPrompt, runTask } from "../src/run-task.js";
import { assertProvenance, contextBlocks } from "../src/lib/provenance.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

/**
 * THE RECON'S OWN WARNING NEVER REACHED THE WORKER WHO COULD ACT ON IT.
 *
 * `parseReconReport` (lib/worker.ts) fills OBSERVED, INFERRED and COULDN'T-VERIFY.
 * `reconObservedToContext` (run-task.ts) read `parsed?.observed` ALONE, so the other two were
 * computed on every dispatch and dropped before `renderImplementPrompt` was ever called.
 *
 * MEASURED, run W1-T409-1786487330401: a 5-turn recon wrote "THIS RECON ONLY CONFIRMED EXISTENCE,
 * NOT CONTENTS" and named the files to read first. That reached the ledger (`report.followups`)
 * and the operator's console and NOT the implement worker, which ran 73 turns, spent $4.08 and
 * produced zero commits.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY EACH IS NOT VACUOUS:
 *   1. THE GAP REACHES A REAL WORKER — the behavioural tests drive the REAL `runTask` through an
 *      injected spawn and read `spawnCalls[N].prompt`, and each proves it reached ITS OWN branch
 *      before asserting, so a fixture that silently took the other path cannot pass.
 *   2. AN EMPTY COULDN'T-VERIFY PRODUCES NOTHING — not an empty section. A heading with nothing
 *      under it is the silently-empty-block condition `reconDegradedContextNote`'s doc prevents.
 *   3. RECON IS BYTE-IDENTICAL. This changes what the IMPLEMENT worker receives and nothing else;
 *      proven against origin/main's own source text, not merely by absence of a substring.
 *   4. INFERRED IS STILL DROPPED — the argued half of the decision, asserted rather than assumed.
 *   5. IT DOES NOT BREAK THE PROVENANCE GATE, which throws at RENDER time on an uncited CONTEXT
 *      bullet while a string unit test passes green.
 */

const SRC_PATH = fileURLToPath(new URL("../src/run-task.ts", import.meta.url));
const SRC = readFileSync(SRC_PATH, "utf8");

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
  "- id: T-GAPS",
  "  title: recon gap relay probe",
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

/** A real bare origin plus a real clone, so `worktreeAdd` and the run's own git work offline. */
function gitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "gaps-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "gaps-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "gaps-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "gaps-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "gaps-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "gaps-test"]);
}

function fakeGh(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gaps-bin-"));
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
      // W1-T2268: `pollToGate`/`waitForCiGreen` no longer spend `gh pr view --json state,
      // statusCheckRollup` (GraphQL) — they read the rollup over REST — so the three argv shapes
      // below are what production now asks for. Answering them keeps this fixture's ORIGINAL
      // contract intact -- red CI on the first poll -- rather than changing what the test asserts.
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
  const root = mkdtempSync(join(tmpdir(), "gaps-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);
  const FIXED_TS = 1785100000000;
  const fakeBinDir = fakeGh(`run-T-GAPS-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-GAPS", {
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

/** Recon output with a COULDN'T-VERIFY section carrying `gap`, or none when `gap` is undefined. */
function reconText(gap?: string): string {
  return [
    "RECON REPORT",
    "OBSERVED: the repo has a README.md",
    "INFERRED: this looks like a fresh checkout",
    `COULDN'T-VERIFY: ${gap ?? ""}`,
    "",
  ].join("\n");
}

// ── DIRECTION 1: the gap REACHES a real implement worker, labelled ───────────────────────────

test("BEHAVIOURAL: a real implement worker receives recon's COULDN'T-VERIFY line, labelled as a gap", async (t) => {
  const GAP = "THIS RECON ONLY CONFIRMED EXISTENCE, NOT CONTENTS";
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: reconText(GAP) });
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  assert.equal(spawnCalls.length, 2, "recon then implement — the shape the assertions below assume");
  const implPrompt = String(spawnCalls[1].prompt);

  // REACHED ITS OWN BRANCH: the HEALTHY relay, not the degrade note.
  assert.match(implPrompt, /the repo has a README\.md/, "precondition: recon's OBSERVED line really was relayed");
  assert.doesNotMatch(implPrompt, /RECON CONTEXT ABSENT/, "precondition: this is the healthy path, not the degraded one");

  // THE FIX.
  assert.ok(implPrompt.includes(GAP), "the gap recon reported must reach the worker that can act on it");
  assert.ok(
    implPrompt.includes(`${RECON_UNVERIFIED_PREFIX}${GAP}`),
    "and it must be LABELLED — an unmarked gap reads as an established fact",
  );
  // The label must not leak onto the observation, or the two become indistinguishable again.
  assert.doesNotMatch(
    implPrompt,
    new RegExp(`${RECON_UNVERIFIED_PREFIX.replace(/[.*+?^${}()|[\]\\—]/g, "\\$&")}the repo has a README`),
    "the OBSERVED line must NOT carry the gap label",
  );
});

// ── DIRECTION 2: an EMPTY COULDN'T-VERIFY produces NOTHING, not an empty section ─────────────

test("BEHAVIOURAL: an empty COULDN'T-VERIFY contributes no line at all — no dangling label or heading", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: reconText(undefined) });
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  assert.equal(spawnCalls.length, 2);
  const implPrompt = String(spawnCalls[1].prompt);

  // REACHED ITS OWN BRANCH: the relay really ran — without this the next assertion would pass on a
  // prompt that never got a relay at all, proving nothing about the EMPTY case specifically.
  assert.match(implPrompt, /the repo has a README\.md/, "precondition: the healthy relay really happened");
  assert.doesNotMatch(implPrompt, /RECON CONTEXT ABSENT/, "precondition: not the degraded path");

  assert.ok(
    !implPrompt.includes(RECON_UNVERIFIED_PREFIX),
    "an empty COULDN'T-VERIFY must emit NO labelled line — a bare label is the empty-block defect",
  );
});

// ── THE ARGUED HALF: INFERRED stays dropped ──────────────────────────────────────────────────

test("BEHAVIOURAL: INFERRED is still NOT relayed — a conclusion recon drew but did not establish", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: reconText("a gap") });
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  const implPrompt = String(spawnCalls[1].prompt);

  // REACHED ITS OWN BRANCH: both other sections DID travel, so a bare absence of INFERRED here is
  // a real exclusion rather than a relay that never happened.
  assert.match(implPrompt, /the repo has a README\.md/, "precondition: OBSERVED travelled");
  assert.ok(implPrompt.includes("a gap"), "precondition: COULDN'T-VERIFY travelled");

  assert.doesNotMatch(
    implPrompt,
    /this looks like a fresh checkout/,
    "INFERRED must not travel: section() strips the label, so a relayed inference is indistinguishable from an observation",
  );
});

// ── RECON'S FIXED INSTRUCTION TEXT IS BYTE-IDENTICAL ─────────────────────────────────────────
//
// W1-T2632 gave `renderReconPrompt` two new OPTIONAL parameters (task, recordPath) so the recon
// spawn can finally be told which task it is reconning — the function's SIGNATURE and its
// returned ARRAY necessarily changed. What must still hold, and what this test now proves, is
// that the FIXED instruction string every recon has always received (the role sentence, the
// three read-only commands, the report format, the optional Follow-ups section) is untouched —
// this is still an implement/other-lane concern, not a rewrite of what recon is asked to do.

test("the RECON prompt's fixed instruction text is byte-identical to origin/main's — only an optional task/record pointer was added (W1-T2632)", () => {
  const mainSrc = execFileSync("git", ["show", "origin/main:src/run-task.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const fixedInstructionText = (src: string): string => {
    const start = src.indexOf('"You are a RECON worker. Do NOT modify anything.');
    assert.notEqual(start, -1, "the RECON role sentence must be findable in both trees");
    const endMarker = "for anything discovered that is out of THIS recon's scope.\",";
    const endIdx = src.indexOf(endMarker, start);
    assert.notEqual(endIdx, -1, "the Follow-ups sentence must be findable in both trees");
    return src.slice(start, endIdx + endMarker.length);
  };
  assert.equal(
    fixedInstructionText(SRC),
    fixedInstructionText(mainSrc),
    "recon's fixed instruction text must be unchanged, byte for byte",
  );

  // …and the rendered text really carries none of the new label, so the equality above is not the
  // only thing standing between recon and a leak.
  const recon = renderReconPrompt("(plan index)", "");
  assert.ok(!recon.includes(RECON_UNVERIFIED_PREFIX), "recon must not carry the implement-side label");
  assert.match(recon, /^You are a RECON worker\./, "recon keeps its own first sentence");
});

// ── THE PROVENANCE GATE, which throws at RENDER time ─────────────────────────────────────────

test("BEHAVIOURAL: the gap bullet is CITED, so the rendered prompt still passes assertProvenance", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: reconText("contents unread") });
    return result({ sessionId: "s-impl", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  await runFixture(t, spawn);
  const implPrompt = String(spawnCalls[1].prompt);

  // PRECONDITION: the linter really has something to look at, and the gap really is in the region.
  const blocks = contextBlocks(implPrompt);
  assert.ok(blocks.length >= 1, `the CONTEXT block must be populated for this to be a real check, got ${blocks.length}`);
  assert.ok(
    blocks.some((b) => b.join("\n").includes(RECON_UNVERIFIED_PREFIX)),
    "precondition: the gap bullet really sits INSIDE the provenance region, where a citation is required",
  );

  assert.doesNotThrow(() => assertProvenance(implPrompt), "a rendered implement prompt must still pass the gate");
});

// ── the falsifier ────────────────────────────────────────────────────────────────────────────

test("MUTANT: the relay reads couldntVerify, and the label is applied only to those lines", () => {
  const readsGaps = 'nonEmptyLines(parsed?.couldntVerify ?? "")';
  assert.equal(
    SRC.split(readsGaps).length - 1,
    1,
    "the substitution target must be UNIQUE or the mutant proves nothing",
  );

  const labelled = "`- ${RECON_UNVERIFIED_PREFIX}${l} ${citation(`recon#${taskId}`)}`";
  assert.equal(
    SRC.split(labelled).length - 1,
    1,
    "the substitution target must be UNIQUE or the mutant proves nothing",
  );

  // The OBSERVED mapper must NOT carry the label — if it did, the two kinds collapse and the
  // "labelled" assertion above would pass while conveying nothing.
  const plain = "`- ${l} ${citation(`recon#${taskId}`)}`";
  assert.equal(SRC.split(plain).length - 1, 1, "the OBSERVED mapper must exist, exactly once, unlabelled");
});
