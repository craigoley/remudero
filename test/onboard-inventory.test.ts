import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
// The DEFAULT export — a plain, mutable object — so `t.mock.method` can actually intercept
// the calls `realOnboardFsDeps` makes (see the import comment atop
// src/lib/onboard/inventory.ts): named bindings off `node:fs` are non-configurable and
// `mock.method`/`defineProperty` against them throws "Cannot redefine property".
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  DEFAULT_DETECTOR_TABLES,
  DEFAULT_DOC_DETECTORS,
  detectPresence,
  KNOWN_ONBOARD_PHASES,
  OnboardError,
  parseOnboardArgs,
  parseOwnerRepoFromRemoteUrl,
  realOnboardFsDeps,
  realOnboardGhGateway,
  resolveTargetOwnerRepo,
  runOnboardInventory,
  type GhExec,
  type Known,
  type OnboardGhGateway,
} from "../src/lib/onboard/inventory.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/onboard/", import.meta.url));
const FIXTURE_REPO_DIR = join(FIXTURES_DIR, "repo");
const FIXTURE_GH_DIR = join(FIXTURES_DIR, "gh");
const EXPECTED_INVENTORY_PATH = join(FIXTURES_DIR, "expected-inventory.json");

const FIXED_NOW = () => new Date("2026-07-23T00:00:00.000Z");

/** A gateway built straight from the COMMITTED fixture gh JSON files under
 *  test/fixtures/onboard/gh/ — mirrors ghIssueListGateway/ghRepoInfo's real
 *  pull_request-filter contract (issues-intake.ts) without ever shelling out to `gh`. */
function fixtureGhGateway(): OnboardGhGateway {
  const repoJson = JSON.parse(readFileSync(join(FIXTURE_GH_DIR, "repo.json"), "utf8")) as { default_branch: string };
  const issuesJson = JSON.parse(readFileSync(join(FIXTURE_GH_DIR, "issues.json"), "utf8")) as Array<{
    state: string;
    pull_request?: unknown;
  }>;
  const milestonesJson = JSON.parse(readFileSync(join(FIXTURE_GH_DIR, "milestones.json"), "utf8")) as unknown[];
  // The committed test/fixtures/onboard/gh/protection.json stands in for a 200 response
  // from the real `.../branches/<branch>/protection` endpoint — its non-empty presence on
  // disk IS the "protected" fact, read here (not hardcoded) so the fixture file is
  // actually load-bearing rather than decorative.
  const protectionJson = JSON.parse(readFileSync(join(FIXTURE_GH_DIR, "protection.json"), "utf8")) as Record<string, unknown>;

  return {
    repoInfo: () => ({ known: true, value: { exists: true, defaultBranch: repoJson.default_branch } }),
    branchProtection: () => ({ known: true, value: Object.keys(protectionJson).length > 0 }),
    openIssueCount: () => ({
      known: true,
      value: issuesJson.filter((i) => i.state === "open" && i.pull_request === undefined).length,
    }),
    milestoneCount: () => ({ known: true, value: milestonesJson.length }),
  };
}

/** A gateway that resolves nothing — every GitHub fact must render as `"unknown"`. */
function darkGhGateway(): OnboardGhGateway {
  const unknown: Known<never> = { known: false };
  return {
    repoInfo: () => unknown,
    branchProtection: () => unknown,
    openIssueCount: () => unknown,
    milestoneCount: () => unknown,
  };
}

// ── acceptance 1: the fixture repo + issues fixture produce the expected inventory JSON ──

test("acceptance 1: the fixture repo (code + ROADMAP.md + issues fixture) produces the expected inventory JSON, byte-stable against the committed fixture", () => {
  const targetDir = tmpRoot("rmd-onboard-inventory-");
  cpSync(FIXTURE_REPO_DIR, targetDir, { recursive: true });

  const { inventory, writtenPath } = runOnboardInventory(
    targetDir,
    { owner: "acme-corp", repo: "widget-fixture" },
    { fs: realOnboardFsDeps, gh: fixtureGhGateway(), now: FIXED_NOW },
  );

  assert.equal(writtenPath, join(targetDir, "plan", "onboarding", "inventory.json"));

  const expected = readFileSync(EXPECTED_INVENTORY_PATH, "utf8");
  const onDisk = readFileSync(writtenPath, "utf8");
  assert.equal(onDisk, expected, "the WRITTEN artifact must be byte-identical to the committed expectation fixture");
  assert.equal(JSON.stringify(inventory, null, 2) + "\n", expected, "the RETURNED inventory object must also match, not just the file");
});

test("acceptance 1: re-running over the same fixture is deterministic (no hidden nondeterminism beyond the injected clock)", () => {
  const dirA = tmpRoot("rmd-onboard-inventory-a-");
  const dirB = tmpRoot("rmd-onboard-inventory-b-");
  cpSync(FIXTURE_REPO_DIR, dirA, { recursive: true });
  cpSync(FIXTURE_REPO_DIR, dirB, { recursive: true });

  const a = buildInventory(dirA, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realOnboardFsDeps, gh: fixtureGhGateway(), now: FIXED_NOW });
  const b = buildInventory(dirB, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realOnboardFsDeps, gh: fixtureGhGateway(), now: FIXED_NOW });
  assert.deepEqual(a, b);
});

// ── acceptance 2: detectors are DATA — a new doc-type row detects with ZERO engine changes ──

test("acceptance 2: adding a row to the doc-detector table flags a seeded file — zero changes to detectPresence/buildInventory", () => {
  const targetDir = tmpRoot("rmd-onboard-extra-detector-");
  writeFileSync(join(targetDir, "CHANGELOG.md"), "# Changelog\n");

  // The engine's DEFAULT table does not know about CHANGELOG.md.
  const withoutRow = detectPresence(targetDir, realOnboardFsDeps, DEFAULT_DOC_DETECTORS);
  assert.ok(!withoutRow.includes("changelog"), "sanity: the default table has no changelog row yet");

  // A caller adds ONE extra row — no edit to detectPresence, DEFAULT_DOC_DETECTORS, or any
  // other engine code — and passes the extended table through the SAME injectable
  // `detectorTables` parameter every other caller uses.
  const extraRow = { id: "changelog", candidates: ["CHANGELOG.md"] };
  const extendedTables = { ...DEFAULT_DETECTOR_TABLES, docs: [...DEFAULT_DOC_DETECTORS, extraRow] };

  const inventory = buildInventory(targetDir, {}, { fs: realOnboardFsDeps, gh: darkGhGateway(), now: FIXED_NOW }, extendedTables);
  assert.equal(inventory.docs.changelog, true, "the new row must fire on the seeded CHANGELOG.md");

  // The unmodified default table run over the SAME directory still doesn't know the row —
  // proving the row (not some other side effect) is what made the difference.
  const defaultInventory = buildInventory(targetDir, {}, { fs: realOnboardFsDeps, gh: darkGhGateway(), now: FIXED_NOW });
  assert.equal(Object.prototype.hasOwnProperty.call(defaultInventory.docs, "changelog"), false);
});

// ── acceptance 3: the phase is read-only against the target — writes land ONLY under plan/onboarding/ ──

test("acceptance 3: injected fs write-spy on the REAL fs module records zero writes outside plan/onboarding/", (t) => {
  const targetDir = tmpRoot("rmd-onboard-write-spy-");
  cpSync(FIXTURE_REPO_DIR, targetDir, { recursive: true });
  const allowedPrefix = join(targetDir, "plan", "onboarding");

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");
  const mkdirSpy = t.mock.method(fsDefault, "mkdirSync");

  runOnboardInventory(targetDir, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realOnboardFsDeps, gh: fixtureGhGateway(), now: FIXED_NOW });

  assert.ok(writeSpy.mock.calls.length > 0, "sanity: the phase must actually write the inventory artifact");

  for (const call of writeSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(target.startsWith(allowedPrefix), `writeFileSync target "${target}" must live under plan/onboarding/`);
  }
  for (const call of renameSpy.mock.calls) {
    const [from, to] = call.arguments as [string, string];
    assert.ok(from.startsWith(allowedPrefix), `renameSync FROM "${from}" must live under plan/onboarding/`);
    assert.ok(to.startsWith(allowedPrefix), `renameSync TO "${to}" must live under plan/onboarding/`);
  }
  for (const call of mkdirSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(target.startsWith(allowedPrefix), `mkdirSync target "${target}" must live under plan/onboarding/`);
  }

  // The artifact itself must exist exactly where reported, and nowhere the fixture repo tree
  // itself provides (i.e. this call must not have touched any of the fixture's own files).
  assert.ok(fsDefault.existsSync(join(allowedPrefix, "inventory.json")));
});

test("acceptance 3: a target with NO owner/repo resolvable still writes only the inventory artifact, every GitHub fact 'unknown'", (t) => {
  // A bare directory with no git remote at all (mkdtemp, not a git checkout) — the target
  // checkout used by this test intentionally carries NO resolvable owner/repo.
  const targetDir = tmpRoot("rmd-onboard-no-remote-");
  writeFileSync(join(targetDir, "README.md"), "# bare\n");
  const allowedPrefix = join(targetDir, "plan", "onboarding");

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");

  const { inventory } = runOnboardInventory(targetDir, {}, { fs: realOnboardFsDeps, gh: darkGhGateway(), now: FIXED_NOW });

  assert.equal(inventory.target.owner, "unknown");
  assert.equal(inventory.target.repo, "unknown");
  assert.equal(inventory.github.repoExists, "unknown");
  assert.equal(inventory.github.defaultBranch, "unknown");
  assert.equal(inventory.github.branchProtected, "unknown");
  assert.equal(inventory.github.openIssueCount, "unknown");
  assert.equal(inventory.github.milestoneCount, "unknown");

  for (const call of writeSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(target.startsWith(allowedPrefix));
  }
});

// ── unknown vs. known-false: a resolved 404-shaped read must NEVER collapse into "unknown" ──

test("a repo known NOT to exist (404) is recorded as false, not 'unknown' — a genuine unresolved read IS 'unknown'", () => {
  const targetDir = tmpRoot("rmd-onboard-404-");
  writeFileSync(join(targetDir, "README.md"), "# x\n");

  const notFoundGateway: OnboardGhGateway = {
    repoInfo: () => ({ known: true, value: { exists: false, defaultBranch: "" } }),
    branchProtection: () => ({ known: false }), // never asked — no default branch to ask about
    openIssueCount: () => ({ known: false }),
    milestoneCount: () => ({ known: false }),
  };

  const inventory = buildInventory(targetDir, { owner: "ghost-org", repo: "ghost-repo" }, { fs: realOnboardFsDeps, gh: notFoundGateway, now: FIXED_NOW });
  assert.equal(inventory.github.repoExists, false, "a 404-shaped repoInfo read IS knowable information — false, never 'unknown'");
  assert.equal(inventory.github.defaultBranch, "unknown", "no default branch to report when the repo doesn't exist");
  assert.equal(inventory.github.branchProtected, "unknown");
});

test("runOnboardInventory refuses (throws OnboardError) when the target directory does not exist — never silently mkdir -p's a fresh tree", (t) => {
  const parentDir = tmpRoot("rmd-onboard-missing-parent-");
  const missingTargetDir = join(parentDir, "does-not-exist");

  const mkdirSpy = t.mock.method(fsDefault, "mkdirSync");
  const writeSpy = t.mock.method(fsDefault, "writeFileSync");

  assert.throws(
    () => runOnboardInventory(missingTargetDir, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realOnboardFsDeps, gh: fixtureGhGateway(), now: FIXED_NOW }),
    (e: unknown) => e instanceof OnboardError && /does not exist/.test((e as Error).message),
  );
  assert.equal(mkdirSpy.mock.calls.length, 0, "must not mkdir anything for a target that was never confirmed to exist");
  assert.equal(writeSpy.mock.calls.length, 0, "must not write anything for a target that was never confirmed to exist");
});

test("an unresolved (dark) GitHub read renders every fact as the literal string 'unknown', never guessed", () => {
  const targetDir = tmpRoot("rmd-onboard-dark-");
  writeFileSync(join(targetDir, "README.md"), "# x\n");

  const inventory = buildInventory(targetDir, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realOnboardFsDeps, gh: darkGhGateway(), now: FIXED_NOW });
  assert.equal(inventory.github.repoExists, "unknown");
  assert.equal(inventory.github.defaultBranch, "unknown");
  assert.equal(inventory.github.branchProtected, "unknown");
  assert.equal(inventory.github.openIssueCount, "unknown");
  assert.equal(inventory.github.milestoneCount, "unknown");
});

// ── owner/repo resolution — pure, path-parameterized ────────────────────────────────────

test("parseOwnerRepoFromRemoteUrl parses both ssh and https remote url shapes", () => {
  assert.deepEqual(parseOwnerRepoFromRemoteUrl("git@github.com:acme-corp/widget-fixture.git"), { owner: "acme-corp", repo: "widget-fixture" });
  assert.deepEqual(parseOwnerRepoFromRemoteUrl("https://github.com/acme-corp/widget-fixture.git"), { owner: "acme-corp", repo: "widget-fixture" });
  assert.deepEqual(parseOwnerRepoFromRemoteUrl("https://github.com/acme-corp/widget-fixture"), { owner: "acme-corp", repo: "widget-fixture" });
  assert.equal(parseOwnerRepoFromRemoteUrl("not-a-url-at-all"), undefined);
});

test("resolveTargetOwnerRepo is injectable — a fake getRemoteUrl proves it never needs a real git repo, and a throw resolves to undefined (never guessed)", () => {
  const ok = resolveTargetOwnerRepo("/some/target", { getRemoteUrl: () => "git@github.com:acme-corp/widget-fixture.git" });
  assert.deepEqual(ok, { owner: "acme-corp", repo: "widget-fixture" });

  const fails = resolveTargetOwnerRepo("/some/target", {
    getRemoteUrl: () => {
      throw new Error("no such remote");
    },
  });
  assert.equal(fails, undefined);
});

// ── CLI arg parsing: fail loud, before any work ──────────────────────────────────────────

test("parseOnboardArgs requires <target-dir> as the first positional argument", () => {
  const result = parseOnboardArgs(["--phase", "inventory"]);
  assert.equal(result.ok, false);
});

test("parseOnboardArgs requires --phase", () => {
  const result = parseOnboardArgs(["/some/dir"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /--phase is required/);
});

test("parseOnboardArgs rejects an unknown --phase value loudly — phases 2-4 are not yet built", () => {
  const result = parseOnboardArgs(["/some/dir", "--phase", "recon"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /--phase must be one of/);
    assert.match(result.error, /W1-T83\/84\/85/);
  }
});

test("parseOnboardArgs rejects an unrecognized flag", () => {
  const result = parseOnboardArgs(["/some/dir", "--phase", "inventory", "--bogus"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unrecognized argument/);
});

test("parseOnboardArgs accepts --owner/--repo overrides and the sole known phase", () => {
  const result = parseOnboardArgs(["/some/dir", "--phase", "inventory", "--owner", "acme-corp", "--repo", "widget-fixture"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.args, { targetDir: "/some/dir", phase: "inventory", owner: "acme-corp", repo: "widget-fixture" });
  }
  assert.deepEqual(KNOWN_ONBOARD_PHASES, ["inventory"]);
});

// ── realOnboardGhGateway — the REAL `gh api` gateway, via its injectable `opts.exec` seam ──
//
// Mirrors status.ts's `ghGateway(owner, repo, { exec })` pattern (W1-T119): a fake `exec`
// stands in for the actual `gh` subprocess, so every branch of ghRepoInfo/ghBranchProtection/
// ghOpenIssueCount/ghMilestoneCount (success, a knowable 404, and a genuinely unresolved
// failure) is exercised deterministically, with NO real `gh` invocation and no network call.

/** A fake `GhExec` that throws a `{stderr}`-shaped error carrying an HTTP status, the same
 *  shape `gh`'s own "gh: <message> (HTTP <code>)" stderr line takes. */
function throwingExec(stderr: string): GhExec {
  return () => {
    throw { stderr };
  };
}

test("realOnboardGhGateway().repoInfo: a 200 resolves known:true with the repo's default_branch", () => {
  const exec: GhExec = () => JSON.stringify({ default_branch: "trunk" });
  const gateway = realOnboardGhGateway({ exec });
  assert.deepEqual(gateway.repoInfo("acme-corp", "widget"), { known: true, value: { exists: true, defaultBranch: "trunk" } });
});

test("realOnboardGhGateway().repoInfo: a 404 resolves known:true, exists:false (knowable, not unknown)", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: Not Found (HTTP 404)") });
  assert.deepEqual(gateway.repoInfo("ghost-org", "ghost-repo"), { known: true, value: { exists: false, defaultBranch: "" } });
});

test("realOnboardGhGateway().repoInfo: a non-404 failure (auth/network) resolves known:false", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: authentication required") });
  assert.deepEqual(gateway.repoInfo("acme-corp", "widget"), { known: false });
});

test("realOnboardGhGateway().branchProtection: a 200 resolves known:true, value:true", () => {
  const exec: GhExec = () => "{}";
  const gateway = realOnboardGhGateway({ exec });
  assert.deepEqual(gateway.branchProtection("acme-corp", "widget", "main"), { known: true, value: true });
});

test("realOnboardGhGateway().branchProtection: a 404 resolves known:true, value:false (not protected IS knowable)", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: Branch not protected (HTTP 404)") });
  assert.deepEqual(gateway.branchProtection("acme-corp", "widget", "main"), { known: true, value: false });
});

test("realOnboardGhGateway().branchProtection: a non-404 failure resolves known:false, never guessed", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: rate limit exceeded") });
  assert.deepEqual(gateway.branchProtection("acme-corp", "widget", "main"), { known: false });
});

test("realOnboardGhGateway().openIssueCount: filters pull requests out of the issues-list response, same contract as issues-intake.ts", () => {
  const exec: GhExec = () => JSON.stringify([{ number: 1 }, { number: 2, pull_request: {} }, { number: 3 }]);
  const gateway = realOnboardGhGateway({ exec });
  assert.deepEqual(gateway.openIssueCount("acme-corp", "widget"), { known: true, value: 2 });
});

test("realOnboardGhGateway().openIssueCount: a failed/unparseable read resolves known:false", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: network error") });
  assert.deepEqual(gateway.openIssueCount("acme-corp", "widget"), { known: false });
});

test("realOnboardGhGateway().milestoneCount: counts the milestones array", () => {
  const exec: GhExec = () => JSON.stringify([{ number: 1 }, { number: 2 }]);
  const gateway = realOnboardGhGateway({ exec });
  assert.deepEqual(gateway.milestoneCount("acme-corp", "widget"), { known: true, value: 2 });
});

test("realOnboardGhGateway().milestoneCount: a failed/unparseable read resolves known:false", () => {
  const gateway = realOnboardGhGateway({ exec: throwingExec("gh: network error") });
  assert.deepEqual(gateway.milestoneCount("acme-corp", "widget"), { known: false });
});

test("realOnboardGhGateway with no opts.exec still returns a usable gateway shape (the real execFileSync path is only reachable with a live gh binary)", () => {
  const gateway = realOnboardGhGateway();
  assert.equal(typeof gateway.repoInfo, "function");
  assert.equal(typeof gateway.branchProtection, "function");
  assert.equal(typeof gateway.openIssueCount, "function");
  assert.equal(typeof gateway.milestoneCount, "function");
});

test("OnboardError carries the standard Error name for a bad --phase value", () => {
  const result = parseOnboardArgs(["/some/dir", "--phase", "synthesis"]);
  assert.equal(result.ok, false);
  // Exercised indirectly (parseOnboardArgs catches it internally) — this asserts the class
  // itself is exported and usable like project-init.ts's ProjectInitError.
  const e = new OnboardError("x");
  assert.equal(e.name, "OnboardError");
  assert.ok(e instanceof Error);
});
