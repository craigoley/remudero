/**
 * W1-T6594 — HOST BACKUP AND SCRATCH MAINTENANCE KEEP THEIR REAL SAFETY PATHS ON THE MAC DEFAULT BASH.
 *
 * Observed with the Mac's real /bin/bash 3.2.57: the verified Azure off-host copy reached snapshot
 * retention and then died on `syntax error near unexpected token newline` (a `case` pattern's bare `)`
 * inside a command substitution, which Bash 3.2 re-parses when it runs it), and the scratch sweep exited
 * under nounset on a unit whose SCRATCH_LIVE_REPOS array was empty. `bash -n` passed both scripts:
 * these are EXECUTED paths, so only executing them proves anything.
 *
 * So every case here runs the REAL deploy script through an EXPLICITLY NAMED shell executable, in an
 * isolated temporary fixture root, with every external command a fixture port (docker, az, lsof, df,
 * fsid, flock). The shells are found, not assumed: /bin/bash (the Mac default), RMD_TEST_HISTORICAL_BASH
 * (any Bash < 4.4 an operator names), and the modern Bash first on PATH or under Homebrew. A runner
 * with no historical shell says, as a test diagnostic, that Bash 3.2 is UNVERIFIED there; it never
 * presents a modern shell as equivalent, and it never skips — the modern control always runs.
 *
 * Each arm carries a positive control proving it really executed (deletions were issued, a bundle was
 * archived and the unit removed), so a script that died early cannot pass by doing nothing.
 *
 * Falsifiers: restore the `case` inside `$(...)` in host-update.sh, or the bare
 * "${SCRATCH_LIVE_REPOS[@]}" in rmd-host-cleanup.sh, and the historical-shell run fails; drop the
 * owned-name filter and the foreign snapshots are deleted; archive the bundle after the REMOVE and the
 * ordering assertion fails.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { SCRIPT as CLEANUP_SCRIPT, age, fixture, type Fixture } from "./helpers/host-cleanup-fixture.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE_SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

// ── THE NAMED SHELLS ─────────────────────────────────────────────────────────────────────────

interface Shell {
  path: string;
  version: string;
  /** Bash before 4.4: the empty-array-under-nounset and comsub re-parse behaviour of the Mac's 3.2. */
  historical: boolean;
}

function probeShell(path: string): Shell | null {
  if (!existsSync(path)) return null;
  const r = spawnSync(path, ["-c", 'printf "%s %s %s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}" "${BASH_VERSINFO[2]}"'], {
    encoding: "utf8",
  });
  const m = /^(\d+) (\d+) (\d+)$/.exec(r.stdout ?? "");
  if (r.status !== 0 || !m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return { path, version: `${m[1]}.${m[2]}.${m[3]}`, historical: major < 4 || (major === 4 && minor < 4) };
}

function namedShells(): Shell[] {
  const onPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const candidates = ["/bin/bash", process.env.RMD_TEST_HISTORICAL_BASH ?? "", onPath, "/opt/homebrew/bin/bash", "/usr/local/bin/bash"];
  const seen = new Set<string>();
  const shells: Shell[] = [];
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    const real = realpathSync(c);
    if (seen.has(real)) continue;
    seen.add(real);
    const s = probeShell(c);
    if (s) shells.push(s);
  }
  return shells;
}

const SHELLS = namedShells();

/** Every shell this runner has, and an explicit UNVERIFIED line for each class it lacks. */
function shellsFor(t: TestContext): Shell[] {
  assert.ok(SHELLS.length > 0, "no Bash executable was found at all: nothing could be verified");
  t.diagnostic(`named shells: ${SHELLS.map((s) => `${s.path} (${s.version}${s.historical ? ", historical" : ", modern"})`).join(", ")}`);
  if (!SHELLS.some((s) => s.historical)) {
    t.diagnostic(
      `Bash 3.2 UNVERIFIED on this runner: no Bash < 4.4 exists here (/bin/bash is ${probeShell("/bin/bash")?.version ?? "absent"}); ` +
        "only a modern Bash executed, which is NOT evidence the Mac's default /bin/bash path is healthy. " +
        "Name one with RMD_TEST_HISTORICAL_BASH to verify it.",
    );
  }
  if (!SHELLS.some((s) => !s.historical)) t.diagnostic("modern Bash control UNVERIFIED on this runner: no Bash >= 4.4 exists here");
  return SHELLS;
}

// ── OFF-HOST RETENTION FIXTURE (the technique of the-nightly-state-snapshot-has-an-off-host-copy) ──

const RG = "SYNTHWATCH-RG";
const DISK = "remudero-data";
const DISK_ID = `/subscriptions/505a01eb-0000/resourceGroups/${RG}/providers/Microsoft.Compute/disks/${DISK}`;
const DISK_TARGET = `azure-disk-snapshot:${RG}/${DISK}`;
const OURS = { purpose: "fleet-state-backup", "created-by": "host-update" };

/** `docker run` as the image would run it: `-v` mounts and `/app` rewritten onto this checkout. */
const RUN_HELPER = `
import { spawnSync } from "node:child_process";
const [repoRoot, ...argv] = process.argv.slice(2);
const mounts = [];
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rm") continue;
  if (["--pull", "--network", "-w", "--entrypoint"].includes(a)) { i++; continue; }
  if (a === "-v") { const [src, dst] = argv[++i].split(":"); mounts.push([dst, src]); continue; }
  break;
}
const cmd = argv.slice(i + 1).map((arg) => {
  let out = arg.split("/app/").join(repoRoot + "/");
  for (const [dst, src] of mounts) out = out.split(dst).join(src);
  return out;
});
process.exit(spawnSync(process.execPath, cmd, { cwd: repoRoot, stdio: "inherit" }).status ?? 1);
`;

/** A fake `az` over a JSON model of the resource group's snapshots; honours the script's tag filters. */
const AZ_FAKE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(join(process.env.STUB_REC, "az-calls"), JSON.stringify(argv) + "\\n");
const modes = (process.env.STUB_AZ_MODE ?? "").split(",");
const statePath = process.env.STUB_AZ_STATE;
const model = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { snapshots: [] };
const save = () => writeFileSync(statePath, JSON.stringify(model));
const opt = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const fail = (msg, code = 1) => { process.stderr.write("ERROR: " + msg + "\\n"); process.exit(code); };
const query = opt("--query") ?? "";
switch (argv.slice(0, 2).join(" ")) {
  case "disk show":
    console.log(process.env.STUB_DISK_ID + "|eastus");
    break;
  case "snapshot create": {
    const i = argv.indexOf("--tags");
    const tags = {};
    for (let j = i + 1; i >= 0 && j < argv.length && !argv[j].startsWith("-"); j++) {
      const [k, v] = argv[j].split("="); tags[k] = v;
    }
    model.snapshots.push({ name: opt("-n"), tags, time: new Date().toISOString(), source: opt("--source") });
    save();
    break;
  }
  case "snapshot show": {
    const s = model.snapshots.find((x) => x.name === opt("-n"));
    if (!s) fail("(ResourceNotFound) snapshot " + opt("-n"), 3);
    console.log(["Succeeded", s.tags.purpose, s.tags["created-by"], s.source].join("|"));
    break;
  }
  case "snapshot list": {
    let rows = [...model.snapshots];
    if (query.includes("tags.purpose=='fleet-state-backup'")) rows = rows.filter((s) => s.tags.purpose === "fleet-state-backup");
    if (query.includes("tags.\\"created-by\\"=='host-update'")) rows = rows.filter((s) => s.tags["created-by"] === "host-update");
    if (query.includes("sort_by(")) rows.sort((a, b) => a.time.localeCompare(b.time));
    for (const s of rows) console.log(s.name);
    break;
  }
  case "snapshot delete":
    if (modes.includes("delete-fails")) fail("(Conflict) snapshot is in use");
    model.snapshots = model.snapshots.filter((x) => x.name !== opt("-n"));
    save();
    break;
  default:
    fail("fake az: unexpected command " + argv.join(" "), 2);
}
`;

interface Snap {
  name: string;
  tags: Record<string, string>;
  time: string;
  source?: string;
}

interface Rung {
  status: number;
  stdout: string;
  stderr: string;
  az: string[][];
  snapshots: Snap[];
  receipt: string;
}

function runRung(shell: Shell, opts: { seed: Snap[]; env?: Record<string, string>; args?: string[] }): Rung {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shellport-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shellport-rec-`));
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in "info --format") echo "$STUB_REC"; exit 0 ;; "system df") echo "TYPE TOTAL"; exit 0 ;; esac',
    'case "$1" in',
    "  ps) exit 0 ;;",
    '  run) shift; exec node "$STUB_DIR/docker-run.mjs" "$STUB_REPO_ROOT" "$@" ;;',
    '  image) [ "$2" = inspect ] && exit 0; echo "Total reclaimed space: 0B"; exit 0 ;;',
    "esac",
    'echo "Total reclaimed space: 0B"; exit 0',
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "docker-run.mjs"), RUN_HELPER);
  writeFileSync(join(dir, "az-fake.mjs"), AZ_FAKE);
  writeFileSync(join(dir, "az-fake"), '#!/usr/bin/env bash\nexec node "$STUB_DIR/az-fake.mjs" "$@"\n', { mode: 0o755 });
  const state = join(rec, "az-state.json");
  writeFileSync(state, JSON.stringify({ snapshots: opts.seed }));
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shellport-vol-`));
  mkdirSync(join(vol, "state"), { recursive: true });
  writeFileSync(join(vol, "state", "ledger.ndjson"), '{"step":"run.start","task":"W1-T6594"}\n');
  const receipt = join(rec, "receipt", "state-snapshot.receipt");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    STUB_DIR: dir,
    STUB_REPO_ROOT: REPO_ROOT,
    STUB_AZ_STATE: state,
    STUB_DISK_ID: DISK_ID,
    RMD_STATE_DIR: vol,
    RMD_STATE_OFFHOST: DISK_TARGET,
    RMD_STATE_OFFHOST_AZ: join(dir, "az-fake"),
    RMD_STATE_SNAPSHOT_RECEIPT: receipt,
    RMD_GIT_RECLAIM_DIRS: gitRepo({ kind: "shellport-reclaim-target" }).dir,
    RMD_AGENT_HISTORY_DIRS: join(vol, "no-agent-history"),
    ...opts.env,
  };
  delete env.RMD_STATE_BACKUP_DIR;
  const r = spawnSync(shell.path, [UPDATE_SCRIPT, ...(opts.args ?? ["--reclaim-only"])], { encoding: "utf8", cwd: REPO_ROOT, env });
  const calls = existsSync(join(rec, "az-calls")) ? readFileSync(join(rec, "az-calls"), "utf8").split("\n").filter(Boolean) : [];
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    az: calls.map((l) => JSON.parse(l) as string[]),
    snapshots: (JSON.parse(readFileSync(state, "utf8")) as { snapshots: Snap[] }).snapshots,
    receipt: existsSync(receipt) ? readFileSync(receipt, "utf8") : "",
  };
}

const optOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const deletes = (run: Rung) => run.az.filter((c) => c[0] === "snapshot" && c[1] === "delete").map((c) => optOf(c, "-n"));
const snap = (name: string, tags: Record<string, string>, day: number): Snap => ({
  name,
  tags,
  time: new Date(Date.UTC(2026, 8, day)).toISOString(),
});
const stamp = (day: number) => `${DISK}-202609${String(day).padStart(2, "0")}T041700Z`;

test("off-host retention executes on the real host shells without broadening its deletion set", (t) => {
  // Four of this rung's own, oldest first; and, OLDER still and carrying BOTH of its tags so only the
  // owned-name filter stands between them and deletion, names that are not <disk>-<UTC stamp>.
  const ours = [3, 4, 5, 6].map((d) => snap(stamp(d), OURS, d));
  const foreignTagged = [
    snap("other-disk-20260901T041700Z", OURS, 1),
    snap(`${DISK}-manual-keep`, OURS, 1),
    snap(`${DISK}-20260901T041700Z-keep`, OURS, 1),
    snap(`x${DISK}-20260901T041700Z`, OURS, 1),
    snap(`${DISK}-20260901T0417Z`, OURS, 2),
  ];
  const operator = snap(stamp(2), { purpose: "fleet-state-backup", "created-by": "operator-session" }, 2);
  const untagged = snap(`${DISK}-20260902T041701Z`, {}, 2);
  const foreign = [...foreignTagged, operator, untagged];

  for (const shell of shellsFor(t)) {
    const at = `${shell.path} (${shell.version})`;
    const run = runRung(shell, { seed: [...foreign, ...ours], env: { RMD_STATE_OFFHOST_KEEP: "2" } });
    assert.doesNotMatch(run.stderr, /syntax error|unbound variable/, `${at}: the retention arm parsed and ran:\n${run.stderr}`);
    assert.equal(run.status, 0, `${at}: a verified copy with a clean prune passes the rung:\n${run.stderr}`);
    const created = optOf(run.az.find((c) => c[0] === "snapshot" && c[1] === "create") ?? [], "-n");
    assert.match(created, new RegExp(`^${DISK}-\\d{8}T\\d{6}Z$`), `${at}: tonight's snapshot was created`);
    assert.match(run.stdout, new RegExp(`azure disk snapshot ${RG}/${created} verified`), `${at}: and verified before retention`);
    // POSITIVE CONTROL: retention really executed, and its deletion set is exactly the oldest of its own.
    assert.deepEqual(deletes(run), [stamp(3), stamp(4), stamp(5)], `${at}: exactly the oldest owned snapshots, oldest first:\n${run.stdout}`);
    assert.match(run.stdout, new RegExp(`expired azure disk snapshot ${RG}/${stamp(3)} \\(keeping the newest 2\\)`), at);
    const left = run.snapshots.map((s) => s.name);
    for (const s of foreign) assert.ok(left.includes(s.name), `${at}: ${s.name} is not this rung's to expire`);
    assert.ok(left.includes(created), `${at}: the newest snapshot, tonight's, is never expired`);
    assert.ok(left.includes(stamp(6)), `${at}: the newest RMD_STATE_OFFHOST_KEEP are kept`);
    assert.match(run.receipt, /^result=ok$/m, `${at}: the receipt records the healthy night:\n${run.receipt}`);
    assert.match(run.receipt, /^offhost=ok$/m, at);

    // A delete that fails is a FAILED night, recorded as such, and still expires nothing foreign.
    const failed = runRung(shell, { seed: [...foreign, ...ours], env: { RMD_STATE_OFFHOST_KEEP: "2", STUB_AZ_MODE: "delete-fails" } });
    assert.doesNotMatch(failed.stderr, /syntax error|unbound variable/, `${at}:\n${failed.stderr}`);
    assert.notEqual(failed.status, 0, `${at}: a failed expiry must not report success`);
    assert.match(failed.stderr, /OFF-HOST COPY FAILED — az snapshot delete -g \S+ -n remudero-data-20260903T041700Z failed/, `${at}:\n${failed.stderr}`);
    assert.deepEqual(deletes(failed), [stamp(3), stamp(4), stamp(5)], `${at}: the attempted set is still only its own oldest`);
    assert.match(failed.receipt, /^result=failed$/m, `${at}: the receipt records the failure:\n${failed.receipt}`);
    assert.match(failed.receipt, /^offhost=failed$/m, at);
    for (const s of foreign) assert.ok(failed.snapshots.some((x) => x.name === s.name), `${at}: ${s.name} survives a failed night`);

    // --dry-run contacts no az and mutates nothing.
    const dry = runRung(shell, { seed: [...foreign, ...ours], env: { RMD_STATE_OFFHOST_KEEP: "2" }, args: ["--reclaim-only", "--dry-run"] });
    assert.equal(dry.status, 0, `${at}:\n${dry.stderr}`);
    assert.match(dry.stdout, /off-host copy \(DRY RUN\) — would copy to azure-disk-snapshot:SYNTHWATCH-RG\/remudero-data/, at);
    assert.deepEqual(dry.az, [], `${at}: a dry run sends nothing`);
    assert.deepEqual(dry.snapshots.map((s) => s.name), [...foreign, ...ours].map((s) => s.name), `${at}: and deletes nothing`);
  }
});

// ── SCRATCH: A UNIT WITH NO REPOSITORY MEMBERS ─────────────────────────────────────────────────

/** The janitor through a named shell; the whole-pass lock is a fixture port, not the host's flock. */
function sweep(shell: Shell, fx: Fixture, extra: Record<string, string> = {}) {
  const flock = join(fx.root, "bin", "flock");
  if (!existsSync(flock)) {
    writeFileSync(flock, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(fx.root, "flock.calls")}"\nexit 0\n`);
    chmodSync(flock, 0o755);
  }
  const env = {
    ...process.env,
    ...fx.env,
    RMD_CLEANUP_FLOCK: flock,
    RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch,
    RMD_CLEANUP_SCRATCH_PARENTS: "",
    RMD_CLEANUP_TMP_ROOTS: "",
    ...extra,
  };
  const r = spawnSync(shell.path, [CLEANUP_SCRIPT], { encoding: "utf8", cwd: REPO_ROOT, env });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A scratch unit holding no Git repository at all, only a loose bundle and some data. */
function emptyMemberUnit(fx: Fixture, name: string): { unit: string; bundle: string; bytes: Buffer } {
  const unit = join(fx.scratch, name);
  mkdirSync(join(unit, "work"), { recursive: true });
  writeFileSync(join(unit, "work", "data"), "x");
  const bundle = join(unit, "work", "saved.bundle");
  const bytes = Buffer.from(`# v2 git bundle\nfixture ${name}\n`);
  writeFileSync(bundle, bytes);
  return { unit, bundle, bytes };
}

const archived = (fx: Fixture) => {
  const d = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch");
  return existsSync(d) ? readdirSync(d).map((n) => join(d, n)) : [];
};

test("empty scratch membership preserves whole-unit safety on the real host shells", (t) => {
  for (const shell of shellsFor(t)) {
    const at = `${shell.path} (${shell.version})`;

    // 1. POSITIVE CONTROL: an idle unit with no repository is swept — its bundle is ARCHIVED, byte for
    //    byte, BEFORE the unit is removed, and the pass reaches its end.
    {
      const fx = fixture();
      const u = emptyMemberUnit(fx, "loose");
      age(u.unit);
      const r = sweep(shell, fx);
      assert.doesNotMatch(r.stderr, /unbound variable|syntax error/, `${at}: the empty-member arm ran:\n${r.stderr}`);
      assert.equal(r.status, 0, `${at}:\n${r.stderr}${r.stdout}`);
      const files = archived(fx);
      assert.equal(files.length, 1, `${at}: the loose bundle was archived:\n${r.stdout}`);
      assert.ok(readFileSync(files[0]).equals(u.bytes), `${at}: byte for byte`);
      const archiveAt = r.stdout.indexOf(`ARCHIVE ${u.bundle} -> `);
      const removeAt = r.stdout.indexOf(`REMOVE ${u.unit}\n`);
      assert.ok(archiveAt >= 0 && removeAt > archiveAt, `${at}: preservation precedes removal:\n${r.stdout}`);
      assert.equal(existsSync(u.unit), false, `${at}: and then the idle unit goes:\n${r.stdout}`);
      assert.ok(readFileSync(join(fx.root, "flock.calls"), "utf8").includes("-n -E 73 9"), `${at}: the lock port was asked`);
    }

    // 2. Empty membership is not a bypass: every unit-level hold still keeps the unit.
    {
      const fx = fixture();
      const fresh = emptyMemberUnit(fx, "fresh");
      const held = emptyMemberUnit(fx, "held");
      const marked = emptyMemberUnit(fx, "marked");
      writeFileSync(join(marked.unit, ".rmd-scratch-keep"), "");
      for (const u of [held, marked]) age(u.unit);
      writeFileSync(fx.lsofList, `${held.unit}/work/data\n`);
      const r = sweep(shell, fx);
      assert.doesNotMatch(r.stderr, /unbound variable|syntax error/, `${at}:\n${r.stderr}`);
      assert.equal(r.status, 0, `${at}:\n${r.stderr}${r.stdout}`);
      assert.ok(r.stdout.includes(`KEEP ${fresh.unit}: written within 720 min`), `${at}:\n${r.stdout}`);
      assert.ok(r.stdout.includes(`KEEP ${held.unit}: held open by a process`), `${at}:\n${r.stdout}`);
      assert.ok(r.stdout.includes(`KEEP ${marked.unit}: scratch keep marker`), `${at}:\n${r.stdout}`);
      for (const u of [fresh, held, marked]) {
        assert.equal(existsSync(u.bundle), true, `${at}: ${u.unit} keeps its bundle`);
      }
      assert.deepEqual(archived(fx), [], `${at}: a held unit archives nothing`);
    }

    // 3. A bundle with nowhere safe to go (the archive is on the same filesystem) keeps the unit whole.
    {
      const fx = fixture();
      const u = emptyMemberUnit(fx, "stuck");
      age(u.unit);
      const r = sweep(shell, fx, { FAKE_ARCHIVE_FSID: "1" });
      assert.doesNotMatch(r.stderr, /unbound variable|syntax error/, `${at}:\n${r.stderr}`);
      assert.equal(r.status, 0, `${at}:\n${r.stderr}${r.stdout}`);
      assert.ok(r.stdout.includes(`KEEP ${u.unit}: bundle could not be archived safely`), `${at}:\n${r.stdout}`);
      assert.ok(!r.stdout.includes(`REMOVE ${u.unit}`), `${at}:\n${r.stdout}`);
      assert.ok(readFileSync(u.bundle).equals(u.bytes), `${at}: the bundle is untouched`);
    }

    // 4. An unknown probe is a refusal, never a pass: a failing lsof keeps the unit.
    {
      const fx = fixture();
      const u = emptyMemberUnit(fx, "unknown");
      age(u.unit);
      const r = sweep(shell, fx, { FAKE_LSOF_FAIL: "1" });
      assert.doesNotMatch(r.stderr, /unbound variable|syntax error/, `${at}:\n${r.stderr}`);
      assert.equal(existsSync(u.bundle), true, `${at}: an unknown process probe removes nothing:\n${r.stdout}`);
      assert.ok(!r.stdout.includes(`REMOVE ${u.unit}`), `${at}:\n${r.stdout}`);
    }

    // 5. --dry-run names the archive and the removal, and mutates nothing.
    {
      const fx = fixture();
      const u = emptyMemberUnit(fx, "dry");
      age(u.unit);
      const r = sweep(shell, fx, { DRY_RUN: "1" });
      assert.doesNotMatch(r.stderr, /unbound variable|syntax error/, `${at}:\n${r.stderr}`);
      assert.equal(r.status, 0, `${at}:\n${r.stderr}${r.stdout}`);
      assert.ok(r.stdout.includes(`ARCHIVE ${u.bundle} -> `), `${at}: the dry run reached the archive step:\n${r.stdout}`);
      assert.ok(r.stdout.includes(`DRYRUN would: rm -rf -- ${u.unit}`), `${at}:\n${r.stdout}`);
      assert.equal(existsSync(u.unit), true, `${at}: a dry run removes nothing`);
      assert.ok(readFileSync(u.bundle).equals(u.bytes), `${at}: and moves no bundle`);
      assert.deepEqual(archived(fx), [], `${at}: and writes no archive`);
    }
  }
});
