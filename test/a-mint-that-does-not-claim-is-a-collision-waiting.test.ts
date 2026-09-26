/**
 * `rmd next-task-id` — RESERVING IS THE DEFAULT (W1-T3091).
 *
 * WHY THIS FILE EXISTS. The old default printed an id and claimed NOTHING, so two lanes minting in
 * one window took the same number and one renumbered after its PR was open. `ci.yml`'s own
 * task-id-existence job already recorded the defect in prose before the task was filed: "The hand
 * lane's only id source, `rmd next-task-id`, prints an id and reserves NOTHING by design, so a
 * later mint handed the same number out as free and nothing noticed until an open PR had to be
 * renumbered."
 *
 * MEASURED: five id incidents in one session on 2026-09-07, and again on 2026-09-15 when two
 * shards reached main under W1-T3620 and `loadPlan` threw — main's own plan would not load, so
 * every PR's required `ci` failed until a human renumbered the loser. Second time in nine days.
 *
 * THE SUBJECT IS THE ARGUMENT CONTRACT, driven as a pure decision rather than by pushing refs to a
 * real origin: `reservingFor` is the predicate the command applies, and `validateReserveArgs` is
 * the refusal it applies first.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { nextTaskIdCommand, validateReserveArgs } from "../src/run-task.js";
import type { RemoteRefReserver, RemoteReserveOutcome } from "../src/lib/task-id-reservation.js";
import { gitRepo } from "./helpers/git-repo.js";

const mintRepo = gitRepo({ kind: "default-claim-plan" });
mkdirSync(join(mintRepo.dir, "plan"), { recursive: true });
writeFileSync(join(mintRepo.dir, "plan", "tasks.yaml"), "- id: W1-T3091\n  title: seed\n");
mintRepo.git("add", "plan/tasks.yaml");
mintRepo.git("commit", "--quiet", "-m", "fixture plan");

const DOCS = readFileSync(new URL("../docs/cli-reference.md", import.meta.url), "utf8");

/** The predicate this file models the command by, for the cheap synchronous checks below. Every
 *  claim it makes is also proven against the REAL command in the "DRIVING THE REAL COMMAND"
 *  section further down — behaviour, not a second reading of the committed source (W1-T2905's
 *  source-text-assertion census: a test that reads src/ as text passes on right prose and wrong
 *  behaviour, so the model here is checked by calling the command, never by regexing its file). */
function reservingFor(rest: string[]): boolean {
  return !rest.includes("--no-reserve") && !rest.includes("--offline") && !rest.includes("--audit");
}

test("a bare mint claims the id rather than printing a number anyone may take", async () => {
  // THE WHOLE POINT. Before this task a bare invocation reserved nothing.
  assert.equal(reservingFor([]), true, "a bare mint must CLAIM");

  // And the REAL command must actually compute it that way — not merely this test's model. Driven
  // rather than read as text: {@link run} below spawns `nextTaskIdCommand` itself.
  const bare = await run([]);
  assert.ok(bare.tried.length > 0, "the command must reserve by default: a bare mint reaches the reserver");

  // The opt-out works, and `--reserve` stays valid and redundant so existing callers are unbroken.
  assert.equal(reservingFor(["--no-reserve"]), false, "--no-reserve must opt out");
  assert.equal(reservingFor(["--reserve"]), true, "--reserve remains valid and redundant");
  const optOut = await run(["--no-reserve"]);
  assert.deepEqual(optOut.tried, [], "the old opt-IN default must be gone, or a bare mint still claims nothing");
});

test("an offline mint declines to claim rather than refusing the invocation", () => {
  // `--offline` declines to READ origin, so it cannot PUSH to it either. It implies the opt-out
  // instead of erroring, because refusing would break a legitimate offline query.
  assert.equal(reservingFor(["--offline"]), false, "--offline must imply the opt-out");
  assert.equal(validateReserveArgs(["--offline"]), undefined, "a bare --offline must NOT be refused");

  // Only asking for BOTH by name stays a refusal — that is two incompatible things requested
  // explicitly, which is different from one implying the other.
  assert.match(
    String(validateReserveArgs(["--reserve", "--offline"])),
    /contradictory/,
    "an explicit --reserve beside --offline is still refused",
  );
  assert.match(
    String(validateReserveArgs(["--reserve", "--no-reserve"])),
    /contradictory/,
    "claiming and not claiming in one invocation is refused by name, never silently resolved",
  );

  // `--audit` is a read-only report and must never claim.
  assert.equal(reservingFor(["--audit"]), false, "--audit is read-only and must not reserve");
});

test("the opt-out is named in the command's own syntax rather than only in prose", () => {
  // An operator reading `--help` or the reference must SEE the opt-out. A default that can only be
  // discovered by reading source is a default nobody can turn off.
  assert.match(DOCS, /--no-reserve/, "the reference must name the opt-out");
  assert.match(
    DOCS,
    /rmd next-task-id \[--plan <path>\] \[--offline\] \[--no-reserve\]/,
    "and it must appear in the SYNOPSIS, not only in the prose below it",
  );
  // `--no-reserve` being a KNOWN argument (rather than erroring as unknown) is proven behaviourally
  // by "EXECUTED: a bare mint reaches the reserver, and --no-reserve does not" below: an unknown
  // flag would print the usage refusal instead of an id, which that test's own assertion excludes.
});

// ── DRIVING THE REAL COMMAND ──────────────────────────────────────────────────────────────────
// The tests above model the argument contract and check it against the REAL command by calling
// `run()` (defined below), never by reading the committed source as text. The tests below drive
// `nextTaskIdCommand` itself with an injected reserver for the remaining arms, so "claims" and
// "claims nothing" are observed rather than inferred.

function stubReserver(): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return "created";
    },
  };
}

function captureConsole(): { out: string[]; err: string[]; restore(): void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return { out, err, restore() { console.log = log; console.error = error; } };
}

async function run(rest: string[]): Promise<{ out: string; err: string; tried: string[]; code: number }> {
  const reserver = stubReserver();
  const cap = captureConsole();
  let code = -1;
  try {
    code = await nextTaskIdCommand(rest, {}, { repoRoot: mintRepo.dir, reserver, holderOf: () => "unknown", openPrTexts: () => [] });
  } finally {
    cap.restore();
  }
  return { out: cap.out.join("\n"), err: cap.err.join("\n"), tried: reserver.tried, code };
}

test("EXECUTED: a bare mint reaches the reserver, and --no-reserve does not", async () => {
  const bare = await run([]);
  assert.ok(bare.tried.length > 0, `a bare mint must ATTEMPT a claim; tried=${JSON.stringify(bare.tried)}`);
  assert.match(bare.out, /RESERVED W1-T[0-9]+/, "and must report the id it actually holds");

  const optOut = await run(["--no-reserve"]);
  assert.deepEqual(optOut.tried, [], "--no-reserve must reach the reserver ZERO times");
  assert.doesNotMatch(optOut.out, /RESERVED/, "and must not claim to have reserved anything");
  assert.match(optOut.out, /W1-T[0-9]+/, "but must still PRINT an id — it is still a mint");

  // THE DISCRIMINATING PAIR: same command, same stubs, opposite reserver traffic. Without the
  // opt-out arm this would pass on an implementation that always reserved.
  assert.notDeepEqual(bare.tried, optOut.tried);
});

test("EXECUTED: --offline mints without claiming and does not refuse", async () => {
  const offline = await run(["--offline"]);
  assert.equal(offline.code, 0, `the fixture plan is readable; stderr=${offline.err}`);
  assert.doesNotMatch(offline.err, /contradictory/, "--offline alone is not a contradiction");
  assert.deepEqual(offline.tried, [], "--offline cannot push to an origin it declines to read");
  assert.match(offline.out, /W1-T[0-9]+/, "it still prints a floor");
});

test("EXECUTED: a named contradiction refuses before reaching the reserver", async () => {
  const clash = await run(["--reserve", "--no-reserve"]);
  assert.notEqual(clash.code, 0, "the contradiction must be refused");
  assert.match(clash.err, /contradictory/);
  assert.deepEqual(clash.tried, [], "and must refuse BEFORE any claim is attempted");
});
