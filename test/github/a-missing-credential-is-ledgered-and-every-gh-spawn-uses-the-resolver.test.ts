// W1-T12075 — a missing GitHub credential is ledgered, and every gh spawn uses the one resolver.
//
// The four gh spawns outside the transport (pr-state's direct read, the broker's upstream executor with an
// explicit environment, `rmd gh`'s direct path and the broker client's fallback) take their environment
// from the resolver W1-T11926 added. Each test drives the REAL spawn into a PATH-stubbed `gh` that writes
// the environment it received to a file, so the assertion is on what the child got, not on source text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { ghBrokerClientSpawn } from "#src/lib/gh-read-broker-client.js";
import { defaultGhUpstreamExec, ghCredentialChildEnv, runGhDirect } from "#src/lib/gh-read-broker.js";
import {
  GITHUB_CREDENTIAL_MISSING_STEP, GITHUB_CREDENTIAL_REFERENCES_FILENAME, GITHUB_CREDENTIAL_SOURCE_ORDER, GithubCredentialMissingError,
  resolveGithubCredential,
} from "#src/lib/github-credential.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { prStateCommand } from "#src/lib/pr-state.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghStubPath } from "#test/helpers/gh-stub.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const AMBIENT = "ambient-token-w1-t12075";
const REFERENCED = "referenced-token-w1-t12075";
const REFERENCE_VAR = "RMD_W1_T12075_REFERENCED";
const READ = ["api", "repos/acme/widgets/pulls/7"];

/** Environment overrides; `undefined` removes the variable. */
type Overrides = Record<string, string | undefined>;

interface Fixture {
  root: string;
  /** A HOME with no references file under it. */
  bareHome: string;
  /** A HOME whose state directory holds a remudero-wide reference to {@link REFERENCE_VAR}. */
  referencedHome: string;
  /** A gh config directory holding a stored login. */
  loggedIn: string;
  /** A gh config directory with no stored login. */
  loggedOut: string;
  /** The directory holding the stub `gh`, built by the shared helper. */
  stubDir: string;
  /** A directory on PATH with no `gh` in it. */
  noGhDir: string;
  cache: string;
  dump: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-spawn-resolver-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f: Fixture = {
    root,
    bareHome: join(root, "bare-home"),
    referencedHome: join(root, "referenced-home"),
    loggedIn: join(root, "gh-logged-in"),
    loggedOut: join(root, "gh-logged-out"),
    stubDir: "",
    noGhDir: join(root, "no-gh"),
    cache: join(root, "cache"),
    dump: join(root, "env.dump"),
  };
  for (const dir of [f.bareHome, f.loggedIn, f.loggedOut, f.noGhDir, f.cache]) mkdirSync(dir, { recursive: true });
  const stateDir = join(f.referencedHome, "Remudero", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, GITHUB_CREDENTIAL_REFERENCES_FILENAME),
    JSON.stringify({ references: [{ scope: "*", kind: "env", name: REFERENCE_VAR }] }));
  writeFileSync(join(f.loggedIn, "hosts.yml"), "github.com:\n  user: octo\n");
  // The stub writes the environment it received and prints nothing, so an inherited stdout stays quiet.
  f.stubDir = ghStubPath(`#!/bin/sh\nenv > '${f.dump}'\nexit 0\n`);
  t.after(() => rmSync(dirname(f.stubDir), { recursive: true, force: true }));
  return f;
}

function withOverrides(base: NodeJS.ProcessEnv, overrides: Overrides): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** The environment the stub last received, one sorted line per variable; the dump is consumed. */
function takeDump(f: Fixture): string[] | undefined {
  if (!existsSync(f.dump)) return undefined;
  const lines = readFileSync(f.dump, "utf8").split("\n").filter((line) => line !== "").sort();
  rmSync(f.dump, { force: true });
  return lines;
}

/** What the stub receives when spawned with exactly `env`: the environment a spawn gave gh before W1-T12075. */
function control(f: Fixture, env: NodeJS.ProcessEnv): string[] {
  const out = spawnSync(`${f.stubDir}/gh`, [], { env, cwd: process.cwd() });
  assert.equal(out.status, 0, String(out.stderr));
  const dump = takeDump(f);
  assert.ok(dump, "the control spawn wrote its environment");
  return dump;
}

/** Run `fn` with this process's environment changed by `overrides`, restoring every key afterwards. */
async function underProcessEnv<T>(overrides: Overrides, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run `fn` with this process's stderr captured into `into`. A write's callback still fires, so a flush waits on nothing. */
async function capturingStderr<T>(into: string[], fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: unknown, done?: unknown): boolean => {
    into.push(String(chunk));
    const callback = typeof encoding === "function" ? encoding : done;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
}

interface SpawnOutcome {
  /** The environment the stub received, or `undefined` when no gh child ran. */
  dump: string[] | undefined;
  /** The environment the spawn site was given: the one it handed gh before W1-T12075. */
  before: NodeJS.ProcessEnv;
  /** What the call site reported, for the refusal assertions. */
  report: string;
  code: number;
}

type SpawnSite = (f: Fixture, overrides: Overrides) => Promise<SpawnOutcome>;

/** The four spawn sites, each driven through its real code path. */
const SITES: Record<string, SpawnSite> = {
  "src/lib/pr-state.ts direct read": async (f, overrides) => {
    const env = withOverrides(process.env, overrides);
    const out: string[] = [];
    const code = await prStateCommand(["7", "--max-age", "2m"], {
      stateDir: () => f.root,
      readLedger: async function* () {},
      readBroker: undefined,
      repository: () => ({ owner: "acme", repo: "widgets" }),
      clock: fixedClock(Date.parse("2026-11-15T10:00:00Z")),
      write: (text) => out.push(text),
      error: (text) => out.push(text),
      env,
    });
    return { dump: takeDump(f), before: env, report: out.join("\n"), code };
  },
  "src/lib/gh-read-broker.ts upstream executor": async (f, overrides) => {
    const env = withOverrides(process.env, overrides);
    const result = await defaultGhUpstreamExec([...READ], { env });
    return { dump: takeDump(f), before: env, report: result.stderr, code: result.exitCode };
  },
  "src/lib/gh-read-broker.ts direct path": async (f, overrides) => {
    let before: NodeJS.ProcessEnv = {};
    const stderr: string[] = [];
    const code = await underProcessEnv(overrides, async () => {
      before = { ...process.env };
      return await capturingStderr(stderr, () => runGhDirect([...READ]));
    });
    return { dump: takeDump(f), before, report: stderr.join(""), code };
  },
  "src/gh-read-broker-client-main.ts fallback": async (f, overrides) => {
    // NODE_OPTIONS would re-run this suite's setup in the child, which puts its own refusing gh first on PATH.
    const env = withOverrides(process.env, { ...overrides, NODE_OPTIONS: "" });
    // The spawn the synchronous transport makes, against a socket that is not there: the client falls back.
    // The loader alone: this file's execArgv also carries the suite setup, which a production child never loads.
    const spawned = ghBrokerClientSpawn(join(f.root, "nowhere.sock"), READ, "agent", ["--import", "tsx"]);
    const out = spawnSync(spawned.file, spawned.args, { env, cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    assert.match(out.stderr, /gh-broker: unreachable/, "the client took its fallback path");
    return { dump: takeDump(f), before: env, report: out.stderr, code: out.status ?? -1 };
  },
};

function gh(dump: string[] | undefined, key: string): string | undefined {
  const line = dump?.find((entry) => entry.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

test("W1-T12075 criterion 1: `rmd gh` installs the ledger writer, and a gh call with no credential writes one github.credential_missing row naming the sources and no value", (t) => {
  const f = fixture(t);
  const ledgerRoot = join(f.root, "remudero");
  mkdirSync(join(ledgerRoot, "state"), { recursive: true });
  mkdirSync(join(f.bareHome, ".config", "remudero"), { recursive: true });
  writeFileSync(join(f.bareHome, ".config", "remudero", "config.json"), JSON.stringify({ root: ledgerRoot, claudeBin: "/usr/bin/claude" }));
  // A fresh CLI process must install its own ledger writer, with no sink inherited from this suite.
  const env = withOverrides(process.env, {
    HOME: f.bareHome, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: f.loggedOut, XDG_CONFIG_HOME: undefined,
    PATH: f.noGhDir, RMD_GH_CACHE_HOME: f.cache, XDG_CACHE_HOME: undefined, [REFERENCE_VAR]: REFERENCED,
    NODE_OPTIONS: "",
  });
  const out = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/run-task.ts"),
    ..."gh -- api repos/acme/widgets-c1/pulls/7".split(" ")], {
    env, cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(out.error);
  assert.equal(out.status, 1, `expected \`rmd gh\` to exit 1: ${out.stderr}`);
  assert.match(out.stderr, /no GitHub credential for `gh api repos\/acme\/widgets-c1\/pulls\/7`/, "the caller reads the named error");
  const rows = readFileSync(join(ledgerRoot, "state", LEDGER_FILENAME), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === GITHUB_CREDENTIAL_MISSING_STEP);
  assert.equal(rows.length, 1, "exactly one row for the one failed call");
  assert.equal(rows[0]?.operation, "gh api repos/acme/widgets-c1/pulls/7");
  assert.equal(rows[0]?.repo, "acme/widgets-c1");
  assert.deepEqual((rows[0]?.sources as { source: string }[]).map((entry) => entry.source), [...GITHUB_CREDENTIAL_SOURCE_ORDER]);
  assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(`${REFERENCED}|${AMBIENT}`), "the row carries no credential value");
});

test("W1-T12075 criterion 2: the gh spawns in pr-state, the read broker and the broker client take their environment from the resolver", async (t) => {
  const f = fixture(t);
  const referenced: Overrides = {
    HOME: f.referencedHome, GH_TOKEN: AMBIENT, GITHUB_TOKEN: undefined, [REFERENCE_VAR]: REFERENCED,
    PATH: `${f.stubDir}:${process.env.PATH ?? ""}`, RMD_GH_CACHE_HOME: f.cache, XDG_CACHE_HOME: undefined,
  };
  // Positive control: the resolver itself picks the reference over the ambient token in this environment.
  assert.equal(resolveGithubCredential({ env: withOverrides(process.env, referenced) }).source, "remudero-reference");
  for (const [name, site] of Object.entries(SITES)) {
    const outcome = await site(f, referenced);
    assert.ok(outcome.dump, `${name}: gh ran`);
    assert.equal(gh(outcome.dump, "GH_TOKEN"), REFERENCED, `${name}: gh got the referenced credential, not the ambient one`);
  }

  // No source answers: each site refuses before it spawns, and its caller reads the named sources.
  const missing: Overrides = {
    HOME: f.bareHome, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: f.loggedOut, XDG_CONFIG_HOME: undefined,
    PATH: f.noGhDir, RMD_GH_CACHE_HOME: f.cache, XDG_CACHE_HOME: undefined,
  };
  for (const [name, site] of Object.entries(SITES)) {
    const outcome = await site(f, missing);
    assert.equal(outcome.dump, undefined, `${name}: no gh child ran`);
    assert.notEqual(outcome.code, 0, `${name}: the call failed`);
    assert.match(outcome.report, /no GitHub credential for `gh /, `${name}: the failure names the missing credential`);
    assert.match(outcome.report, /gh-login: gh has no stored login/, `${name}: and the sources it tried`);
  }
  assert.throws(() => ghCredentialChildEnv([...READ], withOverrides(process.env, missing)), GithubCredentialMissingError);

  // A test's own stub gh, found after a PATH entry without one, still runs with no credential, unchanged.
  const stubbed: Overrides = { ...missing, PATH: `${f.noGhDir}:${f.stubDir}` };
  for (const [name, site] of Object.entries(SITES)) {
    const outcome = await site(f, stubbed);
    assert.deepEqual(outcome.dump, control(f, outcome.before), `${name}: the stub ran with the environment it was given`);
  }
});

test("W1-T12075 criterion 3: with an ambient token or a stored gh login and no references file, each spawn receives the same environment as before", async (t) => {
  const f = fixture(t);
  const common: Overrides = {
    HOME: f.bareHome, XDG_CONFIG_HOME: undefined, [REFERENCE_VAR]: undefined,
    PATH: `${f.stubDir}:${process.env.PATH ?? ""}`, RMD_GH_CACHE_HOME: f.cache, XDG_CACHE_HOME: undefined,
  };
  const scenarios: [string, Overrides, string][] = [
    ["ambient token", { ...common, GH_TOKEN: AMBIENT, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: f.loggedOut }, "ambient-env"],
    ["stored gh login", { ...common, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: f.loggedIn }, "gh-login"],
  ];
  for (const [label, overrides, source] of scenarios) {
    // Positive control: the scenario is the one it names, so the comparison below is not vacuous.
    assert.equal(resolveGithubCredential({ env: withOverrides(process.env, overrides) }).source, source, label);
    for (const [name, site] of Object.entries(SITES)) {
      const outcome = await site(f, overrides);
      assert.ok(outcome.dump, `${label}, ${name}: gh ran (${outcome.code}: ${outcome.report})`);
      assert.deepEqual(outcome.dump, control(f, outcome.before), `${label}, ${name}: gh got exactly the environment it got before`);
    }
  }
});
