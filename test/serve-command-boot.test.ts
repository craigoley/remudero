/**
 * test/serve-command-boot.test.ts — W1-T152: `rmd serve`'s REAL boot path, in-process.
 *
 * serveCommand has only ever been asserted against as SOURCE TEXT (test/run-task.test.ts's
 * extractFunctionBody checks) because it binds a port and blocks until a signal. That is
 * exactly why the service posture this task adds — logs forced 0600 before the token-bearing
 * banner prints, an off-main notice that WARNS instead of refusing, a bind that waits out a
 * dying process's port — has to be exercised here rather than described: a spawned child
 * proves behaviour but reports no coverage, and an untested boot path is how a console that is
 * supposed to be always-on acquires a startup crash nobody sees until the operator is 3000
 * miles away.
 *
 * Its own file (the run-task.test.ts file-level coverage-crash lesson). One host, so
 * `server.close()` on shutdown really does release everything this test opened.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveCommand, benchmarkAaReadinessRuntime, buildInboxDraftSpawnArgs, lintPlanCommand, main, approveCommand, draftProposalBatch } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { inboxDraftExampleFragmentYaml, composeStampLine, fileRatificationDraft, fileRatificationBatch, RatificationDraftRefusedError, checkoutRepoFacts, lintDraftedFragment, planProjectionForDependsOn } from "../src/lib/inbox.js";
import { serveLogPaths } from "../src/lib/launchd.js";
import type { Mounts } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

const REPO_ROOT = findRepoRoot();

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** W1-T4226: the board's gateway, through `serveCommand`'s existing `buildBatchedGithub` seam (the
 *  same fake test/serve-answers-before-it-accepts.test.ts wires) — so booting the console never
 *  lists pulls through the refused `gh`. Nothing in this file asserts on board contents. */
const BOARD_BRANCH_LISTS = { listMergedHeadBranches: () => [], listOpenHeadBranches: () => [] };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A throwaway instance: its own HOME, its own config.json, its own state root. */
function instance(serve?: { host?: string; port?: number }): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-servecmd-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT, serve }));
  return { home, root };
}

test("selected real daemon draft batch retains its captured intent through the actual lint after an asynchronous spawn", async (t) => {
  const { home, root } = instance(), seed = gitRepo({ kind: "selected-draft-origin" });
  t.after(() => { seed.cleanup(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(seed.dir, "plan")); mkdirSync(join(seed.dir, "src", "lib"), { recursive: true });
  const fragment = inboxDraftExampleFragmentYaml(), planText = fragment.replaceAll("NEW-1", "W1-T1")
    .replace("Tighten the empty-input guard in parseTasksFromYaml", "Qualify xenolith riverbed alpenglow context") + "\n";
  assert.throws(() => planProjectionForDependsOn("[]\n"), /projected to zero tasks/);
  assert.match(planProjectionForDependsOn(planText), /W1-T1/);
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), planText);
  copyFileSync(join(REPO_ROOT, "src", "lib", "plan.ts"), join(seed.dir, "src", "lib", "plan.ts"));
  seed.git("add", "."); seed.git("commit", "-m", "chore: seed a private draft fixture");
  seed.git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(root, "repos"), { recursive: true }); seed.git("clone", "--quiet", seed.dir, join(root, "repos", "fixture"));
  const selectedPath = join(home, "selected.yaml");
  writeFileSync(selectedPath, "instances:\n  fixture:\n    github_repo: owner/repo\n    mode: shadow\n");
  const facts = checkoutRepoFacts(seed.dir), id = "P-selected-draft";
  assert.deepEqual(lintDraftedFragment(fragment, id, composeStampLine(id, "qualification only", ["NEW-1"]), new Set(["remudero"]),
    facts.moduleExists, facts.readGrepProofFile, facts.pathIsDirectory, facts.pathExistsAtBase), [],
    "prove this exact fixture is lint-clean BEFORE any real batch can reach an uninjected escalation default");
  for (const enabled of [false, true]) {
    const config = JSON.parse(readFileSync(join(home, ".config", "remudero", "config.json"), "utf8"));
    if (enabled) config.selectedRegistryMode = { mode: "shadow", instanceName: "fixture", registryPath: selectedPath };
    const rows: Array<Record<string, unknown>> = []; let calls = 0;
    const outcome = await draftProposalBatch([{ id, summary: "qualification only", evidenceAnchors: [] }], config, "owner", "fixture",
      `SELECTED-DRAFT-${enabled ? "shadow" : "legacy"}`, (step, fields) => rows.push({ step, ...fields }), async args => {
        calls++; assert.equal(calls, 1, "this clean fixture must never retry or reach an escalation capacity port");
        assert.deepEqual(args.tools, ["Read", "Grep", "Glob"]);
        assert.ok(args.prompt.includes("W1-T1"), "the real draft prompt must project the seeded plan before spawning");
        assert.ok(!args.prompt.includes(selectedPath), "private intent cannot be added to an untrusted prompt");
        config.selectedRegistryMode = undefined; await Promise.resolve();
        return fakeWorkerResult(`=== FRAGMENT START ===\n${fragment}\n=== FRAGMENT END ===\nSTAMP: qualification only`);
      });
    assert.equal(calls, 1); assert.equal(outcome[0]?.ok, true);
    const selected = rows.filter(row => row.step === "instance_registry.consumer_shadow_observed");
    assert.equal(selected.length, enabled ? 1 : 0, "the REAL batch, not only a fixture-supplied context, must own its post-spawn lint");
    assert.ok(selected.every(row => row.action === "inbox-discovery" && row.selected_state === "unknown" && row.publication_permission === "not-granted"));
    assert.ok(!JSON.stringify(selected).includes(selectedPath));
    assert.equal(readFileSync(join(root, "repos", "fixture", "plan", "tasks.yaml"), "utf8"), planText);
  }
});

test("selected real approve command scopes single and batch fileability adapters without publication", async (t) => {
  const { home, root } = instance(), selectedPath = join(home, "selected.yaml"), state = join(root, "state");
  t.after(() => rmSync(home, { recursive: true, force: true })); mkdirSync(state, { recursive: true });
  writeFileSync(selectedPath, "instances:\n  fixture:\n    github_repo: owner/repo\n    mode: shadow\n");
  const config = JSON.parse(readFileSync(join(home, ".config", "remudero", "config.json"), "utf8"));
  const plan = join(home, "tasks.yaml"); writeFileSync(plan, "[]\n");
  const ids = ["P-selected-approval-a", "P-selected-approval-b"];
  const proposals = JSON.stringify({ proposals: ids.map(id => ({ id, summary: "qualification only", evidenceAnchors: [] })) });
  writeFileSync(join(state, "inbox-proposals.json"), proposals);
  writeFileSync(join(state, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(ids.map((id, index) => [id, {
    proposalId: id, fragmentYaml: inboxDraftExampleFragmentYaml().replace("Tighten the empty-input guard in parseTasksFromYaml", `Qualify xenolith riverbed alpenglow ${index ? "borealis" : "albedo"}`),
    stampLine: composeStampLine(id, "qualification only", ["NEW-1"]), anchorFingerprint: "",
  }]))));
  const quiet = t.mock.method(console, "error", () => {}); t.after(() => quiet.mock.restore());
  const trappedFs = { mkdirSync: () => assert.fail("invalid draft must not create a directory"),
    writeFileSync: () => assert.fail("invalid draft must not write"), readFileSync: () => "" };
  for (const batch of [false, true]) await t.test(batch ? "batch approval adapter owns shadow context" : "single approval adapter owns shadow context", async () => {
  for (const enabled of [false, true]) {
    writeFileSync(join(state, "ledger.ndjson"), "");
    config.selectedRegistryMode = enabled ? { mode: "shadow", instanceName: "fixture", registryPath: selectedPath } : undefined;
    let entered = 0;
    const gateway = { createRatificationBranch: (payload: Parameters<typeof fileRatificationDraft>[1]) => {
      entered++; fileRatificationDraft(root, { ...payload, fragmentYaml: "not valid: [" }, trappedFs, join); return "unreachable";
    }, openPlanPr: () => assert.fail("qualification cannot open a PR") };
    const batchGateway = { createRatificationBranch: (payloads: readonly Parameters<typeof fileRatificationDraft>[1][]) => {
      entered++; fileRatificationBatch(root, payloads.map(payload => ({ ...payload, fragmentYaml: "not valid: [" })),
        () => assert.fail("qualification cannot mint"), trappedFs, join); return "unreachable";
    }, openPlanPr: () => assert.fail("qualification cannot open a PR") };
    await assert.rejects(approveCommand(batch ? ids : ids.slice(0, 1), { config, planPath: plan, gateway, batchGateway }), RatificationDraftRefusedError);
    assert.equal(entered, 1, "the actual command must reach its selected fileability adapter, not refuse classification first");
    const rows = readFileSync(join(state, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const observed = rows.filter(row => row.step === "instance_registry.consumer_shadow_observed");
    assert.equal(observed.length, enabled ? 1 : 0, "real single/batch command invocation must own the context even with an alternative filing adapter");
    assert.ok(observed.every(row => row.action === "inbox-discovery" && row.selected_state === "unknown" && row.publication_permission === "not-granted"));
    assert.ok(!JSON.stringify(observed).includes(selectedPath));
    assert.equal(rows.some(row => row.step === "ratify.approved"), false);
    assert.equal(readFileSync(join(state, "inbox-proposals.json"), "utf8"), proposals, "refusal retains the human's pending proposals");
  }
  });
});

test("selected loaded CLI config reaches benchmark delayed draft evaluation and actual offline lint without activation", async (t) => {
  const { home, root } = instance(), repo = gitRepo({ kind: "selected-cli-lint" });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const saved = { HOME: process.env.HOME, RMD_INSTANCE_REGISTRY: process.env.RMD_INSTANCE_REGISTRY, GH_TOKEN: process.env.GH_TOKEN };
  const configPath = join(home, ".config", "remudero", "config.json"), selectedPath = join(home, "selected.yaml");
  const planPath = join(repo.dir, "plan", "tasks.yaml"); mkdirSync(join(repo.dir, "plan")); writeFileSync(planPath, "[]\n");
  writeFileSync(selectedPath, "instances:\n  fixture:\n    github_repo: owner/repo\n    mode: shadow\n");
  const initial = JSON.parse(readFileSync(configPath, "utf8"));
  const rows = (): Array<Record<string, unknown>> => {
    try { return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const realArgv = process.argv;
  const exit = t.mock.method(process, "exit", ((code?: number): never => { throw Object.assign(new Error("isolated-exit"), { code }); }) as typeof process.exit);
  const quiet = [t.mock.method(console, "log", () => {}), t.mock.method(console, "error", () => {})];
  try {
    process.env.HOME = home; process.env.RMD_INSTANCE_REGISTRY = selectedPath; process.env.GH_TOKEN = "fixture-no-network";
    for (const enabled of [false, true]) {
      const config = { ...initial, ...(enabled ? { selectedRegistryMode: { mode: "shadow", instanceName: "fixture", registryPath: selectedPath } } : {}) };
      writeFileSync(configPath, JSON.stringify(config));
      const before = rows().filter(row => row.step === "instance_registry.consumer_shadow_observed").length;
      const runtime = benchmarkAaReadinessRuntime(join(root, "state"));
      // Capture config BEFORE its caller can mutate it; this runs the actual default registry reader.
      if (runtime.config.selectedRegistryMode) runtime.config.selectedRegistryMode.registryPath = join(home, "later-unavailable.yaml");
      const result = runtime.defaultInstanceRoots();
      assert.ok("roots" in result || "reason" in result);
      const routingRows: Record<string, unknown>[] = [];
      const args = buildInboxDraftSpawnArgs({ cwd: repo.dir, settingsFile: "/unused/read-only-settings", prompt: "draft", mount: { model: "fixture" } as never,
        config, disallowedTools: [], proposalId: "P-selected", draftRoutingLog: (step, fields) => { routingRows.push({ step, ...fields }); } });
      if (config.selectedRegistryMode) config.selectedRegistryMode.mode = "legacy";
      const evaluation = args.draftRouting?.evaluate({ text: `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: qualification only`, blocks: [] } as never);
      assert.equal(evaluation?.contractFailed, false, "a real parsed draft must reach lint, not short-circuit at parse");
      assert.equal(routingRows.some(row => row.step === "instance_registry.consumer_shadow_observed"), enabled,
        "the actual delayed evaluation must retain the loaded opt-in, but ambient env must not enable it");
      // Main's existing invocation config read, not a new read in the offline lint helper.
      process.argv = ["node", "rmd", "lint-plan", "--all"];
      await assert.rejects(main({ checkFreshness: () => ({ status: "guarded" } as never), dispatch: async () =>
        lintPlanCommand(["--all"], { repoRoot: repo.dir, offline: true }) }), error => (error as { code?: number }).code === 0);
      const observations = rows().filter(row => row.step === "instance_registry.consumer_shadow_observed").slice(before);
      assert.equal(observations.some(row => row.action === "benchmark-discovery"), enabled);
      assert.equal(observations.some(row => row.action === "inbox-discovery"), enabled);
      assert.ok(observations.every(row => row.selected_state === "unknown" && row.target_instance === undefined && row.publication_permission === "not-granted"));
      assert.ok(!JSON.stringify([...observations, ...routingRows]).includes(selectedPath));
      assert.equal(readFileSync(planPath, "utf8"), "[]\n", "qualification must not file, approve or activate anything");
    }
  } finally {
    process.argv = realArgv; exit.mock.restore(); for (const q of quiet) q.mock.restore();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    repo.cleanup(); rmSync(home, { recursive: true, force: true });
  }
});

test("selected real serve CLI forwards loaded opt-in but environment alone never enables it", { timeout: 90000 }, async (t) => {
  const selection = instance(), selectionPath = join(selection.home, "selected.yaml");
  const homes = [selection.home];
  writeFileSync(selectionPath, "instances:\n  fixture:\n    github_repo: owner/repo\n    mode: shadow\n    state_dir: /private/selected-material-sentinel\n");
  const settings = { mode: "shadow", instanceName: "fixture", registryPath: selectionPath };
  const keys = ["HOME", "RMD_INSTANCE_REGISTRY", "GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH"];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  const consoleLog = console.log, consoleError = console.error;
  try {
    process.env.RMD_INSTANCE_REGISTRY = selectionPath;
    for (const key of keys.slice(2)) delete process.env[key];
    for (const enabled of [false, true]) {
      const port = await freePort(), { home, root } = instance({ host: "127.0.0.1", port });
      homes.push(home);
      const configPath = join(home, ".config", "remudero", "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, ...(enabled ? { selectedRegistryMode: settings } : {}) }));
      process.env.HOME = home;
      let listening = false;
      console.log = (...values: unknown[]) => { if (values.join(" ").includes("listening on")) listening = true; };
      console.error = () => {};
      // Reuse this suite's actual boot gateway; the shared test preload refuses any escaped live transport.
      const running = serveCommand([], { branch: () => "main", buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });
      try {
        for (let n = 0; n < 300 && !listening; n++) await sleep(50);
        assert.equal(listening, true, "real isolated CLI must bind before its request is qualified");
        const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
        const response = await fetch(`http://127.0.0.1:${port}/v1/registry`, { headers: { authorization: `Bearer ${tokens.read}`, connection: "close" } });
        assert.equal(response.status, 200);
        assert.ok(!(await response.text()).includes("selected-material-sentinel"));
        const rows = (): Array<Record<string, unknown>> => readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
          .split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        for (let n = 0; n < (enabled ? 100 : 10) && !rows().some(row => row.step === "instance_registry.consumer_shadow_observed"); n++) await sleep(20);
        const receipt = rows().find(row => row.step === "instance_registry.consumer_shadow_observed" && row.action === "serve-registry");
        if (!enabled) assert.equal(receipt, undefined, "ambient selection must never activate the feature");
        else {
          assert.ok(receipt, "the actual CLI loaded config must reach production composition");
          assert.equal(receipt.target_instance, "core", "observe the actual serving instance, not configured boot text");
          assert.equal(receipt.selected_state, "absent", "the selected fixture is not the actual serving core identity");
          assert.equal(receipt.publication_permission, "not-granted");
          assert.ok(!JSON.stringify(receipt).includes(selectionPath));
        }
      } finally { process.emit("SIGTERM"); assert.equal(await running, 0); }
    }
  } finally {
    console.log = consoleLog; console.error = consoleError;
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Every server owned by this case has returned from its normal shutdown before its fixture is removed.
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

test("serve boots on main, secures its logs 0600, and answers on the config-resolved interface", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.env.HOME = home;
  delete process.env.RMD_SERVE_HOST; // config.serve.* is the source under test

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));

  // No flags at all: port AND host must come from config alone, which is what the generated
  // launchd unit relies on (it bakes the port into argv and the hosts into RMD_SERVE_HOST —
  // both resolved by the SAME two functions this exercises).
  // `branch` injected as main: CI checks out a detached merge SHA, so neither the quiet path
  // nor the warning path would ever be DETERMINISTIC here without it (see the sibling test).
  let boardOpts: { ttlMs?: number; prewarmLeadMs?: number } | undefined;
  const running = serveCommand([], {
    branch: () => "main",
    buildBatchedGithub: (_owner, _repo, opts) => {
      boardOpts = opts;
      return fakeGitHub(BOARD_BRANCH_LISTS);
    },
  });
  t.after(() => {
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = oldHome;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  const banner = stdout.join("\n");
  assert.match(banner, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`), "config-resolved host:port, no flags");

  // R-5: the banner above carries the READ token, and under launchd stdout IS a file. The log
  // files must already be 0600 by the time anything is printed.
  const logs = serveLogPaths(root);
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600);
  assert.equal(statSync(logs.stderr).mode & 0o777, 0o600);

  // The console really answers — an authed request over the interface it just claimed.
  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${tokens.read}` } });
  assert.equal(res.status, 200, "an authed GET answers 200 on the bound interface");
  const unauthed = await fetch(`http://127.0.0.1:${port}/v1/status`);
  assert.equal(unauthed.status, 401, "…and an unauthed one does not");

  assert.doesNotMatch(stderr.join("\n"), /WARNING: this checkout is on branch/, "on main: no branch noise");
  // A warm on the TTL's own cadence must refresh ahead of it, or requests walk GitHub on the serving thread.
  assert.equal(boardOpts?.prewarmLeadMs, boardOpts?.ttlMs, "serve's board gateway warms one full cadence ahead of expiry");
  assert.ok((boardOpts?.prewarmLeadMs ?? 0) > 0);

  // SIGTERM is the shutdown launchd sends. It must return 0 — under KeepAlive:true the console
  // comes back from a clean exit too, which is why the unit does not use SuccessfulExit:false.
  process.emit("SIGTERM");
  assert.equal(await running, 0, "a clean signal shutdown returns 0");
});

test("a held port is WAITED OUT and, if it never frees, fails loudly instead of dying silently", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  // Somebody else already owns the port — the old process being reaped, in the real incident.
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));

  const stderr: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));
  t.after(() => {
    console.error = realErr;
    process.env.HOME = oldHome;
    squatter.close();
  });

  const rc = await serveCommand([], { branch: () => "main", bindRetry: { attempts: 3, delayMs: 5 }, buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });

  const said = stderr.join("\n");
  assert.match(said, /still held \(EADDRINUSE\), waiting for release \(attempt 1\)/, "it WAITS rather than dying on the first miss");
  assert.match(said, /attempt 2/);
  assert.match(said, /failed to listen on 127\.0\.0\.1:/, "and a port that never frees is a LOUD failure");
  assert.equal(rc, 1, "…with a non-zero exit, so launchd's ThrottleInterval paces the retry");

  // Silence is what made the original outage expensive: the ledger carries both the waiting
  // and the give-up, so `rmd ops` can see a bind fight that stderr scrolled away.
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.bind_retry"/);
  assert.match(ledger, /"step":"serve\.bind_failed"/);
});

test("an OFF-MAIN checkout warns loudly and SERVES ANYWAY — a KeepAlive'd service never refuses to boot", async (t) => {
  const port = await freePort();
  const { home } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.env.HOME = home;
  delete process.env.RMD_SERVE_HOST;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));

  const running = serveCommand([], { branch: () => "run-W1-T152", buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });
  t.after(() => {
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = oldHome;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);

  // THE FALSIFIER for W1-T152's original wording ("REFUSES to bind when not on main, exit
  // non-zero"): under this task's own launchd unit that refusal is a KeepAlive crash-loop —
  // the #726 daemon incident, re-created on the console. It binds, and it says so.
  assert.match(stdout.join("\n"), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`), "it BOUND despite being off main");
  const warned = stderr.join("\n");
  assert.match(warned, /WARNING: this checkout is on branch 'run-W1-T152', not 'main'/);
  assert.match(warned, /Serving anyway/);

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

// ── W1-T2303: the feedback-expansion rung, wired at boot ────────────────────────────────────
//
// PanelGraphDeps.expandFeedback was assigned nowhere in production — this is the boot-path half
// of that fix (the route's own fail-open legs are already covered, against a stub, by
// test/panel-graph.test.ts). Both tests below drive the REAL `serveCommand` construction (never
// a synthetic ServeDeps object) so the proof is that `rmd serve` itself resolves and threads the
// rung through, not merely that `buildPreviewFeedbackRoute` can be handed one.

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-feedback-expander-boot",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

/** A `Mounts` table whose routing table defines no routes at all — the shape
 *  `resolveRiskJudgeMount`/`resolveFeedbackExpansionMount` throws `MountsError` against
 *  ("no worker mount found in mounts.yaml routes"), i.e. "an install that resolves no mount". */
function noRouteMounts(): Mounts {
  const mount = { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1000 };
  return {
    tiers: { haiku: 0 },
    efforts: { medium: 0 },
    architect: mount,
    judge: mount,
    synthesis: { retro: mount, triage: mount, inbox_draft: mount },
    routes: {},
  };
}

test("serve resolves a real feedback-expansion rung at boot: a preview backed by the stubbed spawn arms a real four-section expansion, not null", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const expansionPayload = {
    claim: "the drain retry banner overlaps the status pill",
    evidence: "",
    recon: ["establish whether this reproduces at other viewport widths"],
    falsifying_check: "if the overlap does not reproduce on a fresh reload, this is a one-off render glitch",
  };
  let spawnCalls = 0;
  const spawn = async (): Promise<WorkerResult> => {
    spawnCalls++;
    return fakeWorkerResult(JSON.stringify(expansionPayload));
  };

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  const running = serveCommand([], { branch: () => "main", spawn, buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  assert.match(stdout.join("\n"), /listening on/, "boots exactly as before this task");

  // "resolved ONCE and threaded through": construction alone must not have spawned anything —
  // the rung is a real cost only on an operator-initiated preview click (design (iv)).
  assert.equal(spawnCalls, 0, "resolving the rung at boot must not itself spawn a worker");

  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { write: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/feedback/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.write}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "the console doesn't show me when spend is blocked" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { expansion: unknown };
  assert.deepEqual(body.expansion, expansionPayload, "the real expander (stubbed spawn) armed a real expansion, not { expansion: null }");
  assert.equal(spawnCalls, 1, "exactly one spawn per preview click");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.feedback_expander_resolved"/);

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

test("an install whose mounts table resolves no route boots UNCHANGED: preview still degrades to { expansion: null }, same fail-open as before this wiring", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  const running = serveCommand([], { branch: () => "main", loadMounts: () => noRouteMounts(), buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  assert.match(stdout.join("\n"), /listening on/, "a mount that fails to resolve must not crash-loop the whole console");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.feedback_expander_unavailable"/);
  assert.match(ledger, /no worker mount found in mounts\.yaml routes/);

  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { write: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/feedback/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.write}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { expansion: null }, "unresolved mount degrades exactly like an unset dep — never a 5xx, never a crash");

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

test("serve's banner never prints the read token, which a container writes to docker logs", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  const running = serveCommand([], { branch: () => "main", buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS) });
  t.after(async () => {
    process.emit("SIGTERM");
    await running;
    console.log = realLog;
    process.env.HOME = oldHome;
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("console:"))) await sleep(100);
  const banner = stdout.join("\n");
  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
  // W1-T4563: the daemon serves the /v1 gateway only; the banner names the console that exists.
  assert.match(banner, /console: {5}https:\/\/app\.remudero\.com \(this host serves the \/v1 gateway only\)/);
  assert.ok(!banner.includes(tokens.read), "the read token never reaches stdout");
});
