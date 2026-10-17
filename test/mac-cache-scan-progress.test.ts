/** Private real-filesystem controls for bounded namespace inventory reuse. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";

const script = resolve("deploy/mac/cache-reclaim.py");
function fixture(noise = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-cache-progress-")));
  const root = join(home, ".codex/work-artifacts");
  mkdirSync(root, { recursive: true }); mkdirSync(join(home, "tmp"));
  if (noise) for (let n = 0; n < 8; n++) {
    const dir = join(root, `noise-${n}`); mkdirSync(dir);
    for (let k = 0; k < 100; k++) writeFileSync(join(dir, `report-${k}.json`), "retained diagnostic\n");
  }
  const repo = gitRepo({ seedCommit: false, kind: "cache-progress-source" });
  writeFileSync(join(repo.dir, "package.json"), '{"private":true}\n');
  writeFileSync(join(repo.dir, ".gitignore"), ".next/\n");
  repo.git("add", "."); repo.git("commit", "-qm", "fixture source");
  const workspace = join(root, "candidate"); renameSync(repo.dir, workspace);
  writeFileSync(join(workspace, "private-unpublished.ts"), "preserve unpublished source\n");
  const cache = join(workspace, ".next/cache/turbopack"); mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "0001.sst"), "owned generated compiler cache\n");
  writeFileSync(join(workspace, ".next/receipt.json"), "preserve evidence\n");
  const stateDir = join(home, ".local/state/remudero/cache-reclaim-progress");
  const run = (apply = false, limit = 500_000, code = "", old = true) => {
    const program = "import runpy,os,time,sys,pathlib,json\nns=runpy.run_path(os.environ['CACHE_SCRIPT'])\ng=ns['main'].__globals__\n" +
      (old ? "observed=time.time();ns['time'].time=lambda:observed+8*3600\n" : "") +
      `g['MAX_ENTRIES']=${limit}\n` + code +
      `\nsys.exit(ns['main'](['--home',os.environ['CACHE_HOME']]${apply ? "+['--apply']" : ""}))\n`;
    const r = spawnSync("python3", ["-c", program], { encoding: "utf8", timeout: 60_000,
      env: { ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CACHE_HOME: home, CACHE_SCRIPT: script } });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr + r.stdout);
    const line = r.stdout.split("\n").find(l => l.startsWith("cache-reclaim: "));
    assert.ok(line, r.stdout); return JSON.parse(line.slice("cache-reclaim: ".length));
  };
  return { home, root, workspace, cache, stateDir, run };
}

test("cache scan progress eventually reclaims through multiple bounded passes without losing source or evidence", () => {
  const f = fixture(true);
  try {
    const reports: any[] = [];
    for (let n = 0; n < 12 && existsSync(f.cache); n++) reports.push(f.run(true, 450));
    assert.equal(existsSync(f.cache), false, JSON.stringify(reports));
    assert.ok(reports.length > 1);
    assert.equal(reports[0].inspection.discoveryComplete, false);
    assert.ok(reports.some(r => r.inspection.progress.reusedDirectories > 0));
    assert.ok(reports.every(r => r.entriesInspected <= 450 && r.bytesRead <= 2 * 1024 ** 3));
    const done = reports.at(-1);
    assert.equal(done.inspection.referencesComplete, true);
    assert.equal(done.inspection.candidateEvaluationComplete, true);
    assert.equal(done.decisions.find((r: any) => r.path === f.cache).action, "removed");
    assert.equal(readFileSync(join(f.workspace, "private-unpublished.ts"), "utf8"), "preserve unpublished source\n");
    assert.equal(readFileSync(join(f.workspace, ".next/receipt.json"), "utf8"), "preserve evidence\n");
    for (let n = 0; n < 8; n++) assert.equal(readFileSync(join(f.root, `noise-${n}/report-99.json`), "utf8"), "retained diagnostic\n");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress rechecks the final reference root after a warm namespace gains a shared symlink", () => {
  const f = fixture();
  try {
    assert.equal(f.run().decisions.find((r: any) => r.path === f.cache).action, "would-remove");
    symlinkSync(f.cache, join(f.home, "tmp/shared-compiler-cache"));
    const r = f.run(true);
    assert.equal(r.inspection.referencesComplete, true);
    assert.ok(r.inspection.progress.invalidatedDirectories > 0);
    assert.equal(r.decisions.find((v: any) => v.path === f.cache).reason, "shared-reference");
    assert.ok(existsSync(f.cache));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress invalidates changed descendants even when the outer reference root is unchanged", () => {
  const f = fixture();
  try {
    const consumer = join(f.home, "Developer/consumer"); mkdirSync(consumer, { recursive: true });
    f.run(); symlinkSync(f.cache, join(consumer, "cache-alias"));
    const r = f.run(true);
    assert.equal(r.decisions.find((v: any) => v.path === f.cache).reason, "shared-reference");
    assert.ok(existsSync(f.cache));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress refuses a forged inventory without using its omitted references", () => {
  const f = fixture();
  try {
    f.run(); const state = join(f.stateDir, "inventory.json");
    const value = JSON.parse(readFileSync(state, "utf8")); value.payload.directories = {};
    writeFileSync(state, JSON.stringify(value));
    const r = f.run(true);
    assert.ok(r.decisions.some((v: any) => v.reason === "progress-state-invalid"));
    assert.equal(r.inspection.discoveryComplete, false); assert.ok(existsSync(f.cache));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress refuses symlinked or nonprivate state instead of following or adopting it", () => {
  for (const variant of ["symlink", "permissions", "missing-key"]) {
    const f = fixture();
    try {
      f.run(); const state = join(f.stateDir, "inventory.json");
      if (variant === "symlink") { renameSync(state, join(f.home, "retained-state.json")); symlinkSync(join(f.home, "retained-state.json"), state); }
      if (variant === "permissions") chmodSync(state, 0o644);
      if (variant === "missing-key") renameSync(join(f.stateDir, "key"), join(f.home, "retained-key"));
      const r = f.run(true);
      assert.equal(r.inspection.discoveryComplete, false); assert.ok(existsSync(f.cache));
      assert.ok(r.decisions.some((v: any) => v.action === "keep"));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test("cache scan progress cannot turn a warm inventory into a six-hour or live-use bypass", () => {
  for (const variant of ["young", "active"]) {
    const f = fixture();
    try {
      f.run();
      const r = f.run(true, 500_000, variant === "active" ? "g['inactive']=lambda *a: (_ for _ in ()).throw(ns['Hold']('owned-live-use-control'))\n" : "", variant !== "young");
      assert.ok(existsSync(f.cache));
      assert.equal(r.decisions.find((v: any) => v.path === f.cache).reason, variant === "young" ? "recent-foreign-or-flagged" : "owned-live-use-control");
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test("cache scan progress cold-rescans a checkpoint from a different writer before considering removal", () => {
  const f = fixture();
  try {
    f.run(); symlinkSync(f.cache, join(f.home, "tmp/new-shared-alias"));
    const r = f.run(true, 500_000, String.raw`import hmac,hashlib
state=pathlib.Path(os.environ['CACHE_HOME'])/'.local/state/remudero/cache-reclaim-progress'
value=json.loads((state/'inventory.json').read_text());value['payload']['scope']['writer']='not-current-writer'
encoded=ns['DirectoryProgress'].encode(value['payload']);value['mac']=hmac.new((state/'key').read_bytes(),encoded,hashlib.sha256).hexdigest()
(state/'inventory.json').write_text(json.dumps(value))
`);
    assert.equal(r.inspection.progress.state, "reset-scope");
    // The old inventory is discarded; new discovery may legitimately be
    // reused by references later in this same fully checked pass.
    assert.equal(r.inspection.progress.loadedDirectories, 0);
    assert.equal(r.decisions.find((v: any) => v.path === f.cache).reason, "shared-reference");
    assert.ok(existsSync(f.cache));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress retains an indivisible directory that exceeds the per-pass entry ceiling", () => {
  const f = fixture();
  try {
    const wide = join(f.root, "wide"); mkdirSync(wide);
    for (let n = 0; n < 100; n++) writeFileSync(join(wide, `entry-${n}`), "retain\n");
    for (let n = 0; n < 3; n++) {
      const r = f.run(true, 80);
      assert.equal(r.inspection.discoveryComplete, false);
      assert.equal(r.inspection.exhausted.limit, "entries");
      assert.ok(r.entriesInspected <= 80); assert.ok(existsSync(f.cache));
    }
    assert.equal(readFileSync(join(wide, "entry-99"), "utf8"), "retain\n");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress does not double-charge authenticated names in a warm symlink-heavy reference scan", () => {
  const f = fixture();
  try {
    const consumer = join(f.home, "Developer/consumer"); mkdirSync(consumer, { recursive: true });
    for (let n = 0; n < 160; n++) symlinkSync(join(f.home, "unrelated-target"), join(consumer, `link-${n}`));
    const cold = f.run();
    assert.equal(cold.decisions.find((v: any) => v.path === f.cache).action, "would-remove");
    const warm = f.run(false, cold.entriesInspected);
    assert.equal(warm.inspection.referencesComplete, true);
    assert.equal(warm.decisions.find((v: any) => v.path === f.cache).action, "would-remove");
    assert.ok(warm.entriesInspected <= cold.entriesInspected);
    assert.ok(warm.inspection.progress.reusedDirectories > 0);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress evicts stale observations within its byte bound even after incomplete passes", () => {
  const f = fixture();
  try {
    const seed = String.raw`g['MAX_PROGRESS_BYTES']=4096
original_save=ns['DirectoryProgress'].save
def seed_and_save(self):
    s=pathlib.Path(os.environ['CACHE_HOME']).stat()
    for n in range(50): self.remember(pathlib.Path(os.environ['CACHE_HOME'])/('deleted-'+str(n)),s,[])
    original_save(self)
ns['DirectoryProgress'].save=seed_and_save
`;
    f.run(false, 500_000, seed);
    let value = JSON.parse(readFileSync(join(f.stateDir, "inventory.json"), "utf8"));
    const previous = Object.keys(value.payload.directories);
    assert.ok(previous.length > 0 && previous.length < 50);
    const wide = join(f.root, "wide"); mkdirSync(wide);
    for (let n = 0; n < 100; n++) writeFileSync(join(wide, `entry-${n}`), "retained\n");
    const r = f.run(false, 80, String.raw`g['MAX_PROGRESS_BYTES']=4096
original_save=ns['DirectoryProgress'].save
def churn_and_save(self):
    s=pathlib.Path(os.environ['CACHE_HOME']).stat()
    for n in range(50): self.remember(pathlib.Path(os.environ['CACHE_HOME'])/('new-'+str(n)),s,[])
    original_save(self)
ns['DirectoryProgress'].save=churn_and_save
`);
    assert.equal(r.inspection.discoveryComplete, false);
    assert.ok(r.inspection.progress.evictedDirectories > 0);
    assert.ok(statSync(join(f.stateDir, "inventory.json")).size <= 4096);
    value = JSON.parse(readFileSync(join(f.stateDir, "inventory.json"), "utf8"));
    assert.ok(Object.keys(value.payload.directories).some(p => p.endsWith("new-49")));
    assert.ok(previous.every(p => !(p in value.payload.directories)));
    assert.deepEqual(value.payload.recency, Object.keys(value.payload.directories).sort((a, b) => Number(a.split("new-").at(-1)) - Number(b.split("new-").at(-1))));
    // Recency survives canonical key sorting on the following authenticated load.
    const next = f.run(false, 80, "g['MAX_PROGRESS_BYTES']=4096\n");
    assert.equal(next.inspection.progress.state, "resumed");
    assert.ok(existsSync(f.cache));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cache scan progress cleans only its own failed save stage and never accumulates crash stages", () => {
  for (const fault of ["write", "fsync", "dir-fsync", "replace", "unlink", "race", "abandoned"]) {
    const f = fixture();
    try {
      f.run(); const inventory = readFileSync(join(f.stateDir, "inventory.json"));
      if (fault === "abandoned") writeFileSync(join(f.stateDir, "inventory.tmp"), "retain unknown crash-left stage\n", { mode: 0o600 });
      const inject = String.raw`original_save=ns['DirectoryProgress'].save
def failed_save(self):
    original_fsync,original_replace,original_fdopen,original_unlink=ns['os'].fsync,ns['os'].replace,ns['os'].fdopen,ns['os'].unlink
    def fail(*a,**kw): raise OSError('owned-save-failure')
    def dir_fsync(fd):
        if ns['stat'].S_ISDIR(ns['os'].fstat(fd).st_mode): raise OSError('owned-directory-fsync-failure')
        original_fsync(fd)
    def raced_replace(*a,**kw):
        ns['os'].unlink('inventory.tmp',dir_fd=self.fd)
        fd=ns['os'].open('inventory.tmp',ns['os'].O_CREAT|ns['os'].O_WRONLY|ns['os'].O_EXCL,0o600,dir_fd=self.fd)
        ns['os'].write(fd,b'preserve replaced stage');ns['os'].close(fd)
        raise OSError('owned-save-race')
    class FailedWriter:
        def __init__(self,fd,*a): self.fd=fd
        def __enter__(self): return self
        def __exit__(self,*a): ns['os'].close(self.fd)
        def write(self,data): raise OSError('owned-write-failure')
    try:
        if os.environ['SAVE_FAULT']=='write': ns['os'].fdopen=FailedWriter
        if os.environ['SAVE_FAULT']=='fsync': ns['os'].fsync=fail
        if os.environ['SAVE_FAULT']=='dir-fsync': ns['os'].fsync=dir_fsync
        if os.environ['SAVE_FAULT']=='replace': ns['os'].replace=fail
        if os.environ['SAVE_FAULT']=='unlink': ns['os'].replace=fail;ns['os'].unlink=fail
        if os.environ['SAVE_FAULT']=='race': ns['os'].replace=raced_replace
        original_save(self)
    finally:
        ns['os'].fsync,ns['os'].replace,ns['os'].fdopen,ns['os'].unlink=original_fsync,original_replace,original_fdopen,original_unlink
ns['DirectoryProgress'].save=failed_save
`;
      for (let n = 0; n < 3; n++) {
        const r = f.run(false, 500_000, `os.environ['SAVE_FAULT']=${JSON.stringify(fault)}\n` + inject);
        assert.ok(r.decisions.some((v: any) => v.action === "keep" && /owned-|stage-present/.test(v.reason ?? "")), JSON.stringify(r));
        if (fault !== "dir-fsync") assert.deepEqual(readFileSync(join(f.stateDir, "inventory.json")), inventory);
        else assert.equal(r.inspection.progress.state, "resumed", "each following pass authenticates the prior publication");
        assert.deepEqual(readdirSync(f.stateDir).sort(), ["unlink", "race", "abandoned"].includes(fault) ? ["inventory.json", "inventory.tmp", "key"] : ["inventory.json", "key"]);
        if (fault === "unlink" && n === 0) assert.equal(r.inspection.progress.saveStageCleanupUnverified, true);
        if (fault === "dir-fsync") assert.equal(r.inspection.progress.saveStageAbsent, true);
      }
      if (fault === "race") assert.equal(readFileSync(join(f.stateDir, "inventory.tmp"), "utf8"), "preserve replaced stage");
      if (fault === "abandoned") assert.equal(readFileSync(join(f.stateDir, "inventory.tmp"), "utf8"), "retain unknown crash-left stage\n");
      // Rename precedes directory sync: on its failure a new authenticated
      // inventory can already be published. Do not falsely demand old bytes
      // or roll back over them; verify its next real read succeeds instead.
      if (fault === "dir-fsync") assert.equal(f.run().inspection.progress.state, "resumed");
      assert.ok(existsSync(f.cache));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});
