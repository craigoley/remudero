import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { resolveLedgerUnion } from "#src/lib/ledger-union.js";
import { parseLedger } from "#src/lib/retro.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const terminalStep = "sweep.fix.uncreditable_head";
const escalatedStep = "sweep.fix.uncreditable_head_escalated";
const rawPattern = /"step":"sweep\.fix\.uncreditable_head"|"step":"sweep\.fix\.uncreditable_head_escalated"/;
const standDownReason = `terminal uncreditable head already escalated for this PR@head (${escalatedStep})`;
const unreadHistoryReason = "terminal uncreditable head history is unreadable";
const childFlag = "--warm-terminal-check-child";
const rotationName = /^ledger\..+\.ndjson\.gz$/;
const candidates = [1, 2, 3, 4, 5].map((prNumber) => ({ prNumber, headSha: `sha-${prNumber}` }) as OpenPrView);
const freePr = candidates[4]!;

function terminal(prNumber: number) {
  return {
    step: terminalStep, pr_number: prNumber, head_sha: `sha-${prNumber}`, head: "foreign/fix",
    reason: "not_a_run_branch", terminal: true, repair_task_id: "W1-T14386", cause: "review",
  };
}

function escalated(prNumber: number) {
  return { step: escalatedStep, pr_number: prNumber, head_sha: `sha-${prNumber}` };
}

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "warm-terminal-check");
  const ledger = writeLedger([terminal(4)], {
    dir: join(root, "state"),
    rotations: [
      { at: "2026-11-01T00:00:00.000Z", gz: true, rows: [terminal(1), escalated(1), { step: "unrelated" }] },
      { at: "2026-11-02T00:00:00.000Z", gz: true, rows: [terminal(2), escalated(2), terminal(3)] },
      { at: "2026-11-03T00:00:00.000Z", gz: true, rows: [escalated(3)] },
    ],
  });
  const archive = join(ledger.dir, "ledger.2026-11-02T00-00-00-000Z.ndjson.gz");
  // Whole seconds, so a replacement can carry the same mtime exactly.
  utimesSync(archive, 1_800_000_000, 1_800_000_000);
  return { root, ...ledger, archive, rotations: 3 };
}

function buildEffects(root: string, ledgerPath: string) {
  return buildSweepEffects({
    owner: "acme", repo: "scratch", config: { root } as never,
    ledgerPath, runId: "SWEEP-warm-terminal-check", plan: { tasks: [], byId: new Map() },
    log: () => {}, policy: DEFAULT_SWEEP_POLICY,
  });
}

/** Run `act` while counting reads (readFileSync or openSync) of rotated ledger files and gunzip calls. */
function counting<T>(act: () => T, fault?: (path: string, nth: number) => Buffer | undefined) {
  const read = fs.readFileSync;
  const open = fs.openSync;
  const gunzip = zlib.gunzipSync;
  const reads: string[] = [];
  let gunzips = 0;
  let inRead = 0; // readFileSync opens through fs.openSync: count that open once, as one read.
  const rotation = (path: unknown): path is string => typeof path === "string" && rotationName.test(basename(path));
  fs.readFileSync = new Proxy(read, {
    apply(target, receiver, args) {
      if (rotation(args[0])) {
        reads.push(args[0]);
        const replaced = fault?.(args[0], reads.filter((path) => path === args[0]).length);
        if (replaced !== undefined) return replaced;
      }
      inRead++;
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        inRead--;
      }
    },
  });
  fs.openSync = new Proxy(open, {
    apply(target, receiver, args) {
      if (rotation(args[0]) && inRead === 0) reads.push(args[0]);
      return Reflect.apply(target, receiver, args);
    },
  });
  zlib.gunzipSync = (...args) => {
    gunzips++;
    return gunzip(...args);
  };
  syncBuiltinESMExports();
  try {
    return { value: act(), reads, gunzips };
  } finally {
    fs.readFileSync = read;
    fs.openSync = open;
    zlib.gunzipSync = gunzip;
    syncBuiltinESMExports();
  }
}

function answers(standDown: (pr: OpenPrView) => string | undefined): Array<string | undefined> {
  return candidates.map((pr) => standDown(pr));
}

function unionAnswers(dir: string): Array<string | undefined> {
  const union = resolveLedgerUnion(dir, rawPattern);
  assert.equal(union.ok, true);
  const rows = parseLedger(union.matches.join("\n"));
  return candidates.map(({ prNumber, headSha }) => {
    const headRows = rows.filter((row) => row.pr_number === prNumber && row.head_sha === headSha);
    const stuck = headRows.some((row) => row.step === terminalStep && row.reason === "not_a_run_branch" && row.terminal === true)
      && headRows.some((row) => row.step === escalatedStep);
    return stuck ? standDownReason : undefined;
  });
}

function eio(): never {
  throw Object.assign(new Error("rotation read failed: EIO"), { code: "EIO" });
}

function damaged(archive: string): Buffer {
  const bytes = Buffer.from(readFileSync(archive));
  bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
  return bytes;
}

function coldCheck(root: string, ledgerPath: string, mode: "clean" | "eio" | "corrupt", archive: string) {
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    fileURLToPath(import.meta.url), childFlag, root, ledgerPath, mode, archive,
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as { answers: Array<string | null>; reads: number; gunzips: number };
}

if (process.argv[2] === childFlag) {
  const [root, ledgerPath, mode, archive] = process.argv.slice(3) as [string, string, string, string];
  const bad = mode === "corrupt" ? damaged(archive) : undefined;
  const observed = counting(() => answers(buildEffects(root, ledgerPath).terminalFixStandDown!), (path) => {
    if (path !== archive || mode === "clean") return undefined;
    return bad ?? eio();
  });
  process.stdout.write(JSON.stringify({
    answers: observed.value.map((answer) => answer ?? null), reads: observed.reads.length, gunzips: observed.gunzips,
  }));
} else {
  test("W1-T14386 criterion 1: warm stand-down checks with no rotation stat change read no rotation bytes", (t) => {
    const { root, dir, path, rotations } = fixture(t);
    const expected = unionAnswers(dir);
    assert.deepEqual(expected, [standDownReason, standDownReason, standDownReason, undefined, undefined]);
    const effects = buildEffects(root, path);

    const first = counting(() => effects.terminalFixStandDown!(candidates[0]!));
    assert.equal(first.value, standDownReason);
    assert.ok(first.reads.length >= rotations, "the first check reads and verifies every rotation");
    assert.equal(new Set(first.reads).size, rotations);

    const second = counting(() => answers(effects.terminalFixStandDown!));
    const third = counting(() => answers(effects.terminalFixStandDown!));
    const sibling = counting(() => answers(buildEffects(root, path).terminalFixStandDown!));
    for (const warm of [second, third, sibling]) {
      assert.deepEqual(warm.reads, []);
      assert.equal(warm.gunzips, 0);
      assert.deepEqual(warm.value, expected);
    }
  });

  const statChanges = {
    "a rewrite": (archive: string) => writeFileSync(archive, readFileSync(archive)),
    "a same-size, same-mtime replacement": (archive: string) => {
      const before = statSync(archive);
      const temp = `${archive}.tmp`;
      writeFileSync(temp, readFileSync(archive));
      utimesSync(temp, before.atime, before.mtime);
      renameSync(temp, archive);
      const after = statSync(archive);
      assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
      assert.notEqual(after.ino, before.ino);
    },
  };
  for (const [change, apply] of Object.entries(statChanges)) {
    test(`W1-T14386 criterion 2: ${change} of a verified rotation is read and hashed again before the next answer`, (t) => {
      const { root, path, archive } = fixture(t);
      const effects = buildEffects(root, path);
      const expected = answers(effects.terminalFixStandDown!);
      assert.equal(counting(() => answers(effects.terminalFixStandDown!)).reads.length, 0);

      apply(archive);
      const reread = counting(() => answers(effects.terminalFixStandDown!));
      assert.ok(reread.reads.filter((read) => read === archive).length >= 2, "parsed, then hashed against its fingerprint");
      assert.deepEqual(reread.reads.filter((read) => read !== archive), []);
      assert.deepEqual(reread.value, expected);
      assert.equal(counting(() => answers(effects.terminalFixStandDown!)).reads.length, 0);
    });

    test(`W1-T14386 criterion 2: EIO after ${change} of a verified rotation holds dispatch`, (t) => {
      const { root, path, archive } = fixture(t);
      const effects = buildEffects(root, path);
      assert.equal(effects.terminalFixStandDown!(freePr), undefined);

      apply(archive);
      const held = counting(() => answers(effects.terminalFixStandDown!), (read) => (read === archive ? eio() : undefined));
      assert.deepEqual(held.value, candidates.map(() => unreadHistoryReason));
      assert.equal(buildEffects(root, path).terminalFixStandDown!(freePr), undefined, "readable bytes free the head again");
    });

    test(`W1-T14386 criterion 2: bytes that differ from the fingerprint after ${change} hold dispatch`, (t) => {
      const { root, path, archive } = fixture(t);
      const effects = buildEffects(root, path);
      assert.equal(effects.terminalFixStandDown!(freePr), undefined);

      apply(archive);
      const bad = damaged(archive);
      // The parse reads the real bytes; every later read of the same rotation returns other bytes.
      const held = counting(() => answers(effects.terminalFixStandDown!), (read, nth) => (read === archive && nth > 1 ? bad : undefined));
      assert.deepEqual(held.value, candidates.map(() => unreadHistoryReason));
      assert.ok(held.reads.filter((read) => read === archive).length >= 2);
      assert.equal(buildEffects(root, path).terminalFixStandDown!(freePr), undefined, "the next build hashes the real bytes again");
    });
  }

  test("W1-T14386 criterion 3: a cold reader seeded from the shared snapshot hashes every rotation and holds on EIO or corrupt bytes", (t) => {
    const { root, dir, path, archive, rotations } = fixture(t);
    const expected = answers(buildEffects(root, path).terminalFixStandDown!);
    rmSync(join(dir, "cache", "rotation-digests"), { recursive: true, force: true });
    assert.ok(statSync(join(dir, "cache", "rotation-slices")).isDirectory(), "the warm build published the shared snapshot");

    const clean = coldCheck(root, path, "clean", archive);
    assert.deepEqual(clean.answers, expected.map((answer) => answer ?? null));
    assert.equal(clean.gunzips, 0, "the cold rows come from the shared snapshot");
    assert.equal(clean.reads, rotations, "the cold reader hashes each rotation it did not verify itself");

    for (const mode of ["eio", "corrupt"] as const) {
      const held = coldCheck(root, path, mode, archive);
      assert.deepEqual(held.answers, candidates.map(() => unreadHistoryReason), mode);
      assert.equal(held.gunzips, 0, `${mode}: the fault is found by the hash of snapshot rows, not by a parse`);
    }
  });

  test("W1-T14386 criterion 4: a live escalation row appended between warm checks is seen without rotation reads", (t) => {
    const { root, dir, path } = fixture(t);
    const effects = buildEffects(root, path);
    const before = answers(effects.terminalFixStandDown!);
    assert.equal(before[3], undefined);

    writeFileSync(path, `${JSON.stringify(escalated(4))}\n`, { flag: "a" });
    const after = counting(() => answers(effects.terminalFixStandDown!));
    const expected = unionAnswers(dir);
    assert.equal(expected[3], standDownReason);
    assert.deepEqual(after.value, expected);
    assert.deepEqual(after.reads, []);
    assert.equal(after.gunzips, 0);
  });
}
