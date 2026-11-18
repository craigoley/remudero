import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { boundGitCall } from "#src/lib/git-fetch-retry.js";
import { defaultOpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { asyncGit } from "#src/lib/self-sync.js";
import { bootSpawnHelper, installedSpawnHelper, installSpawnHelper, SPAWN_HELPER_SWITCH, startSpawnHelper,
  stopBootedSpawnHelper, type SpawnHelper } from "#src/lib/spawn-helper.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T13664: serve starts the spawn helper at boot; its git calls and its ops-catalog reads fork through it.

type Row = { step: string } & Record<string, unknown>;
const capture = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra = {}) => { rows.push({ step, ...extra }); } };
};

function stopInstalled(): void {
  installedSpawnHelper()?.stop();
  installSpawnHelper(undefined);
}

/** A directory holding one executable `name` that runs `body`, and the env that finds it first. */
function shim(name: string, body: string): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-helper-`));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "condition never held");
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("W1-T13664: the switch set to off starts no helper, and a start that throws leaves the direct path with a named row", () => {
  try {
    installSpawnHelper(undefined);
    const off = capture();
    assert.equal(bootSpawnHelper(off.log, { [SPAWN_HELPER_SWITCH]: "off" }, "serve.spawn_helper"), undefined);
    assert.equal(installedSpawnHelper(), undefined);
    assert.deepEqual(off.rows, [{ step: "serve.spawn_helper", started: false, reason: "switch_off",
      switch: "RMD_SPAWN_HELPER", value: "off" }]);

    const broken = capture();
    const result = bootSpawnHelper(broken.log, {}, "serve.spawn_helper", () => { throw new Error("no fork for you"); });
    assert.equal(result, undefined);
    assert.equal(installedSpawnHelper(), undefined, "a failed start leaves nothing installed");
    assert.deepEqual(broken.rows, [{ step: "serve.spawn_helper", started: false, reason: "start_failed: no fork for you",
      switch: "RMD_SPAWN_HELPER", value: "unset" }]);

    const on = capture();
    const helper = bootSpawnHelper(on.log, {}, "serve.spawn_helper");
    assert.ok(helper);
    assert.equal(installedSpawnHelper(), helper);
    assert.deepEqual(on.rows, [{ step: "serve.spawn_helper", started: true, pid: helper.pid,
      switch: "RMD_SPAWN_HELPER", value: "unset" }]);

    // The close stops only the helper this boot started.
    const other: SpawnHelper = startSpawnHelper();
    installSpawnHelper(other);
    stopBootedSpawnHelper(helper);
    assert.equal(helper.unhealthy(), "helper_stopped");
    assert.equal(installedSpawnHelper(), other, "a later helper stays installed");
    assert.equal(other.unhealthy(), undefined);
    stopBootedSpawnHelper(other);
    assert.equal(installedSpawnHelper(), undefined);
    stopBootedSpawnHelper(undefined);
  } finally {
    stopInstalled();
  }
});

test("W1-T13664: a git read and a bounded fetch fork through the installed helper, and the helper stops a fetch's child at its bound", async () => {
  const repo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-helper-repo-`));
  const slow = shim("git", "exec sleep 5");
  try {
    execFileSync("git", ["init", "--quiet", repo]);
    installSpawnHelper(undefined);
    const seen = capture();
    installSpawnHelper(startSpawnHelper({ log: seen.log }));

    const read = await asyncGit(repo)(["rev-parse", "--git-dir"]);
    assert.equal(read.trim(), ".git");
    const bounded = await boundGitCall(asyncGit(repo), ["rev-parse", "--git-dir"], 10_000);
    assert.equal(bounded.trim(), ".git");
    const routed = seen.rows.filter((row) => row.step === "spawn.routed");
    assert.deepEqual(routed.map((row) => [row.via, row.command]), [["helper", "git"], ["helper", "git"]]);

    // A fetch that never ends: the helper stops its child at the bound, and the call rejects.
    const began = Date.now();
    await assert.rejects(asyncGit(repo)(["fetch"], new AbortController().signal, slow.env, 300));
    assert.ok(Date.now() - began < 4_000, "the child was stopped at its bound, not at its own end");
  } finally {
    stopInstalled();
    slow.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T13664: a routed git call settles at its abort, and a failing child rejects with its stderr", async () => {
  const hung = shim("git", "exec sleep 5");
  const failing = shim("git", "echo boom >&2\nexit 3");
  type Failure = Error & { stderr?: string; code?: unknown };
  try {
    installSpawnHelper(undefined);
    const seen = capture();
    installSpawnHelper(startSpawnHelper({ log: seen.log }));

    const controller = new AbortController();
    const began = Date.now();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(asyncGit("/tmp")(["fetch"], controller.signal, hung.env, 20_000), { name: "AbortError" });
    assert.ok(Date.now() - began < 3_000, "settled at the abort, not at the child's end");

    const already = new AbortController();
    already.abort();
    await assert.rejects(asyncGit("/tmp")(["fetch"], already.signal, hung.env, 20_000), { name: "AbortError" });

    const viaHelper = await asyncGit("/tmp")(["fetch"], undefined, failing.env).then(() => undefined, (error: Failure) => error);
    assert.ok(seen.rows.some((row) => row.step === "spawn.routed" && row.via === "helper"), "the failing call went through the helper");
    stopInstalled();
    const direct = await asyncGit("/tmp")(["fetch"], undefined, failing.env).then(() => undefined, (error: Failure) => error);
    assert.match(String(viaHelper?.stderr), /boom/);
    assert.equal(viaHelper?.code, 3);
    assert.equal(viaHelper?.code, direct?.code, "the same exit code as a direct execFile");
    assert.match(String(viaHelper?.message), /boom/, "the message carries the stderr, as a direct execFile's does");
    assert.match(String(direct?.message), /boom/);
  } finally {
    stopInstalled();
    hung.cleanup();
    failing.cleanup();
  }
});

test("W1-T13664: a signalled call with no bound keeps its direct child, which its signal can stop", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-helper-pid-`));
  const pidFile = join(pidDir, "pid");
  const hung = shim("git", `echo $$ > ${pidFile}\nexec sleep 20`);
  try {
    installSpawnHelper(undefined);
    const seen = capture();
    installSpawnHelper(startSpawnHelper({ log: seen.log }));

    const controller = new AbortController();
    const settled = asyncGit("/tmp")(["fetch"], controller.signal, hung.env).then(() => undefined, (error: Error) => error);
    await until(() => { try { return readFileSync(pidFile, "utf8").trim() !== ""; } catch { return false; } });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(alive(pid), "the direct child is running");
    controller.abort();
    assert.equal((await settled)?.name, "AbortError");
    await until(() => !alive(pid));
    assert.deepEqual(seen.rows.filter((row) => row.step === "spawn.routed"), [], "nothing was routed through the helper");
  } finally {
    stopInstalled();
    hung.cleanup();
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("W1-T13664: the catalog's default api forks gh through the installed helper", async () => {
  const cli = shim("gh", `echo '{"ok":true}'`);
  const savedPath = process.env.PATH;
  try {
    installSpawnHelper(undefined);
    const seen = capture();
    installSpawnHelper(startSpawnHelper({ log: seen.log }));
    process.env.PATH = cli.env.PATH;
    const pacer = { wait: () => undefined, waitAsync: async () => undefined, recordResult: () => undefined };
    const api = defaultOpsCatalogApi({ pacer: pacer as unknown as NonNullable<Parameters<typeof defaultOpsCatalogApi>[0]>["pacer"] });
    assert.deepEqual(await api("repos/o/r/git/ref/heads/main"), { ok: true });
    assert.deepEqual(seen.rows.filter((row) => row.step === "spawn.routed").map((row) => [row.via, row.command]), [["helper", "gh"]]);
  } finally {
    process.env.PATH = savedPath;
    stopInstalled();
    cli.cleanup();
  }
});
