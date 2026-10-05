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
 *  2. BEHAVIOUR: the real draft rung answers readiness for 50 plan tasks with zero `gh` search spawns.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function that builds the
// gateway, including paths no single execution drives; the same shape as test/gh-transport-census.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import { buildBatchedGithub, ghGateway } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildDepsReadinessAccessors, buildInboxDraftHook } from "../src/run-task.js";

/** Functions the loop DOES reach that build the unbatched gateway, with the reason each is bounded.
 *  SHRINK-ONLY: an entry the census no longer reaches (or whose function no longer builds the
 *  gateway) is itself a failure, so the table can only get shorter. */
const LOOP_REACHABLE_EXEMPTIONS: Readonly<Record<string, string>> = {
  retroShippedGithubGateway:
    "reached from retroTriggerCheck (the checkRetroTrigger hook). Bounded per pass: the trigger counts " +
    "only merges AFTER the retro marker, so the trailer searches are limited to the post-marker " +
    "candidates, not the plan. Leaves the table when W1-T3104 stops the trigger building the unbatched gateway.",
};

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
  assert.ok(pop.includes("retroShippedGithubGateway"), `population must see the known site; got ${pop.join(", ")}`);
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
  assert.deepEqual(Object.keys(LOOP_REACHABLE_EXEMPTIONS), ["retroShippedGithubGateway"], "the table may only shrink");
});

/** A `gh` on PATH that logs every invocation: the only way to SEE a synchronous spawn. */
function withCountingGh<T>(dir: string, body: (calls: () => string[]) => T): T {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const callLog = join(dir, "gh-calls.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${callLog}"\necho '[]'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(callLog, "");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    return body(() => readFileSync(callLog, "utf8").split("\n").filter((l) => /search/.test(l)));
  } finally {
    process.env.PATH = oldPath;
  }
}

function unlandedTasks(n: number): Task[] {
  const plan = loadPlan(new URL("../plan/tasks.yaml", import.meta.url).pathname);
  // Unlanded only: a plan-merged task resolves without asking GitHub, which would let an unbatched
  // gateway pass unseen.
  const tasks = [...plan.byId.values()].filter((t) => t.status === "queued" || t.status === "blocked").slice(0, n);
  assert.equal(tasks.length, n, `the live plan holds at least ${n} unlanded tasks to derive`);
  return tasks;
}

test("unit test: test/no-daemon-loop-path-builds-the-unbatched-gateway.test.ts — inbox-draft readiness answers isMerged for 50 plan tasks with zero unbatched trailer searches", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5650-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const tasks = unlandedTasks(50);
  const plan = { byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
  withCountingGh(dir, (searches) => {
    // CONTROL: the instrument sees the unbatched gateway. 50 tasks cost 50 synchronous searches.
    const unbatched = buildDepsReadinessAccessors(plan, { ledgerPath, github: ghGateway("o", "r") });
    for (const t of tasks) unbatched.isMerged(t);
    assert.ok(searches().length >= 50, `the control must see one search per task; saw ${searches().length}`);
  });
  withCountingGh(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5650b-`)), (searches) => {
    // The gateway the draft rung now receives: the sweep's daemon-lifetime batched one.
    const batched = buildBatchedGithub("o", "r", { fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map() });
    const accessors = buildDepsReadinessAccessors(plan, { ledgerPath, github: batched });
    for (const t of tasks) assert.equal(accessors.isMerged(t), false);
    assert.deepEqual(searches(), [], "50 isMerged answers, zero unbatched trailer searches");
  });
});

test("the draft rung runs clean on the injected batched gateway and spawns no search", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5650c-`));
  const root = join(dir, "root");
  mkdirSync(join(root, "state"), { recursive: true });
  const ids = unlandedTasks(50).map((t) => t.id);
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: ids.map((id) => ({ id: `proof-debt:${id}`, summary: "s", evidenceAnchors: [] })) }),
  );
  const batched = buildBatchedGithub("o", "r", { fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map() });
  const logs: string[] = [];
  await withCountingGh(dir, async (searches) => {
    const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-5650", (s) => void logs.push(s), async () => [], undefined, () => "sha", batched);
    await hook();
    assert.deepEqual(searches(), []);
  });
  assert.ok(!logs.includes("inbox.draft_readiness_unavailable"), "readiness was built, not skipped");
  assert.ok(!logs.includes("inbox.draft_rung.error"), "the rung itself ran clean");
});
