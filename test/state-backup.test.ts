import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  STATE_BACKUP_LEDGER_RELPATH,
  STATE_BACKUP_PROPOSALS_REGISTER_RELPATH,
  StateBackupError,
  restoreState,
  snapshotState,
} from "../src/lib/ledger.js";

// ── W1-T234: state/ holds the ledger, the run locks, the service tokens and the proposals
// register — and until this task none of it was backed up. These three tests are this
// task's own rewritten acceptance proofs, verbatim: (1) a snapshot's content list names the
// ledger and the proposals register, (2) restore round-trips a seeded state directory with
// the restored ledger byte-identical to the source, (3) a snapshot failure escalates loudly
// rather than completing silently or leaving an empty archive. ─────────────────────────────

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Seeds a fake `state/` directory with the four organs this task's title names — the
 *  ledger, a run lock, a service-token file, and the proposals register — plus a
 *  `status.json` that must NOT survive into a snapshot (this task's own rationale: "status.json
 *  is rederivable and does not matter"). */
function seedStateDir(): string {
  const stateDir = tmpDir("rmd-state-backup-src-");
  writeFileSync(join(stateDir, "ledger.ndjson"), '{"ts":"2026-08-19T00:00:00.000Z","run_id":"r1","task_id":"W1-T234","step":"run.start"}\n');
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P45" }] }));
  writeFileSync(join(stateDir, "drain.lock"), JSON.stringify({ holder: "host-a", pid: 123 }));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ derived: true }));
  mkdirSync(join(stateDir, "inflight"), { recursive: true });
  writeFileSync(join(stateDir, "inflight", "W1-T1.lock"), JSON.stringify({ holder: "host-a" }));
  const tokenPath = join(stateDir, "worker-keychain-password");
  writeFileSync(tokenPath, "s3cr3t");
  chmodSync(tokenPath, 0o600); // matches worker-home.ts's own service-token file mode
  return stateDir;
}

test("acceptance 1: a snapshot's content list names the ledger and the proposals register", () => {
  const stateDir = seedStateDir();
  const backupsRoot = tmpDir("rmd-state-backup-dst-");

  const result = snapshotState(stateDir, backupsRoot);

  assert.ok(result.entries.length > 0, "snapshot must be non-empty");
  assert.ok(result.entries.includes(STATE_BACKUP_LEDGER_RELPATH), "content list must name the ledger");
  assert.ok(
    result.entries.includes(STATE_BACKUP_PROPOSALS_REGISTER_RELPATH),
    "content list must name the proposals register",
  );
  // status.json is explicitly rederivable (this task's own rationale) and must be excluded.
  assert.ok(!result.entries.includes("status.json"), "status.json must not be backed up");
  // The archive directory this call reports must be real and hold what it claims.
  assert.ok(existsSync(result.archiveDir));
  assert.deepStrictEqual(readdirSync(result.archiveDir).sort(), ["drain.lock", "inbox-proposals.json", "inflight", "ledger.ndjson", "worker-keychain-password"].sort());
});

test("acceptance 2: restore round-trips a seeded state directory, ledger byte-identical to the source", () => {
  const stateDir = seedStateDir();
  const backupsRoot = tmpDir("rmd-state-backup-dst-");
  const restoreDir = tmpDir("rmd-state-backup-restore-");

  const snapshot = snapshotState(stateDir, backupsRoot);
  restoreState(snapshot.archiveDir, restoreDir);

  const sourceLedger = readFileSync(join(stateDir, "ledger.ndjson"));
  const restoredLedger = readFileSync(join(restoreDir, "ledger.ndjson"));
  assert.deepStrictEqual(restoredLedger, sourceLedger, "restored ledger must be byte-identical to the source");

  const sourceRegister = readFileSync(join(stateDir, "inbox-proposals.json"));
  const restoredRegister = readFileSync(join(restoreDir, "inbox-proposals.json"));
  assert.deepStrictEqual(restoredRegister, sourceRegister, "restored proposals register must be byte-identical to the source");

  const sourceLock = readFileSync(join(stateDir, "inflight", "W1-T1.lock"));
  const restoredLock = readFileSync(join(restoreDir, "inflight", "W1-T1.lock"));
  assert.deepStrictEqual(restoredLock, sourceLock, "restored run lock must be byte-identical to the source");

  // status.json was never in the snapshot, so it must never reappear on restore either.
  assert.ok(!existsSync(join(restoreDir, "status.json")));
});

test("acceptance 2b: restore preserves the service token's permission bits", { skip: process.platform === "win32" }, () => {
  const stateDir = seedStateDir();
  const backupsRoot = tmpDir("rmd-state-backup-dst-");
  const restoreDir = tmpDir("rmd-state-backup-restore-");

  const snapshot = snapshotState(stateDir, backupsRoot);
  restoreState(snapshot.archiveDir, restoreDir);

  const restoredMode = statSync(join(restoreDir, "worker-keychain-password")).mode & 0o777;
  assert.strictEqual(restoredMode, 0o600, "restored service token must keep its 0600 mode");
});

test("acceptance 3: a snapshot failure escalates loudly rather than completing silently or leaving an empty archive", () => {
  const backupsRoot = tmpDir("rmd-state-backup-dst-");

  // A source dir that does not exist at all — the most basic failure a scheduled nightly
  // run can hit (a wiped/unmounted state root).
  const missingStateDir = join(tmpDir("rmd-state-backup-missing-parent-"), "does-not-exist");
  assert.throws(() => snapshotState(missingStateDir, backupsRoot), StateBackupError);
  assert.deepStrictEqual(readdirSync(backupsRoot), [], "a failed snapshot must not leave anything behind");

  // A source dir whose only contents are excluded (rederivable) — snapshotState must refuse
  // to publish an EMPTY archive rather than silently completing with nothing to restore.
  const emptyStateDir = tmpDir("rmd-state-backup-empty-src-");
  writeFileSync(join(emptyStateDir, "status.json"), "{}");
  assert.throws(() => snapshotState(emptyStateDir, backupsRoot), StateBackupError);
  assert.deepStrictEqual(readdirSync(backupsRoot), [], "an empty-would-be archive must never be published");

  // Restoring from an archive that does not exist must also throw loudly, never silently no-op.
  assert.throws(() => restoreState(join(backupsRoot, "no-such-snapshot"), tmpDir("rmd-state-backup-restore-")), StateBackupError);
});

/** A stand-in for `copyStateFiles` that copies every entry EXCEPT `skipRel` (pass `null` to
 *  skip nothing). Injected only by the verification test below: the real copier copies every
 *  entry or throws, so "the staged copy lost a file" cannot be produced through the public
 *  API — and a refusal that can never fire is indistinguishable from one that is absent. */
function copierSkipping(skipRel: string | null): (srcRoot: string, dstRoot: string, relPaths: readonly string[]) => void {
  return (srcRoot, dstRoot, relPaths) => {
    for (const rel of relPaths) {
      if (rel === skipRel) continue;
      const dst = join(dstRoot, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(srcRoot, rel), dst);
    }
  };
}

test("acceptance 3b: a snapshot whose staged copy lost the ledger is refused, not published", () => {
  const stateDir = seedStateDir();
  const backupsRoot = tmpDir("rmd-state-backup-dst-");

  // The staged copy comes back non-empty but WITHOUT the ledger — the one file this task's
  // acceptance names by name. Verification must refuse it rather than publish an archive an
  // operator would later restore from and find the ledger gone.
  assert.throws(
    () => snapshotState(stateDir, backupsRoot, { copy: copierSkipping(STATE_BACKUP_LEDGER_RELPATH) }),
    (err: unknown) =>
      err instanceof StateBackupError &&
      err.message.includes(STATE_BACKUP_LEDGER_RELPATH) &&
      /refusing to publish it/.test(err.message),
  );
  assert.deepStrictEqual(readdirSync(backupsRoot), [], "a refused snapshot must leave no archive and no temp dir");

  // CONTROL, same seam and same invocation: an injected copier that skips NOTHING publishes
  // normally — so the refusal above is the missing ledger, not the injection itself.
  const published = snapshotState(stateDir, backupsRoot, { copy: copierSkipping(null) });
  assert.ok(published.entries.includes(STATE_BACKUP_LEDGER_RELPATH));
  assert.deepStrictEqual(readdirSync(backupsRoot), [basename(published.archiveDir)]);
});

test("acceptance 3c: restore refuses an archive that exists but holds no files", () => {
  const restoreDir = tmpDir("rmd-state-backup-restore-");

  // The archive EXISTS — so this is a different refusal from the missing-source one above —
  // but its walk yields no files. A directory-only tree is the realistic shape (a half-copied
  // archive), and it proves the refusal reads the WALK rather than a top-level readdir.
  const emptyArchive = tmpDir("rmd-state-backup-empty-archive-");
  mkdirSync(join(emptyArchive, "inflight"), { recursive: true });
  assert.ok(existsSync(emptyArchive), "the archive must exist, or this would exercise the wrong refusal");

  assert.throws(
    () => restoreState(emptyArchive, restoreDir),
    (err: unknown) => err instanceof StateBackupError && /refusing to restore from an empty archive/.test(err.message),
  );
  assert.deepStrictEqual(readdirSync(restoreDir), [], "a refused restore must not write into the target");

  // CONTROL, same archive path and same call: one real file in it and the restore succeeds —
  // so the refusal above is the emptiness, not an unreadable archive or an unusable target.
  writeFileSync(join(emptyArchive, STATE_BACKUP_LEDGER_RELPATH), "{}\n");
  restoreState(emptyArchive, restoreDir);
  assert.deepStrictEqual(readdirSync(restoreDir), [STATE_BACKUP_LEDGER_RELPATH]);
});

test("acceptance 3d: a restore that fails for an unforeseen reason is wrapped as a StateBackupError, cause kept", () => {
  const stateDir = seedStateDir();
  const backupsRoot = tmpDir("rmd-state-backup-dst-");
  const snapshot = snapshotState(stateDir, backupsRoot);

  // A uid-INDEPENDENT denial: the target's parent is a regular FILE, so the mkdir inside
  // restoreState raises ENOTDIR for every uid, root included. (A chmod-based denial would
  // read as success under root — which is why test/host-capability-fixtures.test.ts refuses
  // one, and CHMOD_REMEDY names exactly this substitution.)
  const notADir = join(tmpDir("rmd-state-backup-notdir-"), "occupied");
  writeFileSync(notADir, "this path is a file, not a directory\n");
  const impossibleTarget = join(notADir, "state");

  assert.throws(
    () => restoreState(snapshot.archiveDir, impossibleTarget),
    (err: unknown) =>
      err instanceof StateBackupError &&
      err.message.includes(`restore into ${impossibleTarget}`) &&
      err.message.includes("failed:") &&
      (err.cause as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR",
  );

  // CONTROL, same archive and same call: a target whose parent IS a directory restores
  // cleanly — so the wrap above is the ENOTDIR, not a defective archive.
  const goodTarget = join(tmpDir("rmd-state-backup-restore-"), "state");
  restoreState(snapshot.archiveDir, goodTarget);
  assert.ok(existsSync(join(goodTarget, STATE_BACKUP_LEDGER_RELPATH)));
});

const engineHash = "a".repeat(64);
const engineRel = `engines/${engineHash}`;
const dependencyRel = `${engineRel}/node_modules`;
const manifestRel = "state-backup-engine-links.json";

function seedEngine(state: string, target: string): void {
  const engine = join(state, engineRel);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: "b".repeat(40), sourceHash: engineHash, builtAt: 123 }));
  writeFileSync(join(engine, "package.json"), '{"name":"engine","version":"1.0.0"}');
  writeFileSync(join(engine, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
  symlinkSync(target, join(state, dependencyRel));
}

test("a state backup restores engine dependency links without following their targets", () => {
  const state = seedStateDir();
  const backups = tmpDir("rmd-engine-backups-");
  const target = "../../../missing-worker/node_modules";
  seedEngine(state, target);
  const snapshot = snapshotState(state, backups);
  assert.equal(readlinkSync(join(snapshot.archiveDir, dependencyRel)), target);
  assert.ok(snapshot.entries.includes(dependencyRel));
  assert.equal(existsSync(join(state, manifestRel)), false, "metadata belongs only in the archive");
  const manifest = JSON.parse(readFileSync(join(snapshot.archiveDir, manifestRel), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "requires-engine-dependency-reconstruction");
  assert.equal(manifest.links[0].path, dependencyRel);
  assert.equal(manifest.links[0].target, target);
  assert.equal(manifest.links[0].sourceHash, engineHash);
  assert.equal(manifest.links[0].revision, "b".repeat(40));
  assert.ok(manifest.links[0].identities["package.json"]);
  assert.ok(manifest.links[0].identities["package-lock.json"]);
  const restored = tmpDir("rmd-engine-restore-");
  const restoredState = restoreState(snapshot.archiveDir, restored);
  assert.ok(lstatSync(join(restored, dependencyRel)).isSymbolicLink());
  assert.equal(readlinkSync(join(restored, dependencyRel)), target);
  assert.equal(existsSync(join(restored, manifestRel)), false);
  assert.deepEqual(restoredState.reconstructionRequired, [dependencyRel]);
  const nextSnapshot = snapshotState(restored, tmpDir("rmd-engine-backups-"));
  assert.equal(readlinkSync(join(nextSnapshot.archiveDir, dependencyRel)), target);
  for (const rel of ["ledger.ndjson", "inbox-proposals.json", "worker-keychain-password"]) {
    assert.deepEqual(readFileSync(join(restored, rel)), readFileSync(join(state, rel)));
  }
  rmSync(join(restored, dependencyRel));
  symlinkSync("/old-dangling-install", join(restored, dependencyRel));
  restoreState(snapshot.archiveDir, restored);
  assert.equal(readlinkSync(join(restored, dependencyRel)), target);
});

test("engine dependency references do not excuse missing irreplaceable state", () => {
  const state = seedStateDir();
  const external = tmpDir("rmd-engine-install-");
  writeFileSync(join(external, "sentinel"), "external dependency payload");
  chmodSync(join(external, "sentinel"), 0o640);
  seedEngine(state, external);
  for (const rel of ["node_modules/critical", "engines/not-a-hash/node_modules/critical"]) {
    mkdirSync(dirname(join(state, rel)), { recursive: true });
    writeFileSync(join(state, rel), "irreplaceable");
  }
  const otherHash = "c".repeat(64);
  const realModules = `engines/${otherHash}/node_modules/critical`;
  mkdirSync(dirname(join(state, realModules)), { recursive: true });
  writeFileSync(join(state, realModules), "real directory");
  symlinkSync(external, join(state, "external-content"));
  symlinkSync("ledger.ndjson", join(state, "ledger-alias"));
  const backups = tmpDir("rmd-engine-backups-");
  const snapshot = snapshotState(state, backups);
  assert.equal(snapshot.entries.some((rel) => rel.startsWith(`${dependencyRel}/`)), false);
  assert.equal(readlinkSync(join(snapshot.archiveDir, dependencyRel)), external);
  assert.equal(readFileSync(join(snapshot.archiveDir, "external-content/sentinel"), "utf8"), "external dependency payload");
  assert.deepEqual(readFileSync(join(snapshot.archiveDir, "ledger-alias")), readFileSync(join(state, "ledger.ndjson")));
  for (const rel of ["node_modules/critical", "engines/not-a-hash/node_modules/critical", realModules]) {
    assert.equal(readFileSync(join(snapshot.archiveDir, rel), "utf8"), readFileSync(join(state, rel), "utf8"));
  }
  const restored = tmpDir("rmd-engine-restore-");
  restoreState(snapshot.archiveDir, restored);
  assert.equal(readlinkSync(join(restored, dependencyRel)), external);
  assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "external dependency payload");
  assert.equal(statSync(join(external, "sentinel")).mode & 0o777, 0o640);
  symlinkSync("missing-register", join(state, "critical-register"));
  const failedBackups = tmpDir("rmd-engine-backups-");
  assert.throws(() => snapshotState(state, failedBackups), StateBackupError);
  assert.deepEqual(readdirSync(failedBackups), []);
  rmSync(join(state, "critical-register"));
  assert.throws(() => snapshotState(state, failedBackups, { copy: copierSkipping("inbox-proposals.json") }), /missing inbox-proposals.json/);
  assert.deepEqual(readdirSync(failedBackups), []);
});

test("invalid engine dependency reconstruction evidence refuses before restore writes", () => {
  const state = seedStateDir();
  seedEngine(state, "/missing-worker/node_modules");
  const backups = tmpDir("rmd-engine-backups-");
  const engineRecord = join(state, engineRel, "engine.json");
  const originalRecord = readFileSync(engineRecord);
  for (const bad of [null, "{", '{}', JSON.stringify({ sha: "not-a-revision", sourceHash: engineHash, builtAt: 123 }),
    JSON.stringify({ sha: "b".repeat(40), sourceHash: "wrong", builtAt: 123 }),
    JSON.stringify({ sha: "b".repeat(40), sourceHash: engineHash, builtAt: "yesterday" })]) {
    if (bad === null) rmSync(engineRecord);
    else writeFileSync(engineRecord, bad);
    assert.throws(() => snapshotState(state, backups), /engine dependency reconstruction/);
    assert.deepEqual(readdirSync(backups), []);
    writeFileSync(engineRecord, originalRecord);
  }
  assert.throws(() => snapshotState(state, backups, { copy: (src, dst, paths) => {
    copierSkipping(null)(src, dst, paths);
    rmSync(join(dst, dependencyRel));
    symlinkSync("/substituted", join(dst, dependencyRel));
  } }), /engine dependency reconstruction/);
  assert.deepEqual(readdirSync(backups), []);
  const packageLock = join(state, engineRel, "package-lock.json");
  const sourceLock = readFileSync(packageLock);
  for (const bad of ["", "{", "[]", "{}"] ) {
    writeFileSync(packageLock, bad);
    assert.throws(() => snapshotState(state, backups), /engine dependency reconstruction/);
    assert.deepEqual(readdirSync(backups), []);
  }
  writeFileSync(packageLock, sourceLock);
  for (const change of [
    (dst: string) => writeFileSync(join(dst, manifestRel), "{}"),
    (dst: string) => rmSync(join(dst, dependencyRel)),
  ]) {
    assert.throws(() => snapshotState(state, backups, { copy: (src, dst, paths) => {
      copierSkipping(null)(src, dst, paths);
      change(dst);
    } }), /engine dependency reconstruction/);
    assert.deepEqual(readdirSync(backups), []);
  }
  const snapshot = snapshotState(state, backups);
  const manifestPath = join(snapshot.archiveDir, manifestRel);
  const originalManifest = readFileSync(manifestPath, "utf8");
  const target = tmpDir("rmd-engine-restore-");
  writeFileSync(join(target, "keep"), "untouched");
  const refuses = () => {
    assert.throws(() => restoreState(snapshot.archiveDir, target), /engine dependency reconstruction/);
    assert.deepEqual(readdirSync(target), ["keep"]);
    assert.equal(readFileSync(join(target, "keep"), "utf8"), "untouched");
  };
  for (const mutate of [
    (m: any) => { m.version = 99; },
    (m: any) => { m.links[0].path = "../escape/node_modules"; },
    (m: any) => { m.links[0].sourceHash = "d".repeat(64); },
    (m: any) => { m.links[0].revision = "e".repeat(40); },
    (m: any) => { m.links[0].target = "/substituted"; },
    (m: any) => { m.links[0].identities["package-lock.json"] = "f".repeat(64); },
    (m: any) => { m.criticalState = []; },
    (m: any) => { m.links.push(m.links[0]); },
    (m: any) => { m.links = []; },
  ]) {
    const manifest = JSON.parse(originalManifest);
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    refuses();
  }
  writeFileSync(manifestPath, "{");
  refuses();
  rmSync(manifestPath);
  refuses();
  writeFileSync(manifestPath, originalManifest);
  const lockPath = join(snapshot.archiveDir, engineRel, "package-lock.json");
  const lock = readFileSync(lockPath);
  writeFileSync(lockPath, '{"lockfileVersion":3,"packages":{"changed":{}}}');
  refuses();
  writeFileSync(lockPath, lock);
  const redirectTarget = tmpDir("rmd-engine-redirect-");
  const unsafeTarget = tmpDir("rmd-engine-unsafe-restore-");
  symlinkSync(redirectTarget, join(unsafeTarget, "engines"));
  assert.throws(() => restoreState(snapshot.archiveDir, unsafeTarget), /unsafe restore destination/);
  assert.deepEqual(readdirSync(unsafeTarget), ["engines"]);
  assert.deepEqual(readdirSync(redirectTarget), []);
  rmSync(join(unsafeTarget, "engines"));
  mkdirSync(join(unsafeTarget, dependencyRel), { recursive: true });
  writeFileSync(join(unsafeTarget, dependencyRel, "keep"), "occupied install");
  assert.throws(() => restoreState(snapshot.archiveDir, unsafeTarget), /unsafe restore destination/);
  assert.equal(existsSync(join(unsafeTarget, "ledger.ndjson")), false);
  assert.equal(readFileSync(join(unsafeTarget, dependencyRel, "keep"), "utf8"), "occupied install");
  rmSync(join(snapshot.archiveDir, "inbox-proposals.json"));
  refuses();
  assert.ok(existsSync(snapshot.archiveDir), "refusal must retain the archive");
});

test("a state backup refuses a directory link cycle without publishing", () => {
  const state = seedStateDir();
  mkdirSync(join(state, "nested"));
  symlinkSync("..", join(state, "nested", "back"));
  const backups = tmpDir("rmd-cycle-backups-");
  assert.throws(() => snapshotState(state, backups), /directory link cycle/);
  assert.deepEqual(readdirSync(backups), []);
  const target = tmpDir("rmd-cycle-restore-");
  assert.throws(() => restoreState(state, target), /directory link cycle/);
  assert.deepEqual(readdirSync(target), []);
  rmSync(join(state, "nested", "back"));
  symlinkSync("self", join(state, "self"));
  assert.throws(() => snapshotState(state, backups), /directory link cycle/);
  assert.deepEqual(readdirSync(backups), []);
});
