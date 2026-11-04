// An engine tree is keyed by its bundle's source hash, so main advancing only outside that closure used to leave the
// tree at the revision it was first cut at. Run children read workflows, plan and scripts from their engine tree, so
// the reviewer then withheld every terminal verdict as stale (#15638, 2026-11-04: the engine sat 67 commits behind).
// These drive ensureEngineTree against a real git repository: a newer descendant revision advances the published
// tree in place, a live run or a moved source keeps it where it is, and a revision that is not a descendant is refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ENGINE_RECORD, enginePath, ensureEngineTree, newestCurrentEngine } from "#src/lib/engine-tree.js";
import { writeStatus } from "#src/lib/run-child-contract.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "rmd-engine-advance-")));
const hashOf = (n: number): string => n.toString(16).padStart(64, "0");
type Row = { step: string; extra?: Record<string, unknown> };
const GEN = { containerId: "c1", initStart: "t0" };
const probe = { process: () => ({ state: "alive" as const, start: "proc:1" }), generation: () => GEN };

/** A real repository whose commits change only a file no bundle carries (a workflow), as main did on 2026-11-04. */
function seedCommits(commits: number): { dir: string; shas: string[] } {
  const fixture = gitRepo({ seedCommit: false, kind: "engine" });
  mkdirSync(join(fixture.dir, ".github", "workflows"), { recursive: true });
  const shas: string[] = [];
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(fixture.dir, ".github", "workflows", "ci-gate.yml"), `# revision ${i}\n`);
    fixture.git("add", "-A");
    fixture.git("commit", "--quiet", "-m", `commit ${i}`);
    shas.push(fixture.git("rev-parse", "HEAD"));
  }
  return { dir: fixture.dir, shas };
}

function engineAt(state: string, hash: string): { head: string; recorded: string } {
  const root = enginePath(state, hash);
  return {
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    recorded: (JSON.parse(readFileSync(join(root, ENGINE_RECORD), "utf8")) as { sha: string }).sha,
  };
}

test("an engine tree advances to main's newer revision when main moved only outside its bundle", async () => {
  const { dir, shas } = seedCommits(3);
  const state = tmp();
  const hash = hashOf(91);
  const rows: Row[] = [];
  const deps = {
    repoDir: dir, storeRoot: join(state, "store"), probe, log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra }),
    linkNodeModules: () => "linked" as const, materialize: () => ({ outcome: "hit" as const, hash }),
  };
  assert.equal((await ensureEngineTree(state, shas[0]!, hash, deps)).kind, "built");
  assert.deepEqual(engineAt(state, hash), { head: shas[0], recorded: shas[0] }, "positive control: the first cut is at its revision");

  const again = await ensureEngineTree(state, shas[2]!, hash, deps);
  assert.equal(again.kind, "present");
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "the same-hash engine moved to main's revision");
  assert.ok(rows.some((r) => r.step === "engine.advanced" && r.extra?.from_sha === shas[0] && r.extra?.to_sha === shas[2]));
  assert.equal(readFileSync(join(enginePath(state, hash), ".github", "workflows", "ci-gate.yml"), "utf8"), "# revision 2\n",
    "the tree a run child reads from now holds main's workflow");

  const lagRows: Row[] = [];
  const newest = await newestCurrentEngine(state, shas[2]!, { repoDir: dir, isCurrent: () => true, log: (step, extra) => void lagRows.push({ step, extra }) });
  assert.equal(newest?.sha, shas[2]);
  assert.equal(lagRows.filter((r) => r.step === "engine.lag").length, 0, "an advanced engine no longer lags main");
});

test("an engine tree a live run names, or whose source no longer hashes to its bundle, is not advanced", async () => {
  const { dir, shas } = seedCommits(3);
  const state = tmp();
  const hash = hashOf(92);
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const base = { repoDir: dir, storeRoot: join(state, "store"), probe, log, linkNodeModules: () => "linked" as const };
  assert.equal((await ensureEngineTree(state, shas[0]!, hash, { ...base, materialize: () => ({ outcome: "hit", hash }) })).kind, "built");

  // A live run names the engine: nothing moves a tree a run's status names.
  const run = join(state, "runs", "run-live");
  mkdirSync(run, { recursive: true });
  writeStatus(run, {
    schema: { major: 1, minor: 0 }, runId: "run-live", identity: { pid: 4242, startTicks: "proc:1", containerGeneration: GEN },
    engineSha: shas[0]!, entryKind: "bundle", phase: "implement", heartbeatAt: 1, state: "running",
  });
  await ensureEngineTree(state, shas[2]!, hash, { ...base, materialize: () => ({ outcome: "hit", hash }) });
  assert.deepEqual(engineAt(state, hash), { head: shas[0], recorded: shas[0] }, "a live run keeps its engine where it is");
  assert.ok(rows.some((r) => r.step === "engine.advance_deferred" && r.extra?.reason === "named by a live run"));
  writeStatus(run, {
    schema: { major: 1, minor: 0 }, runId: "run-live", identity: { pid: 4242, startTicks: "proc:1", containerGeneration: GEN },
    engineSha: shas[0]!, entryKind: "bundle", phase: "implement", heartbeatAt: 2, state: "done",
  });

  // The advanced tree hashes elsewhere: the checkout is rolled back and the record is untouched.
  await ensureEngineTree(state, shas[2]!, hash, { ...base, materialize: () => ({ outcome: "hit", hash: hashOf(93) }) });
  assert.deepEqual(engineAt(state, hash), { head: shas[0], recorded: shas[0] }, "a moved source rolls the tree back");
  assert.ok(rows.some((r) => r.step === "engine.advance_failed" && /source-moved/.test(String(r.extra?.reason))));

  // Advanced for real, then asked for an older revision: an engine never moves backwards.
  await ensureEngineTree(state, shas[2]!, hash, { ...base, materialize: () => ({ outcome: "hit", hash }) });
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] });
  await ensureEngineTree(state, shas[1]!, hash, { ...base, materialize: () => ({ outcome: "hit", hash }) });
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "a revision that does not descend is refused");
});
