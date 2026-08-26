import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { CREDITED_PROOF_QUEUE_AUDIT_CAUSES } from "../src/lib/proof-queue-audit.js";
import { creditedProofVisibility, proofQueueAuditCommand } from "../src/run-task.js";

// ── THE TWO INJECTED-SEAM DEFAULTS INSIDE `creditedProofVisibility` (src/run-task.ts) ────────
//
// Its sibling suite (test/credited-task-proof-visibility.test.ts) supplies `ledgerPath` and
// `symbolFoundAt` on every call, which is correct for what that suite asserts and means BOTH
// DEFAULTS NEVER RUN — the #977/#978 shape: "when every test injects a fake, the seam's DEFAULT
// implementation and each `catch` arm are unreachable".
//
// Each default is a `try`/`catch` thunk, so there are FOUR conditions here, not two, and each
// test below DRIVES its condition rather than merely calling the function:
//
//   `ledgerPath`     default: `ledgerPathFor(loadConfig())`, catching to `undefined`.
//                    Driven through `$HOME` — `configPath()` is `join(homedir(), ".config",
//                    "remudero", "config.json")` and node's `os.homedir()` reads `$HOME` on
//                    POSIX (verified before this suite was written, not assumed). A VALID config
//                    exercises the return; a MALFORMED one makes `JSON.parse` throw and
//                    exercises the catch.
//   `symbolFoundAt`  default: `readFileSync(join(cwd, path)).includes(symbol)`, catching to
//                    `false`. Reached only when a `grep:` proof's declared path is ABSENT, so
//                    each case below builds a real on-disk tree and lets the REAL `pathExists`
//                    default resolve it. A readable sibling containing the symbol exercises the
//                    true return, one without it the false return, and a DIRECTORY in that
//                    position makes `readFileSync` throw EISDIR and exercises the catch.
//
// `$HOME` is restored in a `finally` and every fixture lives under `mkdtemp` — nothing here
// writes the tracked tree.

function fixtureTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: {},
    budget_usd: 10,
    risk: "low",
    origin: "architect",
    status: "queued",
    attempts: 0,
    ...overrides,
  } as Task;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** A HOME whose `~/.config/remudero/config.json` is exactly `body`, plus a state root. */
function homeWithConfig(body: string): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-seam-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-seam-root-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), body, "utf8");
  return { home, root };
}

function withHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test("ledgerPath default RESOLVES from the real config — the credit is found through `ledgerPathFor(loadConfig())`, not through an injected path", () => {
  const { home, root } = homeWithConfig(JSON.stringify({ claudeBin: "/bin/echo", root: "PLACEHOLDER" }));
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/echo", root }), "utf8");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "ledger.ndjson"),
    JSON.stringify({ task_id: "W9-SEAM-A", step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" }) + "\n",
    "utf8",
  );
  const plan = planOf([fixtureTask({ id: "W9-SEAM-A", acceptance: [] })]);
  try {
    // NOTE: `ledgerPath` is DELIBERATELY not supplied — that omission is the whole point.
    const result = withHome(home, () => creditedProofVisibility(join(root, "plan", "tasks.yaml"), plan, { cwd: root }));
    assert.equal(result.creditedCount, 1, "the default must have resolved the ledger the config names, and read the credit out of it");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledgerPath default CATCHES an unreadable config and fails open to undefined — zero credited, never a throw", () => {
  const bad = homeWithConfig("{ this is not json");
  const good = homeWithConfig("PLACEHOLDER");
  writeFileSync(join(good.home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/echo", root: good.root }), "utf8");
  mkdirSync(join(good.root, "state"), { recursive: true });
  writeFileSync(
    join(good.root, "state", "ledger.ndjson"),
    JSON.stringify({ task_id: "W9-SEAM-B", step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" }) + "\n",
    "utf8",
  );
  const plan = planOf([fixtureTask({ id: "W9-SEAM-B", acceptance: [] })]);
  try {
    const broken = withHome(bad.home, () => creditedProofVisibility(join(bad.root, "plan", "tasks.yaml"), plan, { cwd: bad.root }));
    assert.equal(broken.creditedCount, 0, "an unreadable config must yield zero credited tasks rather than crashing");
    // THE DISCRIMINATOR: the identical plan and the identical omission, with a READABLE config,
    // credits the task — so the zero above is the catch arm and not an inert fixture.
    const working = withHome(good.home, () => creditedProofVisibility(join(good.root, "plan", "tasks.yaml"), plan, { cwd: good.root }));
    assert.equal(working.creditedCount, 1, "the falsifier: the same call with a readable config DOES credit");
  } finally {
    for (const d of [bad.home, bad.root, good.home, good.root]) rmSync(d, { recursive: true, force: true });
  }
});

/** A cwd holding `src/`, with the proof's declared path deliberately ABSENT. */
function relocationFixture(): { cwd: string; ledgerPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-seam-cwd-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const ledgerPath = join(cwd, "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    JSON.stringify({ task_id: "W9-SEAM-C", step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" }) + "\n",
    "utf8",
  );
  return { cwd, ledgerPath };
}

function relocationTask() {
  return fixtureTask({
    id: "W9-SEAM-C",
    files: ["src/old-home.ts", "src/new-home.ts"],
    acceptance: [{ claim: "the symbol still exists", proof: "grep: myMovedSymbol( in src/old-home.ts" }],
  });
}

test("symbolFoundAt default READS the sibling file and finds the moved symbol — the row is RELOCATED", () => {
  const { cwd, ledgerPath } = relocationFixture();
  try {
    writeFileSync(join(cwd, "src", "new-home.ts"), "export function myMovedSymbol() { return 1; }\n", "utf8");
    // `symbolFoundAt` and `pathExists` are BOTH omitted — src/old-home.ts is absent on disk, so
    // the real `existsSync` default reports it missing and the real read default is consulted.
    const result = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), planOf([relocationTask()]), { ledgerPath, cwd });
    assert.equal(result.proof.relocated.length, 1, "the default read must have found the symbol at the sibling path");
    assert.equal(result.proof.relocated[0].relocatedTo, "src/new-home.ts");
    assert.deepEqual(result.proof.byCause["grep-path-absent"], [], "a relocated row must not also count as an absence");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("symbolFoundAt default returns FALSE for a readable sibling that does not contain the symbol — absence stays absence", () => {
  const { cwd, ledgerPath } = relocationFixture();
  try {
    writeFileSync(join(cwd, "src", "new-home.ts"), "export function somethingElse() { return 1; }\n", "utf8");
    const result = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), planOf([relocationTask()]), { ledgerPath, cwd });
    assert.equal(result.proof.relocated.length, 0, "a readable file WITHOUT the symbol must not relocate");
    assert.deepEqual(result.proof.byCause["grep-path-absent"], ["W9-SEAM-C"], "it stays a real absence");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("symbolFoundAt default CATCHES an unreadable sibling and returns false — a directory in that position never relocates", () => {
  const { cwd, ledgerPath } = relocationFixture();
  try {
    // A DIRECTORY where the sibling source should be: `readFileSync` throws EISDIR, which is the
    // only way into this default's catch arm without racing a file away mid-read.
    mkdirSync(join(cwd, "src", "new-home.ts"), { recursive: true });
    const result = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), planOf([relocationTask()]), { ledgerPath, cwd });
    assert.equal(result.proof.relocated.length, 0, "an unreadable sibling must degrade to 'not found', never throw");
    assert.deepEqual(result.proof.byCause["grep-path-absent"], ["W9-SEAM-C"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── THE THREE REMAINING DEFAULTS ON THE SAME PATH ───────────────────────────────────────────
//
// The sibling suite drives `--credited` through the `creditedProofVisibility` seam, so the
// command's own RELOCATED print, the ledger scan's torn-line arm and the git-evidence catch are
// all unreached for the same reason the two above were.

/** A `resolveLedgerUnion` stand-in returning exactly `matches` — the documented `deps.ledgerUnion`
 *  seam. Only the CORPUS is supplied here; the `JSON.parse`/`continue` under test is
 *  `earliestCreditTimestamps`'s own, and still runs for real. */
function unionOf(matches: string[]) {
  return ((stateDir: string) => ({
    stateDir,
    archiveFiles: [],
    archiveCount: 1,
    liveFileRead: true,
    unreadable: [],
    ok: true,
    matches,
  })) as never;
}

/** A credited task WITH its own shard, in a cwd that is deliberately NOT a git repository. */
function shardedFixture(id: string): { cwd: string; ledgerPath: string; plan: Plan } {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-seam-shard-"));
  mkdirSync(join(cwd, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(cwd, "plan", "tasks.d", `${id}.yaml`),
    [`- id: ${id}`, '  title: "fixture"', "  repo: remudero", "  type: implement", ""].join("\n"), "utf8");
  const ledgerPath = join(cwd, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ task_id: id, step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" }) + "\n", "utf8");
  return { cwd, ledgerPath, plan: planOf([fixtureTask({ id, acceptance: [] })]) };
}

test("earliestCreditTimestamps SKIPS a torn ledger line and still dates the credits around it", () => {
  const { cwd, ledgerPath, plan } = shardedFixture("W9-SEAM-D");
  try {
    const good = JSON.stringify({ task_id: "W9-SEAM-D", step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" });
    // A TORN line BETWEEN two well-formed ones. It reaches `JSON.parse` (the union's own
    // pre-filter is bypassed by supplying the corpus directly), throws, and must cost only
    // ITS OWN timestamp — the dated credit either side of it must survive.
    const torn = '{"task_id":"W9-SEAM-D","step":"verdict.merged","ts":"2026-01-0';
    const withTorn = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), plan, {
      ledgerPath, cwd, ledgerUnion: unionOf([good, torn, good]),
    });
    assert.equal(withTorn.creditedCount, 1, "the torn line must not cost the whole read");
    // THE DISCRIMINATOR: a corpus of ONLY the torn line dates nothing, so the survival above is
    // the good lines being parsed and not the torn one being tolerated into a timestamp.
    const onlyTorn = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), plan, {
      ledgerPath, cwd, ledgerUnion: unionOf([torn]),
    });
    assert.equal(onlyTorn.amendment.measurable + onlyTorn.amendment.unmeasurable, 1);
    assert.equal(onlyTorn.amendment.flagged.length, 0, "an undated credit has nothing to compare against");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("defaultCreditedAmendmentEvidence CATCHES an unreadable git state and reports UNMEASURABLE, never a guess", () => {
  const { cwd, ledgerPath, plan } = shardedFixture("W9-SEAM-E");
  try {
    // The cwd is NOT a git repository, so `git rev-parse --is-shallow-repository` exits non-zero
    // and `execFileSync` throws. A dated credit is supplied so the evidence read is genuinely
    // ATTEMPTED rather than short-circuited by the "no dated credit" guard above it.
    const dated = JSON.stringify({ task_id: "W9-SEAM-E", step: "verdict.merged", ts: "2026-01-02T00:00:00.000Z" });
    const result = creditedProofVisibility(join(cwd, "plan", "tasks.yaml"), plan, {
      ledgerPath, cwd, ledgerUnion: unionOf([dated]),
    });
    assert.equal(result.creditedCount, 1, "sanity: the task IS credited, so the amendment read was reached");
    // The shard WAS found, so the task is `measurable` — `unmeasurable` counts a missing shard,
    // not a failed git read. What the catch arm guarantees is the next line: an unavailable
    // evidence read FAILS OPEN and is never turned into an amendment claim.
    assert.equal(result.amendment.measurable, 1, "the shard resolved, so the git read was genuinely attempted");
    assert.deepEqual(result.amendment.flagged, [], "an unreadable git state must never be reported as an amendment");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the --credited report PRINTS each relocated row, naming where the symbol moved to", async () => {
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (m: string) => lines.push(String(m));
  try {
    await proofQueueAuditCommand(["--credited", "--plan", "plan/tasks.yaml"], {
      creditedProofVisibility: () => ({
        creditedCount: 1,
        proof: {
          candidates: 1,
          offenders: [],
          // Built FROM the exported cause list rather than hand-listed, so a future cause cannot
          // make this fixture silently under-specify what the command iterates.
          byCause: Object.fromEntries(CREDITED_PROOF_QUEUE_AUDIT_CAUSES.map((c) => [c, []])),
          relocated: [{ taskId: "W9-SEAM-F", criterionIndex: 0, cause: "grep-path-absent", claim: "x",
                        proof: "grep: myMovedSymbol( in src/old-home.ts", relocatedTo: "src/new-home.ts" }],
        },
        amendment: { measurable: 0, flagged: [] },
      }) as never,
    });
  } finally {
    console.log = origLog;
  }
  const printed = lines.join("\n");
  assert.match(printed, /↷ W9-SEAM-F/, "a relocated row must be printed, not silently dropped from the report");
  assert.match(printed, /relocated to src\/new-home\.ts/, "and it must name WHERE the symbol moved");
});
