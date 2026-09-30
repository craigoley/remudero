// The live-write guard (operator ruling 2026-07-30, recon-AQ option 2).
//
// recon-AQ established that test/mounts-wiring.test.ts reaches the LIVE repo: over three
// days it pushed 6 branches, opened 5 PRs, filed 3 needs-human issues, and left one PR
// with auto-merge ARMED, at real model spend. These tests lock the four outward boundaries
// shut under the test runner, and lock them OPEN everywhere else so the daemon is unaffected.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { ledgerPathFor } from "../src/lib/ledger-path.js";
import { main } from "../src/run-task.js";
import { ghExec, ghExecFile, ghJson } from "../src/lib/github-transport.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { ghRefusalCount } from "./setup/tmp-hygiene.js";
import { installNoLiveRemote } from "./setup/no-live-remote.js";
import {
  assertLiveWriteAllowed,
  isTestRunner,
  LiveWriteBlockedError,
  LIVE_WRITE_OVERRIDE_ENV,
  LIVE_WRITE_SENTINEL_TOKEN,
  TEST_LIVE_STATE_ROOT_ENV,
  liveWritesExempt,
  withLiveWritesAllowed,
  type LiveWriteBoundary,
} from "../src/lib/live-write-guard.js";

/** The env a real daemon/operator process carries: no runner variable at all. */
const REAL_RUN: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/x" };
/** The env node's own test runner sets — measured, not assumed (see the module header). */
const TEST_RUN: NodeJS.ProcessEnv = { ...REAL_RUN, NODE_TEST_CONTEXT: "child-v8" };

const BOUNDARIES: LiveWriteBoundary[] = ["git-push", "gh-pr-create", "gh-pr-merge", "gh-issue-create"];

test("the signal is NODE_TEST_CONTEXT, and NODE_ENV is deliberately NOT used", () => {
  // NODE_ENV is unset in BOTH contexts on this host, so a guard keyed on it would never
  // fire — the inert-module trap this repo already fell into twice.
  assert.equal(isTestRunner(REAL_RUN), false, "a real daemon run must not look like a test");
  assert.equal(isTestRunner(TEST_RUN), true, "a node --test run must be detected");
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_ENV: "test" }), false, "NODE_ENV must NOT arm the guard");
});

test("the signal is presence-tested, so a future runner value cannot silently disarm it", () => {
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "some-future-value" }), true);
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "" }), false, "empty is not a runner");
});

test("every outward boundary REFUSES under the test runner, naming itself", () => {
  for (const b of BOUNDARIES) {
    assert.throws(
      () => assertLiveWriteAllowed(b, "detail here", TEST_RUN),
      (e: unknown) => {
        assert.ok(e instanceof LiveWriteBlockedError, `${b} must throw LiveWriteBlockedError`);
        assert.equal(e.boundary, b, "the error must NAME the boundary it refused");
        assert.match(e.message, /REFUSED/, "the refusal must be loud, not a silent no-op");
        assert.match(e.message, new RegExp(b), "the message must carry the boundary name");
        return true;
      },
      `${b} must refuse under the test runner`,
    );
  }
});

test("REGRESSION LOCK: with the signal absent every boundary behaves exactly as before", () => {
  // The daemon must be completely unaffected. Not "throws something else" — returns cleanly.
  for (const b of BOUNDARIES) {
    assert.doesNotThrow(() => assertLiveWriteAllowed(b, "detail here", REAL_RUN), `${b} must be a no-op in a real run`);
  }
});

test("a deliberate override lets an intended live write through, so the guard is narrow", () => {
  const opted: NodeJS.ProcessEnv = { ...TEST_RUN, [LIVE_WRITE_OVERRIDE_ENV]: "1" };
  for (const b of BOUNDARIES) {
    assert.doesNotThrow(() => assertLiveWriteAllowed(b, "detail here", opted));
  }
  // Only the exact opt-in value counts — a stray truthy string must NOT disarm it.
  assert.throws(() => assertLiveWriteAllowed("git-push", "d", { ...TEST_RUN, [LIVE_WRITE_OVERRIDE_ENV]: "yes" }));
});

test("STRUCTURAL: every outward-effect call site in src/ is guarded — this is what keeps containment total", () => {
  // The four boundaries have NO single choke point (8 push sites, 5 merge, 4 pr-create,
  // 1 issue-create across five files), so "remember to guard" would decay into partial
  // containment — which is worse than none because it invites false confidence. This test
  // is the replacement for a choke point: a NEW unguarded outward call fails the build.
  const SHAPES = [
    // impl-BA: git-push now has a LEAF (src/lib/git-push.ts). The old marker was the exact
    // substring '"push", "origin", "HEAD"', which MISSED spike.ts's `push -u` variant — that
    // call site sat UNGUARDED and this test still reported clean. `PUSH_SHAPE` below is
    // checked structurally instead, so both variants are caught and the only surviving
    // inlined push (the leaf's own) must carry the guard.
    '"pr", "create"',
    '"pr", "merge"',
    '"issue", "create"',
    "refs/heads/${LANDING_BRANCH}",
  ];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  // Any inlined `execFileSync("git", [... "push" ...])` anywhere in src/, regardless of the
  // exact argv — this is what the old exact-substring marker could not see.
  const isInlinedPush = (line: string): boolean =>
    line.includes('execFileSync("git"') && line.includes('"push"');

  const unguarded: string[] = [];
  for (const file of walk("src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!SHAPES.some((s) => line.includes(s)) && !isInlinedPush(line)) return;
      if (line.includes("assertLiveWriteAllowed")) return;
      // guarded when the assert appears on the preceding line, or anywhere in the
      // enclosing few lines above (a builder guard at the top of its function).
      const window = lines.slice(Math.max(0, i - 8), i).join("\n");
      if (!window.includes("assertLiveWriteAllowed")) unguarded.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(unguarded, [], `these outward call sites are NOT guarded:\n${unguarded.join("\n")}`);

  // THE LEAF ITSELF. After impl-BA the push goes out through an indirection
  // (`(opts.exec ?? defaultPushExec)(...)`), so the argv-substring scan above can no longer
  // see it — which means the scan alone would NOT notice the leaf losing its guard. Assert
  // it directly: this is the single line that guards all nine former call sites.
  const leaf = readFileSync("src/lib/git-push.ts", "utf8");
  assert.ok(
    leaf.includes('assertLiveWriteAllowed("git-push"'),
    "src/lib/git-push.ts is THE git-push leaf and has lost its guard — every push in the " +
      "codebase routes through it, so nothing is guarded",
  );
});

// ── The per-test opt-out (operator ruling 2026-07-30, option 2) ─────────────────────
// Five suites legitimately drive these boundaries against their OWN containment, so the
// guard has to be suspendable at TEST granularity. These lock the two ways such a
// mechanism leaks, plus the regression that matters most: not wrapping is still refused.

test("REGRESSION LOCK: a boundary that does NOT wrap is still refused, so the opt-out did not make the guard inert", () => {
  assert.equal(liveWritesExempt(), false, "no exemption may be in effect before this test");
  assert.throws(
    () => assertLiveWriteAllowed("git-push", "unwrapped push", TEST_RUN),
    (e: unknown) => e instanceof LiveWriteBlockedError,
    "an unwrapped boundary must still throw",
  );
});

test("the opt-out suspends the guard only INSIDE the wrapped section", () => {
  assert.equal(liveWritesExempt(), false);
  const seen = withLiveWritesAllowed(() => {
    assert.equal(liveWritesExempt(), true, "exempt inside");
    assertLiveWriteAllowed("git-push", "wrapped push", TEST_RUN); // must NOT throw
    return "ran";
  });
  assert.equal(seen, "ran", "the wrapped section's return value passes through");
  assert.equal(liveWritesExempt(), false, "re-armed immediately after");
  assert.throws(() => assertLiveWriteAllowed("git-push", "after", TEST_RUN), LiveWriteBlockedError);
});

test("TRAP 1 throw: a wrapped section that THROWS leaves the guard armed again afterwards", () => {
  assert.throws(
    () =>
      withLiveWritesAllowed(() => {
        assert.equal(liveWritesExempt(), true, "exempt while inside");
        throw new Error("boom");
      }),
    /boom/,
    "the original error must propagate unchanged",
  );
  // Assert the RE-ARMED STATE directly, not merely the absence of an effect.
  assert.equal(liveWritesExempt(), false, "the exemption must not survive a throw");
  assert.throws(() => assertLiveWriteAllowed("gh-pr-create", "after throw", TEST_RUN), LiveWriteBlockedError);
});

test("TRAP 1 async: a wrapped ASYNC section stays exempt for the whole await and re-arms only after it settles", async () => {
  let exemptDuringAwait: boolean | undefined;
  const p = withLiveWritesAllowed(async () => {
    await new Promise((r) => setTimeout(r, 25));
    // If the restore ran synchronously, the guard would already be re-armed HERE and the
    // boundary would be refused mid-section — the exact early-restore bug.
    exemptDuringAwait = liveWritesExempt();
    assertLiveWriteAllowed("gh-pr-merge", "inside awaited work", TEST_RUN); // must NOT throw
    return "async-done";
  });
  assert.equal(liveWritesExempt(), true, "still exempt while the promise is pending");
  assert.equal(await p, "async-done");
  assert.equal(exemptDuringAwait, true, "exempt for the DURATION of the awaited work");
  assert.equal(liveWritesExempt(), false, "re-armed once the promise settles");
});

test("TRAP 1 async reject: a wrapped ASYNC section that REJECTS still re-arms the guard", async () => {
  await assert.rejects(
    withLiveWritesAllowed(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("async-boom");
    }),
    /async-boom/,
  );
  assert.equal(liveWritesExempt(), false, "the exemption must not survive an async rejection");
});

test("the opt-out NESTS without an inner section re-arming the guard for the outer one", () => {
  withLiveWritesAllowed(() => {
    withLiveWritesAllowed(() => {
      assert.equal(liveWritesExempt(), true);
    });
    // A boolean flag would have re-armed here; a depth counter must not.
    assert.equal(liveWritesExempt(), true, "the OUTER exemption survives the inner one ending");
    assertLiveWriteAllowed("git-push", "outer still exempt", TEST_RUN);
  });
  assert.equal(liveWritesExempt(), false);
});

// ── W1-T4805: process-level containment (test/setup/no-live-remote.ts) ─────────────────────────
// The per-call fence above can fire AFTER an effect it does not know about. These canaries prove
// the suite's own process cannot reach live GitHub at all: dead push URLs, a sentinel token the
// transport refuses, no App key. They rely on the shared `--import tmp-hygiene.ts` setup only.

const GITHUB_PUSH_URLS = [
  "https://github.com/craigoley/remudero.git",
  "git@github.com:craigoley/remudero.git",
  "ssh://git@github.com/craigoley/remudero.git",
];

test("W1-T4805: a real push to github from the suite fails on the dead rewrite", () => {
  const repo = gitRepo({ kind: "canary-push" });
  // every github.com push URL form resolves to the dead path, before any network is involved
  for (const url of GITHUB_PUSH_URLS) {
    repo.addRemote("canary", url);
    const pushUrl = repo.git("remote", "get-url", "--push", "canary");
    assert.match(pushUrl, /W1-T4805-live-github-push-blocked/, `${url} must rewrite to the dead path`);
    repo.git("remote", "remove", "canary");
  }
  // and a real `git push` fails loudly, naming the dead rewrite
  repo.addRemote("origin", GITHUB_PUSH_URLS[0]!);
  const pushed = spawnSync("git", ["-C", repo.dir, "push", "origin", "HEAD:refs/heads/w1-t4805-canary"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(pushed.status, 0, "a push to github.com must fail under the suite");
  assert.match(pushed.stderr, /W1-T4805-live-github-push-blocked/, "the failure must name the dead rewrite");
  // a LOCAL bare fixture remote is a plain path: the rewrite must not touch it
  const bare = gitRepo({ bare: true, kind: "canary-bare" });
  repo.addRemote("local", bare.dir);
  repo.git("push", "local", "HEAD:refs/heads/main");
  assert.equal(bare.git("rev-parse", "main"), repo.git("rev-parse", "HEAD"));
});

test("W1-T4805: the transport refuses the sentinel token before gh runs", () => {
  assert.equal(process.env.GH_TOKEN, LIVE_WRITE_SENTINEL_TOKEN, "the shared setup must install the sentinel");
  assert.equal(process.env.GITHUB_TOKEN, LIVE_WRITE_SENTINEL_TOKEN);
  const before = ghRefusalCount();
  const refused = (fn: () => unknown): void =>
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof LiveWriteBlockedError, "must be LiveWriteBlockedError, never the CLI's own 401");
      assert.equal(e.boundary, "gh-transport");
      assert.match(e.message, /W1-T4805/);
      assert.match(e.message, /gh pr create 1/, "the refusal must name the command");
      return true;
    });
  // PATH resolves no gh under the temp dir, so the only gh a spawn could reach is a real one
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-w1-t4805";
  try {
    refused(() => ghExec(["pr", "create", "1", "--fill"], { encoding: "utf8" }));
    refused(() => ghExecFile("gh", ["pr", "create", "1"], { encoding: "utf8" }));
    refused(() => ghJson(["pr", "create", "1"]));
  } finally {
    process.env.PATH = originalPath;
  }
  // the shared refusing stub `gh` was never spawned: the transport's refusal came first
  assert.equal(ghRefusalCount(), before, "gh must not have been spawned");
});

test("W1-T4805: a test's own PATH-stubbed gh still runs under the sentinel", () => {
  const shim = ghShim([{ when: "pr view", stdout: "stubbed" }], { kind: "sentinel-own-stub" });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    assert.equal(ghExec(["pr", "view", "1"], { encoding: "utf8" }).trim(), "stubbed");
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepEqual(shim.calls(), ["pr view 1"]);
});

test("W1-T4805: a spawned child inherits the sentinel and no app key", () => {
  const probe =
    "const e = process.env; console.log(JSON.stringify({ t: e.GH_TOKEN, g: e.GITHUB_TOKEN, k: e.GH_APP_PRIVATE_KEY_PATH ?? null," +
    " id: e.GH_APP_ID ?? null, inst: e.GH_APP_INSTALLATION_ID ?? null, cfg: e.GH_CONFIG_DIR ?? null }));";
  const out = JSON.parse(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" })) as Record<string, string | null>;
  assert.equal(out.t, LIVE_WRITE_SENTINEL_TOKEN);
  assert.equal(out.g, LIVE_WRITE_SENTINEL_TOKEN);
  assert.equal(out.k, null);
  assert.equal(out.id, null);
  assert.equal(out.inst, null);
  assert.ok(out.cfg !== null && out.cfg.includes("rmd-test-gh-config-"), "GH_CONFIG_DIR must be the empty per-process dir");
  assert.deepEqual(readdirSync(out.cfg), [], "the gh config dir must be empty — no keyring login reachable");
});

test("the cli test harness never resolves the live ledger path", async (t) => {
  const liveRoot = process.env[TEST_LIVE_STATE_ROOT_ENV];
  assert.ok(liveRoot, "the shared setup must remember the original live root");
  const fixturePath = ledgerPathFor(loadConfig());
  assert.notEqual(fixturePath, join(liveRoot, "state", "ledger.ndjson"));
  const sentinelRoot = mkdtempSync(join(tmpdir(), "rmd-test-original-ledger-"));
  const sentinelPath = writeLedger([{ step: "sentinel" }], { dir: join(sentinelRoot, "state") }).path;
  const sentinelBytes = readFileSync(sentinelPath);

  const originalArgv = process.argv;
  process.env[TEST_LIVE_STATE_ROOT_ENV] = sentinelRoot;
  process.argv = ["node", "run-task.js", "help"];
  t.mock.method(process, "exit", ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
  t.mock.method(console, "log", () => {});
  try {
    await assert.rejects(main(), /exit 0/);
  } finally {
    process.argv = originalArgv;
    process.env[TEST_LIVE_STATE_ROOT_ENV] = liveRoot;
  }
  const rows = readFileSync(fixturePath, "utf8").trim().split("\n").map((row) => JSON.parse(row) as { step: string; verb: string });
  assert.ok(rows.some((row) => row.step === "cli.invoked" && row.verb === "help"));
  assert.deepEqual(readFileSync(sentinelPath), sentinelBytes, "the original ledger keeps every byte");
});

test("the test preload reads the original config without creating or changing it", async () => {
  for (const source of ["absent", "configured", "malformed"] as const) {
    const home = mkdtempSync(join(tmpdir(), `rmd-test-original-home-${source}-`));
    const configPath = join(home, ".config", "remudero", "config.json");
    const customRoot = join(home, "custom-root");
    const original = source === "configured" ? JSON.stringify({ root: customRoot }) : "{broken";
    if (source !== "absent") {
      mkdirSync(join(home, ".config", "remudero"), { recursive: true });
      await writeFile(configPath, original);
    }
    const env: NodeJS.ProcessEnv = { HOME: home, NODE_TEST_CONTEXT: "child-v8" };
    const installed = installNoLiveRemote(env);
    try {
      assert.equal(env[TEST_LIVE_STATE_ROOT_ENV], source === "configured" ? customRoot : join(home, "Remudero"));
      assert.ok(env.HOME !== home && installed.fixtureHome === env.HOME);
      assert.equal(existsSync(configPath), source !== "absent");
      if (source !== "absent") assert.equal(readFileSync(configPath, "utf8"), original);
      assert.ok(existsSync(join(env.HOME!, ".config", "remudero", "config.json")));
    } finally {
      if (installed.fixtureHome) rmSync(installed.fixtureHome, { recursive: true, force: true });
      if (installed.ghConfigDir) rmSync(installed.ghConfigDir, { recursive: true, force: true });
    }
  }
});

test("an append under the live state root from the suite is refused before writing", () => {
  const deniedRoot = mkdtempSync(join(tmpdir(), "rmd-test-ledger-deny-"));
  const path = join(deniedRoot, "state", "nested", "ledger.ndjson");
  const alias = join(mkdtempSync(join(tmpdir(), "rmd-test-ledger-alias-")), "alias");
  symlinkSync(deniedRoot, alias, "dir");
  const prior = process.env[TEST_LIVE_STATE_ROOT_ENV];
  process.env[TEST_LIVE_STATE_ROOT_ENV] = deniedRoot;
  try {
    assert.throws(
      () => appendLedger(path, { run_id: "canary", task_id: "CLI", step: "cli.invoked" }),
      (error: unknown) => error instanceof LiveWriteBlockedError && error.boundary === "ledger-append" && /W1-T4923/.test(error.message),
    );
    assert.equal(existsSync(path), false, "the refusal must precede mkdir and open");
    assert.throws(
      () => appendLedger(join(alias, "state", "ledger.ndjson"), { run_id: "alias", task_id: "CLI", step: "cli.invoked" }),
      (error: unknown) => error instanceof LiveWriteBlockedError && error.boundary === "ledger-append",
      "a symlink alias must not bypass the denied root",
    );
  } finally {
    if (prior === undefined) delete process.env[TEST_LIVE_STATE_ROOT_ENV];
    else process.env[TEST_LIVE_STATE_ROOT_ENV] = prior;
  }
});

test("a spawned child inherits the live ledger deny root", () => {
  const deniedRoot = mkdtempSync(join(tmpdir(), "rmd-test-child-ledger-deny-"));
  const path = join(deniedRoot, "state", "ledger.ndjson");
  const ledgerUrl = pathToFileURL(join(process.cwd(), "src", "lib", "ledger.ts")).href;
  const probe = `import { appendLedger } from ${JSON.stringify(ledgerUrl)};\n` +
    `try { appendLedger(${JSON.stringify(path)}, { run_id: "child", task_id: "CLI", step: "cli.invoked" }); console.log("wrote"); }\n` +
    `catch (error) { console.log(error.name + ":" + error.message); }\n` +
    `console.log("coverage=" + String(process.env.NODE_V8_COVERAGE));`;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, [TEST_LIVE_STATE_ROOT_ENV]: deniedRoot };
  childEnv.NODE_V8_COVERAGE = undefined;
  delete childEnv.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: childEnv,
  });
  assert.match(output, /LiveWriteBlockedError:.*W1-T4923/);
  assert.match(output, /coverage=undefined/);
  assert.equal(existsSync(path), false);
});
