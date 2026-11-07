// A private-registry Codex profile denies the filesystem root, so it must positively grant what Codex's
// own Linux sandbox re-execs: the native executable's directory (reached through `codex-linux-sandbox`
// PATH aliases) and `$CODEX_HOME/tmp`, where those aliases live. On 2026-11-05 core's first selected-
// registry container ran every Codex worker under this profile and every sandboxed command failed
// `execvp codex-linux-sandbox` before it ran, so every daemon review posted a false FAIL.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import * as runtimeRegistry from "#src/lib/instance-registry-selection.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { codexPrivateProfileExecutableReads, spawnCodexWorker } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TIMEOUT = { timeout: 60_000 };

/** A Codex npm install shaped like the image's: launcher package plus a platform package holding vendor/. */
function codexInstall(root: string) {
  const scope = join(root, "opt", "clis", "node_modules", "@openai");
  const launcherPkg = join(scope, "codex"), platformPkg = join(scope, "codex-linux-x64"), unrelated = join(scope, "other");
  mkdirSync(join(launcherPkg, "bin"), { recursive: true });
  writeFileSync(join(launcherPkg, "package.json"), "{}");
  writeFileSync(join(launcherPkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
  chmodSync(join(launcherPkg, "bin", "codex.js"), 0o755);
  const vendorBin = join(platformPkg, "vendor", "x86_64-unknown-linux-musl", "bin");
  mkdirSync(vendorBin, { recursive: true });
  writeFileSync(join(platformPkg, "package.json"), "{}");
  writeFileSync(join(vendorBin, "codex"), "native");
  mkdirSync(join(unrelated, "vendor"), { recursive: true });
  writeFileSync(join(unrelated, "package.json"), "{}");
  // /usr/local/bin/codex -> hop -> codex.js: a symlink CHAIN, as npm global installs produce.
  const binDir = join(root, "usr", "local", "bin"), hopDir = join(root, "hop");
  mkdirSync(binDir, { recursive: true }); mkdirSync(hopDir, { recursive: true });
  symlinkSync(join(launcherPkg, "bin", "codex.js"), join(hopDir, "codex"));
  symlinkSync(join(hopDir, "codex"), join(binDir, "codex"));
  return { bin: join(binDir, "codex"), platformVendor: join(platformPkg, "vendor"), unrelatedVendor: join(unrelated, "vendor") };
}

test("the executable reads follow a symlinked launcher to the platform package's vendor dir and CODEX_HOME/tmp", TIMEOUT, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-reads-`)));
  try {
    const install = codexInstall(root), home = join(root, "codex-home");
    mkdirSync(home);
    const reads = codexPrivateProfileExecutableReads(install.bin, home);
    assert.ok(reads.includes(install.platformVendor), "the native helper's package vendor dir is granted");
    assert.ok(reads.includes(join(home, "tmp")), "the arg0 alias dir is granted even before Codex creates it");
    assert.equal(reads.includes(install.unrelatedVendor), false, "only the launcher's own platform packages, nothing else in the scope");
    assert.equal(reads.some(r => r === home || home.startsWith(r + "/")), false, "never CODEX_HOME itself, which holds auth.json");
    assert.equal(reads.some(r => r.includes(join("usr", "local", "bin"))), false, "the symlink's own directory is not the grant");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a native codex executable grants its own directory, and a planted tmp symlink is canonicalised", TIMEOUT, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-reads-native-`)));
  try {
    const nativeDir = join(root, "native"), home = join(root, "codex-home"), elsewhere = join(root, "elsewhere");
    mkdirSync(nativeDir); mkdirSync(home); mkdirSync(elsewhere);
    writeFileSync(join(nativeDir, "codex"), "native");
    symlinkSync(elsewhere, join(home, "tmp"));
    const reads = codexPrivateProfileExecutableReads(join(nativeDir, "codex"), home);
    assert.ok(reads.includes(nativeDir));
    assert.ok(reads.includes(elsewhere), "the grant is the canonical target, so the policy names what is really readable");
    assert.equal(reads.includes(join(home, "tmp")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type RuntimeRegistryRunner = <T>(operation: () => T | Promise<T>, input: { envPath?: string; instanceName?: string }) => Promise<T>;
const runtimeRegistryRunner = (): RuntimeRegistryRunner => Reflect.get(runtimeRegistry, "withInstanceRegistryRuntime") as RuntimeRegistryRunner;

function selectedFixture(root: string) {
  const selected = join(root, ".config", "remudero", "selected-registry.yaml");
  mkdirSync(join(root, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  const registry = "instances:\n  worker:\n    github_repo: owner/repo\n    mode: shadow\n";
  writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), registry.replace("shadow", "live"));
  writeFileSync(selected, registry);
  return selected;
}

/** Spawn through the real private-registry path and hand back the enforced inline -c overrides. */
async function selectedProfileOverrides(root: string, codexBin: string, intent: "reader" | "writer" | "review", cwdPath = "checkout", gitRoot = false) {
  const selected = selectedFixture(root), codexHome = join(root, "codex-home"), cwd = join(root, cwdPath);
  mkdirSync(codexHome, { recursive: true }); mkdirSync(cwd, { recursive: true });
  if (gitRoot) writeFileSync(join(cwd, ".git"), "gitdir: /nonexistent/worktree-git-dir\n");
  let overrides: string[] = [], profileText = "";
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  stdin.on("finish", () => { stdout.end(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n"); queueMicrotask(() => child.emit("exit", 0)); });
  await runtimeRegistryRunner()(() => spawnCodexWorker({
    cwd, workerHome: root, prompt: "profile grant fixture", settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    tools: intent === "writer" ? ["Read", "Edit", "Bash"] : ["Read", "Bash"],
    ...(intent === "review" ? { sandboxIntent: "disposable-review" as const } : {}),
    containment: { spawn: options => {
      const at = options.args.indexOf("--profile");
      profileText = readFileSync(join(codexHome, options.args[at + 1]! + ".config.toml"), "utf8");
      overrides = options.args.flatMap((value, i) => options.args[i - 1] === "-c" ? ["-c", value] : []);
      return { process: child as never, pid: 4242 };
    }, teardown: () => {} },
  }, { root, claudeBin: "/unused", workerProviders: { enabled: ["codex"], codexBin, codexModel: "gpt-6-luna", codexHome } }),
  { envPath: selected });
  return { overrides, profileText, selected, codexHome, cwd };
}

test("the selected-registry profile grants the derived executable reads and still denies the private and credential paths", TIMEOUT, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-profile-`)));
  try {
    const install = codexInstall(root);
    for (const intent of ["reader", "writer", "review"] as const) {
      const { overrides, profileText, selected, codexHome } = await selectedProfileOverrides(root, install.bin, intent);
      const inline = overrides.join("\n");
      for (const surface of [profileText, inline]) {
        assert.ok(surface.includes(`${JSON.stringify(install.platformVendor)}="read"`), `${intent}: the helper's vendor dir is readable`);
        assert.ok(surface.includes(`${JSON.stringify(join(realpathSync(codexHome), "tmp"))}="read"`), `${intent}: the arg0 alias dir is readable`);
        assert.ok(surface.includes('":root"="deny"'), `${intent}: the root deny stays`);
        assert.equal(surface.includes(selected), false, `${intent}: the private registry is never named`);
        assert.equal(surface.includes(`${JSON.stringify(realpathSync(codexHome))}=`), false, `${intent}: CODEX_HOME (auth.json) is never granted`);
        assert.equal(surface.includes(join(root, ".config")), false, `${intent}: no ~/.config grant`);
        assert.equal(/"[^"]+"="write"/.test(surface.replace(/":(workspace_roots|tmpdir)"="write"/g, "")), false,
          `${intent}: the new grants are read-only; only the existing workspace/tmpdir pseudo-roots may write`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11550 criterion 1: the worktree's parent is denied on both profile surfaces for every intent", TIMEOUT, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-parent-deny-`)));
  try {
    const install = codexInstall(root);
    for (const intent of ["reader", "writer", "review"] as const) {
      const { overrides, profileText, cwd } = await selectedProfileOverrides(root, install.bin, intent, "worktrees/run-1", true);
      for (const surface of [profileText, overrides.join("\n")]) {
        assert.ok(surface.includes(`${JSON.stringify(dirname(cwd))}="deny"`), `${intent}: the parent is denied`);
        assert.equal(surface.includes(`${JSON.stringify(dirname(cwd))}="read"`), false, `${intent}: never readable, which would expose sibling worktrees`);
        assert.ok(surface.includes('":root"="deny"'), `${intent}: the root deny stays`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11550 criterion 2: a grant beside the worktree keeps its read, because a parent deny would hide it", TIMEOUT, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-parent-grant-`)));
  try {
    const install = codexInstall(root);
    const { overrides, profileText } = await selectedProfileOverrides(root, install.bin, "writer");
    for (const surface of [profileText, overrides.join("\n")]) {
      assert.equal(surface.includes(`${JSON.stringify(root)}="deny"`), false, "the shared parent holds the vendor grant, so it is not denied");
      assert.ok(surface.includes(`${JSON.stringify(install.platformVendor)}="read"`), "the nested grant still applies");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11564 criterion 1: a working directory that is not a git checkout root keeps its parent undenied, so Codex's AGENTS.md walk reads no denied directory", TIMEOUT, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-probe-dir-`)));
  try {
    const install = codexInstall(root);
    for (const intent of ["reader", "writer", "review"] as const) {
      const { overrides, profileText, cwd } = await selectedProfileOverrides(root, install.bin, intent, "tmp/isolation-probe-1");
      for (const surface of [profileText, overrides.join("\n")]) {
        assert.equal(surface.includes(`${JSON.stringify(dirname(cwd))}=`), false, `${intent}: a plain probe directory's parent is untouched`);
        assert.ok(surface.includes('":root"="deny"'), `${intent}: the root deny stays`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function linuxCodex(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try { return execFileSync("which", ["codex"], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; }
}

test("a real codex sandbox starts under the selected-registry profile and runs a trivial command", {
  ...TIMEOUT,
  skip: linuxCodex() === undefined ? "needs Linux with codex on PATH (macOS uses seatbelt, not this bwrap path); CI or the image is the real check" : false,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-profile-real-`)));
  try {
    const codex = linuxCodex()!;
    const { overrides, codexHome } = await selectedProfileOverrides(root, codex, "reader");
    const out = execFileSync(codex, ["sandbox", ...overrides, "--", "/bin/echo", "sandbox-ok"],
      { encoding: "utf8", cwd: join(root, "checkout"), env: { ...process.env, CODEX_HOME: codexHome }, timeout: 45_000 });
    assert.match(out, /sandbox-ok/);
    assert.ok(existsSync(codexHome));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11550 criterion 3: a real sandbox refuses a write beside the worktree with an OS error and still writes inside it", {
  ...TIMEOUT,
  skip: linuxCodex() === undefined ? "needs Linux with codex on PATH; the image is the real check" : false,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-parent-real-`)));
  try {
    const codex = linuxCodex()!;
    const { overrides, codexHome, cwd } = await selectedProfileOverrides(root, codex, "writer", "worktrees/run-1", true);
    const privateTmp = join(root, "private-tmp");
    mkdirSync(privateTmp);
    const run = spawnSync(codex, ["sandbox", ...overrides, "--", "/bin/bash", "-c", "touch ../beside; echo rc=$?; touch inside; echo rc=$?"],
      { encoding: "utf8", cwd, env: { ...process.env, CODEX_HOME: codexHome, TMPDIR: privateTmp }, timeout: 45_000 });
    assert.match(`${run.stdout}${run.stderr}`, /read-only file system/i, "the OS denial the containment probe reads");
    assert.match(run.stdout, /rc=1\nrc=0/);
    assert.equal(existsSync(join(dirname(cwd), "beside")), false);
    assert.ok(existsSync(join(cwd, "inside")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
