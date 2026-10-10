import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import {
  checkSharedPause,
  disposeSharedPauseRefresh,
  pauseFilePath,
  prepareSharedPause,
  readSharedPause,
  realSharedPauseGitDeps,
  requestFleetPause,
  sharedPauseRef,
} from "../src/lib/fleet-control.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { resolvePauseTarget } from "../src/lib/pause-target.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T7727 — core, site and console run ONE checkout against ONE origin, each from its own state root.
// `rmd pause` used to push the fleet-wide refs/rmd-pause/hold, so pausing core for a serve window held
// all of them. Every test below drives the REAL CLI (bin/rmd) and reads back through the PRODUCTION
// readers (`checkSharedPause` behind `prepareSharedPause`, the daemon's own gate), on a fixture whose
// four instances share one checkout and one bare origin, as the live host's do.

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RMD = join(REPO, "bin", "rmd");
const INSTANCES = ["core", "site", "console", "wild-trails"] as const;
type Instance = (typeof INSTANCES)[number];

interface Fixture {
  dir: string;
  checkout: string;
  origin: string;
  root: (name: Instance) => string;
  homeFor: (name: Instance | "operator") => string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function registryText(dir: string, extra = ""): string {
  const row = (name: string, repo: string, project: string) =>
    `  ${name}:\n    repo: ${repo}\n    project: ${project}\n    github_repo: fixture/${repo}\n    state_dir: ${join(dir, name)}\n`;
  return (
    "instances:\n" +
    row("core", "remudero", "remudero").replace("    state_dir", "    primary: true\n    state_dir") +
    row("site", "remudero-site", "remudero") +
    row("console", "remudero-console", "remudero") +
    row("wild-trails", "wild-trails", "wild-trails") +
    extra
  );
}

function makeFixture(registry?: (dir: string) => string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instance-pause-`));
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const checkout = join(dir, "checkout");
  execFileSync("git", ["clone", "-q", origin, checkout]);
  git(checkout, "config", "user.email", "fixture@invalid");
  git(checkout, "config", "user.name", "fixture");
  const registryPath = daemonInstanceRegistryPath(checkout);
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, registry ? registry(dir) : registryText(dir));
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "fixture");
  git(checkout, "push", "-q", "origin", "HEAD:main");
  for (const name of INSTANCES) mkdirSync(join(dir, name, "state"), { recursive: true });
  const homeFor = (name: Instance | "operator") => {
    const home = join(dir, `home-${name}`);
    const configDir = join(home, ".config", "remudero");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ root: join(dir, name), claudeBin: "/bin/true" }));
    return home;
  };
  return { dir, checkout, origin, root: (name) => join(dir, name), homeFor };
}

/** The real CLI, run as `as` (its config.root), from the shared checkout whose origin is the fixture's bare repo. */
function rmd(fx: Fixture, as: Instance | "operator", ...args: string[]): { status: number | null; out: string } {
  const res = spawnSync(RMD, args, {
    cwd: fx.checkout,
    encoding: "utf8",
    // The origin is a local bare repo inside the fixture, so a push can only land there.
    env: { ...process.env, HOME: fx.homeFor(as), RMD_ALLOW_LIVE_WRITES: "1" },
    timeout: 120_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

/** The daemon's own gate for one instance: local flag first, then the shared hold read off the loop. */
async function gate(fx: Fixture, name: Instance): Promise<string | undefined> {
  const deps = realSharedPauseGitDeps(fx.checkout);
  try {
    await prepareSharedPause(fx.root(name), deps);
    return checkSharedPause(fx.root(name), deps);
  } finally {
    disposeSharedPauseRefresh(deps);
  }
}

async function heldInstances(fx: Fixture): Promise<Instance[]> {
  const held: Instance[] = [];
  for (const name of INSTANCES) if ((await gate(fx, name)) !== undefined) held.push(name);
  return held;
}

function sharedRefOnOrigin(fx: Fixture): string {
  return execFileSync("git", ["-C", fx.origin, "for-each-ref", "refs/rmd-pause/"], { encoding: "utf8" }).trim();
}

/** Control rows in one instance's ledger. `cli.invoked` is the CLI's own audit of every invocation (written under the
 *  invoking config's root before any verb runs), not a pause or resume write, so it is not one. */
function ledgerRows(fx: Fixture, name: Instance): Array<Record<string, unknown>> {
  const path = join(fx.root(name), "state", "ledger.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step !== "cli.invoked");
}

test("W1-T7727: a pause through the real CLI holds only the instance it targets", async () => {
  const fx = makeFixture();
  // Positive control: the fixture's readers CAN see a hold on the shared origin before the real assertions rely on a zero.
  assert.equal(readSharedPause(realSharedPauseGitDeps(fx.checkout)), "absent", "the fixture origin starts with no shared hold");

  const paused = rmd(fx, "core", "pause", "--reason", "serve restoration window");
  assert.equal(paused.status, 0, paused.out);
  assert.match(paused.out, /instance 'core'/);
  assert.deepEqual(await heldInstances(fx), ["core"], "only core holds; site, console and wild-trails share its checkout and origin and stay free");
  assert.equal(sharedRefOnOrigin(fx), "", `no fleet-wide ${sharedPauseRef()} was pushed`);
  const flag = JSON.parse(readFileSync(pauseFilePath(fx.root("core")), "utf8")) as Record<string, unknown>;
  assert.equal(flag.instance, "core", "the flag names the instance it holds");
  assert.equal(flag.reason, "serve restoration window");
  assert.equal(typeof flag.sessionId, "string");
  assert.equal(typeof flag.expiresAt, "string", "a default expiry is recorded, as before");
  const row = ledgerRows(fx, "core").find((r) => r.step === "fleet.pause");
  assert.equal(row?.scope, "instance");
  assert.equal(row?.instance, "core");
  for (const other of ["site", "console", "wild-trails"] as const) {
    assert.equal(ledgerRows(fx, other).length, 0, `${other}'s ledger is untouched`);
  }
});

test("W1-T7727: pausing wild-trails holds no Remudero instance, and pausing core does not hold wild-trails", async () => {
  const fx = makeFixture();
  const wild = rmd(fx, "operator", "pause", "--instance", "wild-trails", "--reason", "wild-trails maintenance");
  assert.equal(wild.status, 0, wild.out);
  assert.deepEqual(await heldInstances(fx), ["wild-trails"]);
  assert.equal(ledgerRows(fx, "wild-trails").find((r) => r.step === "fleet.pause")?.resolved_by, "--instance");
  const resumed = rmd(fx, "operator", "resume", "--instance", "wild-trails");
  assert.equal(resumed.status, 0, resumed.out);
  assert.deepEqual(await heldInstances(fx), []);

  const core = rmd(fx, "operator", "pause", "--instance", "core");
  assert.equal(core.status, 0, core.out);
  assert.deepEqual(await heldInstances(fx), ["core"], "wild-trails stays free while core is held");
  assert.equal(sharedRefOnOrigin(fx), "");
});

test("W1-T7727: resuming one instance leaves another instance's hold standing", async () => {
  const fx = makeFixture();
  assert.equal(rmd(fx, "core", "pause", "--reason", "core window").status, 0);
  assert.equal(rmd(fx, "operator", "pause", "--instance", "site", "--reason", "site window").status, 0);
  assert.deepEqual(await heldInstances(fx), ["core", "site"]);
  const resumed = rmd(fx, "operator", "resume", "--instance", "site");
  assert.equal(resumed.status, 0, resumed.out);
  assert.deepEqual(await heldInstances(fx), ["core"], "core's hold survives site's resume");
  assert.match(String(JSON.parse(readFileSync(pauseFilePath(fx.root("core")), "utf8")).reason), /core window/);
});

test("W1-T7727: a target that cannot be resolved unambiguously changes nothing", async () => {
  const cases: Array<{ name: string; fx: () => Fixture; as: Instance | "operator"; args: string[]; refusal: RegExp }> = [
    { name: "a config.root that is no instance's state_dir", fx: () => makeFixture(), as: "operator", args: ["pause"], refusal: /not the state_dir of any instance/ },
    { name: "an undeclared --instance", fx: () => makeFixture(), as: "operator", args: ["pause", "--instance", "nope"], refusal: /not a declared instance/ },
    { name: "--fleet with --instance", fx: () => makeFixture(), as: "core", args: ["pause", "--fleet", "--instance", "core"], refusal: /cannot be combined/ },
    {
      name: "two instances declaring one state_dir",
      fx: () => makeFixture((dir) => registryText(dir, `  shadow-core:\n    repo: shadow\n    github_repo: fixture/shadow\n    state_dir: ${join(dir, "core")}\n`)),
      as: "core",
      args: ["pause"],
      refusal: /state_dir of 2 instances/,
    },
    { name: "an unreadable registry", fx: () => makeFixture((dir) => `not a registry ${dir}\n`), as: "core", args: ["pause"], refusal: /cannot tell which instance/ },
  ];
  for (const c of cases) {
    const fx = c.fx();
    const res = rmd(fx, c.as, ...c.args);
    assert.notEqual(res.status, 0, `${c.name}: refused`);
    assert.match(res.out, c.refusal, `${c.name}: the refusal says why`);
    assert.match(res.out, /nothing was changed/, `${c.name}: the refusal says nothing changed`);
    for (const name of INSTANCES) {
      assert.equal(existsSync(pauseFilePath(fx.root(name))), false, `${c.name}: no PAUSE flag under ${name}`);
      assert.equal(ledgerRows(fx, name).length, 0, `${c.name}: no ledger row under ${name}`);
    }
    assert.equal(existsSync(join(fx.dir, "operator", "state", "PAUSE")), false, `${c.name}: no flag under the operator's own root`);
    assert.equal(sharedRefOnOrigin(fx), "", `${c.name}: no shared ref`);
    assert.deepEqual(await heldInstances(fx), [], `${c.name}: no instance is held`);
  }
});

test("W1-T7727: an existing fleet-wide hold is honored, survives an instance resume, and only resume --fleet clears it", async () => {
  const fx = makeFixture();
  // A hold set the pre-W1-T7727 way (the shared ref, with its attributed anchor) by another operator.
  const legacy = withLiveWritesAllowed(() => requestFleetPause(realSharedPauseGitDeps(fx.checkout), "another operator's hold"));
  assert.equal(legacy.pushed, true);
  assert.deepEqual(await heldInstances(fx), [...INSTANCES], "every instance honors the fleet-wide hold, as before");

  const resumed = rmd(fx, "core", "resume");
  assert.equal(resumed.status, 0, resumed.out);
  assert.match(resumed.out, /NOT cleared by an instance resume/);
  assert.notEqual(sharedRefOnOrigin(fx), "", "an instance resume never deletes the fleet-wide hold");
  assert.deepEqual(await heldInstances(fx), [...INSTANCES]);

  const fleet = rmd(fx, "core", "resume", "--fleet");
  assert.equal(fleet.status, 0, fleet.out);
  assert.equal(sharedRefOnOrigin(fx), "");
  assert.deepEqual(await heldInstances(fx), []);

  const explicit = rmd(fx, "core", "pause", "--fleet", "--reason", "deliberate fleet-wide maintenance");
  assert.equal(explicit.status, 0, explicit.out);
  assert.deepEqual(await heldInstances(fx), [...INSTANCES], "--fleet is the explicit way to hold every instance");
  for (const name of INSTANCES) assert.equal(existsSync(pauseFilePath(fx.root(name))), false, "--fleet writes no instance flag");
});

test("W1-T7727: resolvePauseTarget names the registry instance, or refuses", () => {
  const dir = "/srv/fixture";
  const text = registryText(dir);
  const reach = () => true;
  assert.deepEqual(resolvePauseTarget({ configRoot: `${dir}/core/`, registryText: text, registryPath: "r", dirExists: reach }), {
    ok: true,
    target: { instance: "core", root: `${dir}/core/`, resolvedBy: "config-root" },
  });
  assert.deepEqual(resolvePauseTarget({ configRoot: "/elsewhere", instance: "console", registryText: text, registryPath: "r", dirExists: reach }), {
    ok: true,
    target: { instance: "console", root: `${dir}/console`, resolvedBy: "--instance" },
  });
  const unreachable = resolvePauseTarget({ configRoot: "/elsewhere", instance: "site", registryText: text, registryPath: "r", dirExists: () => false });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.ok ? "" : unreachable.refusal, /not reachable from this process/);
  const retired = resolvePauseTarget({
    configRoot: "/elsewhere",
    instance: "site",
    registryText: text.replace("    repo: remudero-site\n", "    repo: remudero-site\n    retired: true\n"),
    registryPath: "r",
    dirExists: reach,
  });
  assert.match(retired.ok ? "" : retired.refusal, /retired/);
  const badName = resolvePauseTarget({ configRoot: "/elsewhere", instance: "../core", registryText: text, registryPath: "r", dirExists: reach });
  assert.match(badName.ok ? "" : badName.refusal, /not an instance name/);
});
