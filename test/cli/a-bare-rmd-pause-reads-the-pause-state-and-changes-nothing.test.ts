import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { pauseFilePath, readSharedPauseAnchor, realSharedPauseGitDeps, requestFleetPause, requestPause } from "#src/lib/fleet-control.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12457 — on 2026-11-12 an agent ran a bare `rmd pause` to READ the pause state, and each run held
// instance 'core' for two hours. These tests drive the real CLI (bin/rmd) against a fixture whose two
// instances share one checkout and one bare origin, and read back the flag files, the ledgers and the ref.

const RMD = join(REPO_ROOT, "bin", "rmd");
const INSTANCES = ["core", "site"] as const;
type Instance = (typeof INSTANCES)[number];

interface Fixture {
  checkout: string;
  origin: string;
  root: (name: Instance) => string;
  home: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bare-pause-`));
  const origin = gitRepo({ bare: true, kind: "bare-pause-origin" }).dir;
  const shared = gitRepo({ cloneFrom: origin, kind: "bare-pause-checkout" });
  shared.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  shared.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const row = (name: Instance, repo: string, primary: boolean) =>
    `  ${name}:\n    repo: ${repo}\n    project: remudero\n${primary ? "    primary: true\n" : ""}    github_repo: fixture/${repo}\n    state_dir: ${join(dir, name)}\n`;
  const registryPath = daemonInstanceRegistryPath(shared.dir);
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `instances:\n${row("core", "remudero", true)}${row("site", "remudero-site", false)}`);
  shared.git("add", "-A");
  shared.git("commit", "-q", "-m", "fixture");
  shared.git("push", "-q", "origin", "HEAD:main");
  for (const name of INSTANCES) mkdirSync(join(dir, name, "state"), { recursive: true });
  const home = join(dir, "home-core");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: join(dir, "core"), claudeBin: "/bin/true" }));
  return { checkout: shared.dir, origin, root: (name) => join(dir, name), home };
}

/** The real CLI, run as instance core (its config.root), from the shared checkout. */
function rmd(fx: Fixture, ...args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.home, RMD_ALLOW_LIVE_WRITES: "1" };
  delete env.RMD_INSTANCE_REGISTRY;
  delete env.RMD_SELECTED_INSTANCE_REGISTRY;
  const res = spawnSync(RMD, args, { cwd: fx.checkout, encoding: "utf8", env, timeout: 180_000 });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function pauseRows(fx: Fixture, name: Instance): Array<Record<string, unknown>> {
  const path = join(fx.root(name), "state", "ledger.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "fleet.pause");
}

function sharedRef(fx: Fixture): string {
  return execFileSync("git", ["-C", fx.origin, "for-each-ref", "refs/rmd-pause/"], { encoding: "utf8" }).trim();
}

/** Nothing was written: no PAUSE flag, no fleet.pause row in any ledger, no shared ref on origin. */
function assertNothingWritten(fx: Fixture, label: string): void {
  for (const name of INSTANCES) {
    assert.equal(existsSync(pauseFilePath(fx.root(name))), false, `${label}: no PAUSE flag under ${name}`);
    assert.equal(pauseRows(fx, name).length, 0, `${label}: no fleet.pause row under ${name}`);
  }
  assert.equal(sharedRef(fx), "", `${label}: refs/rmd-pause/hold was not pushed`);
}

test("W1-T12457 criterion 1: a bare rmd pause prints the instance's pause state and the fleet-wide hold state", () => {
  const fx = makeFixture();
  const free = rmd(fx, "pause");
  assert.equal(free.status, 0, free.out);
  assert.match(free.out, /read only; nothing was changed/);
  assert.match(free.out, /instance 'core': not paused/);
  assert.match(free.out, /fleet-wide hold \(refs\/rmd-pause\/hold\): not held/);

  requestPause(fx.root("core"), "serve window", undefined, { instance: "core", until: "2099-01-01T00:00:00.000Z" });
  const pushed = withLiveWritesAllowed(() => requestFleetPause(realSharedPauseGitDeps(fx.checkout), "fleet maintenance"));
  assert.equal(pushed.pushed, true, "positive control: the fixture origin holds the fleet-wide ref");
  const held = rmd(fx, "pause");
  assert.equal(held.status, 0, held.out);
  assert.match(held.out, /instance 'core': PAUSED — reason: serve window; set by: .+; expires: 2099-01-01T00:00:00\.000Z/);
  assert.match(held.out, /fleet-wide hold \(refs\/rmd-pause\/hold\): HELD/);
});

test("W1-T12457 criterion 2: a bare rmd pause writes no PAUSE file, no fleet.pause row and no shared ref", () => {
  const fx = makeFixture();
  const res = rmd(fx, "pause");
  assert.equal(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /is PAUSED/);
  assertNothingWritten(fx, "bare pause");
});

test("W1-T12457 criterion 3: rmd pause --status reads the state and writes nothing, also with --instance, --fleet or --reason", () => {
  const fx = makeFixture();
  const cases: Array<{ args: string[]; shows: RegExp; hides?: RegExp }> = [
    { args: ["--status"], shows: /instance 'core': not paused/ },
    { args: ["--status", "--instance", "site"], shows: /instance 'site': not paused/ },
    { args: ["--status", "--fleet"], shows: /fleet-wide hold \(refs\/rmd-pause\/hold\): not held/, hides: /instance '/ },
    { args: ["--instance", "core", "--reason", "a real hold", "--status"], shows: /instance 'core': not paused/ },
  ];
  for (const c of cases) {
    const res = rmd(fx, "pause", ...c.args);
    const label = c.args.join(" ");
    assert.equal(res.status, 0, `${label}: ${res.out}`);
    assert.match(res.out, c.shows, label);
    assert.match(res.out, /fleet-wide hold/, label);
    if (c.hides) assert.doesNotMatch(res.out, c.hides, label);
    assertNothingWritten(fx, label);
  }
});

test("W1-T12457 criterion 4: a hold without a non-empty --reason refuses with exit 2 and changes nothing", () => {
  const fx = makeFixture();
  for (const args of [["--instance", "core"], ["--fleet"], ["--instance", "site", "--reason", "  "]]) {
    const res = rmd(fx, "pause", ...args);
    const label = args.join(" ");
    assert.equal(res.status, 2, `${label}: ${res.out}`);
    assert.match(res.out, /REFUSED: a hold needs --reason <text>; nothing was changed/, label);
    assert.match(res.out, /usage: rmd pause \[--instance <name>\] \[--status\]/, label);
    assertNothingWritten(fx, label);
  }
});

test("W1-T12457 criterion 5: a pause with --reason holds as before, and the row and the flag carry the reason", () => {
  const fx = makeFixture();
  const core = rmd(fx, "pause", "--reason", "serve window");
  assert.equal(core.status, 0, core.out);
  assert.match(core.out, /instance 'core'.* is PAUSED \(drain-and-hold\)/);
  assert.equal(JSON.parse(readFileSync(pauseFilePath(fx.root("core")), "utf8")).reason, "serve window");
  assert.equal(pauseRows(fx, "core").at(-1)?.reason, "serve window");
  assert.equal(sharedRef(fx), "", "an instance pause pushes no fleet-wide hold");

  const site = rmd(fx, "pause", "--instance", "site", "--reason", "site window");
  assert.equal(site.status, 0, site.out);
  assert.equal(JSON.parse(readFileSync(pauseFilePath(fx.root("site")), "utf8")).reason, "site window");
  assert.equal(pauseRows(fx, "site").at(-1)?.reason, "site window");

  const fleet = rmd(fx, "pause", "--fleet", "--reason", "fleet maintenance");
  assert.equal(fleet.status, 0, fleet.out);
  assert.match(fleet.out, /FLEET-WIDE hold pushed/);
  const sha = execFileSync("git", ["-C", fx.origin, "rev-parse", "refs/rmd-pause/hold"], { encoding: "utf8" }).trim();
  assert.equal(readSharedPauseAnchor(sha, realSharedPauseGitDeps(fx.checkout))?.reason, "fleet maintenance");
  const row = pauseRows(fx, "core").at(-1)!;
  assert.equal(row.scope, "fleet");
  assert.equal(row.reason, "fleet maintenance");
});

test("W1-T12457 criterion 6: an unknown flag refuses with exit 2 before anything is written", () => {
  const fx = makeFixture();
  for (const args of [["--state"], ["--show"], ["--instance", "core", "--reason", "hold", "--now"]]) {
    const res = rmd(fx, "pause", ...args);
    const label = args.join(" ");
    assert.equal(res.status, 2, `${label}: ${res.out}`);
    assert.match(res.out, /rmd pause: unexpected argument '--(state|show|now)'.*nothing was changed/, label);
    assertNothingWritten(fx, label);
  }
});
