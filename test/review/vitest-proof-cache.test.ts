import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execWhitelistedProof, execWhitelistedProofAsync, parseWhitelistedProof } from "#src/lib/review.js";
import {
  createProofCache, hasSharedInstall, proofCacheIdentity, vitestCacheCapability,
  PROOF_CACHE_DIR_PREFIX, PROOF_CACHE_OWNER_FILE, ProofCacheUnavailableError,
} from "#src/lib/proof-cache.js";

const target = { owner: "craigoley", repo: "remudero-console" };
const title = "a cached shared-install proof";
const tap = `TAP version 13\n1..1\nok 1 - tests/unit/shared.test.ts {\n    1..1\n    ok 1 - ${title}\n}\n`;
const noBrowsers = { preflightBrowsers: () => {} };
const FLAG = "--fsModuleCachePath=";

/** A pinned-runner stand-in that models only the measured write: it needs a writable module cache, records what it
 *  saw, and then exits as the fixture's `mode` says. It is not Vitest's semantics. */
function shim(mode: string): string {
  return `
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = process.argv.find((a) => a.startsWith(${JSON.stringify(FLAG)}));
const cache = arg === undefined ? undefined : arg.slice(${FLAG.length});
const seen = cache === undefined ? null : readdirSync(cache).filter((n) => n !== ${JSON.stringify(PROOF_CACHE_OWNER_FILE)});
if (cache !== undefined) writeFileSync(join(cache, "transform.bin"), "x");
appendFileSync(join(process.cwd(), "observed.ndjson"), JSON.stringify({ cache, seen }) + "\\n");
const mode = ${JSON.stringify(mode)};
if (cache === undefined && mode !== "plain") { process.stderr.write("EACCES: node_modules/.vitest-cache is read-only\\n"); process.exit(1); }
if (mode === "nonzero") process.exit(1);
if (mode === "hang") setTimeout(() => {}, 60000);
else process.stdout.write(${JSON.stringify(tap)});
`;
}

interface Fixture { root: string; cwd: string; install: string }

function fixture(mode: string, version = "5.0.0", name = "checkout"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-proof-cache-"));
  const install = join(root, "install");
  const cwd = join(root, name);
  mkdirSync(join(install, "vitest"), { recursive: true });
  mkdirSync(join(cwd, "tests", "unit"), { recursive: true });
  writeFileSync(join(install, "vitest", "package.json"), JSON.stringify({ name: "vitest", version }));
  writeFileSync(join(install, "vitest", "vitest.mjs"), shim(mode));
  writeFileSync(join(cwd, "tests", "unit", "shared.test.ts"), `test("${title}", () => {});\n`);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "cache-fixture", type: "module", devDependencies: { vitest: version } }));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/vitest": { version } } }));
  symlinkSync(install, join(cwd, "node_modules"), "dir");
  return { root, cwd, install };
}

function readOnly(f: Fixture): void {
  // A file at the default cache location blocks mkdir even for uid 0; only this fixture is modified.
  writeFileSync(join(f.install, ".vitest-cache"), "owned fixture blocks the default cache directory");
}

function dispose(...fixtures: Fixture[]): void {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
}

function observed(cwd: string): { cache?: string; seen: string[] | null }[] {
  return readFileSync(join(cwd, "observed.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function leftovers(cwd: string): string[] {
  return readdirSync(cwd).filter((name) => name.startsWith(PROOF_CACHE_DIR_PREFIX));
}

const pureProof = () => parseWhitelistedProof("unit test: tests/unit/shared.test.ts", target)!;

test("W1-T10675: shared-install Vitest proofs use owned writable caches on both executors", async () => {
  const f = fixture("write");
  try {
    readOnly(f);
    const before = readdirSync(f.install);
    // Real default child and filesystem path, a read-only dependency payload, no injected spawner.
    assert.equal(execWhitelistedProof(pureProof(), f.cwd, 20_000, undefined, noBrowsers), "pass");
    assert.equal(await execWhitelistedProofAsync(pureProof(), f.cwd, 20_000, undefined, noBrowsers), "pass");
    const runs = observed(f.cwd);
    assert.equal(runs.length, 2, "both executors reached the real child");
    for (const run of runs) {
      assert.ok(run.cache?.startsWith(join(f.cwd, PROOF_CACHE_DIR_PREFIX)), `owned cache beside the sources: ${run.cache}`);
      assert.ok(!run.cache!.includes(`${f.install}`), "never inside the shared dependency payload");
      assert.ok(!existsSync(run.cache!), "the completed invocation's cache is gone");
    }
    assert.notEqual(runs[0].cache, runs[1].cache);
    assert.deepEqual(leftovers(f.cwd), []);
    assert.deepEqual(readdirSync(f.install), before, "the shared dependency payload was not written");

    // Name-filtered (title) proofs take the same route, in the asynchronous executor too.
    const titled = parseWhitelistedProof(`unit test: ${title}`, target)!;
    assert.equal(await execWhitelistedProofAsync(titled, f.cwd, 20_000, undefined, noBrowsers), "pass");
    assert.ok(observed(f.cwd)[2].cache !== undefined);
    assert.deepEqual(leftovers(f.cwd), []);
  } finally { dispose(f); }
});

test("W1-T10675: shared-install Vitest proofs use owned writable caches on both executors (capability)", async () => {
  const old = fixture("plain", "4.9.0");
  const unknown = fixture("plain", "5.0.0");
  try {
    rmSync(join(unknown.install, "vitest", "package.json"));
    const argvs: (readonly string[])[] = [];
    const spy = (_c: string, args: readonly string[]) => { argvs.push(args); return tap; };
    assert.equal(execWhitelistedProof(pureProof(), old.cwd, 1000, spy, noBrowsers), "pass");
    assert.equal(await execWhitelistedProofAsync(pureProof(), old.cwd, 1000, async (...a) => spy(a[0], a[1]), noBrowsers), "pass");
    assert.throws(() => execWhitelistedProof(pureProof(), unknown.cwd, 1000, spy, noBrowsers), ProofCacheUnavailableError);
    await assert.rejects(execWhitelistedProofAsync(pureProof(), unknown.cwd, 1000, async (...a) => spy(a[0], a[1]), noBrowsers), ProofCacheUnavailableError);
    assert.equal(argvs.length, 2, "unreadable shared capability never spawns a child or becomes a passing proof");
    for (const args of argvs) assert.ok(!args.some((a) => a.startsWith(FLAG)));
    assert.match(String((vitestCacheCapability(old.cwd) as { reason: string }).reason), /predates/);
    assert.match(String((vitestCacheCapability(unknown.cwd) as { reason: string }).reason), /unreadable/);
    assert.deepEqual(leftovers(old.cwd), []);
    assert.equal(hasSharedInstall(join(old.root, "install")), false);
  } finally { dispose(old, unknown); }
});

test("W1-T10675: head and base proof caches cannot reuse another revision state", async () => {
  const head = fixture("write", "5.0.0", "head");
  const base = fixture("write", "5.0.0", "base");
  try {
    // A stale cache from an earlier run of the SAME identity: never adopted, never removed.
    for (const f of [head, base]) {
      const stale = join(f.cwd, `${PROOF_CACHE_DIR_PREFIX}${proofCacheIdentity([f.cwd])}-stale`);
      mkdirSync(stale);
      writeFileSync(join(stale, "poison.bin"), "old revision");
    }
    for (const f of [head, base, head]) assert.equal(execWhitelistedProof(pureProof(), f.cwd, 20_000, undefined, noBrowsers), "pass");
    assert.equal(await execWhitelistedProofAsync(pureProof(), base.cwd, 20_000, undefined, noBrowsers), "pass");
    const all = [...observed(head.cwd), ...observed(base.cwd)];
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map((r) => r.cache)).size, 4, "no two invocations share a cache directory");
    for (const run of all) assert.deepEqual(run.seen, [], "every cache starts empty: no transform from another revision");
    for (const f of [head, base]) {
      assert.deepEqual(leftovers(f.cwd).filter((n) => n.endsWith("-stale")), [`${PROOF_CACHE_DIR_PREFIX}${proofCacheIdentity([f.cwd])}-stale`]);
      assert.equal(leftovers(f.cwd).length, 1, "only the foreign stale directory remains");
    }
    // The revision's lockfile hash and proof label are part of the identity.
    const a = createProofCache({ cwd: head.cwd, identity: ["label", "hash-a"] });
    const b = createProofCache({ cwd: head.cwd, identity: ["label", "hash-b"] });
    try {
      assert.equal(a.kind, "owned");
      assert.equal(b.kind, "owned");
      assert.notEqual((a as { path: string }).path.replace(/-[^-]+$/, ""), (b as { path: string }).path.replace(/-[^-]+$/, ""));
    } finally { if (a.kind === "owned") a.release(); if (b.kind === "owned") b.release(); }
  } finally { dispose(head, base); }
});

test("W1-T10675: cache failures preserve proof errors and release only owned scratch", async () => {
  const f = fixture("nonzero");
  const slow = fixture("hang");
  try {
    readOnly(f);
    const foreign = join(f.cwd, `${PROOF_CACHE_DIR_PREFIX}foreign-owner`);
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.bin"), "not ours");

    // A real child's nonzero exit stays a genuine fail, and its cache is still released.
    const proof = pureProof();
    assert.equal(execWhitelistedProof(proof, f.cwd, 20_000, undefined, noBrowsers), "fail");
    assert.match(proof.failureOutput ?? "", /exit 1/);
    assert.equal(proof.proofCacheRelease?.released, true);
    assert.equal(await execWhitelistedProofAsync(pureProof(), f.cwd, 20_000, undefined, noBrowsers), "fail");

    // A real timeout still surfaces as the error it is, and releases the cache after the child settled.
    assert.throws(() => execWhitelistedProof(pureProof(), slow.cwd, 800, undefined, noBrowsers), /ETIMEDOUT|timed out|SIGKILL/i);
    await assert.rejects(execWhitelistedProofAsync(pureProof(), slow.cwd, 800, undefined, noBrowsers));
    assert.deepEqual(leftovers(slow.cwd), []);

    // A spawner that throws before any child exists: the thrown error is the proof's, the cache is gone.
    let seenPath = "";
    const boom = new Error("spawn exploded");
    assert.throws(() => execWhitelistedProof(pureProof(), f.cwd, 1000, (_c, args) => {
      seenPath = args.find((a) => a.startsWith(FLAG))!.slice(FLAG.length);
      assert.ok(existsSync(seenPath), "the cache exists while the child runs");
      throw boom;
    }, noBrowsers), (error) => error === boom);
    assert.ok(seenPath.length > 0 && !existsSync(seenPath));
    await assert.rejects(execWhitelistedProofAsync(pureProof(), f.cwd, 1000, async (_c, args) => {
      seenPath = args.find((a) => a.startsWith(FLAG))!.slice(FLAG.length);
      throw boom;
    }, noBrowsers), (error) => error === boom);
    assert.ok(!existsSync(seenPath));

    // Only owned scratch was released: the foreign lookalike and the payload are untouched.
    assert.deepEqual(leftovers(f.cwd), [`${PROOF_CACHE_DIR_PREFIX}foreign-owner`]);
    assert.equal(readFileSync(join(foreign, "keep.bin"), "utf8"), "not ours");
    assert.deepEqual(readdirSync(f.install).sort(), [".vitest-cache", "vitest"]);
  } finally { dispose(f, slow); }
});

test("W1-T10675: cache failures preserve proof errors and release only owned scratch (release arms)", () => {
  const f = fixture("plain");
  try {
    const creationFailure = createProofCache({ cwd: f.cwd, identity: [] }, {
      mkdtemp: () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); },
    });
    assert.deepEqual(creationFailure, { kind: "unavailable", reason: "proof cache scratch unavailable (EROFS)", cleanup: { released: true } });
    // A later independent preparation can succeed; the failed preparation itself is never success.
    assert.equal(execWhitelistedProof(pureProof(), f.cwd, 20_000, undefined, noBrowsers), "pass");

    const failing = createProofCache({ cwd: f.cwd, identity: [] }, { remove: () => { throw new Error("EBUSY: locked"); } });
    assert.equal(failing.kind, "owned");
    const first = (failing as { release(): { released: boolean; error?: string } }).release();
    assert.equal(first.released, false);
    assert.match(first.error ?? "", /EBUSY/);

    const tampered = createProofCache({ cwd: f.cwd, identity: [] });
    assert.equal(tampered.kind, "owned");
    const path = (tampered as { path: string }).path;
    writeFileSync(join(path, PROOF_CACHE_OWNER_FILE), "someone else");
    const refused = (tampered as { release(): { released: boolean; error?: string } }).release();
    assert.equal(refused.released, false);
    assert.match(refused.error ?? "", /owner marker changed/);
    assert.ok(existsSync(path), "a directory whose owner marker is not ours is never removed");

    const ok = createProofCache({ cwd: f.cwd, identity: [] });
    const release = (ok as { release(): { released: boolean } }).release;
    assert.equal(release().released, true);
    assert.equal(release().released, true, "release is idempotent");

    const ordinary = mkdtempSync(join(tmpdir(), "rmd-proof-cache-ordinary-"));
    try {
      mkdirSync(join(ordinary, "node_modules"));
      assert.equal(createProofCache({ cwd: ordinary, identity: [] }).kind, "ordinary");
      assert.equal(vitestCacheCapability(ordinary).supported, false);
      mkdirSync(join(ordinary, "node_modules", "vitest"));
      writeFileSync(join(ordinary, "node_modules", "vitest", "package.json"), "{}");
      assert.match((vitestCacheCapability(ordinary) as { reason: string }).reason, /no version/);
      writeFileSync(join(ordinary, "node_modules", "vitest", "package.json"), '{"version":"next"}');
      assert.match((vitestCacheCapability(ordinary) as { reason: string }).reason, /not parseable/);
    } finally { rmSync(ordinary, { recursive: true, force: true }); }
  } finally {
    for (const name of leftovers(f.cwd)) rmSync(join(f.cwd, name), { recursive: true, force: true });
    dispose(f);
  }
});


test("shared cache pins, prepared argv and failed marker writes remain explicit", async () => {
  const future = fixture("plain", "6.0.0"), mismatched = fixture("plain"), prepared = fixture("write");
  try {
    writeFileSync(join(mismatched.cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/vitest": { version: "5.0.1" } } }));
    for (const f of [future, mismatched]) {
      let spawned = false;
      assert.throws(() => execWhitelistedProof(pureProof(), f.cwd, 1000, () => { spawned = true; return tap; }, noBrowsers), ProofCacheUnavailableError);
      assert.equal(spawned, false);
    }
    const failed = createProofCache({ cwd: prepared.cwd, identity: ["marker-failure"] }, {
      writeMarker: () => { throw Object.assign(Error("marker refused"), { code: "EIO" }); },
    });
    assert.equal(failed.kind, "unavailable");
    if (failed.kind === "unavailable") assert.deepEqual(failed.cleanup, { released: true });
    assert.deepEqual(leftovers(prepared.cwd), [], "the directory is removed when its marker cannot be written");
    const proof = pureProof();
    const args = [join(prepared.cwd, "node_modules/vitest/vitest.mjs"), ...proof.args.slice(1)];
    assert.equal(execWhitelistedProof(proof, prepared.cwd, 20_000, undefined, { ...noBrowsers, preparedArgs: args }), "pass");
    assert.ok(observed(prepared.cwd)[0].cache, "prepared argv still gets a fresh cache before an actual spawn");
    assert.deepEqual(leftovers(prepared.cwd), []);
  } finally { dispose(future, mismatched, prepared); }
});

test("cache cleanup failure cannot turn a passing child into acknowledged success or erase its own error", async () => {
  const f = fixture("plain");
  const tamper = (args: readonly string[]) => {
    const path = args.find(arg => arg.startsWith(FLAG))!.slice(FLAG.length);
    writeFileSync(join(path, PROOF_CACHE_OWNER_FILE), "foreign owner");
  };
  try {
    const proof = pureProof();
    assert.throws(() => execWhitelistedProof(proof, f.cwd, 1000, (_c, args) => { tamper(args); return tap; }, noBrowsers), ProofCacheUnavailableError);
    assert.equal(proof.proofCacheRelease?.released, false);
    await assert.rejects(execWhitelistedProofAsync(pureProof(), f.cwd, 1000, async (_c, args) => { tamper(args); return tap; }, noBrowsers), ProofCacheUnavailableError);
    const failed = pureProof();
    const boom = Object.assign(Error("original child error"), { code: "ETIMEDOUT" });
    assert.throws(() => execWhitelistedProof(failed, f.cwd, 1000, (_c, args) => { tamper(args); throw boom; }, noBrowsers), error => error === boom);
    assert.equal(failed.proofCacheRelease?.released, false);
    await assert.rejects(execWhitelistedProofAsync(pureProof(), f.cwd, 1000, async (_c, args) => { tamper(args); throw boom; }, noBrowsers), error => error === boom);
  } finally { dispose(f); }
});
