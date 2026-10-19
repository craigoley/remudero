/** Account-owned dependency generations. Checkout workspaces and caches stay private. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { systemClock } from "./clock.js";

export const DEPENDENCY_SEED_MIN_IDLE_MS = 6 * 60 * 60 * 1000;
const ROOT_MARKER = ".rmd-dependency-seed-root.json";
const CONSUMER_MARKER = ".rmd-dependency-seed.json";
const VERSION = 1;
type Manifest = { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
type SeedMetadata = { version: number; key: string; lastUsed: number; files: Record<string, string>; policy: string; platform: string; arch: string; node: string; npm: string };
export type SeedMethod = "apfs-clone" | "readonly-links" | "private-copy";
export interface DependencySeedOptions {
  root?: string;
  sourceDir?: string;
  proof?: boolean;
  platform?: NodeJS.Platform;
  npmVersion?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  runInstall?: (stage: string, args: string[], env: NodeJS.ProcessEnv) => void;
  lockWaitMs?: number;
}
export type DependencySeedResult = { status: "present" } | { status: "materialized"; key: string; seed: string; method: SeedMethod; installed: boolean };

export function dependencySeedConfigPath(home = homedir()): string {
  return join(home, ".config", "remudero", "dependency-seeds.json");
}

/** Configuration is opt-in, so rollout never rewires an existing service or checkout. */
export function configuredDependencySeedRoot(home = homedir(), env = process.env): string | undefined {
  const override = env.RMD_DEPENDENCY_SEED_ROOT;
  if (override === "") return undefined; // Explicitly disable account preferences for isolated test fixtures.
  if (override) {
    if (!isAbsolute(override)) throw new Error("RMD_DEPENDENCY_SEED_ROOT must be absolute");
    return override;
  }
  const file = dependencySeedConfigPath(home);
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as { enabled?: boolean; root?: string };
  if (!config.enabled) return undefined;
  if (!config.root || !isAbsolute(config.root)) throw new Error("dependency seed config requires an absolute root");
  return config.root;
}

export function defaultDependencySeedRoot(home = homedir(), platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? join(home, "Library", "Application Support", "Remudero", "dependencies") : join(home, ".local", "share", "remudero", "dependencies");
}

function readInputs(checkout: string): Record<string, string> {
  const files: Record<string, string> = {};
  const read = (name: string) => {
    const file = realpathSync(join(checkout, name));
    if (!file.startsWith(`${realpathSync(checkout)}${sep}`)) throw new Error("dependency input escapes its checkout");
    return readFileSync(file, "utf8");
  };
  for (const name of ["package.json", "package-lock.json"]) files[name] = read(name);
  JSON.parse(files["package.json"]);
  const lock = JSON.parse(files["package-lock.json"]) as { packages?: Record<string, { link?: boolean; resolved?: string }> };
  // Local packages are part of identity, including workspace dependencies that changed without a root lock change.
  for (const name of Object.keys(lock.packages ?? {}).sort()) {
    if (!name || name.split("/").includes("node_modules")) continue;
    if (isAbsolute(name) || name.split("/").includes("..")) throw new Error("dependency seed refuses an escaping local package");
    files[join(name, "package.json")] = read(join(name, "package.json"));
  }
  if (existsSync(join(checkout, ".npmrc"))) {
    const config = read(".npmrc");
    // Credentials never enter durable generation metadata, or an install performed for another checkout.
    if (/auth|token|password|username/i.test(config)) throw new Error("dependency seed refuses credential-bearing project npmrc");
    files[".npmrc"] = config;
  }
  return files;
}

export function dependencySeedIdentity(checkout: string, opts: DependencySeedOptions = {}): SeedMetadata {
  const files = readInputs(checkout);
  const env = opts.env ?? process.env;
  // Environment options which change npm's dependency graph or lifecycle behavior cannot borrow another generation.
  const npmConfig = Object.fromEntries(Object.entries(env).filter(([key]) => /^npm_config_(omit|include|legacy_peer_deps|install_links|install_strategy|ignore_scripts|optional|production|arch|platform|libc)$/i.test(key)).sort());
  const npm = opts.npmVersion ?? execFileSync("npm", ["--version"], { encoding: "utf8", env, timeout: 10_000 }).trim();
  const identity = { version: VERSION, files, policy: opts.proof ? "proof-ignore-scripts" : "development-ignore-scripts", platform: opts.platform ?? process.platform, arch: process.arch, node: process.version, abi: process.versions.modules, npm, npmConfig, nodeEnv: env.NODE_ENV ?? "" };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { ...identity, key, lastUsed: opts.now ?? systemClock.now() };
}

function ownedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && process.getuid() !== 0 && stat.uid !== process.getuid())) throw new Error(`dependency seed directory is not account-owned: ${path}`);
}

function makeStore(root: string): void {
  if (!isAbsolute(root)) throw new Error("dependency seed root must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  ownedDirectory(root);
  if (realpathSync(root) !== resolve(root)) throw new Error("dependency seed root must not traverse symlinks");
  const marker = join(root, ROOT_MARKER);
  try { writeFileSync(marker, JSON.stringify({ version: VERSION }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const stage = `${file}.${randomUUID()}`;
  writeFileSync(stage, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(stage, file);
}

function registerConsumer(seed: string, checkout: string, modules: string, key: string, method: SeedMethod, installed: boolean): void {
  writeJsonAtomic(join(modules, CONSUMER_MARKER), { version: VERSION, key, seed, checkout, method });
  const consumer = createHash("sha256").update(checkout).digest("hex");
  const mountNamespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/mnt") : "host";
  writeJsonAtomic(join(seed, "consumers", `${consumer}.json`), {
    checkout, mountNamespace, provisioning: { version: 1, method, installed },
  });
}

export interface DependencySeedReuseReport {
  version: 1;
  assurance: "registered-provisioning-metadata-only";
  state: "complete" | "partial" | "unknown";
  observedGenerations: number;
  readableRegistrations: number;
  knownProvisioningRegistrations: number;
  freshInstallGenerations: number;
  reusedRegistrations: number;
  unknownRegistrations: number;
  reuseShare: number | null;
  methods: Record<SeedMethod, number>;
  reasons: string[];
  cleanupAuthorized: false;
}

/** Bounded read-only registry observation, never a payload attestation or GC permit.
 * Existing worker/reviewer/hand callers already reach registerConsumer through priming.
 * Retain unknown legacy/namespace rows instead of calling missing observations zero use. */
export function observeDependencySeedReuse(root: string, maxRecords = 5000): DependencySeedReuseReport {
  const report: DependencySeedReuseReport = {
    version: 1, assurance: "registered-provisioning-metadata-only", state: "complete",
    observedGenerations: 0, readableRegistrations: 0, knownProvisioningRegistrations: 0,
    freshInstallGenerations: 0, reusedRegistrations: 0, unknownRegistrations: 0, reuseShare: null,
    methods: { "apfs-clone": 0, "readonly-links": 0, "private-copy": 0 }, reasons: [], cleanupAuthorized: false,
  };
  const note = (reason: string): void => { if (!report.reasons.includes(reason) && report.reasons.length < 8) report.reasons.push(reason); };
  const entries = (path: string, limit: number, reason: string): string[] => {
    const dir = opendirSync(path), names: string[] = [];
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (names.length === limit) throw new Error(reason);
        names.push(entry.name);
      }
    } finally { dir.closeSync(); }
    return names;
  };
  const read = (path: string): Record<string, unknown> => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o077) || before.size > 16384) throw new Error("unverified registry metadata");
      const bytes = Buffer.alloc(before.size + 1);
      let used = 0;
      while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, used); if (!n) break; used += n; }
      if (used !== before.size) throw new Error("registry changed while reading");
      const value = JSON.parse(bytes.subarray(0, used).toString("utf8")) as Record<string, unknown>;
      const after = fstatSync(fd), named = lstatSync(path);
      if ([after, named].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs)) throw new Error("registry changed while reading");
      return value;
    } finally { closeSync(fd); }
  };
  try {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000) throw new Error("invalid bounded observation size");
    ownedDirectory(root);
    if (realpathSync(root) !== resolve(root) || read(join(root, ROOT_MARKER)).version !== VERSION) throw new Error("unverified dependency store");
    const namespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/mnt") : "host";
    const allNames = entries(root, 10000, "store directory inspection bound");
    const generations = allNames.filter(name => /^[a-f0-9]{64}$/.test(name)).sort();
    if (generations.length > 256) throw new Error("generation inspection bound");
    let inspected = 0;
    for (const key of generations) {
      const seed = join(root, key), consumers = join(seed, "consumers");
      try {
        ownedDirectory(seed); ownedDirectory(consumers);
        const names = entries(consumers, maxRecords - inspected, "registration inspection bound");
        report.observedGenerations++;
        let sawFreshInstall = false;
        for (const name of names.sort()) {
          inspected++;
          try {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("unrecognized registry row");
            const row = read(join(consumers, name));
            if (typeof row.checkout !== "string" || !isAbsolute(row.checkout) || createHash("sha256").update(row.checkout).digest("hex") + ".json" !== name || row.mountNamespace !== namespace) throw new Error("unknown consumer path or mount namespace");
            report.readableRegistrations++;
            const p = row.provisioning as { version?: number; method?: SeedMethod; installed?: boolean } | undefined;
            if (p?.version !== 1 || !["apfs-clone", "private-copy", "readonly-links"].includes(p.method ?? "") || typeof p.installed !== "boolean") throw new Error("legacy or incomplete provisioning observation");
            report.knownProvisioningRegistrations++;
            report.methods[p.method!]++;
            if (p.installed) sawFreshInstall = true; else report.reusedRegistrations++;
          } catch (e) { report.unknownRegistrations++; report.state = "partial"; note((e as Error).message); }
        }
        if (sawFreshInstall) report.freshInstallGenerations++;
      } catch (e) {
        report.state = "partial"; note((e as Error).message);
        if ((e as Error).message === "registration inspection bound") break;
      }
    }
    if (report.state === "complete" && report.knownProvisioningRegistrations > 0) report.reuseShare = report.reusedRegistrations / report.knownProvisioningRegistrations;
  } catch (e) { report.state = "unknown"; note((e as Error).message); }
  return report;
}

function workspaceLinks(checkout: string, modules: string, workspace = ""): void {
  const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8")) as { packages?: Record<string, { link?: boolean; resolved?: string }> };
  for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
    const prefix = workspace ? `${workspace}/node_modules/` : "node_modules/";
    if (!pkg.link || !pkg.resolved || !name.startsWith(prefix)) continue;
    const local = resolve(checkout, pkg.resolved);
    if (!local.startsWith(`${resolve(checkout)}${sep}`)) throw new Error("workspace dependency escapes its checkout");
    const suffix = name.slice(prefix.length);
    if (suffix.split("/").includes("..")) throw new Error("workspace link escapes node_modules");
    const dest = join(modules, suffix);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(relative(dirname(dest), local), dest, "dir");
  }
}

function copyModules(source: string, dest: string, clone: boolean): void {
  if (clone) {
    if (statSync(source).dev !== statSync(dirname(dest)).dev) throw new Error("APFS clones require the same filesystem");
    // Node/libuv's COPYFILE_FICLONE_FORCE returns ENOSYS on Darwin. Apple's cp uses clonefile(2).
    execFileSync("/bin/cp", ["-cRP", source, dest], { stdio: "pipe", timeout: 120_000 });
    for (const name of [".cache", CONSUMER_MARKER]) rmSync(join(dest, name), { recursive: true, force: true });
  } else cpSync(source, dest, { recursive: true, verbatimSymlinks: true,
    filter: (path) => ![".cache", CONSUMER_MARKER].includes(path.split(sep).pop()!) });
}

function setWritable(path: string, writable: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
  if (stat.isDirectory()) for (const name of readdirSync(path)) setWritable(join(path, name), writable);
}

function verifyPackages(checkout: string, modules: string): void {
  const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as Manifest;
  const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8")) as { packages?: Record<string, { link?: boolean; version?: string }> };
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (lock.packages?.[`node_modules/${name}`]?.link) continue;
    if (!existsSync(join(modules, name, "package.json"))) throw new Error(`dependency seed is missing ${name}`);
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    const actual = JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")) as { version?: string };
    if (expected && expected !== actual.version) throw new Error(`dependency seed version mismatch for ${name}`);
  }
}

/** An occupied destination is never replaced. Validate it before calling it available: a dangling
 * borrower or stale generation must not silently become an install/retry storm. Legacy installs
 * have no generation identity; package checks do not claim their unrecorded toolchain is proven. */
function verifyExistingDependencies(checkout: string, modules: string, opts: DependencySeedOptions): void {
  if (!statSync(modules).isDirectory()) throw new Error("dependency destination is not a directory");
  verifyPackages(checkout, modules);
  const marker = join(modules, CONSUMER_MARKER);
  let reference: { version?: unknown; key?: unknown; checkout?: unknown; seed?: unknown };
  try { reference = JSON.parse(readFileSync(marker, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const expected = dependencySeedIdentity(checkout, opts);
  if (reference.version !== VERSION || reference.key !== expected.key || reference.checkout !== checkout ||
      typeof reference.seed !== "string" || !isAbsolute(reference.seed)) {
    throw new Error("occupied dependency generation identity mismatch");
  }
  const ready = JSON.parse(readFileSync(join(reference.seed, "ready.json"), "utf8")) as SeedMetadata;
  if (ready.version !== VERSION || ready.key !== expected.key) throw new Error("occupied dependency generation is not ready");
}

function linkPackages(seedModules: string, dest: string): void {
  mkdirSync(dest);
  for (const name of readdirSync(seedModules)) {
    if (name === ".cache" || name === CONSUMER_MARKER) continue;
    const source = join(seedModules, name);
    if (name === ".bin" || name === ".package-lock.json" || name === ".rmd-install-hash") {
      cpSync(source, join(dest, name), { recursive: true, verbatimSymlinks: true });
    } else if (name.startsWith("@")) {
      mkdirSync(join(dest, name));
      for (const pkg of readdirSync(source)) symlinkSync(join(source, pkg), join(dest, name, pkg), "dir");
    } else symlinkSync(source, join(dest, name), "dir");
  }
}

/** Existing installs, including dangling links, are never replaced. Publication fails if a concurrent installer wins. */
export function materializeDependencySeed(checkout: string, opts: DependencySeedOptions = {}): DependencySeedResult {
  checkout = realpathSync(checkout);
  const dest = join(checkout, "node_modules");
  let occupied = false;
  try { lstatSync(dest); occupied = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Keep the validation outside the ENOENT catch: an occupied dangling link must never fall
  // through to provisioning, which could otherwise publish through another owner's path.
  if (occupied) { verifyExistingDependencies(checkout, dest, opts); return { status: "present" }; }
  const root = opts.root ?? configuredDependencySeedRoot() ?? defaultDependencySeedRoot();
  makeStore(root);
  const meta = dependencySeedIdentity(checkout, opts);
  const seed = join(root, meta.key);
  const lock = join(root, `${meta.key}.lock`);
  let installed = false;
  // Serialize builders and GC. Never reclaim another installer's lock by timestamp.
  const started = systemClock.now();
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || systemClock.now() - started >= (opts.lockWaitMs ?? 120_000)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  const stage = join(root, `.stage-${randomUUID()}`);
  const targetStage = join(checkout, `.rmd-dependency-stage-${randomUUID()}`);
  try {
    if (!existsSync(join(seed, "ready.json"))) {
      mkdirSync(stage, { mode: 0o700 });
      for (const [name, content] of Object.entries(meta.files)) {
        mkdirSync(dirname(join(stage, name)), { recursive: true });
        writeFileSync(join(stage, name), content, { mode: 0o600 });
      }
      let donor: string | undefined;
      if (opts.sourceDir) {
        const source = realpathSync(opts.sourceDir);
        const sourceMeta = dependencySeedIdentity(source, opts);
        if (sourceMeta.key !== meta.key) throw new Error("dependency seed donor inputs do not match checkout");
        const pkg = JSON.parse(meta.files["package.json"]) as Manifest;
        if (["preinstall", "install", "postinstall", "prepare"].some(name => pkg.scripts?.[name])) throw new Error("dependency seed donor has root lifecycle scripts");
        donor = join(source, "node_modules");
        if (!lstatSync(donor).isDirectory()) throw new Error("dependency seed donor must be a real install");
        verifyPackages(source, donor);
        const lockPackages = (JSON.parse(meta.files["package-lock.json"]) as { packages?: Record<string, { link?: boolean }> }).packages ?? {};
        for (const name of readdirSync(donor).filter(name => !name.startsWith("."))) {
          const entries = name.startsWith("@") ? readdirSync(join(donor, name)).map(pkg => `${name}/${pkg}`) : [name];
          for (const entry of entries) if (lstatSync(join(donor, entry)).isSymbolicLink() && lockPackages[`node_modules/${entry}`]?.link !== true) {
            throw new Error("dependency seed donor contains an external package link");
          }
        }
      }
      if (donor) {
        copyModules(donor, join(stage, "node_modules"), meta.platform === "darwin");
        for (const name of Object.keys(meta.files).filter(name => name.endsWith(`${sep}package.json`))) {
          const local = join(dirname(donor), dirname(name), "node_modules");
          if (existsSync(local)) copyModules(local, join(stage, dirname(name), "node_modules"), meta.platform === "darwin");
        }
      }
      else {
        const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
        const parentEnv = opts.env ?? process.env;
        const env = { ...parentEnv, npm_config_cache: parentEnv.npm_config_cache ?? parentEnv.NPM_CONFIG_CACHE ?? join(root, ".npm-cache") };
        (opts.runInstall ?? ((cwd, argv, env) => execFileSync("npm", argv, { cwd, env, stdio: "pipe", timeout: 120_000, killSignal: "SIGKILL" })))(stage, args, env);
        mkdirSync(join(stage, "node_modules"), { recursive: true });
        installed = true;
      }
      verifyPackages(stage, join(stage, "node_modules"));
      setWritable(join(stage, "node_modules"), false);
      for (const name of Object.keys(meta.files).filter(name => name.endsWith(`${sep}package.json`))) {
        const local = join(stage, dirname(name), "node_modules");
        if (existsSync(local)) setWritable(local, false);
      }
      mkdirSync(join(stage, "consumers"), { mode: 0o700 });
      writeJsonAtomic(join(stage, "ready.json"), meta);
      renameSync(stage, seed);
    }
    ownedDirectory(seed);
    const ready = JSON.parse(readFileSync(join(seed, "ready.json"), "utf8")) as SeedMetadata;
    if (ready.version !== VERSION || ready.key !== meta.key) throw new Error("dependency seed readiness metadata mismatch");
    verifyPackages(checkout, join(seed, "node_modules"));
    const method: SeedMethod = meta.platform === "darwin" ? "apfs-clone" : opts.proof ? "private-copy" : "readonly-links";
    if (method === "readonly-links") { linkPackages(join(seed, "node_modules"), targetStage); setWritable(targetStage, true); }
    else { copyModules(join(seed, "node_modules"), targetStage, method === "apfs-clone"); setWritable(targetStage, true); }
    workspaceLinks(checkout, targetStage);
    for (const name of Object.keys(meta.files).filter(name => name.endsWith(`${sep}package.json`))) {
      const workspace = dirname(name), local = join(checkout, workspace, "node_modules"), source = join(seed, workspace, "node_modules");
      if (!existsSync(source)) continue;
      try { lstatSync(local); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const localStage = join(checkout, workspace, `.rmd-dependency-stage-${randomUUID()}`);
      try {
        if (method === "readonly-links") linkPackages(source, localStage);
        else copyModules(source, localStage, method === "apfs-clone");
        setWritable(localStage, true);
        workspaceLinks(checkout, localStage, workspace);
        registerConsumer(seed, join(checkout, workspace), localStage, meta.key, method, installed);
        renameSync(localStage, local);
      } finally { if (existsSync(localStage)) { setWritable(localStage, true); rmSync(localStage, { recursive: true, force: true }); } }
    }
    // Register before publication, under the GC lock. A failed publication leaves a harmless stale reference.
    registerConsumer(seed, checkout, targetStage, meta.key, method, installed);
    writeJsonAtomic(join(seed, "ready.json"), { ...ready, lastUsed: opts.now ?? systemClock.now() });
    if (existsSync(dest)) throw new Error("dependency destination was occupied during provisioning");
    renameSync(targetStage, dest);
    return { status: "materialized", key: meta.key, seed, method, installed };
  } finally {
    for (const path of [stage, targetStage]) if (existsSync(path)) { setWritable(path, true); rmSync(path, { recursive: true, force: true }); }
    rmSync(lock, { recursive: true });
  }
}

/** GC requires a successful all-account open-file check, six idle hours and zero checkout references. */
export function sweepDependencySeeds(root: string, opts: { apply?: boolean; now?: number; isOpen?: (path: string) => boolean } = {}): Array<{ seed: string; action: "keep" | "remove"; reason: string }> {
  ownedDirectory(root);
  if (!existsSync(join(root, ROOT_MARKER))) throw new Error("not a dependency seed store");
  const results: Array<{ seed: string; action: "keep" | "remove"; reason: string }> = [];
  for (const key of readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const seed = join(root, key), lock = join(root, `${key}.lock`);
    let reason = "";
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch { results.push({ seed, action: "keep", reason: "installer or sweeper lock" }); continue; }
    try {
      ownedDirectory(seed);
      const meta = JSON.parse(readFileSync(join(seed, "ready.json"), "utf8")) as SeedMetadata;
      if (meta.key !== key || meta.version !== VERSION || !Number.isFinite(meta.lastUsed)) throw new Error("invalid readiness metadata");
      if ((opts.now ?? systemClock.now()) - meta.lastUsed < DEPENDENCY_SEED_MIN_IDLE_MS) reason = "used within six hours";
      for (const name of readdirSync(join(seed, "consumers"))) {
        const { checkout, mountNamespace } = JSON.parse(readFileSync(join(seed, "consumers", name), "utf8")) as { checkout: string; mountNamespace?: string };
        if (typeof checkout !== "string" || !isAbsolute(checkout)) throw new Error("invalid consumer reference");
        const currentNamespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/mnt") : "host";
        if (mountNamespace !== currentNamespace) { reason = "foreign or unverified consumer mount namespace"; continue; }
        const marker = join(checkout, "node_modules", CONSUMER_MARKER);
        try {
          const ref = JSON.parse(readFileSync(marker, "utf8")) as { seed: string };
          if (ref.seed === seed) reason = "referenced by checkout";
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!reason) {
        if (!opts.isOpen) reason = "open-file scan unavailable";
        else if (opts.isOpen(seed)) reason = "open file or process";
      }
      if (!reason && opts.apply) { setWritable(seed, true); rmSync(seed, { recursive: true }); }
      results.push({ seed, action: reason ? "keep" : "remove", reason: reason || "unreferenced and idle for six hours" });
    } catch (error) { results.push({ seed, action: "keep", reason: `unverified: ${(error as Error).message}` }); }
    finally { rmSync(lock, { recursive: true }); }
  }
  return results;
}
