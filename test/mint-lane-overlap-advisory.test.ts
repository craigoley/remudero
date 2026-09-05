import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredFilesForFiledIds, printLaneOverlapAdvisory } from "../src/run-task.js";
import type { Plan } from "../src/lib/plan.js";

// ── W1-T985: THREE MINTING LANES NEVER TYPE THE ADVISORY ────────────────────────────────────
//
// `rareOverlapWarnings` shipped 2026-08-16 as W1-T533 with zero callers outside its own module,
// and gained its only reader the same day as W1-T917 — `nextTaskIdCommand`. That command has
// exactly one non-test caller, the CLI dispatch line, so the advisory printed ONLY for a human
// typing `rmd next-task-id`. `triageCommandLocked`, `planCommand` and `approveCommand` all mint
// and file WITHOUT one, and scored 0 for every advisory symbol against controls that scored 2 and
// 1. This suite covers the readers those three lanes now have.
//
// WHAT IS NOT HERE, DELIBERATELY. This does not close the duplicate-work case, and the shard says
// so in as many words: a filing PR's diff carries a feedback entry and a shard, never the
// implementation files the shard DECLARES, so two filings against the same module stay invisible
// to each other under `openPrFileScopes`' provenance. Changing that provenance is an operator
// ruling, not a line of this task — so nothing below asserts it.

/** A plan whose tasks declare the files a lane's filed shards name. */
function planWith(tasks: Array<{ id: string; files?: string[] }>): Plan {
  return { tasks: tasks.map((t) => ({ ...t, title: t.id })) } as unknown as Plan;
}

/** The advisory's open-PR scope source, faked — no network, and the provenance is unchanged. */
const scopesReturning = (files: string[]) => () => [{ id: "#1", files }];

/**
 * A plan large enough for a path to be RARE. The policy is a ratio —
 * `DEFAULT_OVERLAP_WARNING_POLICY.rareDeclarationRatioCeiling = 0.05` — so a path declared by ONE
 * task in a one-task plan is 100% and correctly outside it. The real plan carries ~1300 tasks and
 * `src/lib/worker-home.ts` is declared by 9 of them (1.46%), comfortably inside; the filler below
 * reproduces that shape rather than a degenerate one.
 */
function planWithFiller(declaring: Array<{ id: string; files?: string[] }>, fillerCount = 200): Plan {
  const filler = Array.from({ length: fillerCount }, (_, i) => ({ id: `W1-TFILL${i}`, files: [`src/lib/filler-${i}.ts`] }));
  return planWith([...declaring, ...filler]);
}

// ── declaredFilesForFiledIds — the candidate list each lane hands in ─────────────────────────

test("W1-T985: a lane reads the declared files of the shards it just filed", () => {
  const plan = planWith([
    { id: "W1-T900", files: ["src/lib/worker-home.ts", "test/worker-home.test.ts"] },
    { id: "W1-T901", files: ["src/lib/elsewhere.ts"] },
  ]);
  const files = declaredFilesForFiledIds("ignored", ["W1-T900"], { plan: () => plan });
  assert.deepEqual(files.sort(), ["src/lib/worker-home.ts", "test/worker-home.test.ts"]);
});

test("W1-T985: two shards filed in one run contribute one candidate list, with duplicates collapsed", () => {
  const plan = planWith([
    { id: "W1-T900", files: ["src/lib/worker-home.ts"] },
    { id: "W1-T901", files: ["src/lib/worker-home.ts", "src/lib/other.ts"] },
  ]);
  const files = declaredFilesForFiledIds("ignored", ["W1-T900", "W1-T901"], { plan: () => plan });
  assert.deepEqual(files.sort(), ["src/lib/other.ts", "src/lib/worker-home.ts"], "the rarity comparison is over a SET of paths");
});

test("W1-T985: an unreadable plan yields no candidates rather than throwing into a lane that spends money", () => {
  const files = declaredFilesForFiledIds("ignored", ["W1-T900"], {
    plan: () => {
      throw new Error("plan unreadable");
    },
  });
  assert.deepEqual(files, [], "the triage lane's own comment puts a worker at a median of $0.96 — an input that throws is worse than no advisory");
});

// ── the three lane call sites ───────────────────────────────────────────────────────────────
//
// Each lane hands `printLaneOverlapAdvisory` a candidate list it read itself. These drive the
// same helper the three sites call, with the candidate list each site produces.

function laneAdvisoryLines(opts: { declared: string[]; openPrFiles: string[]; declaringTasks?: Array<{ id: string; files?: string[] }> }): string[] {
  const said: string[] = [];
  const plan = planWithFiller(opts.declaringTasks ?? [{ id: "W1-T900", files: opts.declared }]);
  printLaneOverlapAdvisory(opts.declared, "craigoley", "remudero", "ignored", {
    plan: () => plan,
    scopes: scopesReturning(opts.openPrFiles),
    say: (l) => said.push(l),
  });
  return said;
}


/**
 * The body of one named lane function, from the shipped module. The three criteria this suite
 * proves are CALL SITES — the advisory's behaviour is covered above by driving it directly, and
 * what remains is that each lane reaches it. Scoping to one function is what makes each criterion
 * fail on its OWN lane's removal rather than all three failing together.
 */
function laneBody(fnName: string): string {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  // Anchored on the DECLARATION, never a bare name search: `triageCommandLocked` is first
  // mentioned ~7000 lines earlier in a COMMENT, and slicing from there covered none of its body
  // while still looking like it had. The `\n` prefix keeps it off a call site too.
  const decl = new RegExp(`\\n(?:export )?(?:async )?function ${fnName.replace("(", "\\(")}`);
  const m = decl.exec(src);
  assert.ok(m, `control: a declaration of ${fnName} must exist in the shipped module`);
  const start = m!.index + 1;
  const next = [/\n(?:export )?(?:async )?function /g]
    .flatMap((re) => [...src.slice(start + 1).matchAll(re)].map((x) => start + 1 + x.index))
    .filter((i) => i > start);
  return src.slice(start, next.length ? Math.min(...next) : src.length);
}

const ADVISORY_CALL = "printLaneOverlapAdvisory(";

test("W1-T985: the triage lane prints the overlap advisory after the shard is filed", () => {
  assert.ok(laneBody("triageCommandLocked(").includes(ADVISORY_CALL), "`triageCommandLocked` must reach the advisory — on origin/main it scored 0 for every advisory symbol");
  const lines = laneAdvisoryLines({ declared: ["src/lib/worker-home.ts"], openPrFiles: ["src/lib/worker-home.ts"] });
  assert.ok(lines.length > 0, "an open PR touching the same rare path must produce an advisory line");
  assert.ok(lines.join("\n").includes("src/lib/worker-home.ts"), lines.join("\n"));
});

test("W1-T985: the plan lane prints the overlap advisory for its filed shard", () => {
  assert.ok(laneBody("planCommand(").includes(ADVISORY_CALL), "`planCommand` must reach the advisory — on origin/main it scored 0 for every advisory symbol");
  const lines = laneAdvisoryLines({ declared: ["src/lib/plan-lane-only.ts"], openPrFiles: ["src/lib/plan-lane-only.ts"] });
  assert.ok(lines.length > 0, "the plan lane files without a human at a terminal — the advisory must reach it");
  assert.ok(lines.join("\n").includes("src/lib/plan-lane-only.ts"), lines.join("\n"));
});

test("W1-T985: the approve lane prints the overlap advisory for its filed shard", () => {
  assert.ok(laneBody("approveCommand(").includes(ADVISORY_CALL), "`approveCommand` must reach the advisory — on origin/main it scored 0 for every advisory symbol");
  const lines = laneAdvisoryLines({ declared: ["src/lib/approve-lane-only.ts"], openPrFiles: ["src/lib/approve-lane-only.ts"] });
  assert.ok(lines.length > 0, "ratification files shards too, and mints without a terminal");
  assert.ok(lines.join("\n").includes("src/lib/approve-lane-only.ts"), lines.join("\n"));
});

test("W1-T985: a hub path every shard declares is not warned about, so the advisory stays rare", () => {
  // The policy is a RATIO — DEFAULT_OVERLAP_WARNING_POLICY.rareDeclarationRatioCeiling = 0.05 —
  // and this task retunes nothing. A path declared by most of the plan is correctly outside it.
  const hub = "src/run-task.ts";
  // 60 of the 260 tasks in the fixture plan declare it — 23%, far outside the 5% ceiling, the same
  // shape `src/run-task.ts` has in the real plan at 222 of ~1300 (36.10%).
  const declaringTasks = Array.from({ length: 60 }, (_, i) => ({ id: `W1-T${800 + i}`, files: [hub] }));
  const lines = laneAdvisoryLines({ declared: [hub], openPrFiles: [hub], declaringTasks });
  assert.deepEqual(lines, [], "a hub is not a rare overlap, and the threshold was never the obstacle");
});

// ── the contract every new site inherits ────────────────────────────────────────────────────

test("W1-T985: an advisory failure leaves the minted id and the exit code unchanged", () => {
  const said: string[] = [];
  let threw = false;
  try {
    printLaneOverlapAdvisory(["src/lib/worker-home.ts"], "craigoley", "remudero", "ignored", {
      plan: () => {
        throw new Error("plan read exploded");
      },
      scopes: (() => {
        throw new Error("open-PR read exploded");
      }) as never,
      say: (l) => said.push(l),
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "advisory means advisory: it cannot refuse a mint, change an id, or alter an exit code");
  // W1-T2606: degrading must not mean going MUTE — a genuine failure is distinguishable in the
  // OUTPUT from a clean no-overlap read, which prints nothing at all.
  assert.equal(said.length, 1, `a failure yields exactly one outage line, not silence and not a stack: ${JSON.stringify(said)}`);
});

test("W1-T985: a say() that throws is swallowed too, so a broken sink cannot take the lane down", () => {
  let threw = false;
  try {
    printLaneOverlapAdvisory(["src/lib/worker-home.ts"], "craigoley", "remudero", "ignored", {
      plan: () => planWithFiller([{ id: "W1-T900", files: ["src/lib/worker-home.ts"] }]),
      scopes: scopesReturning(["src/lib/worker-home.ts"]),
      say: () => {
        throw new Error("sink exploded");
      },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "every new site inherits the same fail-to-silence contract");
});

test("W1-T985: a lane whose filed shard declares no files prints no advisory line", () => {
  const said: string[] = [];
  let scopesRead = false;
  printLaneOverlapAdvisory([], "craigoley", "remudero", "ignored", {
    plan: () => planWith([{ id: "W1-T900", files: [] }]),
    scopes: (() => {
      scopesRead = true;
      return [];
    }) as never,
    say: (l) => said.push(l),
  });
  assert.deepEqual(said, [], "no bare heading, and no line at all");
  assert.equal(scopesRead, false, "and nothing is spent reading open PRs when there is nothing to compare");
});

// ── the three lanes really call it ──────────────────────────────────────────────────────────

test("W1-T985: all three minting lanes reach the advisory, not just the CLI verb a human types", () => {
  // Read from the SHIPPED module rather than a source scan: each lane accepts an `overlap` seam of
  // the advisory's own deps type, which is the wiring a test can hold. A lane that never called the
  // advisory would have no reason to carry one.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  const callSites = [...src.matchAll(/printLaneOverlapAdvisory\(/g)].length;
  assert.ok(callSites >= 4, `expected the definition plus three lane call sites, found ${callSites}`);
});
