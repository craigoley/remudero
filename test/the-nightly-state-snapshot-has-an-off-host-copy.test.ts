/**
 * W1-T5546 — THE NIGHTLY STATE SNAPSHOT HAS AN OFF-HOST COPY.
 *
 * Every state root and every archive W1-T5545 writes sits on ONE Azure managed disk (remudero-data,
 * mounted at /mnt/rmd): a lost disk loses the ledger and all its backups together. Section 3a of
 * `deploy/host-update.sh --reclaim-only` now ships a copy off the VM once the local archives verify,
 * when `RMD_STATE_OFFHOST` names a target — an incremental Azure disk snapshot or a blob upload — and
 * says so in one line, without failing, when it names none (enabling it is an operator cost decision).
 *
 * THE TECHNIQUE IS test/the-state-snapshot-actually-runs-on-this-host.test.ts's: stub `docker` on
 * PATH, run the REAL script. Its `docker run` really runs snapshotState against this checkout, so the
 * archive an off-host copy ships is a real one. `az` is a FAKE (`RMD_STATE_OFFHOST_AZ`, or a fake named
 * `az` first on PATH for the default) that records every argv and keeps a tiny JSON model of the
 * resource group's snapshots and the container's blobs. It honours exactly the JMESPath filters the
 * script asks for, so a list query that drops the tag filter really does return untagged snapshots.
 * NO TEST HERE MAY REACH THE REAL `az`: every run either injects the fake or puts it first on PATH.
 *
 * Falsifier: ignore the fake `az`'s non-zero exit, and the failure test's rung exits 0 with no copy.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const LEDGER = '{"step":"run.start","task":"W1-T5546"}\n';
const RG = "SYNTHWATCH-RG";
const DISK = "remudero-data";
const DISK_ID = `/subscriptions/505a01eb-0000/resourceGroups/${RG}/providers/Microsoft.Compute/disks/${DISK}`;
const DISK_TARGET = `azure-disk-snapshot:${RG}/${DISK}`;

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

/**
 * The fake `az`. STUB_AZ_MODE is a comma list of failures to act out; the model lives in
 * STUB_AZ_STATE ({ snapshots: [{ name, tags, time, source }], blobs: { name: { size, copy } } }).
 */
const AZ_FAKE = `
import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(join(process.env.STUB_REC, "az-calls"), JSON.stringify(argv) + "\\n");
const modes = (process.env.STUB_AZ_MODE ?? "").split(",");
const statePath = process.env.STUB_AZ_STATE;
const model = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { snapshots: [], blobs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(model));
const opt = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const fail = (msg, code = 1) => { process.stderr.write("ERROR: " + msg + "\\n"); process.exit(code); };
const cmd = argv.slice(0, 2).join(" ") + (argv[0] === "storage" ? " " + argv[2] : "");
const query = opt("--query") ?? "";
switch (cmd) {
  case "disk show":
    if (modes.includes("disk-missing")) fail("(ResourceNotFound) disk " + opt("-n"), 3);
    console.log(process.env.STUB_DISK_ID + "|eastus");
    break;
  case "snapshot create": {
    if (modes.includes("create-fails")) fail("(QuotaExceeded) snapshot quota reached");
    if (modes.includes("create-lies")) break;
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
    if (!s || modes.includes("show-fails")) fail("(ResourceNotFound) snapshot " + opt("-n"), 3);
    console.log(["Succeeded", s.tags.purpose, s.tags["created-by"], s.source].join("|"));
    break;
  }
  case "snapshot list": {
    if (modes.includes("list-fails")) fail("(AuthorizationFailed) list");
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
  case "storage blob upload": {
    if (modes.includes("upload-fails")) fail("(AuthorizationPermissionMismatch) upload");
    const file = opt("--file");
    const copy = join(process.env.STUB_REC, "blob-" + Object.keys(model.blobs).length + ".tar.gz");
    copyFileSync(file, copy);
    const size = statSync(file).size;
    model.blobs[opt("--account-name") + "/" + opt("--container-name") + "/" + opt("--name")] = { size: modes.includes("blob-short") ? size - 1 : size, copy };
    save();
    break;
  }
  case "storage blob show": {
    const b = model.blobs[opt("--account-name") + "/" + opt("--container-name") + "/" + opt("--name")];
    if (!b) fail("(BlobNotFound)", 3);
    console.log(String(b.size));
    break;
  }
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

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  docker: string[];
  az: string[][];
  model: { snapshots: Snap[]; blobs: Record<string, { size: number; copy: string }> };
  vol: string;
}

function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "${a//$\'\\n\'/ }" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
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
  // Named `az-fake`, not `az`: only the default-path test puts a fake named `az` on PATH.
  writeFileSync(join(dir, "az-fake"), '#!/usr/bin/env bash\nexec node "$STUB_DIR/az-fake.mjs" "$@"\n', { mode: 0o755 });
}

function stateVolume(): string {
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}offhost-vol-`));
  mkdirSync(join(vol, "state"), { recursive: true });
  writeFileSync(join(vol, "state", "ledger.ndjson"), LEDGER);
  return vol;
}

interface Opts {
  env?: NodeJS.ProcessEnv;
  seed?: Snap[];
  args?: string[];
  vol?: string;
  /** Put a fake named `az` first on PATH and leave RMD_STATE_OFFHOST_AZ unset (the default). */
  defaultAz?: boolean;
}

function runRung(opts: Opts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}offhost-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}offhost-rec-`));
  writeStubs(dir);
  const state = join(rec, "az-state.json");
  writeFileSync(state, JSON.stringify({ snapshots: opts.seed ?? [], blobs: {} }));
  const vol = opts.vol ?? stateVolume();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    STUB_DIR: dir,
    STUB_REPO_ROOT: REPO_ROOT,
    STUB_AZ_STATE: state,
    STUB_DISK_ID: DISK_ID,
    RMD_STATE_DIR: vol,
    RMD_STATE_OFFHOST_AZ: join(dir, "az-fake"),
    RMD_GIT_RECLAIM_DIRS: gitRepo({ kind: "offhost-reclaim-target" }).dir,
    RMD_AGENT_HISTORY_DIRS: join(vol, "no-agent-history"),
  };
  delete env.RMD_STATE_OFFHOST;
  delete env.RMD_STATE_OFFHOST_KEEP;
  delete env.RMD_STATE_BACKUP_DIR;
  if (opts.defaultAz) {
    writeFileSync(join(dir, "az"), '#!/usr/bin/env bash\nexec node "$STUB_DIR/az-fake.mjs" "$@"\n', { mode: 0o755 });
    delete env.RMD_STATE_OFFHOST_AZ;
  }
  Object.assign(env, opts.env ?? {});
  const r = spawnSync("bash", [SCRIPT, ...(opts.args ?? ["--reclaim-only"])], { encoding: "utf8", cwd: REPO_ROOT, env });
  const read = (f: string) => (existsSync(join(rec, f)) ? readFileSync(join(rec, f), "utf8").split("\n").filter(Boolean) : []);
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    docker: read("calls"),
    az: read("az-calls").map((l) => JSON.parse(l) as string[]),
    model: JSON.parse(readFileSync(state, "utf8")),
    vol,
  };
}

const azCalls = (run: Run, a: string, b: string) => run.az.filter((c) => c[0] === a && c[1] === b);
const optOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const archivesIn = (vol: string) => {
  const d = join(vol, "state-backups");
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith("state-backup.")) : [];
};
const snap = (name: string, tags: Record<string, string>, day: number): Snap => ({
  name,
  tags,
  time: new Date(Date.UTC(2026, 8, day)).toISOString(),
});
const OURS = { purpose: "fleet-state-backup", "created-by": "host-update" };
const stamp = (day: number) => `${DISK}-202609${String(day).padStart(2, "0")}T041700Z`;

// ── 1. THE ACCEPTANCE: A VERIFIED COPY PASSES, A FAILED ONE FAILS, AN UNSET TARGET IS A NOTE ────

test("a verified off-host disk snapshot passes the nightly rung", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET } });
  assert.equal(run.status, 0, `a verified off-host copy must not fail the rung:\n${run.stderr}`);
  assert.equal(archivesIn(run.vol).length, 1, "control: the local archive was taken first");

  const creates = azCalls(run, "snapshot", "create");
  assert.equal(creates.length, 1, "exactly one snapshot of the disk per night");
  const c = creates[0];
  assert.equal(optOf(c, "--incremental"), "true", "incremental — a full copy every night is the cost the operator did not approve");
  assert.equal(optOf(c, "--source"), DISK_ID, "the snapshot's source is the disk the state lives on, by id");
  assert.equal(optOf(c, "-g"), RG);
  assert.equal(optOf(c, "-l"), "eastus", "an incremental snapshot is taken in the disk's own region");
  assert.match(optOf(c, "-n"), new RegExp(`^${DISK}-\\d{8}T\\d{6}Z$`), "named <disk>-<UTC stamp>");
  assert.ok(c.includes("purpose=fleet-state-backup") && c.includes("created-by=host-update"), "tagged so retention can tell its own");

  const shows = azCalls(run, "snapshot", "show");
  assert.equal(shows.length, 1, "the copy is VERIFIED with az snapshot show, not taken on an exit code");
  assert.equal(optOf(shows[0], "-n"), optOf(c, "-n"));
  assert.ok(run.az.indexOf(shows[0]) > run.az.indexOf(c), "verification follows the create");
  assert.match(run.stdout, new RegExp(`off-host copy — azure disk snapshot ${RG}/${optOf(c, "-n")} verified`));
  assert.equal(run.model.snapshots.length, 1);
});

test("an off-host copy failure fails the nightly rung", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, STUB_AZ_MODE: "create-fails" } });
  assert.notEqual(run.status, 0, "a night with no off-host copy must not report success");
  assert.match(run.stderr, /STATE SNAPSHOT OFF-HOST COPY FAILED — az snapshot create .* exited 1/);
  assert.match(run.stderr, /QuotaExceeded/, "the cause is shown");
  assert.match(run.stderr, /nightly STATE SNAPSHOT did not leave a verified, recent archive/);
  assert.equal(archivesIn(run.vol).length, 1, "the local archive is kept: a failed copy is no reason to lose it");
  assert.ok(run.docker.some((l) => l.startsWith("docker\timage\tprune")), "the reclaim still runs");
  assert.equal(azCalls(run, "snapshot", "delete").length, 0, "a failed night expires nothing");
});

test("an unconfigured off-host target is reported without failing the rung", () => {
  const run = runRung();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /off-host copy — NOT CONFIGURED/);
  assert.match(run.stdout, /RMD_STATE_OFFHOST/);
  assert.match(run.stdout, /COST decision/, "the line says why it is off: enabling it costs money");
  assert.deepEqual(run.az, [], "no target, no az at all");
});

// ── 2. VERIFY, DON'T TRUST ──────────────────────────────────────────────────────────────────

test("an az snapshot create that exits 0 but leaves no snapshot is not believed", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, STUB_AZ_MODE: "create-lies" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /OFF-HOST COPY FAILED — az snapshot create exited 0 but az snapshot show/);
  assert.match(run.stderr, /ResourceNotFound/);
});

test("a disk that cannot be resolved fails the rung before anything is created", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, STUB_AZ_MODE: "disk-missing" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /OFF-HOST COPY FAILED — az disk show .* exited 3/);
  assert.equal(azCalls(run, "snapshot", "create").length, 0);
});

// ── 3. RETENTION: ONLY ITS OWN, ONLY AFTER A VERIFIED NEW ONE ────────────────────────────────

test("retention keeps the newest RMD_STATE_OFFHOST_KEEP host-update snapshots and never touches another", () => {
  const ours = [1, 2, 3, 4].map((d) => snap(stamp(d), OURS, d));
  const operator = snap(`${DISK}-20260903T2304Z`, { purpose: "fleet-state-backup", "created-by": "operator-session" }, 3);
  const untagged = snap(`${DISK}-20260902T041701Z`, {}, 2);
  const otherDisk = snap("other-disk-20260901T041700Z", OURS, 1);
  const oddName = snap(`${DISK}-manual-keep`, OURS, 1);
  const run = runRung({
    env: { RMD_STATE_OFFHOST: DISK_TARGET, RMD_STATE_OFFHOST_KEEP: "3" },
    seed: [...ours, operator, untagged, otherDisk, oddName],
  });
  assert.equal(run.status, 0, run.stderr);
  const left = run.model.snapshots.map((s) => s.name);
  const created = optOf(azCalls(run, "snapshot", "create")[0], "-n");
  assert.deepEqual(
    left.filter((n) => n === created || ours.some((o) => o.name === n)).sort(),
    [stamp(3), stamp(4), created].sort(),
    "the newest 3 of its own remain, tonight's included",
  );
  for (const s of [operator, untagged, otherDisk, oddName]) assert.ok(left.includes(s.name), `${s.name} is not this rung's to expire`);
  const list = azCalls(run, "snapshot", "list")[0];
  assert.ok(list, "control: the prune listed snapshots");
  assert.match(optOf(list, "--query"), /tags\.purpose=='fleet-state-backup'/, "the list filters on the purpose tag");
  assert.match(optOf(list, "--query"), /tags\."created-by"=='host-update'/, "and on its own created-by tag");
  assert.equal(azCalls(run, "snapshot", "delete").length, 2);
  assert.match(run.stdout, /expired azure disk snapshot .*-20260901T041700Z \(keeping the newest 3\)/);
});

test("a failed off-host snapshot deletes none of the older ones", () => {
  const ours = [1, 2, 3].map((d) => snap(stamp(d), OURS, d));
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, RMD_STATE_OFFHOST_KEEP: "1", STUB_AZ_MODE: "create-fails" }, seed: ours });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.model.snapshots.map((s) => s.name), ours.map((s) => s.name), "they are the only off-host copies left");
  assert.equal(azCalls(run, "snapshot", "list").length, 0);
});

test("a snapshot delete or list that fails fails the rung, because cost would grow unseen", () => {
  const seed = [1, 2].map((d) => snap(stamp(d), OURS, d));
  for (const mode of ["delete-fails", "list-fails"]) {
    const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, RMD_STATE_OFFHOST_KEEP: "1", STUB_AZ_MODE: mode }, seed });
    assert.notEqual(run.status, 0, mode);
    assert.match(run.stderr, /OFF-HOST COPY FAILED — .*(snapshot delete|snapshot list)/, mode);
    assert.match(run.stdout, /off-host copy — azure disk snapshot .* verified/, `${mode}: the copy itself was made and said so`);
  }
});

// ── 4. CONFIGURATION ─────────────────────────────────────────────────────────────────────────

test("the default az on PATH is the one used when RMD_STATE_OFFHOST_AZ is unset", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET }, defaultAz: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(azCalls(run, "snapshot", "create").length, 1, "the fake named az on PATH took the call");
});

test("a target set with no az to run fails the rung loudly", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET, RMD_STATE_OFFHOST_AZ: "/nonexistent/az" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /OFF-HOST COPY FAILED — RMD_STATE_OFFHOST is set but '\/nonexistent\/az' is not a command/);
});

test("a malformed target or keep count fails the rung and contacts nothing", () => {
  for (const env of [
    { RMD_STATE_OFFHOST: "s3:bucket" },
    { RMD_STATE_OFFHOST: "azure-disk-snapshot:just-a-disk" },
    { RMD_STATE_OFFHOST: "azure-blob:acct/container/extra" },
    { RMD_STATE_OFFHOST: DISK_TARGET, RMD_STATE_OFFHOST_KEEP: "0" },
  ]) {
    const run = runRung({ env });
    assert.notEqual(run.status, 0, JSON.stringify(env));
    assert.match(run.stderr, /OFF-HOST COPY FAILED — (RMD_STATE_OFFHOST='|RMD_STATE_OFFHOST_KEEP must)/, JSON.stringify(env));
    assert.deepEqual(run.az, [], JSON.stringify(env));
    assert.equal(archivesIn(run.vol).length, 1, "the local archive is still taken");
  }
});

test("--dry-run names the off-host copy and sends nothing", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET }, args: ["--reclaim-only", "--dry-run"] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /off-host copy \(DRY RUN\) — would copy to azure-disk-snapshot:SYNTHWATCH-RG\/remudero-data/);
  assert.deepEqual(run.az, []);
});

test("a night whose local snapshot failed attempts no off-host copy and still fails", () => {
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}offhost-empty-`));
  mkdirSync(join(vol, "state"), { recursive: true }); // snapshotState refuses an empty archive
  const run = runRung({ env: { RMD_STATE_OFFHOST: DISK_TARGET }, vol });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /off-host copy — skipped: no archive was verified tonight/);
  assert.deepEqual(run.az, []);
});

// ── 5. THE BLOB TARGET ───────────────────────────────────────────────────────────────────────

test("an azure-blob target uploads each verified archive as a tarball and verifies its size", () => {
  const run = runRung({ env: { RMD_STATE_OFFHOST: "azure-blob:rmdbackups/state" } });
  assert.equal(run.status, 0, run.stderr);
  const up = azCalls(run, "storage", "blob");
  const upload = up.find((c) => c[2] === "upload");
  assert.ok(upload, "the archive was uploaded");
  assert.equal(optOf(upload, "--account-name"), "rmdbackups");
  assert.equal(optOf(upload, "--container-name"), "state");
  assert.equal(optOf(upload, "--auth-mode"), "login", "the host's az login, never an account key on argv");
  const [archive] = archivesIn(run.vol);
  assert.match(optOf(upload, "--name"), new RegExp(`state-backups/${archive}\\.tar\\.gz$`));
  assert.ok(up.some((c) => c[2] === "show"), "the blob is verified after the upload");
  const [blob] = Object.values(run.model.blobs);
  const listing = spawnSync("tar", ["-tzf", blob.copy], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, new RegExp(`^${archive}/ledger\\.ndjson$`, "m"), "the tarball holds the archive");
  assert.match(run.stdout, /off-host copy — .* -> azure-blob rmdbackups\/state\/.* verified/);
  assert.deepEqual(
    readdirSync(join(run.vol, "state-backups")).filter((n) => !n.startsWith("state-backup.")),
    [],
    "the upload's temporary tarball is removed",
  );
});

test("a blob upload that fails, or whose size does not match, fails the rung", () => {
  for (const mode of ["upload-fails", "blob-short"]) {
    const run = runRung({ env: { RMD_STATE_OFFHOST: "azure-blob:rmdbackups/state", STUB_AZ_MODE: mode } });
    assert.notEqual(run.status, 0, mode);
    assert.match(run.stderr, /OFF-HOST COPY FAILED — az storage blob (upload .* exited 1|show reports)/, mode);
  }
});
