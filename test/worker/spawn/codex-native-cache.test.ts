import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";
import { prepareWorkerNativeCache } from "#src/lib/worker-native-cache.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const posix = { skip: process.platform === "win32" ? "POSIX native-cache permissions" : false };
const require = createRequire(import.meta.url);

async function writerOptions(inspect: (options: ContainedSpawnOptions, root: string, home: string) => void,
  mode: "writer" | "reader" | "review" = "writer") {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-cache-test-"));
  const home = join(root, "host-home"), unsafe = join(root, "unsafe-worker-parent");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(unsafe); chmodSync(unsafe, 0o777);
  mkdirSync(join(unsafe, "tmp"));
  const workerHome = join(unsafe, "worker-home"); mkdirSync(workerHome);
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = home; process.env.TMPDIR = join(unsafe, "tmp");
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const child = Object.assign(new EventEmitter(), streams);
  try {
    await spawnCodexWorker({ cwd: REPO_ROOT, prompt: "fixture only", workerHome,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools: mode === "reader" ? ["Read"] : ["Read", "Bash"],
      ...(mode === "review" ? { sandboxIntent: "disposable-review" as const, sandboxReadRoots: [REPO_ROOT] } : {}),
      containment: { spawn(options) {
        inspect(options, root, home);
        queueMicrotask(() => {
          streams.stdout.end(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }) + "\n");
          child.emit("exit", 0);
        });
        return { process: child as never, pid: 37_814 };
      }, teardown() {} },
    }, { root, claudeBin: "/unused", workerProviders: {
      enabled: ["codex"], codexBin: process.execPath, codexModel: "gpt-6-luna", codexHome: join(root, "codex-state"),
    } });
  } finally {
    for (const key of ["HOME", "TMPDIR"] as const) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function shellCache(options: ContainedSpawnOptions): string | undefined {
  const prefix = "shell_environment_policy.set.SWC_NATIVE_BINDING_CACHE=";
  const value = options.args.find(arg => arg.startsWith(prefix));
  return value === undefined ? undefined : JSON.parse(value.slice(prefix.length));
}

test("Codex writers grant only their verified native cache while preserving shell isolation", posix, async () => {
  await writerOptions((options, _root, home) => {
    const cache = join(home, ".cache", "remudero", "swc-native");
    assert.equal(shellCache(options), cache, "core-only shells need an explicit native-cache setting");
    assert.equal(options.env.SWC_NATIVE_BINDING_CACHE, cache);
    assert.ok(existsSync(cache));
    assert.ok(options.args.some((value, index) => value === "--add-dir" && options.args[index + 1] === cache));
    assert.ok(options.args.includes('shell_environment_policy.inherit="core"'));
    assert.ok(options.args.includes('shell_environment_policy.exclude=["CODEX_HOME","OPENAI_API_KEY","ANTHROPIC_API_KEY"]'));
    assert.notEqual(options.env.HOME, home, "the operator HOME is never restored");
    assert.equal(options.env.SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK, undefined);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  });
});

test("Codex writer native parsing succeeds with security checks and unsafe cache controls still refuse", posix, async () => {
  await writerOptions((options, root) => {
    // Own the copied package and carrier so an eligible filesystem replacement cannot write shared dependencies.
    const core = dirname(require.resolve("@swc/core/package.json"));
    const copy = join(root, "parser"); cpSync(core, copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
    const names = Object.keys(manifest.optionalDependencies).filter(name => name.startsWith(`@swc/core-${process.platform}-${process.arch}`));
    const installed = names.map(name => { try { return require.resolve(name); } catch { return undefined; } }).filter((path): path is string => path !== undefined);
    assert.equal(installed.length, 1, "the installed native carrier is a positive control");
    const native = installed[0]!;
    const originalNative = readFileSync(native);
    assert.ok(originalNative.includes(Buffer.from("SWC native addon:")), "this scenario requires the real security-checking carrier");
    copyFileSync(native, join(copy, basename(native)));
    const env: NodeJS.ProcessEnv = { NODE_PATH: join(REPO_ROOT, "node_modules") };
    for (const key of ["HOME", "TMPDIR", "PATH", "LANG", "USER"]) env[key] = options.env[key];
    const code = "const s=require(process.argv[1]);const target=s.getBinaryMetadata().target;if(!target)throw Error('native binding required');console.log(JSON.stringify({target,type:s.parseSync('const n: number = 1',{syntax:'typescript'}).type}));";
    const run = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["-e", code, copy], {
      cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20_000,
    });
    const legacy = run({ SWC_NATIVE_BINDING_CACHE: "0" });
    assert.notEqual(legacy.status, 0, "the existing temporary fallback must actually reject the unsafe ancestors");
    assert.match(legacy.stderr, /parent writable by another user|trusted sticky protection/);
    const cache = shellCache(options);
    assert.equal(typeof cache, "string", "the real shell argv must supply the trusted root");
    const loaded = run({ SWC_NATIVE_BINDING_CACHE: cache });
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(JSON.parse(loaded.stdout).type, "Module");
    assert.equal(typeof JSON.parse(loaded.stdout).target, "string");
    const refused = run({ SWC_NATIVE_BINDING_CACHE: join(root, "unsafe-worker-parent", "cache") });
    assert.notEqual(refused.status, 0, "an unsafe configured root remains refused after a successful native load");
    assert.match(refused.stderr, /parent writable by another user|trusted sticky protection/);
    assert.ok(originalNative.equals(readFileSync(native)), "shared dependency bytes remain unchanged");
  });
});

test("read-only and disposable-review workers receive no native-cache write grant", posix, async () => {
  for (const mode of ["reader", "review"] as const) await writerOptions((options, _root, home) => {
    assert.equal(shellCache(options), undefined);
    assert.equal(options.env.SWC_NATIVE_BINDING_CACHE, undefined);
    assert.equal(existsSync(join(home, ".cache")), false);
    assert.notEqual(options.env.HOME, home);
  }, mode);
});

function cacheFixture(check: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "rmd-native-cache-guard-"));
  try { check(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("native cache creation is private and repeated preparation preserves the namespace", posix, () => {
  cacheFixture(home => {
    const first = prepareWorkerNativeCache(home);
    const marker = join(first, "owned-marker"); writeFileSync(marker, "retained");
    assert.equal(prepareWorkerNativeCache(home), first);
    assert.equal(lstatSync(first).mode & 0o777, 0o700);
    assert.equal(lstatSync(first).uid, process.geteuid!());
    assert.equal(readFileSync(marker, "utf8"), "retained");
  });
});

test("native cache refuses unsafe ancestors and existing public namespaces without changing their modes", posix, () => {
  cacheFixture(home => {
    const parent = join(home, ".cache"); mkdirSync(parent); chmodSync(parent, 0o777);
    assert.throws(() => prepareWorkerNativeCache(home), /untrusted directory/);
    assert.equal(lstatSync(parent).mode & 0o7777, 0o777);
    assert.equal(existsSync(join(parent, "remudero")), false);
    chmodSync(parent, 0o700);
    const root = join(parent, "remudero", "swc-native"); mkdirSync(root, { recursive: true }); chmodSync(root, 0o755);
    assert.throws(() => prepareWorkerNativeCache(home), /private to its writer/);
    assert.equal(lstatSync(root).mode & 0o7777, 0o755);
    chmodSync(root, 0o500);
    assert.throws(() => prepareWorkerNativeCache(home), /private to its writer/);
    assert.equal(lstatSync(root).mode & 0o7777, 0o500);
  });
});

test("native cache rejects symlink and foreign-owner ancestors before granting a writable directory", posix, () => {
  cacheFixture(home => {
    const target = join(home, "other"); mkdirSync(target); writeFileSync(join(target, "marker"), "retained");
    symlinkSync(target, join(home, ".cache"));
    assert.throws(() => prepareWorkerNativeCache(home), /untrusted directory/);
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "retained");
    assert.equal(existsSync(join(target, "remudero")), false);
    unlinkSync(join(home, ".cache"));
    assert.throws(() => prepareWorkerNativeCache(home, process.geteuid!() + 1), /untrusted directory|private to its writer/);
  });
});

test("native cache refuses when process ownership cannot be measured", posix, t => {
  t.mock.method(process, "geteuid", () => undefined as never);
  cacheFixture(home => assert.throws(() => prepareWorkerNativeCache(home), /ownership cannot be verified/));
});

test("native cache permits a trusted sticky parent without relaxing the private leaf", posix, () => {
  cacheFixture(root => {
    chmodSync(root, 0o1777);
    const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
    const cache = prepareWorkerNativeCache(home);
    assert.equal(lstatSync(root).mode & 0o7777, 0o1777);
    assert.equal(lstatSync(cache).mode & 0o777, 0o700);
  });
});
