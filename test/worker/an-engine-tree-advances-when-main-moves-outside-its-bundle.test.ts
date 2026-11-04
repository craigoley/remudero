// An engine tree is keyed by its bundle's source hash, so main advancing only outside that closure used to leave the
// tree at the revision it was first cut at. Run children read workflows, plan and scripts from their engine tree, so
// the reviewer then withheld every terminal verdict as stale (#15638, 2026-11-04: the engine sat 67 commits behind).
// These drive ensureEngineTree against a real git repository: a newer descendant revision advances the published
// tree in place, a live run or a moved source keeps it where it is, and a revision that is not a descendant is refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildIntoStore, materializeFromStore } from "#src/lib/child-entry-store.js";
import { ENGINE_RECORD, enginePath, enginesRoot, ensureEngineTree, hardenedEngineGit, newestCurrentEngine, pinEngineForRun, type EngineGit } from "#src/lib/engine-tree.js";
import { readSpec, RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildSpec } from "#src/lib/run-child-contract.js";

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

/** A launch's publish: the spec a real launch writes, naming the engine revision it was handed under the pin. */
function publishInto(dir: string) {
  return (engine: { sourceHash: string; sha: string }) => {
    mkdirSync(dir, { recursive: true });
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, taskId: "W1-T1", runId: "run-pin", instance: "core", engine,
      planSnapshotPath: join(dir, "plan.json"), reservationId: "r1", options: {} } as unknown as RunChildSpec);
  };
}

test("a run that pins while an engine advances names the revision its tree holds, never the one the tree left", async () => {
  const { dir, shas } = seedCommits(3);
  const state = tmp();
  const hash = hashOf(94);
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const base = { repoDir: dir, storeRoot: join(state, "store"), probe, log, linkNodeModules: () => "linked" as const,
    materialize: () => ({ outcome: "hit" as const, hash }) };
  assert.equal((await ensureEngineTree(state, shas[0]!, hash, base)).kind, "built");

  // The reviewer's interleaving: a launch publishes its spec after the advance's census, before its checkout.
  const run = join(state, "runs", "run-pin");
  let during: Awaited<ReturnType<typeof pinEngineForRun>> | undefined;
  const git: EngineGit = async (repoDir, args) => {
    if (args[0] === "checkout" && during === undefined) {
      during = await pinEngineForRun(state, hash, "run-pin", publishInto(run), { waitMs: 0 });
    }
    return hardenedEngineGit(repoDir, args);
  };
  await ensureEngineTree(state, shas[2]!, hash, { ...base, git });
  assert.ok(during && "unavailable" in during, "a launch cannot publish a spec while the advance holds the pin");
  assert.match(String((during as { unavailable: string }).unavailable), /pin busy/);
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "positive control: the advance completed");

  // The same launch, once the advance released the pin, names the revision the tree now holds.
  const after = await pinEngineForRun(state, hash, "run-pin", publishInto(run), { waitMs: 0 });
  assert.deepEqual(after, { sourceHash: hash, sha: shas[2] });
  const spec = readSpec(run);
  assert.ok(spec.ok);
  assert.equal(spec.value.engine.sha, engineAt(state, hash).head, "the spec names exactly the revision its tree holds");
});

test("an engine a launch is pinning is not advanced until the pin is released", async () => {
  const { dir, shas } = seedCommits(3);
  const state = tmp();
  const hash = hashOf(95);
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const base = { repoDir: dir, storeRoot: join(state, "store"), probe, log, linkNodeModules: () => "linked" as const,
    materialize: () => ({ outcome: "hit" as const, hash }) };
  assert.equal((await ensureEngineTree(state, shas[0]!, hash, base)).kind, "built");

  // A launch in another process holds the pin (a live holder: this process), between its record read and its spec.
  const lock = join(enginesRoot(state), `${hash}.pin.lock`);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, run_id: "run-elsewhere", host: hostname(), startedAt: new Date().toISOString() }));
  await ensureEngineTree(state, shas[2]!, hash, base);
  assert.deepEqual(engineAt(state, hash), { head: shas[0], recorded: shas[0] }, "the advance deferred instead of moving a pinned tree");
  assert.ok(rows.some((r) => r.step === "engine.advance_deferred" && /a run is pinning the engine/.test(String(r.extra?.reason))));

  // The pin released and no run named the engine: the next pass advances it.
  rmSync(lock);
  await ensureEngineTree(state, shas[2]!, hash, base);
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "positive control: an unpinned engine advances");
});

test("two overlapping advances never move an engine back: the later caller re-reads the record under the pin", async () => {
  const { dir, shas } = seedCommits(3);
  const state = tmp();
  const hash = hashOf(96);
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const base = { repoDir: dir, storeRoot: join(state, "store"), probe, log, linkNodeModules: () => "linked" as const,
    materialize: () => ({ outcome: "hit" as const, hash }) };
  assert.equal((await ensureEngineTree(state, shas[0]!, hash, base)).kind, "built");

  // Caller X (target B) has read the record at A and passed its pre-pin ancestry check; before it takes the pin,
  // caller Y (another process: a distinct state-root spelling, so it does not join X's in-process pass) advances A→C.
  let overlapped = false;
  const gitX: EngineGit = async (repoDir, args) => {
    if (args[0] === "merge-base" && !overlapped) {
      overlapped = true;
      const result = await hardenedEngineGit(repoDir, args);
      await ensureEngineTree(`${state}/.`, shas[2]!, hash, base);
      assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "positive control: caller Y advanced to C");
      return result;
    }
    return hardenedEngineGit(repoDir, args);
  };
  await ensureEngineTree(state, shas[1]!, hash, { ...base, git: gitX });
  assert.ok(overlapped, "the overlap really happened");
  assert.deepEqual(engineAt(state, hash), { head: shas[2], recorded: shas[2] }, "the engine stays at the newest descendant");
  assert.ok(rows.some((r) => r.step === "engine.advance_deferred" && r.extra?.reason === "superseded" && r.extra?.from_sha === shas[2]),
    "the superseded caller defers, naming the revision it found under the pin");
});

// ── the REAL store: an advance never publishes another hash's bundle, and a failed advance restores its own ──────────

/**
 * A harness-shaped repository (the build script, the three declared entries, esbuild linked in), committed at A; B
 * changes only a workflow (the same source hash); C changes an entry (another source hash). The store holds the REAL
 * build of both hashes, as the daemon's store does once main has moved.
 */
async function harnessWithStore(): Promise<{ dir: string; store: string; a: string; b: string; c: string; hashA: string; hashC: string }> {
  const fixture = gitRepo({ seedCommit: false, kind: "engine" });
  const dir = fixture.dir;
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n");
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "esbuild"), join(dir, "node_modules", "esbuild"));
  copyFileSync(join(REPO_ROOT, "scripts", "build-child-entries.mjs"), join(dir, "scripts", "build-child-entries.mjs"));
  writeFileSync(join(dir, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(dir, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(dir, "src", "check-proof-main.ts"), 'console.log("A");\n');
  writeFileSync(join(dir, "src", "run-task.ts"), 'export const runTask: string = "run-task";\n');
  writeFileSync(join(dir, "src", "run-child-main.ts"), 'export const runChild: string = "run-child";\n');
  writeFileSync(join(dir, ".github", "workflows", "ci-gate.yml"), "# revision a\n");
  const commit = (message: string): string => {
    fixture.git("add", "-A");
    fixture.git("commit", "--quiet", "-m", message);
    return fixture.git("rev-parse", "HEAD");
  };
  const a = commit("A");
  const store = realpathSync(mkdtempSync(join(tmpdir(), "rmd-engine-store-")));
  const builtA = await buildIntoStore(dir, { storeRoot: store });
  assert.equal(builtA.kind, "built", `positive control: the store holds A's build (${JSON.stringify(builtA)})`);
  writeFileSync(join(dir, ".github", "workflows", "ci-gate.yml"), "# revision b\n");
  const b = commit("B: a workflow only");
  writeFileSync(join(dir, "src", "check-proof-main.ts"), 'console.log("C");\n');
  const c = commit("C: an entry");
  const builtC = await buildIntoStore(dir, { storeRoot: store });
  assert.equal(builtC.kind, "built", `positive control: the store holds C's build (${JSON.stringify(builtC)})`);
  const hashA = (builtA as { hash: string }).hash;
  const hashC = (builtC as { hash: string }).hash;
  assert.notEqual(hashA, hashC, "positive control: C's entry change moved the source hash");
  fixture.git("checkout", "--quiet", a);
  return { dir, store, a, b, c, hashA, hashC };
}

/** Every published bundle file's digest: what a run child would execute from the engine. */
function bundleDigests(engineRoot: string): Record<string, string> {
  const out = join(engineRoot, "dist", "child-entries");
  return Object.fromEntries(readdirSync(out).filter((name) => !name.startsWith(".")).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(out, name))).digest("hex")]));
}

function realStoreDeps(h: { dir: string; store: string }, rows: Row[]) {
  return {
    repoDir: h.dir, storeRoot: h.store, probe, log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra }),
    linkNodeModules: (_target: string, tree: string) => {
      symlinkSync(join(h.dir, "node_modules"), join(tree, "node_modules"));
      return "linked" as const;
    },
  };
}

test("an engine whose advanced tree hashes elsewhere keeps its own bundle: the real store's other build is never published", async () => {
  const h = await harnessWithStore();
  const state = tmp();
  const rows: Row[] = [];
  const deps = realStoreDeps(h, rows);
  assert.equal((await ensureEngineTree(state, h.a, h.hashA, deps)).kind, "built");
  const root = enginePath(state, h.hashA);
  const before = bundleDigests(root);
  assert.equal(JSON.parse(readFileSync(join(root, "dist", "child-entries", "manifest.json"), "utf8")).sourceHash, h.hashA);

  // A publish swaps the whole directory, so this marker survives only if nothing was published at all (a publish
  // followed by a restore would leave the same digests but lose the marker).
  const marker = join(root, "dist", "child-entries", ".never-republished");
  writeFileSync(marker, "x\n");
  // C descends from A but hashes to C's source, and the store holds C's build: the advance must refuse BEFORE publishing.
  await ensureEngineTree(state, h.c, h.hashA, deps);
  assert.ok(existsSync(marker), "nothing was published into the engine: C's build was refused before the publish");
  assert.deepEqual(engineAt(state, h.hashA), { head: h.a, recorded: h.a }, "the tree is back at its own revision");
  assert.deepEqual(bundleDigests(root), before, "the engine's dist/child-entries is byte-identical: C's stored build was never published");
  assert.ok(rows.some((r) => r.step === "engine.advance_failed" && /source-moved/.test(String(r.extra?.reason))));
  const current = await newestCurrentEngine(state, h.a, { repoDir: h.dir });
  assert.equal(current?.sourceHash, h.hashA, "the original engine still passes its real currency check");

  // Positive control: a same-hash revision (B) still advances through the real materializer.
  await ensureEngineTree(state, h.b, h.hashA, deps);
  assert.deepEqual(engineAt(state, h.hashA), { head: h.b, recorded: h.b });
  assert.equal((await newestCurrentEngine(state, h.b, { repoDir: h.dir }))?.sourceHash, h.hashA);
});

test("an advance that fails after a publish restores the engine's own bundle as well as its revision", async () => {
  const h = await harnessWithStore();
  const state = tmp();
  const rows: Row[] = [];
  const deps = realStoreDeps(h, rows);
  assert.equal((await ensureEngineTree(state, h.a, h.hashA, deps)).kind, "built");
  const root = enginePath(state, h.hashA);
  const before = bundleDigests(root);

  // The injected failure: the advance's publish lands another hash's REAL stored build (C's) and then reports it.
  let calls = 0;
  const failing = {
    ...deps,
    materialize: (tree: string, store: string, expected?: string) => {
      calls++;
      if (calls === 1) {
        const wrong = materializeFromStore(tree, store, h.hashC);
        assert.equal(wrong.outcome, "hit", "positive control: C's build was published into the engine");
        return wrong;
      }
      return materializeFromStore(tree, store, undefined, undefined, expected);
    },
  };
  await ensureEngineTree(state, h.b, h.hashA, failing);
  assert.equal(calls, 2, "the restore re-published the engine's own bundle");
  assert.deepEqual(engineAt(state, h.hashA), { head: h.a, recorded: h.a }, "the revision and the record are the engine's own");
  assert.deepEqual(bundleDigests(root), before, "dist/child-entries is the engine's own bundle again, byte for byte");
  assert.equal((await newestCurrentEngine(state, h.a, { repoDir: h.dir }))?.sourceHash, h.hashA,
    "the original engine passes its real currency check after the failed advance");
});
