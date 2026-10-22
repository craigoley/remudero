import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APFS_DEPENDENCY_CLONE_PROGRAM, configuredDependencySeedRoot, defaultDependencySeedRoot, dependencySeedConfigPath, dependencySeedIdentity, DEPENDENCY_SEED_MIN_IDLE_MS, legacyHostNamespace, materializeDependencySeed, sweepDependencySeeds } from "../src/lib/dependency-seeds.js";

function writable(path: string): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return;
  chmodSync(path, s.mode | 0o700);
  if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}
function fixture(body: (root: string, donor: string, checkout: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-test-")));
  const donor = join(root, "donor"), checkout = join(root, "checkout");
  for (const dir of [donor, checkout]) {
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { dep: "1.0.0" } }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { name: "fixture" }, "node_modules/dep": { version: "1.0.0" } } }));
  }
  mkdirSync(join(donor, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  writeFileSync(join(donor, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(donor, "node_modules", ".bin"));
  writeFileSync(join(donor, "node_modules", ".bin", "fixture"), "#!/bin/sh\n");
  try { body(root, donor, checkout); }
  finally { writable(root); rmSync(root, { recursive: true, force: true }); }
}
const identityOptions = { npmVersion: "11.19.0", env: {}, platform: "linux" as const };

function reuseFixture(body: (store: string, seed: string, checkout: string, key: string) => void,
  platform: NodeJS.Platform = "linux"): void {
  fixture((root, donor, first) => {
    const store = join(root, "seeds");
    const initial = materializeDependencySeed(first, { ...identityOptions, platform, proof: true, root: store, sourceDir: donor });
    assert.equal(initial.status, "materialized");
    if (initial.status !== "materialized") throw new Error("source generation not materialized");
    const next = join(root, "next"); mkdirSync(next);
    const pkg = JSON.parse(readFileSync(join(first, "package.json"), "utf8"));
    writeFileSync(join(next, "package.json"), JSON.stringify({ ...pkg, scripts: { build: "node new-build.mjs" } }));
    writeFileSync(join(next, "package-lock.json"), readFileSync(join(first, "package-lock.json")));
    body(store, initial.seed, next, initial.key);
  });
}

test("a command-only package edit reuses a managed generation under its new complete identity without installing", () => reuseFixture((store, seed, checkout, key) => {
  const ready = readFileSync(join(seed, "ready.json"));
  let installs = 0;
  const opts = { ...identityOptions, proof: true, root: store, sourceSeed: seed,
    runInstall: () => { installs++; throw new Error("an explicit source seed never installs"); } };
  const result = materializeDependencySeed(checkout, opts);
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") throw new Error("new generation missing");
  assert.notEqual(result.key, key);
  assert.equal(result.key, dependencySeedIdentity(checkout, opts).key);
  assert.equal(result.reusedFrom, key);
  assert.equal(result.installed, false);
  assert.equal(JSON.parse(readFileSync(join(result.seed, "ready.json"), "utf8")).reusedFrom, key);
  assert.deepEqual(materializeDependencySeed(checkout, opts), { status: "present" });
  writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "consumer changed\n");
  assert.equal(readFileSync(join(seed, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.deepEqual(readFileSync(join(seed, "ready.json")), ready);
  assert.equal(installs, 0);
  assert.equal(existsSync(seed + ".lock"), false);
}));

test("actual APFS command-only generation reuse keeps independent payload inodes", { skip: process.platform !== "darwin" }, () => reuseFixture((store, seed, checkout) => {
  const result = materializeDependencySeed(checkout, { ...identityOptions, platform: "darwin", proof: true,
    root: store, sourceSeed: seed, runInstall: () => { throw new Error("no install"); } });
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") throw new Error("new clone missing");
  assert.equal(result.method, "apfs-clone");
  const source = join(seed, "node_modules", "dep", "index.js"), local = join(checkout, "node_modules", "dep", "index.js");
  assert.notEqual(statSync(source).ino, statSync(local).ino);
  writeFileSync(local, "private clone changed\n");
  assert.equal(readFileSync(source, "utf8"), "module.exports = 1;\n");
}, "darwin"));

test("managed generation reuse refuses changed install inputs and lifecycle roots without fallback", () => {
  const edits = [
    (dir: string) => writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}'),
    (dir: string) => writeFileSync(join(dir, ".npmrc"), "omit=dev\n"),
    (dir: string) => {
      const path = join(dir, "package.json"), pkg = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...pkg, dependencies: { dep: "2.0.0" } }));
    },
    (dir: string) => {
      const path = join(dir, "package.json"), pkg = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...pkg, scripts: { prepublish: "", build: "new" } }));
    },
  ];
  for (const edit of edits) reuseFixture((store, seed, checkout) => {
    edit(checkout);
    let installs = 0;
    assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, proof: true,
      root: store, sourceSeed: seed, runInstall: () => { installs++; } }), /source seed (input|package|refuses)/);
    assert.equal(installs, 0);
    assert.equal(existsSync(join(checkout, "node_modules")), false);
    assert.equal(existsSync(seed + ".lock"), false);
  });
});

test("managed generation reuse preserves runtime npm and proof identity", () => {
  for (const changed of [{ npmVersion: "different" }, { proof: false }, { platform: "darwin" as const },
    { env: { npm_config_omit: "dev" } }]) reuseFixture((store, seed, checkout) => {
    assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, proof: true,
      root: store, sourceSeed: seed, ...changed, runInstall: () => { throw new Error("unexpected install"); } }), /source seed identity mismatch/);
    assert.equal(existsSync(join(checkout, "node_modules")), false);
  });
});

test("managed generation reuse refuses corrupt bounded metadata and releases only its own locks", () => {
  const mutations = [
    (seed: string) => writeFileSync(join(seed, "ready.json"), "x".repeat(1024 ** 2 + 1)),
    (seed: string) => {
      const p = join(seed, "ready.json"), ready = JSON.parse(readFileSync(p, "utf8"));
      writeFileSync(p, JSON.stringify({ ...ready, node: "corrupt-runtime" }));
    },
    (seed: string) => writeFileSync(join(seed, "ready.json"), "not-json"),
    (seed: string) => {
      const p = join(seed, "ready.json"); rmSync(p); symlinkSync(join(seed, "package.json"), p);
    },
    (seed: string) => writeFileSync(join(dirname(seed), ".rmd-dependency-seed-root.json"), '{"version":99}'),
  ];
  for (const mutate of mutations) reuseFixture((store, seed, checkout) => {
    mutate(seed);
    assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, proof: true,
      root: store, sourceSeed: seed, runInstall: () => { throw new Error("no fallback"); } }));
    assert.equal(existsSync(join(checkout, "node_modules")), false);
    assert.equal(existsSync(seed + ".lock"), false);
  });
  reuseFixture((store, seed, checkout) => {
    mkdirSync(seed + ".lock"); writeFileSync(join(seed + ".lock", "owner"), "other builder");
    assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, proof: true,
      root: store, sourceSeed: seed, lockWaitMs: 0 }), /EEXIST/);
    assert.equal(readFileSync(join(seed + ".lock", "owner"), "utf8"), "other builder");
    assert.equal(existsSync(join(checkout, "node_modules")), false);
  });
});

test("managed generation reuse refuses borrowed payloads ambiguous donors and relative source paths", () => {
  for (const kind of ["payload", "scope", "package", "alias", "both", "relative"] as const) reuseFixture((store, seed, checkout) => {
    let source = seed;
    if (["payload", "scope", "package"].includes(kind)) writable(join(seed, "node_modules"));
    if (kind === "payload") {
      const p = join(seed, "node_modules"); rmSync(p, { recursive: true, force: true }); symlinkSync(join(dirname(store), "donor", "node_modules"), p);
    } else if (kind === "scope") symlinkSync(join(dirname(store), "donor"), join(seed, "node_modules", "@borrowed"));
    else if (kind === "package") symlinkSync(join(dirname(store), "donor", "node_modules", "dep"), join(seed, "node_modules", "borrowed"));
    else if (kind === "alias") { source = join(dirname(store), "seed-alias"); symlinkSync(seed, source); }
    else if (kind === "relative") source = "relative-seed";
    assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, proof: true,
      root: store, sourceSeed: source, ...(kind === "both" ? { sourceDir: dirname(checkout) } : {}),
      runInstall: () => { throw new Error("no fallback"); } }));
    assert.equal(existsSync(join(checkout, "node_modules")), false);
    assert.equal(existsSync(seed + ".lock"), false);
  });
});

const cloneDefinitions = APFS_DEPENDENCY_CLONE_PROGRAM.split('\nif __name__ == "__main__":')[0];

test("an unsupported native dependency clone refuses without copying package bytes", () => fixture((root, donor) => {
  const script = cloneDefinitions + String.raw`
class Unsupported:
    def __call__(self, *args):
        ctypes.set_errno(errno.ENOTSUP)
        return -1
class Library:
    fclonefileat = Unsupported()
ctypes.CDLL = lambda *args, **kwargs: Library()
def forbidden_list(*args, **kwargs):
    raise AssertionError("directory enumeration must remain streaming")
os.listdir = forbidden_list
try:
    clone_modules(sys.argv[1], sys.argv[2])
except OSError as error:
    assert error.errno == errno.ENOTSUP
    assert not os.path.exists(os.path.join(sys.argv[2], "dep", "index.js"))
else:
    raise AssertionError("unsupported clone silently copied bytes")
`;
  execFileSync("python3", ["-I", "-B", "-c", script, join(donor, "node_modules"), join(root, "refused")],
    { timeout: 10_000, stdio: "pipe" });
  assert.equal(readFileSync(join(donor, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
}));

test("real dependency provisioning propagates a force-clone helper failure without publishing or falling back", () => fixture((root, donor, checkout) => {
  const tools = join(root, "tools"), marker = join(root, "clone-refusal"); mkdirSync(tools);
  writeFileSync(join(tools, "python3"), `#!/bin/sh\nprintf 'refused' > '${marker}'\necho native-clone-refused >&2\nexit 69\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${tools}:${previous ?? "/usr/bin:/bin"}`;
    assert.throws(() => materializeDependencySeed(checkout, {
      ...identityOptions, platform: "darwin", root: join(root, "seeds"), sourceDir: donor,
    }), /native-clone-refused/);
    assert.equal(readFileSync(marker, "utf8"), "refused");
    assert.equal(existsSync(join(checkout, "node_modules")), false);
    assert.deepEqual(readdirSync(join(root, "seeds")).filter(name => !name.startsWith(".")), []);
    assert.equal(readFileSync(join(donor, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
}));

test("the native dependency clone preserves occupied destinations before opening its native library", () => fixture((root, donor) => {
  const target = join(root, "occupied"); mkdirSync(target);
  writeFileSync(join(target, "keep"), "existing");
  const script = cloneDefinitions + String.raw`
def forbidden(*args, **kwargs):
    raise AssertionError("native primitive opened before destination guard")
ctypes.CDLL = forbidden
try:
    clone_modules(sys.argv[1], sys.argv[2])
except FileExistsError:
    assert open(os.path.join(sys.argv[2], "keep")).read() == "existing"
else:
    raise AssertionError("occupied destination accepted")
`;
  execFileSync("python3", ["-I", "-B", "-c", script, join(donor, "node_modules"), target],
    { timeout: 10_000, stdio: "pipe" });
  assert.equal(readFileSync(join(target, "keep"), "utf8"), "existing");
}));

test("the native dependency clone reproduces symlinks without reading their targets", () => fixture((root) => {
  const source = join(root, "links"); mkdirSync(source);
  symlinkSync(join(root, "absent-private-content"), join(source, "external"));
  const script = cloneDefinitions + String.raw`
class Forbidden:
    def __call__(self, *args):
        raise AssertionError("symlink target was opened as package bytes")
class Library:
    fclonefileat = Forbidden()
ctypes.CDLL = lambda *args, **kwargs: Library()
result = clone_modules(sys.argv[1], sys.argv[2])
assert result["symlinks"] == 1 and result["files"] == 0
assert os.readlink(os.path.join(sys.argv[1], "external")) == os.readlink(os.path.join(sys.argv[2], "external"))
assert not os.path.exists(os.readlink(os.path.join(sys.argv[2], "external")))
`;
  const target = join(root, "cloned-links");
  execFileSync("python3", ["-I", "-B", "-c", script, source, target], { timeout: 10_000, stdio: "pipe" });
  assert.ok(lstatSync(join(target, "external")).isSymbolicLink());
}));

test("dependency seed identity separates workspace manifests, toolchains and proof policy", () => fixture((root, donor, checkout) => {
  const first = dependencySeedIdentity(checkout, identityOptions).key;
  assert.equal(first, dependencySeedIdentity(donor, identityOptions).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, proof: true }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, npmVersion: "12" }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, platform: "darwin" }).key);
  assert.notEqual(first, dependencySeedIdentity(checkout, { ...identityOptions, env: { npm_config_omit: "dev" } }).key);
  mkdirSync(join(checkout, "packages", "local"), { recursive: true });
  writeFileSync(join(checkout, "packages", "local", "package.json"), '{"name":"local"}');
  writeFileSync(join(checkout, "package-lock.json"), '{"packages":{"packages/local":{}}}');
  const workspace = dependencySeedIdentity(checkout, identityOptions).key;
  writeFileSync(join(checkout, "packages", "local", "package.json"), '{"name":"local","dependencies":{"dep":"2"}}');
  assert.notEqual(workspace, dependencySeedIdentity(checkout, identityOptions).key);
  writeFileSync(join(checkout, ".npmrc"), "legacy-peer-deps=true\n");
  assert.ok(dependencySeedIdentity(checkout, identityOptions).files[".npmrc"]);
  writeFileSync(join(checkout, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /credential/);
}));

test("dependency seed rejects missing, unreadable and escaping install inputs", () => fixture((root, donor, checkout) => {
  rmSync(join(checkout, "package-lock.json"));
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /ENOENT/);
  symlinkSync(join(donor, "package-lock.json"), join(checkout, "package-lock.json"));
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /escapes/);
  rmSync(join(checkout, "package-lock.json"));
  writeFileSync(join(checkout, "package-lock.json"), '{"packages":{"../escape":{}}}');
  assert.throws(() => dependencySeedIdentity(checkout, identityOptions), /escaping/);
}));

test("dependency seed preserves occupied installs while refusing incomplete and dangling node_modules", () => fixture((root, donor, checkout) => {
  mkdirSync(join(checkout, "node_modules"));
  assert.throws(() => materializeDependencySeed(checkout), /missing dep/);
  assert.ok(lstatSync(join(checkout, "node_modules")).isDirectory());
  rmSync(join(checkout, "node_modules"), { recursive: true });
  symlinkSync(join(root, "missing"), join(checkout, "node_modules"));
  assert.throws(() => materializeDependencySeed(checkout), /ENOENT/);
  assert.ok(lstatSync(join(checkout, "node_modules")).isSymbolicLink());
}));

test("occupied seed validates its generation before reuse and never installs over a stale consumer", () => fixture((root, donor, checkout) => {
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, proof: true };
  const first = materializeDependencySeed(checkout, opts);
  assert.equal(first.status, "materialized");
  if (first.status !== "materialized") throw new Error("fixture seed absent");
  const file = join(checkout, "node_modules", "dep", "index.js");
  const inode = statSync(file).ino;
  const refuseInstall = () => { throw new Error("must not install over occupied dependencies"); };
  assert.deepEqual(materializeDependencySeed(checkout, { ...opts, runInstall: refuseInstall }), { status: "present" });
  assert.throws(() => materializeDependencySeed(checkout, { ...opts, npmVersion: "changed", runInstall: refuseInstall }), /identity mismatch/);
  assert.equal(statSync(file).ino, inode);
  assert.equal(readFileSync(file, "utf8"), "module.exports = 1;\n");
  writeFileSync(join(first.seed, "ready.json"), JSON.stringify({ version: 1, key: "wrong" }));
  assert.throws(() => materializeDependencySeed(checkout, opts), /not ready/);
}));

test("dependency seed Linux materialization keeps package storage shared and caches private", () => fixture((root, donor, checkout) => {
  mkdirSync(join(donor, "node_modules", ".cache"));
  writeFileSync(join(donor, "node_modules", ".cache", "live"), "private");
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor };
  const result = materializeDependencySeed(checkout, opts);
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "readonly-links");
  assert.equal(result.installed, false);
  assert.ok(lstatSync(join(checkout, "node_modules")).isDirectory());
  assert.ok(lstatSync(join(checkout, "node_modules", "dep")).isSymbolicLink());
  assert.equal(statSync(join(result.seed, "node_modules", "dep", "index.js")).mode & 0o222, 0);
  assert.ok(!existsSync(join(checkout, "node_modules", ".cache")));
  mkdirSync(join(checkout, "node_modules", ".cache"));
  writeFileSync(join(checkout, "node_modules", ".cache", "local"), "mine");
  assert.ok(!existsSync(join(result.seed, "node_modules", ".cache")));
  const second = join(root, "second"); mkdirSync(second);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(second, name), readFileSync(join(checkout, name)));
  const reused = materializeDependencySeed(second, { ...opts, runInstall: () => { throw new Error("must reuse"); } });
  assert.equal(reused.status, "materialized");
  if (reused.status === "materialized") assert.equal(reused.seed, result.seed);
}));

test("dependency seed proof copies cannot mutate another checkout or its seed", () => fixture((root, donor, checkout) => {
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, proof: true });
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "private-copy");
  writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "changed");
  assert.equal(readFileSync(join(result.seed, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(readFileSync(join(donor, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.ok(existsSync(join(result.seed, "node_modules", "dep", "index.js")));
}));

test("dependency seed APFS clones have independent inodes and survive checkout reinstall", { skip: process.platform !== "darwin" }, () => fixture((root, donor, checkout) => {
  const result = materializeDependencySeed(checkout, { ...identityOptions, platform: "darwin", root: join(root, "seeds"), sourceDir: donor });
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(result.method, "apfs-clone");
  const seedFile = join(result.seed, "node_modules", "dep", "index.js");
  const localFile = join(checkout, "node_modules", "dep", "index.js");
  assert.notEqual(statSync(seedFile).ino, statSync(localFile).ino);
  writeFileSync(localFile, "changed");
  assert.equal(readFileSync(seedFile, "utf8"), "module.exports = 1;\n");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.ok(existsSync(seedFile));
}));

test("dependency seed workspace links resolve the consuming checkout rather than the donor", () => fixture((root, donor, checkout) => {
  for (const dir of [donor, checkout]) {
    mkdirSync(join(dir, "packages", "local"), { recursive: true });
    writeFileSync(join(dir, "packages", "local", "package.json"), '{"name":"@fixture/local"}');
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "packages/local": {}, "node_modules/dep": {}, "node_modules/@fixture/local": { link: true, resolved: "packages/local" } } }));
  }
  mkdirSync(join(donor, "node_modules", "@fixture"));
  symlinkSync("../../packages/local", join(donor, "node_modules", "@fixture", "local"));
  mkdirSync(join(donor, "packages", "local", "node_modules", "nested"), { recursive: true });
  writeFileSync(join(donor, "packages", "local", "node_modules", "nested", "package.json"), '{"name":"nested"}');
  materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), sourceDir: donor, now: 0 });
  assert.equal(realpathSync(join(checkout, "node_modules", "@fixture", "local")), join(checkout, "packages", "local"));
  assert.ok(existsSync(join(checkout, "packages", "local", "node_modules", "nested", "package.json")));
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.equal(sweepDependencySeeds(join(root, "seeds"), { now: DEPENDENCY_SEED_MIN_IDLE_MS + 1, apply: true, isOpen: () => false })[0].reason, "referenced by checkout");
  assert.ok(existsSync(join(checkout, "packages", "local", "node_modules", "nested", "package.json")));
}));

test("dependency seed fails closed on mismatched or incomplete donors and install failures", () => fixture((root, donor, checkout) => {
  const opts = { ...identityOptions, root: join(root, "seeds"), sourceDir: donor };
  writeFileSync(join(donor, "package.json"), '{"name":"other"}');
  assert.throws(() => materializeDependencySeed(checkout, opts), /do not match/);
  assert.ok(!existsSync(join(checkout, "node_modules")));
  writeFileSync(join(donor, "package.json"), readFileSync(join(checkout, "package.json")));
  writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"2.0.0"}');
  assert.throws(() => materializeDependencySeed(checkout, opts), /version mismatch/);
  rmSync(join(donor, "node_modules", "dep"), { recursive: true });
  assert.throws(() => materializeDependencySeed(checkout, opts), /missing dep/);
  assert.throws(() => materializeDependencySeed(checkout, { ...opts, sourceDir: undefined, runInstall: () => { throw new Error("install failed"); } }), /install failed/);
  assert.equal(readdirSync(opts.root).filter(name => name.endsWith(".lock") || name.startsWith(".stage")).length, 0);
}));

test("dependency seed npm installs disable lifecycle scripts and publish only a verified generation", () => fixture((root, donor, checkout) => {
  let installs = 0;
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "seeds"), proof: true, runInstall: (stage, args, env) => {
    installs++;
    assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    assert.equal(env.npm_config_cache, join(root, "seeds", ".npm-cache"));
    mkdirSync(join(stage, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(stage, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
  } });
  assert.equal(installs, 1);
  if (result.status === "materialized") assert.equal(result.installed, true);
}));

test("dependency seed GC keeps referenced, recent, locked, open and unverified generations", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); const now = Date.now();
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: now - DEPENDENCY_SEED_MIN_IDLE_MS - 1 });
  if (result.status !== "materialized") throw new Error("missing seed");
  assert.equal(sweepDependencySeeds(store, { now, apply: true, isOpen: () => false })[0].reason, "referenced by checkout");
  rmSync(join(checkout, "node_modules"), { recursive: true });
  assert.equal(sweepDependencySeeds(store, { now })[0].reason, "open-file scan unavailable");
  assert.equal(sweepDependencySeeds(store, { now, isOpen: () => true })[0].reason, "open file or process");
  assert.match(sweepDependencySeeds(store, { now, isOpen: () => { throw new Error("blind"); } })[0].reason, /unverified/);
  mkdirSync(`${result.seed}.lock`);
  assert.match(sweepDependencySeeds(store, { now })[0].reason, /lock/);
  rmSync(`${result.seed}.lock`, { recursive: true });
  assert.equal(sweepDependencySeeds(store, { now: now - 2, isOpen: () => false })[0].reason, "used within six hours");
  assert.equal(sweepDependencySeeds(store, { now, isOpen: () => false })[0].action, "remove");
  assert.ok(existsSync(result.seed));
  assert.equal(sweepDependencySeeds(store, { now, apply: true, isOpen: () => false })[0].action, "remove");
  assert.ok(!existsSync(result.seed));
}));

test("dependency seed store cannot be a symlink and busy locks are never stolen", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); mkdirSync(store); symlinkSync(store, join(root, "alias"));
  assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, root: join(root, "alias"), sourceDir: donor }), /account-owned/);
  const key = dependencySeedIdentity(checkout, identityOptions).key; mkdirSync(join(store, `${key}.lock`));
  assert.throws(() => materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, lockWaitMs: 0 }), /EEXIST/);
  assert.ok(existsSync(join(store, `${key}.lock`)));
}));

test("dependency seed defaults are separate per account and platform", () => {
  assert.equal(dependencySeedConfigPath("/account"), "/account/.config/remudero/dependency-seeds.json");
  assert.equal(defaultDependencySeedRoot("/account", "darwin"), "/account/Library/Application Support/Remudero/dependencies");
  assert.equal(defaultDependencySeedRoot("/account", "linux"), "/account/.local/share/remudero/dependencies");
  const previous = process.env.RMD_DEPENDENCY_SEED_ROOT;
  try {
    process.env.RMD_DEPENDENCY_SEED_ROOT = "/seed-root"; assert.equal(configuredDependencySeedRoot(), "/seed-root");
    process.env.RMD_DEPENDENCY_SEED_ROOT = "relative"; assert.throws(configuredDependencySeedRoot, /absolute/);
  } finally { if (previous === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT; else process.env.RMD_DEPENDENCY_SEED_ROOT = previous; }
});

test("generic janitors protect seed stores and ancestors regardless of age", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds"); mkdirSync(store); writeFileSync(join(store, ".rmd-dependency-seed-root.json"), '{}');
  const guard = join(process.cwd(), "deploy", "dependency-seed-guard.sh");
  for (const path of [root, store, join(store, "generation")]) {
    const output = execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk "$2"', "guard", guard, path], { encoding: "utf8" });
    assert.match(output, /dependency seed store/);
  }
  assert.throws(() => execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk "$2"', "guard", guard, checkout]), /Command failed/);
  assert.match(execFileSync("bash", ["-c", 'source "$1"; rmd_dependency_seed_risk ./seeds', "guard", guard], { cwd: root, encoding: "utf8", timeout: 3000 }), /dependency seed store/);
}));

test("dependency seed account configuration is optional and invalid configuration is refused", () => fixture((root) => {
  assert.equal(configuredDependencySeedRoot(root, {}), undefined);
  const file = dependencySeedConfigPath(root); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"enabled":false}'); assert.equal(configuredDependencySeedRoot(root, {}), undefined);
  writeFileSync(file, '{"enabled":true,"root":"/durable/seeds"}'); assert.equal(configuredDependencySeedRoot(root, {}), "/durable/seeds");
  assert.equal(configuredDependencySeedRoot(root, { RMD_DEPENDENCY_SEED_ROOT: "" }), undefined);
  writeFileSync(file, '{"enabled":true,"root":"relative"}'); assert.throws(() => configuredDependencySeedRoot(root, {}), /absolute/);
  writeFileSync(file, 'broken json'); assert.throws(() => configuredDependencySeedRoot(root, {}), /JSON/);
}));

test("dependency seed real npm default primes an empty project without lifecycle execution", () => fixture((root, donor, checkout) => {
  symlinkSync(join(root, "missing-npm-cache"), join(root, ".npm"));
  writeFileSync(join(checkout, "package.json"), '{"name":"empty","version":"1.0.0","scripts":{"prepare":"exit 99"}}');
  writeFileSync(join(checkout, "package-lock.json"), '{"name":"empty","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"empty","version":"1.0.0"}}}');
  const result = materializeDependencySeed(checkout, { root: join(root, "seeds"), proof: true,
    env: { PATH: process.env.PATH, HOME: root, npm_config_offline: "true" } });
  assert.equal(result.status, "materialized");
  if (result.status === "materialized") assert.equal(result.installed, true);
}));

test("dependency seed GC refuses malformed readiness and malformed consumer evidence", () => fixture((root, donor, checkout) => {
  const store = join(root, "seeds");
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: 0 });
  if (result.status !== "materialized") throw new Error("missing seed");
  const ready = join(result.seed, "ready.json"), original = readFileSync(ready);
  writeFileSync(ready, '{}'); assert.match(sweepDependencySeeds(store, { now: Date.now() })[0].reason, /unverified/);
  const third = join(root, "third"); mkdirSync(third);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(third, name), readFileSync(join(checkout, name)));
  assert.throws(() => materializeDependencySeed(third, { ...identityOptions, root: store, sourceDir: donor }), /metadata mismatch/);
  writeFileSync(ready, original);
  const consumer = join(result.seed, "consumers", readdirSync(join(result.seed, "consumers"))[0]);
  writeFileSync(consumer, JSON.stringify({ checkout, mountNamespace: "another container" }));
  assert.equal(sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false })[0].reason, "foreign or unverified consumer mount namespace");
  writeFileSync(join(result.seed, "consumers", "invalid.json"), '{"checkout":"relative"}');
  assert.match(sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false })[0].reason, /unverified/);
}));

test("dependency seed concurrent builders install once and never expose a partial generation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-concurrent-")));
  try {
    const first = join(root, "first"), second = join(root, "second"), calls = join(root, "calls");
    for (const dir of [first, second]) {
      mkdirSync(dir); writeFileSync(join(dir, "package.json"), '{"name":"empty"}'); writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    }
    const module = pathToFileURL(join(process.cwd(), "src/lib/dependency-seeds.ts")).href;
    const code = `import {materializeDependencySeed} from ${JSON.stringify(module)}; import fs from 'node:fs';
      const r=materializeDependencySeed(process.argv[1], {root:process.argv[2],npmVersion:'11.19.0',env:{},runInstall:(stage)=>{
        fs.appendFileSync(process.argv[3],'install\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
        fs.mkdirSync(stage+'/node_modules'); }}); console.log(JSON.stringify(r));`;
    const run = promisify(execFile);
    const results = await Promise.all([first, second].map(dir => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dir, join(root, "seeds"), calls], { timeout: 10_000 })));
    const a = JSON.parse(results[0].stdout), b = JSON.parse(results[1].stdout);
    assert.equal(a.seed, b.seed); assert.equal(readFileSync(calls, "utf8"), "install\n");
    assert.equal([a.installed, b.installed].filter(Boolean).length, 1);
  } finally { writable(root); rmSync(root, { recursive: true, force: true }); }
});

test("dependency seed installer publishes complete immutable tools and preserves existing configuration", () => fixture((root) => {
  const home = join(root, "home"); mkdirSync(home);
  const installer = join(process.cwd(), "deploy", "install-dependency-seeds.sh");
  const env = { ...process.env, HOME: home, RMD_SEED_NODE: process.execPath, RMD_DEPENDENCY_SEED_ROOT: join(home, "store") };
  execFileSync("bash", [installer], { env });
  const wrapper = join(home, ".local", "bin", "remudero-dependencies");
  const saved = readFileSync(wrapper), config = readFileSync(dependencySeedConfigPath(home));
  const versions = join(home, ".local", "share", "remudero", "dependency-seed-tools");
  const version = readdirSync(versions).find(name => /^[a-f0-9]{64}$/.test(name))!;
  assert.ok(existsSync(join(versions, version, "src", "lib", "clock.ts")));
  assert.throws(() => execFileSync(process.execPath, [join(versions, version, "scripts", "dependency-seeds.mjs"), "enable"], { env, stdio: "pipe" }), /existing seed configuration/);
  assert.deepEqual(readFileSync(dependencySeedConfigPath(home)), config);
  const fresh = join(home, "fresh"); mkdirSync(fresh);
  writeFileSync(join(fresh, "package.json"), '{"name":"empty","version":"1.0.0"}');
  writeFileSync(join(fresh, "package-lock.json"), '{"name":"empty","version":"1.0.0","lockfileVersion":3,"packages":{}}');
  const cold = JSON.parse(execFileSync(wrapper, ["prime", fresh], { env: { ...env, PATH: "/usr/bin:/bin", npm_config_offline: "true" }, encoding: "utf8" }));
  assert.equal(cold.status, "materialized", "SSH/cron's minimal PATH still resolves the pinned npm toolchain");
  execFileSync("bash", [installer], { env });
  assert.deepEqual(readFileSync(wrapper), saved);
  assert.deepEqual(readFileSync(dependencySeedConfigPath(home)), config);
  rmSync(join(versions, version, "scripts", "dependency-seeds.mjs"));
  assert.throws(() => execFileSync("bash", [installer], { env, stdio: "pipe" }), /Command failed/);
  assert.deepEqual(readFileSync(wrapper), saved);
}));

test("a pre-namespace consumer record on a macOS host path is read from the host; other legacy records stay retained", () => fixture((root, donor, checkout) => {
  assert.equal(legacyHostNamespace("/Users/someone/Remudero/run", "darwin"), "host");
  assert.equal(legacyHostNamespace("/private/var/folders/x/T/run", "darwin"), "host");
  assert.equal(legacyHostNamespace("/workspace/run", "darwin"), undefined, "a container-only path stays unverified");
  assert.equal(legacyHostNamespace("/Users/someone/run", "linux"), undefined, "Linux has real mount namespaces");
  const store = join(root, "seeds");
  const result = materializeDependencySeed(checkout, { ...identityOptions, root: store, sourceDir: donor, now: 0 });
  if (result.status !== "materialized") throw new Error("missing seed");
  const consumer = join(result.seed, "consumers", readdirSync(join(result.seed, "consumers"))[0]);
  writeFileSync(consumer, JSON.stringify({ checkout }));
  writable(join(checkout, "node_modules")); rmSync(join(checkout, "node_modules"), { recursive: true });
  const [row] = sweepDependencySeeds(store, { now: Date.now(), isOpen: () => false });
  assert.equal(row.reason, process.platform === "darwin" ? "unreferenced and idle for six hours" : "foreign or unverified consumer mount namespace");
}));
