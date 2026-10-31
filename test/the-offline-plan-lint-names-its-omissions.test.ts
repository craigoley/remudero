/**
 * The pre-push path needs the deterministic part of `lint-plan --base` without paying for, or
 * depending on, GitHub. These tests pin the boundary: local blocking rules still refuse, while
 * the one GitHub-backed blocking rule and GitHub-backed advisories are named as omissions.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { lintPlanCommand } from "#src/run-task.js";
import { parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { defaultCreditOverridePath, defaultCreditStorePath, durableDependencyCredit, invalidateDurableCredit, loadCreditOverrides, loadCreditStore, projectPlan, recordCredit, saveCreditStore, type CreditReadState, type CreditStore, type DeriveDeps, type PrRef, type StatusProjection } from "#src/lib/status.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { withTempDir } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { createHash } from "node:crypto";
import { CI_DEPENDENCY_EVIDENCE_SCHEMA } from "#scripts/lib/ci-dependency-evidence.mjs";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Operator resource contract: a cold child must also finish within this bound.
const OFFLINE_CHILD_TIMEOUT_MS = 20_000;
const FIXTURE_IDENTITY = { name: "remudero offline lint fixture", email: "fixture@remudero.invalid" };

// Native-format PRIVATE cache/release fixtures confer no live credit or authority.
const CREDIT_CHILD = "ZZ-T2", CREDIT_DEP = "ZZ-T1", CREDIT_GRANDPARENT = "ZZ-T0";
const CREDIT_PR = "https://github.com/fixture-owner/remudero/pull/17";

function creditTaskYaml(id: string, depends: readonly string[], note: string, machine = false,
  files: readonly string[] = ["src/value.ts"]): string {
  const text = [
    "- id: " + id, '  title: "dependency credit fixture ' + id + '"', "  repo: remudero",
    "  depends_on: [" + depends.join(", ") + "]", "  type: implement", "  verify: auto",
    "  risk: low", "  status: queued", "  attempts: 0", "  budget_usd: 1",
    '  origin: "test-fixture:offline-dependency-credit"',
    ...(machine ? ["  author_class: machine"] : []),
    "  files: [" + files.join(", ") + "]", "  note: " + JSON.stringify(note),
    "  acceptance:", '    - claim: "the fixture proof is resolvable"',
    '      proof: "unit test: test/fixture.test.ts"', "",
  ].join("\n");
  if (!machine) return text;
  const pin = taskRulingPin(parseTasksFromYaml(text, "private fixture")[0]!);
  return text + [
    "  risk_ruling:", '    verdict: "operator"', '    action: "proceed"', "    confidence: 1",
    '    reasons: ["synthetic fixture release only; not real operator authority"]',
    '    judged_at: "2026-10-18T00:00:00Z"', '    pin: "' + pin + '"', "",
  ].join("\n");
}

interface OfflineSpawnFailure { case: string; errorCode: string; signal: NodeJS.Signals | null; status: number | null }

interface DependencyCreditFixture {
  root: string; env: NodeJS.ProcessEnv; base: string; configFile: string; cacheFile: string; overrideFile: string; ledgerFile: string;
  store: (value: CreditStore) => void; config: (value: string | undefined) => void;
  overrides: (value: string) => void;
  child: (depends: readonly string[]) => void;
  offline: () => { code: number | null; output: string };
}

async function withDependencyCreditFixture(
  t: TestContext, run: (f: DependencyCreditFixture) => void | Promise<void>,
  sharedSurface = false,
  onSpawnFailure?: (failure: OfflineSpawnFailure) => void,
  transformCache?: string,
): Promise<void> {
  await withTempDir("offline-dependency-credit", async dir => {
    const checkout = gitRepo({ scope: t, seedCommit: false, kind: "offline-dependency-credit" });
    const root = checkout.dir, home = join(dir, "home"), stateRoot = join(dir, "instance");
    for (const path of [join(root, "plan/tasks.d"), join(root, "src"), join(root, "test"), home, join(dir, "tmp")]) {
      mkdirSync(path, { recursive: true });
    }
    // tsx 4.23.15 keys transformed code by source/options/version in TMPDIR/tsx-<euid>.
    // Share only that cache inside this one proof; every child keeps its own process and scratch.
    if (transformCache !== undefined) {
      symlinkSync(transformCache, join(dir, "tmp", `tsx-${process.geteuid?.() ?? userInfo().username}`), "dir");
    }
    const tripwires = [
      { command: "GitHub CLI", shim: ghShim([{ when: "", exit: 99 }], { kind: "lint-credit-tripwire" }) },
      ...["which", "ssh", "curl"].map(command => ({ command,
        shim: ghShim([{ when: "", exit: 99 }], { kind: "lint-credit-tripwire", command }) })),
    ];
    t.after(() => { for (const { shim } of tripwires) rmSync(shim.dir, { recursive: true, force: true }); });
    const env: NodeJS.ProcessEnv = {
      HOME: home, TMPDIR: join(dir, "tmp"), PATH: [...tripwires.map(({ shim }) => shim.dir), process.env.PATH ?? ""].join(":"),
      LANG: "C", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
      // Preserve only native coverage output routing, not credentials or admission-bypass variables.
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    };
    checkout.addRemote("origin", "https://github.com/fixture-owner/remudero.git");
    writeFileSync(join(root, "src/value.ts"), "export const fixtureValue = 1;\n");
    if (sharedSurface) {
      writeFileSync(join(root, "src/neighbor.ts"), "export const fixtureNeighbor = 1;\n");
      writeFileSync(join(root, "src/grandparent.ts"), "export const fixtureGrandparent = 1;\n");
    }
    writeFileSync(join(root, "test/fixture.test.ts"), 'import {test} from "node:test"; test("fixture proof", () => {});\n');
    writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
    const files = sharedSurface ? ["src/value.ts", "src/neighbor.ts"] : ["src/value.ts"];
    writeFileSync(join(root, "plan/tasks.d/ZZ-T0.yaml"), creditTaskYaml(CREDIT_GRANDPARENT, [], "base", false,
      sharedSurface ? ["src/grandparent.ts"] : files));
    writeFileSync(join(root, "plan/tasks.d/ZZ-T1.yaml"), creditTaskYaml(CREDIT_DEP, [CREDIT_GRANDPARENT], "base", false, files));
    const child = (depends: readonly string[], note = "changed fixture narrative") =>
      writeFileSync(join(root, "plan/tasks.d/ZZ-T2.yaml"), creditTaskYaml(CREDIT_CHILD, depends, note, true, files));
    child([CREDIT_DEP], "base fixture narrative");
    checkout.git("add", "plan", "src", "test"); checkout.git("commit", "-qm", "test: seed private dependency fixture");
    const base = checkout.git("rev-parse", "HEAD");
    child([CREDIT_DEP]);
    const configFile = join(home, ".config/remudero/config.json");
    mkdirSync(dirname(configFile), { recursive: true });
    // Omit claudeBin: a read-only credit consumer must NOT enter loadConfig().
    writeFileSync(configFile, JSON.stringify({ root: stateRoot }) + "\n");
    const cacheFile = defaultCreditStorePath(join(stateRoot, "state/ledger.ndjson"));
    const overrideFile = defaultCreditOverridePath(join(stateRoot, "state/ledger.ndjson"));
    const maybe = (path: string) => existsSync(path) ? statSync(path).isFile() ? readFileSync(path, "utf8") : "<private non-file fixture>" : undefined;
    const offline = () => {
      const before = [maybe(configFile), maybe(cacheFile), maybe(overrideFile)];
      const startedAt = performance.now();
      const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
        join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), "--base", base], {
        cwd: root, env, encoding: "utf8", timeout: OFFLINE_CHILD_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
      });
      t.diagnostic(JSON.stringify({ offlineChildElapsedMs: Math.round(performance.now() - startedAt), sharedTransformCache: transformCache !== undefined }));
      if (r.error !== undefined || r.signal !== null) {
        const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
        const failure: OfflineSpawnFailure = { case: t.name.slice(0, 128),
          errorCode: typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : "unknown",
          signal: r.signal, status: r.status };
        t.diagnostic(JSON.stringify({ offlineSpawnFailure: failure }));
        onSpawnFailure?.(failure);
      }
      assert.equal(r.error, undefined, "the actual offline child must complete"); assert.equal(r.signal, null);
      assert.deepEqual(tripwires.flatMap(({ command, shim }) => shim.calls().map(call => command + " " + call)), [],
        "offline default must not call network tools or which claude");
      assert.deepEqual([maybe(configFile), maybe(cacheFile), maybe(overrideFile)], before, "no default config/credit/override creation or mutation");
      const output = r.stdout + "\n" + r.stderr;
      t.diagnostic(JSON.stringify({ code: r.status, output }));
      return { code: r.status, output };
    };
    await run({
      root, env, base, configFile, cacheFile, overrideFile, ledgerFile: join(stateRoot, "state/ledger.ndjson"),
      child: depends => child(depends), offline,
      store: value => saveCreditStore(cacheFile, value),
      config: value => value === undefined ? rmSync(configFile) : writeFileSync(configFile, value),
      overrides: value => { mkdirSync(dirname(overrideFile), { recursive: true }); writeFileSync(overrideFile, value); },
    });
  });
}

test("lint dependency credit: transform reuse keeps child runtime and scratch independent", async t => {
  assert.equal(OFFLINE_CHILD_TIMEOUT_MS, 20_000, "the operator's child budget is unchanged");
  await withTempDir("offline-lint-transform-cache-control", async cache => {
    const homes: string[] = [], temporaryRoots: string[] = [];
    const run = async (credit: boolean) => withDependencyCreditFixture(t, f => {
      homes.push(f.env.HOME!); temporaryRoots.push(f.env.TMPDIR!);
      const link = join(f.env.TMPDIR!, `tsx-${process.geteuid?.() ?? userInfo().username}`);
      assert.equal(realpathSync(link), realpathSync(cache));
      if (credit) f.store(nativeFixtureCredit());
      const result = f.offline();
      assert.equal(result.code, credit ? 0 : 1, result.output);
      if (!credit) assert.match(result.output, /credit.*(?:unknown|unavailable|unobservable)/i);
      assert.ok(readdirSync(cache).length > 0, "the actual tsx child populated the proof-owned transform cache");
    }, false, undefined, cache);
    await run(true); await run(false);
    assert.equal(new Set(homes).size, 2, "HOME/config authority is not reused");
    assert.equal(new Set(temporaryRoots).size, 2, "runtime temp roots are not reused");
  });
});

function nativeFixtureCredit(
  source: "trailer" | "head-branch" = "trailer", prUrl = CREDIT_PR, prState = "MERGED", id = CREDIT_DEP,
): CreditStore {
  return recordCredit({}, id, { source, prUrl, prNumber: 17, prState });
}

test("lint dependency credit: no-dependency default-entry control stays clean", async t => {
  await withDependencyCreditFixture(t, f => {
    f.child([]);
    assert.equal(f.offline().code, 0, "the private plan has no unrelated lint refusal");
  });
});

test("CI dependency receipt: actual offline CLI accepts only same-run evidence without native credit or network", async t => {
  await withDependencyCreditFixture(t, f => {
    f.config(undefined);
    execFileSync("git", ["add", "plan"], { cwd: f.root, env: f.env });
    execFileSync("git", ["commit", "-qm", "test: commit private CI candidate"], { cwd: f.root, env: f.env });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, env: f.env, encoding: "utf8" }).trim();
    const runnerTemp = join(dirname(f.root), "ci-receipt-" + process.pid);
    mkdirSync(runnerTemp);
    t.after(() => rmSync(runnerTemp, { recursive: true, force: true }));
    const path = join(runnerTemp, "evidence.json");
    const payload = { schema: CI_DEPENDENCY_EVIDENCE_SCHEMA, complete: true,
      repository: "fixture-owner/remudero", head, base: f.base, producerSha: f.base,
      runId: "123", attempt: "1", producerJob: "commitlint", observedAtMs: Date.now(),
      taskIds: [CREDIT_DEP], credits: nativeFixtureCredit(), overrides: [] };
    const bytes = Buffer.from(JSON.stringify(payload)); writeFileSync(path, bytes, { mode: 0o400 });
    Object.assign(f.env, { GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: f.root, RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: "fixture-owner/remudero", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
      RMD_CI_DEPENDENCY_EVIDENCE: path, RMD_CI_DEPENDENCY_PRODUCER_SHA: f.base,
      RMD_CI_DEPENDENCY_DIGEST: createHash("sha256").update(bytes).digest("hex") });
    const accepted = f.offline(); assert.equal(accepted.code, 0, accepted.output);
    assert.equal(existsSync(f.cacheFile), false, "no durable native credit created");
    assert.equal(existsSync(f.configFile), false, "no native runtime config created");
    f.env.GITHUB_RUN_ATTEMPT = "2";
    const wrongRun = f.offline(); assert.equal(wrongRun.code, 1, wrongRun.output);
    assert.match(wrongRun.output, /UNKNOWN/);
    assert.equal(existsSync(f.cacheFile), false);
  });
});

for (const source of ["trailer", "head-branch"] as const) {
  test("lint dependency credit: actual offline default accepts same-repo native " + source + " credit", async t => {
    await withDependencyCreditFixture(t, f => {
      f.store(nativeFixtureCredit(source));
      const result = f.offline();
      assert.equal(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /unmerged dependencies/);
    });
  });
}

const closedCreditCases: Array<{
  name: string; seed: (f: DependencyCreditFixture) => void; reason: RegExp;
}> = [
  { name: "missing store", seed: () => {}, reason: /missing|absent|not found/i },
  { name: "corrupt store", seed: f => {
    mkdirSync(dirname(f.cacheFile), { recursive: true }); writeFileSync(f.cacheFile, "{");
  }, reason: /corrupt|invalid.*json|parse/i },
  { name: "unreadable nonmissing store", seed: f => mkdirSync(f.cacheFile, { recursive: true }), reason: /store.*unreadable/i },
  { name: "malformed top-level store", seed: f => {
    mkdirSync(dirname(f.cacheFile), { recursive: true }); writeFileSync(f.cacheFile, "[]");
  }, reason: /store.*malformed|expected.*object/i },
  { name: "unknown dependency", seed: f => f.store({}), reason: /no.*credit|not.*found|absent|missing/i },
  { name: "unrelated cache entry", seed: f => f.store(nativeFixtureCredit("trailer", CREDIT_PR, "MERGED", "ZZ-T99")),
    reason: /no.*credit|not.*found|absent|missing/i },
  { name: "wrong owner", seed: f => f.store(nativeFixtureCredit("trailer", "https://github.com/other-owner/remudero/pull/17")),
    reason: /repository|repo.*mismatch|wrong.*repo/i },
  { name: "wrong repository", seed: f => f.store(nativeFixtureCredit("trailer", "https://github.com/fixture-owner/other-repo/pull/17")),
    reason: /repository|repo.*mismatch|wrong.*repo/i },
  { name: "wrong host", seed: f => f.store(nativeFixtureCredit("trailer", "https://foreign.invalid/fixture-owner/remudero/pull/17")),
    reason: /host|repository|repo.*mismatch/i },
  { name: "stored OPEN is not positive merge credit", seed: f => f.store(nativeFixtureCredit("trailer", CREDIT_PR, "OPEN")),
    reason: /OPEN|non.?merged|invalid.*state/i },
  { name: "malformed credit entry", seed: f => f.store({ [CREDIT_DEP]: { trailer: { source: "trailer" } } } as unknown as CreditStore),
    reason: /malformed|invalid|missing.*field/i },
  { name: "PR number and URL disagree", seed: f => f.store(nativeFixtureCredit("trailer", CREDIT_PR.replace("/17", "/18"))),
    reason: /number|mismatch|invalid/i },
  { name: "quarantined native entry", seed: f => f.store(invalidateDurableCredit(nativeFixtureCredit(), CREDIT_DEP, "trailer", {
    prUrl: CREDIT_PR, prNumber: 17, reason: "durable-credit-plan-only",
  })), reason: /quarantin|invalidat|plan.only/i },
  { name: "configured root does not borrow another instance store", seed: f => {
    f.store(nativeFixtureCredit()); f.config(JSON.stringify({ root: join(f.root, "other-instance") }));
  }, reason: /missing|absent|not.*found|root/i },
  { name: "missing config", seed: f => f.config(undefined), reason: /instance config absent/i },
  { name: "unreadable nonmissing config", seed: f => { f.config(undefined); mkdirSync(f.configFile); }, reason: /instance config unreadable/i },
  { name: "corrupt config", seed: f => f.config("{"), reason: /instance config could not be decoded/i },
  { name: "relative configured root", seed: f => { f.store(nativeFixtureCredit()); f.config(JSON.stringify({ root: "relative-instance" })); }, reason: /config|root|absolute/i },
  { name: "same-PR remove-credit override", seed: f => { f.store(nativeFixtureCredit()); f.overrides(removedCreditYaml()); }, reason: /override|removed/i },
  { name: "malformed override YAML", seed: f => { f.store(nativeFixtureCredit()); f.overrides("{"); }, reason: /override.*corrupt|invalid.*YAML/i },
  { name: "malformed override shape", seed: f => { f.store(nativeFixtureCredit()); f.overrides("{}"); }, reason: /override.*malformed|array/i },
  { name: "refused override row", seed: f => { f.store(nativeFixtureCredit()); f.overrides('[{"action":"grant-credit"}]'); }, reason: /override.*invalid|refused|malformed/i },
  { name: "unreadable nonmissing override", seed: f => { f.store(nativeFixtureCredit()); mkdirSync(f.overrideFile, { recursive: true }); }, reason: /override.*unreadable/i },
  { name: "malformed invalidation container", seed: f => f.store({ [CREDIT_DEP]: { ...nativeFixtureCredit()[CREDIT_DEP], invalidated: [] } } as unknown as CreditStore), reason: /invalidat|quarantin/i },
  { name: "malformed invalidation mark", seed: f => f.store({ [CREDIT_DEP]: { ...nativeFixtureCredit()[CREDIT_DEP], invalidated: { trailer: { prUrl: CREDIT_PR } } } } as unknown as CreditStore), reason: /invalidat|quarantin/i },
];

function removedCreditYaml(): string {
  return JSON.stringify([{ task: CREDIT_DEP, pr: 17, action: "remove-credit", reason: "private subtract-only fixture", author_class: "operator" }]);
}

test("lint dependency credit: a valid independent sibling survives subtract-only override or quarantine", async t => {
  for (const exclusion of ["override", "quarantine"] as const) await t.test(exclusion, async child => {
    await withDependencyCreditFixture(child, f => {
      const store = exclusion === "quarantine" ? invalidateDurableCredit(nativeFixtureCredit(), CREDIT_DEP, "trailer", {
        prUrl: CREDIT_PR, prNumber: 17, reason: "durable-credit-plan-only",
      }) : nativeFixtureCredit();
      f.store(recordCredit(store, CREDIT_DEP, { source: "head-branch", prUrl: CREDIT_PR.replace("/17", "/18"), prNumber: 18, prState: "MERGED" }));
      if (exclusion === "override") f.overrides(removedCreditYaml());
      assert.equal(f.offline().code, 0);
    });
  });
});

test("lint dependency credit: no-dependency admission needs no config or cache authority", async t => {
  await withDependencyCreditFixture(t, f => {
    f.child([]); f.config(undefined);
    assert.equal(f.offline().code, 0);
  });
});

test("lint dependency credit: native eligibility refuses URL confusion and malformed source identities", () => {
  for (const url of [CREDIT_PR.replace("https:", "http:"), CREDIT_PR.replace("github.com", "user@github.com"),
    CREDIT_PR + "?x=1", CREDIT_PR + "#fragment", CREDIT_PR + "/files", CREDIT_PR.replace("/pull/", "/issues/"),
    CREDIT_PR.replace("fixture-owner", "%66ixture-owner"), CREDIT_PR.replace("/17", "/017")]) {
    const read = durableDependencyCredit(nativeFixtureCredit("trailer", url), CREDIT_DEP, "fixture-owner/remudero", []);
    assert.equal(read.state, "unknown", url);
  }
  for (const record of [null, [], { trailer: { ...nativeFixtureCredit()[CREDIT_DEP]!.trailer!, source: "head-branch" } },
    { trailer: { ...nativeFixtureCredit()[CREDIT_DEP]!.trailer!, prNumber: 0 } },
    { trailer: { ...nativeFixtureCredit()[CREDIT_DEP]!.trailer!, prNumber: 1.5 } },
    { correction: { prUrl: CREDIT_PR }, backfillReceipt: { source: "sweep.credit_backfill", prUrl: CREDIT_PR, prNumber: 17 } }]) {
    assert.equal(durableDependencyCredit({ [CREDIT_DEP]: record } as CreditStore, CREDIT_DEP, "fixture-owner/remudero", []).state, "unknown");
  }
  const quarantined = invalidateDurableCredit(nativeFixtureCredit(), CREDIT_DEP, "trailer", {
    prUrl: CREDIT_PR, prNumber: 17, reason: "durable-credit-plan-only",
  });
  quarantined[CREDIT_DEP]!.trailer!.prUrl = CREDIT_PR.replace("fixture-owner", "FIXTURE-OWNER");
  assert.equal(durableDependencyCredit(quarantined, CREDIT_DEP, "fixture-owner/remudero", []).state, "unknown", "the same quarantined PR cannot recover through URL case variation");
});

test("lint dependency credit: opt-in native read states do not change permissive return contracts", () => {
  const observed: CreditReadState[] = [];
  assert.deepEqual(loadCreditOverrides(() => "{", state => observed.push(state)), { rows: [], refused: [] });
  assert.equal(observed[0]?.state, "corrupt");
  assert.deepEqual(loadCreditOverrides(() => { throw Object.assign(new Error("private missing fixture"), { code: "ENOENT" }); }, state => observed.push(state)), { rows: [], refused: [] });
  assert.equal(observed[1]?.state, "missing");
  assert.deepEqual(loadCreditStore("unused-private-fixture", { existsSync: () => false } as never, state => observed.push(state)), {});
  // existsSync(false) does not distinguish absence from inaccessible ancestors. API semantics,
  // not a reproduced permission error; the ordinary permissive {} result is unchanged.
  assert.deepEqual(observed[2], { state: "unavailable", reason: "merge credit store missing or inaccessible" });
  assert.deepEqual(loadCreditStore("unused-private-fixture", { existsSync: () => false } as never), {});
});

test("lint dependency credit: actual native store reads distinguish unreadable corrupt malformed and present", async () => {
  await withTempDir("credit-store-read-states", dir => {
    const path = join(dir, "merge-credit.json");
    const read = () => {
      let state: CreditReadState | undefined;
      const store = loadCreditStore(path, undefined, value => { state = value; });
      assert.deepEqual(store, {});
      return state;
    };
    mkdirSync(path);
    assert.equal(read()?.state, "unreadable", "a directory triggers a real read error, not a permission simulation");
    rmSync(path, { recursive: true });
    for (const text of ["{", "[]", "null"]) {
      writeFileSync(path, text); assert.equal(read()?.state, "corrupt");
    }
    writeFileSync(path, "{}"); assert.equal(read()?.state, "present");
  });
});

// Keep every negative fixture in its original order, once, across independently executable proofs.
const closedCreditCaseParts = [
  ["missing store", "corrupt store", "unreadable nonmissing store", "malformed top-level store",
    "unknown dependency", "unrelated cache entry", "wrong owner"],
  ["wrong repository", "wrong host", "stored OPEN is not positive merge credit", "malformed credit entry",
    "PR number and URL disagree", "quarantined native entry"],
  ["configured root does not borrow another instance store", "missing config", "unreadable nonmissing config",
    "corrupt config", "relative configured root", "same-PR remove-credit override"],
  ["malformed override YAML", "malformed override shape", "refused override row", "unreadable nonmissing override",
    "malformed invalidation container", "malformed invalidation mark"],
] as const;
assert.equal(new Set(closedCreditCases.map(c => c.name)).size, closedCreditCases.length, "negative fixture names are unique");
assert.deepEqual(closedCreditCaseParts.flat(), closedCreditCases.map(c => c.name), "the four proof parts cover every negative fixture exactly once in original order");

async function assertClosedCreditCases(t: TestContext, names: readonly string[]): Promise<void> {
  const failures: OfflineSpawnFailure[] = [];
  // Emit a bounded parent capsule after all children, where the native failure tail retains it.
  t.after(() => { if (failures.length > 0) t.diagnostic(JSON.stringify({ offlineSpawnFailures: failures })); });
  await withTempDir("offline-lint-transform-cache", async transformCache => {
    for (const name of names) {
      const c = closedCreditCases.find(value => value.name === name)!;
      await t.test(c.name, async child => {
        await withDependencyCreditFixture(child, f => {
          c.seed(f);
          const result = f.offline();
          assert.equal(result.code, 1, result.output);
          const admission = result.output.split("\n").find(line => line.includes("[machine-filing-admission]")) ?? "";
          assert.match(admission, /ZZ-T1/);
          // Current boolean refusal exists; unavailable evidence must not assert an observed unmerged PR.
          assert.match(admission, /credit.*(?:unknown|unavailable|unobservable)|(?:unknown|unavailable|unobservable).*credit/i);
          assert.match(admission, c.reason);
        }, false, failure => { failures.push(failure); }, transformCache);
      });
    }
  });
}

test("lint dependency credit: absent or unusable evidence stays closed with honest UNKNOWN reasons part 1", async t => {
  await assertClosedCreditCases(t, closedCreditCaseParts[0]);
});

test("lint dependency credit: absent or unusable evidence stays closed with honest UNKNOWN reasons part 2", async t => {
  await assertClosedCreditCases(t, closedCreditCaseParts[1]);
});

test("lint dependency credit: absent or unusable evidence stays closed with honest UNKNOWN reasons part 3", async t => {
  await assertClosedCreditCases(t, closedCreditCaseParts[2]);
});

test("lint dependency credit: absent or unusable evidence stays closed with honest UNKNOWN reasons part 4", async t => {
  await assertClosedCreditCases(t, closedCreditCaseParts[3]);
});

test("lint dependency credit: online projection includes transitive dependencies without changing lint scope", async t => {
  await withDependencyCreditFixture(t, async f => {
    let projected: string[] = [];
    const result = await capturedLint(["--plan", join(f.root, "plan/tasks.yaml"), "--base", f.base], {
      repoRoot: f.root,
      loadConfig: (() => ({ root: dirname(dirname(f.cacheFile)) })) as never,
      resolveOwnerRepo: () => ({ owner: "fixture-owner", repo: "remudero" }),
      ghGateway: (() => ({})) as never,
      // Scope probe only: stop before derivation, never return a fabricated merge verdict.
      projectPlan: ((plan: { tasks: Array<{ id: string }>; byId: Map<string, { id: string }> }) => {
        projected = plan.tasks.map(task => task.id).sort();
        assert.deepEqual([...plan.byId.keys()].sort(), projected, "evidence byId indexes exactly the projected tasks");
        throw new Error("TDD scope probe stops before GitHub/status derivation");
      }) as never,
      openPlanShardSlugs: () => [],
    });
    assert.match(result.output, /1 task\(s\) checked/, "only the changed task is linted");
    assert.deepEqual(projected, [CREDIT_GRANDPARENT, CREDIT_DEP, CREDIT_CHILD],
      "one normal online projection must include dependency closure");
  });
});

/** Controller integration: REAL projectPlan/readers/derivation, deterministic fake GitHub only.
 * These private MERGED PR rows are synthetic inputs, not live merge credit or a new authority. */
async function nativeOnlineLint(f: DependencyCreditFixture) {
  const rows: PrRef[] = [CREDIT_GRANDPARENT, CREDIT_DEP].map((id, index) => ({
    number: 17 + index, url: CREDIT_PR.replace("/17", "/" + (17 + index)), state: "MERGED",
    headRefName: "run-" + id + "-1792350000000", body: "Remudero-Task: " + id,
  }));
  const github = fakeGitHub({ listMergedHeadBranches: () => rows, listOpenHeadBranches: () => [],
    changedFiles: () => ["src/value.ts"],
    headRefName: url => rows.find(row => row.url === url)?.headRefName,
    prBody: url => rows.find(row => row.url === url)?.body });
  const observed: { plan?: Plan; deps?: DeriveDeps; result?: Map<string, StatusProjection>; calls: number } = { calls: 0 };
  const result = await capturedLint(["--plan", join(f.root, "plan/tasks.yaml"), "--base", f.base], {
    repoRoot: f.root,
    loadConfig: (() => ({ root: dirname(dirname(f.ledgerFile)) })) as never,
    resolveOwnerRepo: () => ({ owner: "fixture-owner", repo: "remudero" }),
    ghGateway: (() => github) as never,
    projectPlan: (plan, deps, cachePath) => {
      observed.calls++; observed.plan = plan; observed.deps = deps;
      // Do not replace the passed writer/readers or return a fabricated projection.
      observed.result = projectPlan(plan, deps, cachePath);
      return observed.result;
    },
    openPlanShardSlugs: () => [], readMergeEvidenceLog: () => ({ dump: "", ref: "private-fixture-no-history" }),
  });
  return { result, github, observed };
}

function seedPrivateOnlineFiles(f: DependencyCreditFixture): string[] {
  f.store({}); f.overrides("[]\n"); writeFileSync(f.ledgerFile, "");
  return [f.configFile, f.cacheFile, f.overrideFile, f.ledgerFile];
}

test("lint dependency credit: real online projection derives private credits without writing the native store", async t => {
  await withDependencyCreditFixture(t, async f => {
    const paths = seedPrivateOnlineFiles(f), before = paths.map(path => readFileSync(path, "utf8"));
    const { result, github, observed } = await nativeOnlineLint(f);
    assert.equal(result.code, 0, result.output);
    assert.equal(observed.calls, 1);
    assert.deepEqual(observed.plan!.tasks.map(task => task.id).sort(), [CREDIT_GRANDPARENT, CREDIT_DEP, CREDIT_CHILD]);
    assert.deepEqual([...observed.plan!.byId.keys()].sort(), [CREDIT_GRANDPARENT, CREDIT_DEP, CREDIT_CHILD]);
    assert.equal(observed.result!.get(CREDIT_DEP)?.merged, true, "the real branch-credit rung must execute");
    assert.equal(observed.result!.get(CREDIT_GRANDPARENT)?.merged, true);
    assert.equal(observed.result!.get(CREDIT_CHILD)?.merged, false);
    assert.equal(github.calls.filter(call => call.method === "listMergedHeadBranches").length, 1);
    assert.equal(github.calls.filter(call => call.method === "listOpenHeadBranches").length, 1);
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before,
      "the controller's passed writeCreditStore option must suppress real native persistence");

    // Positive writer control: the SAME real projection with its default writer persists ONLY
    // in a second private fixture directory. This is not a live-store write or fake isMerged.
    const controlLedger = join(dirname(f.ledgerFile), "writer-control", "state", "ledger.ndjson");
    mkdirSync(dirname(controlLedger), { recursive: true }); writeFileSync(controlLedger, "");
    const control = projectPlan(observed.plan!, { ...observed.deps!, ledgerPath: controlLedger, writeCreditStore: undefined });
    assert.equal(control.get(CREDIT_DEP)?.merged, true);
    const persisted = loadCreditStore(defaultCreditStorePath(controlLedger));
    assert.equal(persisted[CREDIT_DEP]?.["head-branch"]?.prState, "MERGED", "the fixture would really write without suppression");
    assert.equal(persisted[CREDIT_GRANDPARENT]?.["head-branch"]?.prState, "MERGED");
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
  });
});

test("lint dependency credit: real online dependency credit does not hide unchanged duplicate surfaces", async t => {
  await withDependencyCreditFixture(t, async f => {
    const paths = seedPrivateOnlineFiles(f), before = paths.map(path => readFileSync(path, "utf8"));
    const { result, observed } = await nativeOnlineLint(f);
    assert.equal(observed.calls, 1);
    assert.equal(observed.result!.get(CREDIT_DEP)?.merged, true, "dependency evidence is really merged in the private projection");
    assert.match(result.output, /1 task\(s\) checked/, "only ZZ-T2 is linted, not the dependency closure");
    assert.match(result.output, /\[duplicate-surface\].*ZZ-T1/,
      "the unchanged dependency's evidence must not enter the changed-task-only global credit set");
    assert.doesNotMatch(result.output, /\[machine-filing-admission\]/, "dependency evidence still admits the changed task");
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
  }, true);
});

function taskYaml(proofs: readonly string[]): string {
  return [
    "- id: ZZ-Offline-Lint",
    '  title: "offline lint fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human",
    "  risk: low",
    "  status: queued",
    '  origin: "offline lint test fixture"',
    "  files: [test/example.test.ts]",
    "  acceptance:",
    ...proofs.flatMap((proof, i) => [
      `    - claim: "fixture claim ${i + 1}"`,
      `      proof: "${proof}"`,
    ]),
    "",
  ].join("\n");
}

function fixturePlan(t: TestContext): { dir: string; planPath: string; baseCommit: (content: string) => string } {
  const repo = gitRepo({ scope: t, seedCommit: false, kind: "offline-lint-private-plan" });
  const dir = repo.dir, planPath = join(dir, "plan/tasks.yaml");
  mkdirSync(join(dir, "plan"));
  // Keep the real npm entrypoint and production source/dependencies read-only; only fixture data
  // and its own Git objects are writable. No active checkout is a test scratch directory.
  symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"), "dir");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "lint-plan:offline": scripts["lint-plan:offline"] } }));
  return { dir, planPath, baseCommit: content => {
    writeFileSync(planPath, content); repo.git("add", "plan"); repo.git("commit", "-qm", "test: offline lint base");
    return repo.git("rev-parse", "HEAD");
  } };
}

async function capturedLint(
  args: string[],
  deps: Parameters<typeof lintPlanCommand>[1],
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const [oldLog, oldError, oldWarn] = [console.log, console.error, console.warn];
  console.log = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  console.warn = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  try {
    return { code: await lintPlanCommand(args, deps), output: lines.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
    console.warn = oldWarn;
  }
}

test("offline plan lint keeps local blocking rules and names every GitHub-backed omission", async t => {
  const { dir, planPath, baseCommit } = fixturePlan(t);
  try {
    const clean = taskYaml(["unit test: test/example.test.ts"]);
    const base = baseCommit(clean);
    writeFileSync(planPath, taskYaml(["works"]), "utf8");
    let externalCalls = 0;
    const forbidden = () => {
      externalCalls += 1;
      throw new Error("offline lint attempted a GitHub-backed dependency");
    };

    const result = await capturedLint(["--plan", planPath, "--base", base], {
      repoRoot: dir,
      offline: true,
      loadConfig: forbidden as never,
      resolveOwnerRepo: forbidden as never,
      ghGateway: forbidden as never,
      projectPlan: forbidden as never,
      openPlanShardSlugs: forbidden as never,
    });

    assert.equal(result.code, 1, "the local proof-shape and proof-dialect blocks must still refuse");
    assert.match(result.output, /\[proof-shape\]/);
    assert.match(result.output, /\[proof-dialect\]/);
    assert.match(result.output, /offline subset/i);
    assert.match(result.output, /post-merge-amendment.*block/i);
    assert.match(result.output, /duplicate-title.*warn/i);
    assert.match(result.output, /duplicate-surface.*may over-report/i);
    assert.equal(externalCalls, 0, "no GitHub-backed dependency may be consulted in offline mode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the offline runner omits the merged-task amendment block instead of manufacturing a verdict", async t => {
  const { dir, planPath, baseCommit } = fixturePlan(t);
  try {
    const oneCriterion = taskYaml(["unit test: test/example.test.ts"]);
    const base = baseCommit(oneCriterion);
    writeFileSync(
      planPath,
      taskYaml(["unit test: test/example.test.ts", "unit test: test/example.test.ts"]),
      "utf8",
    );
    const args = ["--plan", planPath, "--base", base];
    const online = await capturedLint(args, {
      repoRoot: dir,
      loadConfig: (() => ({ root: "/synthetic" })) as never,
      resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
      ghGateway: (() => ({})) as never,
      projectPlan: (() => new Map([["ZZ-Offline-Lint", { merged: true, indeterminate: false }]])) as never,
      openPlanShardSlugs: (() => []) as never,
    });
    const offline = await capturedLint(args, {
      repoRoot: dir,
      offline: true,
      loadConfig: (() => {
        throw new Error("must stay offline");
      }) as never,
    });

    assert.equal(online.code, 1);
    assert.match(online.output, /\[post-merge-amendment\]/);
    assert.equal(offline.code, 0, "unknown merge state must skip the check, never infer not-merged");
    assert.doesNotMatch(offline.output, /\[post-merge-amendment\]/);
    assert.match(offline.output, /post-merge-amendment.*omitted/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the standalone offline runner never reaches a gh executable", t => {
  const { dir, planPath, baseCommit } = fixturePlan(t);
  const shim = ghShim([{ when: "", exit: 99 }], { kind: "offline-lint-no-gh" });
  try {
    const base = baseCommit(taskYaml(["unit test: test/example.test.ts"]));
    writeFileSync(planPath, taskYaml(["unit test: test/example.test.ts", "unit test: test/example.test.ts"]), "utf8");

    const child = spawnSync(
      "npm",
      ["run", "--silent", "lint-plan:offline", "--", "--plan", planPath, "--base", base],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(shim.calls(), [], "the fake gh executable must remain untouched");
    assert.match(child.stdout, /offline subset/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
