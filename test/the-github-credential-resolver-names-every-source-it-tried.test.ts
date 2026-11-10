import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { fixedClock } from "#src/lib/clock.js";
import {
  GITHUB_CREDENTIAL_ALL_REPOS,
  GITHUB_CREDENTIAL_MISSING_ROW_GAP_MS,
  GITHUB_CREDENTIAL_MISSING_STEP,
  GITHUB_CREDENTIAL_REFERENCES_FILENAME,
  GITHUB_CREDENTIAL_SOURCE_ORDER,
  GithubCredentialMissingError,
  githubRepoOfGhArgv,
  installGithubCredentialMissingSink,
  parseGithubCredentialReferences,
  resolveGithubCredential,
  type GithubCredentialReference,
} from "#src/lib/github-credential.js";
import { ghExec } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { main } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";

// W1-T11926. On 2026-11-09 a review run computed PASS and could not post it: its process had no
// GH_TOKEN, and gh answered with its own login hint, which names no cause. These tests hold the rule
// that one resolver picks the credential for every gh child, in a fixed order, and names every source
// it tried when none answers. Every credential value below is made up.

const REPO = "acme/widgets";
const REPO_VALUE = "test-token-A";
const WIDE_VALUE = "test-token-B";
const AMBIENT_VALUE = "test-token-C";
const OTHER_REPO_VALUE = "test-token-D";
const ALL_VALUES = [REPO_VALUE, WIDE_VALUE, AMBIENT_VALUE, OTHER_REPO_VALUE];

interface Fixture {
  root: string;
  home: string;
  stateDir: string;
  ghConfigDir: string;
  /** An environment with no credential in it. Tests add the sources they want. */
  env: NodeJS.ProcessEnv;
  writeReferences(references: GithubCredentialReference[]): void;
  storeGhLogin(): void;
  ledgerRows(): Array<Record<string, unknown>>;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}github-credential-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stateDir = join(root, "remudero", "state");
  const ghConfigDir = join(root, "gh-config");
  for (const dir of [join(home, ".config", "remudero"), stateDir, ghConfigDir]) mkdirSync(dir, { recursive: true });
  // The resolver sits below the ledger in the import graph, so the process entry point installs the
  // ledger writer. This is the same wiring, with the real writer and a ledger in the temp dir.
  installGithubCredentialMissingSink((row) => appendLedger(join(stateDir, LEDGER_FILENAME), row));
  t.after(() => installGithubCredentialMissingSink(undefined));
  // The transport finds the state directory through this file, as the rest of the harness does.
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: join(root, "remudero") }));
  return {
    root,
    home,
    stateDir,
    ghConfigDir,
    env: { HOME: home, GH_CONFIG_DIR: ghConfigDir, PATH: "/usr/bin:/bin" },
    writeReferences: (references) =>
      writeFileSync(join(stateDir, GITHUB_CREDENTIAL_REFERENCES_FILENAME), JSON.stringify({ references })),
    storeGhLogin: () => writeFileSync(join(ghConfigDir, "hosts.yml"), "github.com:\n    user: test-user\n"),
    ledgerRows: () => {
      let text = "";
      try {
        text = readFileSync(join(stateDir, LEDGER_FILENAME), "utf8");
      } catch {
        return [];
      }
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** Everything a caller, a logger or a ledger row could read from `value`, as one string. */
function everythingReadable(value: unknown): string {
  return `${inspect(value, { depth: null, showHidden: true, getters: true })}\n${JSON.stringify(value)}`;
}

function assertCarriesNoValue(value: unknown, what: string): void {
  const text = everythingReadable(value);
  for (const secret of ALL_VALUES) assert.ok(!text.includes(secret), `${what} must not carry a credential value`);
}

test("W1-T11926 criterion 1: the resolver returns the first source that answers, in order, by name only", (t) => {
  const f = fixture(t);
  assert.deepEqual([...GITHUB_CREDENTIAL_SOURCE_ORDER], ["repo-reference", "remudero-reference", "ambient-env", "gh-login"]);
  f.writeReferences([
    { scope: GITHUB_CREDENTIAL_ALL_REPOS, kind: "env", name: "TEST_WIDE_CREDENTIAL" },
    { scope: REPO, kind: "env", name: "TEST_REPO_CREDENTIAL" },
  ]);
  f.storeGhLogin();
  const env: NodeJS.ProcessEnv = {
    ...f.env,
    TEST_REPO_CREDENTIAL: REPO_VALUE,
    TEST_WIDE_CREDENTIAL: WIDE_VALUE,
    GH_TOKEN: AMBIENT_VALUE,
  };
  const resolve = () => resolveGithubCredential({ env, repo: REPO, stateDir: f.stateDir });

  // Each step removes the source that just answered, so the next one in the order must answer.
  const perRepo = resolve();
  assert.equal(perRepo.source, "repo-reference");
  assert.equal(perRepo.childEnv(env)?.GH_TOKEN, REPO_VALUE, "the gh child receives the per-repo credential");
  assert.deepEqual(perRepo.tried, []);
  assertCarriesNoValue(perRepo, "a resolution");
  assert.deepEqual(Object.keys(perRepo).sort(), ["childEnv", "source", "tried"]);

  delete env.TEST_REPO_CREDENTIAL;
  const wide = resolve();
  assert.equal(wide.source, "remudero-reference");
  assert.equal(wide.childEnv(env)?.GH_TOKEN, WIDE_VALUE, "the gh child receives the remudero-wide credential");
  assert.deepEqual(wide.tried.map((attempt) => attempt.source), ["repo-reference"]);
  assertCarriesNoValue(wide, "a resolution");

  delete env.TEST_WIDE_CREDENTIAL;
  const ambient = resolve();
  assert.equal(ambient.source, "ambient-env");
  assert.equal(ambient.childEnv(env), env, "an ambient credential leaves the child's environment as it was");
  assert.equal(ambient.childEnv(undefined), undefined, "a child that inherited its environment still inherits it");
  assert.deepEqual(ambient.tried.map((attempt) => attempt.source), ["repo-reference", "remudero-reference"]);
  assertCarriesNoValue(ambient, "a resolution");

  delete env.GH_TOKEN;
  const login = resolve();
  assert.equal(login.source, "gh-login");
  assert.equal(login.childEnv(env), env);
  assert.deepEqual(login.tried.map((attempt) => attempt.source), ["repo-reference", "remudero-reference", "ambient-env"]);
});

test("W1-T11926 criterion 1: a call for another repository skips the per-repo reference", (t) => {
  const f = fixture(t);
  f.writeReferences([{ scope: REPO, kind: "env", name: "TEST_REPO_CREDENTIAL" }]);
  const env = { ...f.env, TEST_REPO_CREDENTIAL: REPO_VALUE, GITHUB_TOKEN: AMBIENT_VALUE };
  assert.equal(resolveGithubCredential({ env, repo: "acme/gadgets", stateDir: f.stateDir }).source, "ambient-env");
  assert.equal(resolveGithubCredential({ env, stateDir: f.stateDir }).source, "ambient-env");
  assert.equal(resolveGithubCredential({ env, repo: "ACME/Widgets", stateDir: f.stateDir }).source, "repo-reference");
});

test("W1-T11926 criterion 2: no source answers, so the error names all four sources and one ledger row is written", (t) => {
  const f = fixture(t);
  const missingFile = join(f.root, "no-such-credential-file");
  f.writeReferences([
    { scope: REPO, kind: "file", name: missingFile },
    { scope: GITHUB_CREDENTIAL_ALL_REPOS, kind: "env", name: "TEST_WIDE_CREDENTIAL" },
    { scope: "acme/gadgets", kind: "env", name: "TEST_OTHER_CREDENTIAL" },
  ]);
  // A credential for a different repository is set. It must not answer, and must not leak.
  const env = { ...f.env, TEST_OTHER_CREDENTIAL: OTHER_REPO_VALUE };
  const query = { env, repo: REPO, stateDir: f.stateDir, operation: "gh pr review" };

  let thrown: unknown;
  try {
    resolveGithubCredential(query);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof GithubCredentialMissingError, `expected the named error, got ${String(thrown)}`);
  assert.deepEqual(thrown.tried.map((attempt) => attempt.source), [...GITHUB_CREDENTIAL_SOURCE_ORDER]);
  for (const source of GITHUB_CREDENTIAL_SOURCE_ORDER) assert.ok(thrown.message.includes(source), `the message names ${source}`);
  assert.match(thrown.message, /gh pr review/);
  assert.ok(thrown.message.includes(missingFile), "the message names the file that could not be read");
  assert.match(thrown.message, /ENOENT/);
  assert.match(thrown.message, /TEST_WIDE_CREDENTIAL is not set/);
  assert.match(thrown.message, /GH_TOKEN and GITHUB_TOKEN are not set/);
  assert.ok(thrown.message.includes(join(f.ghConfigDir, "hosts.yml")), "the message names where gh keeps a stored login");
  assert.doesNotMatch(thrown.message, /gh auth login/, "the login hint that gh prints is never given as the cause");
  assertCarriesNoValue({ message: thrown.message, details: thrown.details, tried: thrown.tried }, "the error");

  // The same failure again, in the same process, adds no second row.
  assert.throws(() => resolveGithubCredential(query), GithubCredentialMissingError);
  const rows = f.ledgerRows().filter((row) => row.step === GITHUB_CREDENTIAL_MISSING_STEP);
  assert.equal(rows.length, 1, "one github.credential_missing row");
  const row = rows[0]!;
  assert.equal(row.repo, REPO);
  assert.equal(row.operation, "gh pr review");
  assert.deepEqual((row.sources as Array<{ source: string }>).map((attempt) => attempt.source), [...GITHUB_CREDENTIAL_SOURCE_ORDER]);
  assertCarriesNoValue(row, "the ledger row");

  // Once the gap has passed, a failure that still stands is recorded again.
  const later = fixedClock(Date.now() + GITHUB_CREDENTIAL_MISSING_ROW_GAP_MS + 1);
  assert.throws(() => resolveGithubCredential({ ...query, clock: later }), GithubCredentialMissingError);
  assert.equal(f.ledgerRows().filter((r) => r.step === GITHUB_CREDENTIAL_MISSING_STEP).length, 2);
});

test("W1-T11926 criterion 2: a call that needs no credential runs without one and writes no row", (t) => {
  const f = fixture(t);
  const resolution = resolveGithubCredential({ env: f.env, repo: REPO, stateDir: f.stateDir, mayRunWithout: () => true });
  assert.equal(resolution.source, "none");
  assert.equal(resolution.childEnv(f.env), f.env);
  assert.equal(resolution.tried.length, GITHUB_CREDENTIAL_SOURCE_ORDER.length);
  assert.deepEqual(f.ledgerRows(), []);
});

test("W1-T11926 criterion 2: a ledger writer that throws never replaces the named error", (t) => {
  const f = fixture(t);
  installGithubCredentialMissingSink(() => {
    throw new Error("the ledger is not writable");
  });
  assert.throws(() => resolveGithubCredential({ env: f.env, repo: REPO, stateDir: f.stateDir }), GithubCredentialMissingError);
  // With no writer installed the error is the same, and nothing is written.
  installGithubCredentialMissingSink(undefined);
  assert.throws(() => resolveGithubCredential({ env: f.env, stateDir: f.stateDir }), GithubCredentialMissingError);
  assert.deepEqual(f.ledgerRows(), []);
});

test("W1-T11926 criterion 2: the CLI entry point installs the production ledger writer", async (t) => {
  const f = fixture(t);
  // `main()` must install the sink itself. Remove the fixture's test-only writer before entering it.
  installGithubCredentialMissingSink(undefined);
  writeFileSync(join(f.home, ".config", "remudero", "config.json"), JSON.stringify({
    root: join(f.root, "remudero"),
    claudeBin: "/usr/bin/claude",
  }));
  const saved = new Map<string, string | undefined>();
  for (const key of ["HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) saved.set(key, process.env[key]);
  const originalArgv = process.argv;
  process.env.HOME = f.home;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.GH_CONFIG_DIR = f.ghConfigDir;
  delete process.env.XDG_CONFIG_HOME;
  process.argv = ["node", "rmd", "skill", "sink-install-probe"];
  class Exit extends Error {
    constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
  }
  t.mock.method(process, "exit", ((code?: number): never => { throw new Exit(code); }) as typeof process.exit);
  try {
    let caught: unknown;
    await main({
      checkFreshness: () => ({ status: "guarded" }),
      dispatch: async () => {
        assert.throws(
          () => resolveGithubCredential({ env: process.env, repo: REPO, operation: "gh pr review" }),
          GithubCredentialMissingError,
        );
        return 0;
      },
    }).catch((error: unknown) => { caught = error; });
    assert.ok(caught instanceof Exit && caught.code === 0, `expected a clean CLI exit, got ${String(caught)}`);
    const rows = f.ledgerRows().filter((row) => row.step === GITHUB_CREDENTIAL_MISSING_STEP);
    assert.equal(rows.length, 1, "main() writes the missing-credential row through the live ledger writer");
    assert.equal(rows[0]?.operation, "gh pr review");
    assert.equal(rows[0]?.repo, REPO);
    assertCarriesNoValue(rows[0], "the production ledger row");
  } finally {
    process.argv = originalArgv;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    installGithubCredentialMissingSink(undefined);
  }
});

test("W1-T11926 criterion 3: a reference is a scope, a kind and a name, and an unreadable file is a failed source", (t) => {
  const f = fixture(t);
  // The shape a console can write: every scope and kind parses, and nothing else does.
  const written: GithubCredentialReference[] = [
    { scope: GITHUB_CREDENTIAL_ALL_REPOS, kind: "env", name: "TEST_WIDE_CREDENTIAL" },
    { scope: "some-owner/some.repo-2", kind: "file", name: "/run/secrets/some-credential" },
    { scope: REPO, kind: "app", name: "fleet-app" },
  ];
  assert.deepEqual(parseGithubCredentialReferences(JSON.stringify({ references: written })), written);
  for (const bad of [
    "not json",
    JSON.stringify({}),
    JSON.stringify({ references: [{ scope: "no-slash", kind: "env", name: "X" }] }),
    JSON.stringify({ references: [{ scope: REPO, kind: "keychain", name: "X" }] }),
    JSON.stringify({ references: [{ scope: REPO, kind: "env" }] }),
  ]) {
    assert.throws(() => parseGithubCredentialReferences(bad), /references/, `must refuse ${bad}`);
  }

  // A file reference for a scope this test invents resolves, so no scope is built into the code.
  const scope = `owner-${process.pid}/repo-${Date.now()}`;
  const credentialFile = join(f.root, "credential-file");
  writeFileSync(credentialFile, `${REPO_VALUE}\n`);
  f.writeReferences([{ scope, kind: "file", name: credentialFile }]);
  const hit = resolveGithubCredential({ env: f.env, repo: scope, stateDir: f.stateDir });
  assert.equal(hit.source, "repo-reference");
  assert.equal(hit.childEnv(f.env)?.GH_TOKEN, REPO_VALUE, "the file's content is trimmed and handed to the child");
  assertCarriesNoValue(hit, "a resolution");

  // A missing file, a directory, an empty file and an app reference each fail. The next source answers.
  const emptyFile = join(f.root, "empty-credential-file");
  writeFileSync(emptyFile, "\n");
  const env = { ...f.env, GH_TOKEN: AMBIENT_VALUE };
  for (const reference of [
    { scope, kind: "file", name: join(f.root, "no-such-file") },
    { scope, kind: "file", name: f.root },
    { scope, kind: "file", name: emptyFile },
    { scope, kind: "file", name: "relative/credential-file" },
    { scope, kind: "app", name: "fleet-app" },
  ] satisfies GithubCredentialReference[]) {
    f.writeReferences([reference]);
    const fallthrough = resolveGithubCredential({ env, repo: scope, stateDir: f.stateDir });
    assert.equal(fallthrough.source, "ambient-env", `${reference.kind} ${reference.name} must not count as an answer`);
    assert.equal(fallthrough.tried[0]?.source, "repo-reference");
    assert.ok((fallthrough.tried[0]?.reason ?? "").length > 0, "the failed source says why");
  }

  // A references file that does not parse fails both reference sources. It never stops the call.
  writeFileSync(join(f.stateDir, GITHUB_CREDENTIAL_REFERENCES_FILENAME), "{ not json");
  const unparsed = resolveGithubCredential({ env, repo: scope, stateDir: f.stateDir });
  assert.equal(unparsed.source, "ambient-env");
  assert.deepEqual(unparsed.tried.map((attempt) => attempt.source), ["repo-reference", "remudero-reference"]);
});

test("W1-T11926: the repository of a gh call is read from its arguments", () => {
  assert.equal(githubRepoOfGhArgv(["pr", "view", "12", "--repo", REPO]), REPO);
  assert.equal(githubRepoOfGhArgv(["pr", "list", "-R", REPO]), REPO);
  assert.equal(githubRepoOfGhArgv(["pr", "list", `--repo=${REPO}`]), REPO);
  assert.equal(githubRepoOfGhArgv(["api", `repos/${REPO}/pulls?state=open`]), REPO);
  assert.equal(githubRepoOfGhArgv(["api", "-X", "POST", `/repos/${REPO}/statuses/abc`]), REPO);
  assert.equal(githubRepoOfGhArgv(["api", "rate_limit"]), undefined);
  assert.equal(githubRepoOfGhArgv(["pr", "view", "12"]), undefined);
});

test("W1-T11926 criterion 4: the transport hands the resolved credential to the gh child it spawns", (t) => {
  const f = fixture(t);
  // A stand-in gh that prints the credential it was given. It lives in the temp dir and reaches no network.
  const shim = ghShim([{ when: "repos/", stdoutEnv: "GH_TOKEN" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  f.writeReferences([{ scope: REPO, kind: "env", name: "TEST_REPO_CREDENTIAL" }]);
  const env = { ...f.env, PATH: `${shim.dir}:/usr/bin:/bin`, TEST_REPO_CREDENTIAL: REPO_VALUE, GH_TOKEN: AMBIENT_VALUE };

  // Both calls post a commit status, the write the 2026-11-09 review run could not make.
  const forRepo = ghExec(["api", "-X", "POST", `repos/${REPO}/statuses/abc`], { env, encoding: "utf8" });
  assert.equal(forRepo.trim(), REPO_VALUE, "a call for the referenced repository carries the per-repo credential");
  const forOther = ghExec(["api", "-X", "POST", "repos/acme/gadgets/statuses/abc"], { env, encoding: "utf8" });
  assert.equal(forOther.trim(), AMBIENT_VALUE, "a call for another repository keeps the ambient credential");
  assert.equal(env.GH_TOKEN, AMBIENT_VALUE, "the caller's environment is not changed");
  assert.equal(shim.calls().length, 2, "each call spawned gh once");
});

test("W1-T11926 criterion 4: the transport refuses a gh call with no credential before it spawns gh", (t) => {
  const f = fixture(t);
  // No gh on this PATH: a spawn would fail with ENOENT, so the named error proves nothing was spawned.
  const emptyBin = join(f.root, "empty-bin");
  mkdirSync(emptyBin);
  const env = { ...f.env, PATH: emptyBin };
  assert.throws(
    () => ghExec(["pr", "review", "12", "--repo", REPO], { env, encoding: "utf8" }),
    (err: unknown) => {
      assert.ok(err instanceof GithubCredentialMissingError, `expected the named error, got ${String(err)}`);
      assert.match(err.message, /gh pr review/);
      assert.doesNotMatch(err.message, /gh auth login/);
      return true;
    },
  );
  assert.equal(f.ledgerRows().filter((row) => row.step === GITHUB_CREDENTIAL_MISSING_STEP).length, 1);
  // `gh auth status` is how a caller asks where it stands, so it is never refused here.
  assert.throws(() => ghExec(["auth", "status"], { env, encoding: "utf8" }), /ENOENT/);
});
