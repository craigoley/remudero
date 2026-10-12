/**
 * W1-T5650 — no daemon-loop path builds the UNBATCHED GitHub gateway.
 *
 * `ghGateway` answers every per-task query with its own synchronous `gh` spawn
 * (`findMergedByTrailer` is one search per task id). The retro trigger reached it and stalled the
 * daemon loop for 44m52s on 2026-10-04; the sweep's inbox-draft readiness reached it too, one trailer
 * search per plan task it derived. Each stall was fixed one site at a time AFTER it was measured on the
 * live daemon. This census refuses the NEXT site before it ships.
 *
 * Two halves:
 *  1. CENSUS (a property of every function in src, so it reads the source): every function that builds
 *     `ghGateway(` is the population; loop reach is a name-based fixed point seeded from
 *     `daemonCommand`'s body. A reachable member is refused by name unless a shrink-only exemption
 *     names why its calls are bounded per pass.
 *  2. DRAFT RUNG: the hook builds neither gateway; its execution tests live in the dedicated
 *     inbox-draft-hook suite.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function that builds the
// gateway, including paths no single execution drives; the same shape as test/gh-transport-census.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Functions the loop DOES reach that build the unbatched gateway, with the reason each is bounded.
 *  SHRINK-ONLY: an entry the census no longer reaches (or whose function no longer builds the
 *  gateway) is itself a failure, so the table can only get shorter. */
const LOOP_REACHABLE_EXEMPTIONS: Readonly<Record<string, string>> = {};

interface Fn {
  name: string;
  file: string;
  body: string;
}

/** Blank comment lines, keeping line numbers. Block comments are recognised only where they START a
 *  line: a naive `/\*...\*\/` regex also fires on glob strings such as "src/**\/*.ts" and swallows code. */
function stripComments(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .map((line) => {
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        return "";
      }
      if (/^\s*\/\*/.test(line)) {
        if (!line.includes("*/", line.indexOf("/*") + 2)) inBlock = true;
        return "";
      }
      return /^\s*\/\//.test(line) ? "" : line;
    })
    .join("\n");
}

function trackedSourceFiles(): string[] {
  const sub = "ls" + "-files";
  return execFileSync("git", [sub, "src/**/*.ts", "src/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
}

/** Every column-0 function declaration; its body runs to the next column-0 declaration (a closing
 *  brace at column 0 is NOT a boundary: a multi-line parameter type closes with one). */
function topLevelFunctions(): Fn[] {
  const fns: Fn[] = [];
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
  const NEXT_DECL = /^(?:export\s+|declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|abstract)\b|^export\s/;
  for (const file of trackedSourceFiles()) {
    const lines = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]!);
      if (!m) continue;
      let end = i;
      end = i + 1;
      while (end < lines.length && !NEXT_DECL.test(lines[end]!)) end++;
      fns.push({ name: m[1]!, file, body: lines.slice(i, end).join("\n") });
    }
  }
  return fns;
}

const BUILDS_UNBATCHED = /(?<!function\s)\bghGateway\(/;

/** Names of the functions that build `ghGateway(` (the definition itself is not a build site). */
function population(fns: Fn[]): string[] {
  return [...new Set(fns.filter((f) => f.name !== "ghGateway" && BUILDS_UNBATCHED.test(f.body)).map((f) => f.name))].sort();
}

/** Name-based fixed point: a function is reachable when its identifier appears in a reachable body. */
function loopReachable(fns: Fn[], seed: string): Set<string> {
  const byName = new Map<string, Fn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const reached = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const name = queue.pop()!;
    for (const f of byName.get(name) ?? []) {
      for (const id of f.body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (byName.has(id) && !reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
      }
    }
  }
  return reached;
}

function refusals(fns: Fn[], exemptions: Readonly<Record<string, string>>): string[] {
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  const out: string[] = [];
  for (const name of pop) {
    if (reach.has(name) && !(name in exemptions)) {
      out.push(`${name} builds ghGateway( and is reachable from the daemon loop (daemonCommand) — use the batched gateway`);
    }
  }
  for (const name of Object.keys(exemptions)) {
    if (!pop.includes(name) || !reach.has(name)) {
      out.push(`exemption '${name}' is stale: it no longer builds ghGateway( on a loop-reachable path — delete the entry`);
    }
  }
  return out;
}

test("census: the seed and the population are real, so the walk cannot pass vacuously", () => {
  const fns = topLevelFunctions();
  assert.ok(fns.some((f) => f.name === "daemonCommand"), "the walk must find daemonCommand to seed from");
  const pop = population(fns);
  // W1-T5649 (#9213) took the retro gateway off ghGateway, so the population's known sites are CLI-only.
  assert.ok(!pop.includes("retroShippedGithubGateway"), `the retro gateway answers from the batched fetch; got ${pop.join(", ")}`);
  assert.ok(pop.includes("correctCommand"), "population must see the CLI-only sites too");
  const reach = loopReachable(fns, "daemonCommand");
  assert.ok(reach.has("retroTriggerCheck") && reach.has("buildInboxDraftHook"), "the loop reaches the retro trigger and the draft hook");
});

test("unit test: test/no-daemon-loop-path-builds-the-unbatched-gateway.test.ts — the census names a loop-reachable function that builds ghGateway", () => {
  const fns = topLevelFunctions();
  assert.deepEqual(refusals(fns, LOOP_REACHABLE_EXEMPTIONS), [], "a loop path builds the unbatched gateway");

  // Falsifier, driven on the real source: put the build back into the draft rung's readiness block.
  const planted = fns.map((f) =>
    f.name === "buildInboxDraftHook" ? { ...f, body: f.body + "\n  const g = ghGateway(owner, repo);" } : f,
  );
  const named = refusals(planted, LOOP_REACHABLE_EXEMPTIONS);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^buildInboxDraftHook builds ghGateway\(/);

  // An exemption for a site the census no longer reaches is itself a failure (shrink-only).
  const stale = refusals(fns, { ...LOOP_REACHABLE_EXEMPTIONS, buildInboxDraftHook: "was bounded" });
  assert.equal(stale.length, 1);
  assert.match(stale[0]!, /exemption 'buildInboxDraftHook' is stale/);
});

test("the exemption table is shrink-only: every entry states why its calls are bounded", () => {
  for (const [name, reason] of Object.entries(LOOP_REACHABLE_EXEMPTIONS)) {
    assert.ok(reason.length > 40, `${name} must carry a stated reason`);
  }
  assert.deepEqual(Object.keys(LOOP_REACHABLE_EXEMPTIONS), [], "the table may only shrink");
});

test("unit test: test/the-inbox-intake-rung-derives-readiness-from-the-batched-gateway.test.ts — the census refuses an unbatched inboxCommand without an exemption", () => {
  const fns = topLevelFunctions();
  assert.ok(loopReachable(fns, "daemonCommand").has("inboxCommand"));
  assert.ok(!population(fns).includes("inboxCommand"));
  assert.deepEqual(refusals(fns, LOOP_REACHABLE_EXEMPTIONS), []);
  const planted = fns.map((f) =>
    f.name === "inboxCommand" ? { ...f, body: f.body + "\n  const g = ghGateway(owner, repo);" } : f,
  );
  assert.deepEqual(refusals(planted, LOOP_REACHABLE_EXEMPTIONS), [
    "inboxCommand builds ghGateway( and is reachable from the daemon loop (daemonCommand) — use the batched gateway",
  ]);
});

test("unit test: test/no-daemon-loop-path-builds-the-unbatched-gateway.test.ts — the inbox draft hook builds no gateway", () => {
  const hook = topLevelFunctions().find((fn) => fn.name === "buildInboxDraftHook");
  assert.ok(hook, "the census finds the draft hook");
  const buildsGateway = /\b(?:buildBatchedGithub|ghGateway)\(/;
  assert.doesNotMatch(hook.body, buildsGateway);
  assert.match(hook.body + "\n const gateway = buildBatchedGithub(owner, repo);", buildsGateway,
    "restoring either gateway is visible to the census");
  assert.match(hook.body + "\n const gateway = ghGateway(owner, repo);", buildsGateway);
});
