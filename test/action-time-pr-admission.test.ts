import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyContribution, readAdmissionRest, readAdmissionRestAsync, type AdmissionSettings, type AdmissionRead } from "../src/lib/contributor-admission.js";
import { observeContributorAdmission, observeContributorAdmissionSync } from "../src/lib/arm-auto-merge.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { validateConfigShape } from "../src/lib/config-schema.js";
import { buildSweepEffects, reviewCommand, depReviewCommand, fixCommand } from "../src/run-task.js";
import { attemptArmAsync, armAutoMergeAtOpenAsync, armAutoMergeDetailedAsync, realArmDeps, realArmDepsAsync } from "../src/lib/arm-auto-merge.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView, buildSweepEffects as libSweepEffects } from "../src/lib/sweep.js";
import { ghShim } from "./helpers/gh-shim.js";

const sha = "a".repeat(40);
const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).trim();
const target = { owner: "example", repo: "core", prNumber: 42, headSha: sha };
const settings: AdmissionSettings = { mode: "shadow", repositoryId: 3,
  policy: { version: "v1", ownerIds: [1], organizationIds: [9], services: [{ id: 2, actions: ["review", "auto-merge"] }], maxEvidenceAgeMs: 100 },
  organizations: [{ id: 9, login: "example-org" }] };
const row = (id = 1, type = "User", head = sha) => ({ number: 42, state: "open", user: { id, type, login: `actor-${id}` },
  head: { sha: head, repo: { id: 4 } }, base: { repo: { id: 3 } } });
const pr = (): OpenPrView => ({ prNumber: 42, prUrl: "https://github.com/example/core/pull/42", taskId: "W1-T7753",
  headSha: sha, reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: "2026-10-10T00:00:00Z", autoMergeArmed: false });

test("W1-T7753: direct and sweep PR actions share fresh admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-action-admission-"));
  const calls: string[] = [];
  const observer = async (_t: unknown, action: string) => { calls.push(`admission:${action}`); };
  const config = { root, claudeBin: "/bin/true" } as Config;
  try {
    const effects = buildSweepEffects({ owner: "example", repo: "core", config, ledgerPath: join(root, "ledger.ndjson"),
      runId: "test", plan: { tasks: [], byId: new Map() } as Plan, policy: DEFAULT_SWEEP_POLICY,
      log: () => {}, contributorAdmissionImpl: observer, reviewRunner: async () => { calls.push("review"); return 0; },
      armImpl: () => { calls.push("arm"); return "armed"; }, depReviewCommandImpl: async () => { calls.push("dependency"); return 0; },
      ghLiveStateImpl: () => ({ ok: true, state: "CLOSED" }), armSessionPrsOverride: false,
      ghJsonImpl: () => ({ headRefName: "run-W1-T7753-1", headRefOid: sha, body: "Remudero-Task: W1-T7753", files: [] }),
      readJsonImpl: async () => ({ headRefName: "run-W1-T7753-1", headRefOid: sha, body: "Remudero-Task: W1-T7753", files: [] }) });
    await effects.postReview!(pr());
    await effects.depReview!(pr());
    await effects.arm!(pr());
    await effects.dispatchFix!(pr(), {} as never);
    const planEffects = effects as ReturnType<typeof libSweepEffects>;
    await planEffects.dispatchPlanOnlyRepair!({ ...pr(), taskId: undefined }, { proofs: [] } as never);
    assert.deepEqual(calls, ["admission:review", "review", "admission:review", "dependency", "admission:auto-merge", "arm", "admission:repair", "admission:repair"]);

    calls.length = 0;
    await assert.rejects(reviewCommand("42", ["--repo", "example/core"], { loadConfig: () => config,
      resolveOwnerRepo: () => ({ owner: "example", repo: "core" }), fetchView: () => ({ ...row(1, "User", checkoutSha), body: "Remudero-Task: W1-T7753", html_url: pr().prUrl }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: sha, originMainSha: sha, advance: "none" }),
      postReviewPending: async () => ({ posted: true }) as never, fetchHead: () => {},
      contributorAdmission: observer, materialize: () => { calls.push("materialize"); throw Error("effect trap"); } }));
    assert.equal(calls[0], "admission:review");
    assert.ok(calls.includes("materialize"));
    calls.length = 0;
    await assert.rejects(depReviewCommand("42", ["--repo", "example/core"], { config,
      gh: () => ({ number: 42, url: pr().prUrl, headRefOid: sha }), contributorAdmission: observer,
      prDiff: () => { calls.push("dependency-diff"); throw Error("effect trap"); } }));
    assert.deepEqual(calls, ["admission:review", "dependency-diff"]);
    calls.length = 0;
    assert.equal(await fixCommand(["42"], { config, self: { owner: "example", repo: "core" },
      contributorAdmission: observer, fetch: () => { calls.push("fix-read"); throw Error("effect trap"); } }), 1);
    assert.deepEqual(calls, ["admission:repair", "fix-read"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7753: owner override and scoped trusted flows do not require another reviewer", async () => {
  for (const [id, type, reason] of [[1, "User", "owner"], [2, "Bot", "scoped-service"]] as const) {
    const records: Record<string, unknown>[] = [];
    await observeContributorAdmission(settings, target, "auto-merge", (_step, fields) => records.push(fields), async () => ({ status: 200, body: row(id, type) }), clockFromMillisFn(() => 10));
    assert.equal(records[0].outcome, "trusted");
    assert.equal(records[0].reason, reason);
    assert.equal(records[0].mode, "shadow");
  }
  const scoped = classifyContribution({ repositoryId: 3, prNumber: 42, headSha: sha, observedAtMs: 10, origin: { actor: { id: 2, type: "Bot" }, headRepository: { id: 4 }, targetRepository: { id: 3 } } }, "repair", settings.policy, [], 10);
  assert.equal(scoped.outcome, "unknown");
});

test("W1-T7753: stale admission is isolated to its PR and head", async () => {
  const records: Record<string, unknown>[] = [];
  let reads = 0;
  await observeContributorAdmission(settings, target, "review", (_step, fields) => records.push(fields), async () => ({ status: 200, body: row(1, "User", ++reads === 1 ? sha : "b".repeat(40)) }), clockFromMillisFn(() => 10));
  assert.equal(records[0].reason, "head-changed");
  await observeContributorAdmission(settings, target, "review", (_step, fields) => records.push(fields), async () => ({ status: 200, body: row() }), clockFromMillisFn(() => 10));
  assert.equal(records[1].outcome, "trusted");
  assert.notEqual(records[0].receiptKey, records[1].receiptKey);
});

test("W1-T7753: shadow evaluation leaves trusted PR effects unchanged", async () => {
  const calls: string[] = [];
  const deps = { headSha: async () => sha, ledgerLines: () => [{ task_id: "W1-T7753", step: "review.posted", state: "success", head_sha: sha, pr_url: pr().prUrl }],
    contributorAdmission: async () => { calls.push("shadow"); }, armAuto: async () => { calls.push("arm"); },
    mergeDirect: async () => { calls.push("merge"); }, disableAuto: async () => {}, say: () => {} };
  assert.equal((await attemptArmAsync(pr().prUrl, deps)).outcome, "armed");
  assert.equal(await armAutoMergeAtOpenAsync(pr().prUrl, deps), "armed");
  assert.equal((await armAutoMergeDetailedAsync(pr().prUrl, "W1-T7753", deps)).outcome, "armed");
  assert.deepEqual(calls, ["shadow", "arm", "shadow", "arm", "shadow", "arm"]);
  calls.length = 0;
  assert.equal((await attemptArmAsync(pr().prUrl, { ...deps, armAuto: async () => { calls.push("refused-arm"); throw Error("clean status"); } })).outcome, "direct-merged");
  assert.ok(calls.includes("merge"));
  assert.equal(calls.at(-2), "shadow", "fallback merge also revalidates");
});

test("membership 404 requires a numeric identity-bound positive control; outages and missing origins remain unknown", async () => {
  for (const capable of [false, true]) {
    const records: Record<string, unknown>[] = [];
    const read: AdmissionRead = async (path) => path.includes("/pulls/") ? { status: 200, body: row(8) }
      : path === "user" ? { status: 200, body: { id: 1, login: "operator", type: "User" } }
      : path.endsWith("/operator") && capable ? { status: 200, body: { state: "active", user: { id: 1 }, organization: { id: 9 } } }
      : { status: 404, body: {} };
    await observeContributorAdmission(settings, target, "review", (_s, f) => records.push(f), read, clockFromMillisFn(() => 10));
    assert.equal(records[0].outcome, capable ? "confirmed-external" : "unknown");
  }
  const records: Record<string, unknown>[] = [];
  await observeContributorAdmission(settings, target, "repair", (_s, f) => records.push(f), async () => { throw Error("timeout"); }, clockFromMillisFn(() => 10));
  assert.equal(records[0].reason, "origin-unreadable");
  await observeContributorAdmission(settings, target, "repair", (_s, f) => records.push(f), async () => ({ status: 200, body: { number: 42, head: { sha }, base: { repo: { id: 3 } } } }), clockFromMillisFn(() => 10));
  assert.equal(records[1].outcome, "unknown");
});

test("shadow config has no default identities and cannot opt into enforcement", async () => {
  assert.equal(validateConfigShape({ root: "/tmp", claudeBin: "/bin/true", contributorAdmission: settings }, "test").contributorAdmission?.mode, "shadow");
  assert.throws(() => validateConfigShape({ root: "/tmp", claudeBin: "/bin/true", contributorAdmission: { ...settings, mode: "enforce" } }, "test"));
  await observeContributorAdmission(undefined, target, "repair", () => assert.fail("disabled means no records"), () => assert.fail("disabled means no reads"));
});

test("repeated organization policy ids cannot multiply admission reads", async () => {
  let membershipReads = 0;
  const repeated = { ...settings, policy: { ...settings.policy, version: "bounded-repeat", organizationIds: [9, 9, 9] } };
  const records: Record<string, unknown>[] = [];
  await observeContributorAdmission(repeated, target, "review", (_step, fields) => records.push(fields), (path) => {
    if (path.includes("/pulls/")) return { status: 200, body: row(8) };
    membershipReads++;
    return { status: 200, body: { state: "pending", user: { id: 8 }, organization: { id: 9 } } };
  }, clockFromMillisFn(() => 10));
  assert.equal(membershipReads, 1);
  assert.equal(records[0].outcome, "confirmed-external");
});

test("real synchronous and asynchronous arm defaults observe configured shadow policy without reaching GitHub", async () => {
  const shim = ghShim([{ when: "", stdout: `HTTP/2 200 OK\ncontent-type: application/json\n\n${JSON.stringify(row())}` }], { kind: "admission-arm-default" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    const config = { root: "/tmp", claudeBin: "/bin/true", contributorAdmission: settings };
    realArmDeps(() => config).contributorAdmission!(pr().prUrl, sha);
    await realArmDepsAsync(() => config).contributorAdmission!(pr().prUrl, sha);
    assert.ok(shim.calls().some((args) => args.includes("repos/example/core/pulls/42")));
  } finally { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); }
});

test("membership cache is positive-only, expires, and never caches PR heads or other policy versions", async () => {
  let now = 10;
  let memberships = 0;
  let pulls = 0;
  const records: Record<string, unknown>[] = [];
  const policy = { ...settings, policy: { ...settings.policy, version: "cache-test" } };
  const read: AdmissionRead = (path) => {
    if (path.includes("/pulls/")) { pulls++; return { status: 200, body: row(8) }; }
    memberships++;
    return { status: 200, body: { user: { id: 8 }, organization: { id: 9 }, state: "active" } };
  };
  const run = (s = policy) => observeContributorAdmission(s, target, "review", (_s, f) => records.push(f), read, clockFromMillisFn(() => now));
  await run(); await run();
  assert.equal(memberships, 1); assert.equal(pulls, 4);
  now = 111; await run(); assert.equal(memberships, 2);
  await run({ ...policy, policy: { ...policy.policy, version: "cache-test-v2" } }); assert.equal(memberships, 3);
  assert.ok(records.every((r) => r.outcome === "trusted"));
  for (const state of ["pending", "garbage"]) {
    let count = 0;
    const s = { ...policy, policy: { ...policy.policy, version: `negative-${state}` } };
    const negative: AdmissionRead = (path) => path.includes("/pulls/") ? { status: 200, body: row(8) }
      : (++count, { status: 200, body: { user: { id: 8 }, organization: { id: 9 }, state } });
    await observeContributorAdmission(s, target, "review", () => {}, negative, clockFromMillisFn(() => now));
    await observeContributorAdmission(s, target, "review", () => {}, negative, clockFromMillisFn(() => now));
    assert.equal(count, 2);
  }
});

test("action-time reconciliation names invalid, changed, stale and unreadable contexts without effects", async () => {
  const scenarios = [
    { first: { status: 404, body: {} }, reason: "origin-unreadable" },
    { first: { status: 200, body: { ...row(), number: 43 } }, reason: "pr-context-changed" },
    { first: { status: 200, body: { ...row(), state: "closed" } }, reason: "pr-context-changed" },
    { first: { status: 200, body: row(1, "User", "b".repeat(40)) }, reason: "head-changed" },
    { second: { status: 500, body: {} }, reason: "origin-recheck-unreadable" },
    { second: Error("transport"), reason: "origin-recheck-unreadable" },
    { second: { status: 200, body: { ...row(), user: { id: 8, type: "User" } } }, reason: "origin-changed" },
  ];
  for (const scenario of scenarios) {
    let count = 0;
    let reason: unknown;
    await observeContributorAdmission(settings, target, "review", (_s, f) => { reason = f.reason; }, () => {
      const response = ++count === 1 ? scenario.first : scenario.second;
      if (response instanceof Error) throw response;
      return response ?? { status: 200, body: row() };
    }, clockFromMillisFn(() => 10));
    assert.equal(reason, scenario.reason);
  }
  for (const bad of [{ ...settings, mode: "enforce" }, { ...settings, organizations: [{ id: 9, login: "bad/namespace" }] }]) {
    let reason: unknown;
    await observeContributorAdmission(bad as AdmissionSettings, target, "review", (_s, f) => { reason = f.reason; }, () => assert.fail("invalid settings never read"), clockFromMillisFn(() => 10));
    assert.equal(reason, "invalid-action-config");
  }
  let now = 0;
  let reason: unknown;
  await observeContributorAdmission(settings, target, "review", (_s, f) => { reason = f.reason; }, () => { now += 101; return { status: 200, body: row() }; }, clockFromMillisFn(() => now));
  assert.equal(reason, "stale-action-evidence");
  const mutable = structuredClone(settings);
  let count = 0;
  await observeContributorAdmission(mutable, target, "review", (_s, f) => { reason = f.reason; }, () => {
    if (++count === 2) mutable.policy.version = "v2";
    return { status: 200, body: row() };
  }, clockFromMillisFn(() => 10));
  assert.equal(reason, "policy-changed");
});

test("membership namespace mismatches and read errors never admit or close a PR", async () => {
  for (const response of [Error("outage"), { status: 403, body: {} }, { status: 200, body: { user: { id: 8 }, organization: { id: 99 }, state: "active" } }]) {
    let outcome: unknown;
    await observeContributorAdmission({ ...settings, policy: { ...settings.policy, version: `unknown-${String(response)}` } }, target, "repair", (_s, f) => { outcome = f.outcome; }, (path) => {
      if (path.includes("/pulls/")) return { status: 200, body: row(8) };
      if (response instanceof Error) throw response;
      return response;
    }, clockFromMillisFn(() => 10));
    assert.equal(outcome, "unknown");
  }
});

test("default REST adapters retain real HTTP errors and distinguish unreadable response bytes", async () => {
  const shim = ghShim([
    { when: "api not-found", stdout: 'HTTP/2 404 Not Found\ncontent-type: application/json\n\n{"message":"Not Found"}', exit: 1 },
    { when: "api malformed", stdout: 'HTTP/2 200 OK\ncontent-type: application/json\n\nnot json' },
    { when: "api unavailable", stderr: "HTTP 404", exit: 1 },
    { when: "", stdout: "no response headers" },
  ], { kind: "admission-response" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    for (const reader of [readAdmissionRest, readAdmissionRestAsync]) {
      assert.equal((await reader("not-found")).status, 404);
      for (const path of ["malformed", "unavailable", "missing-header"]) assert.equal((await reader(path)).status, 0);
    }
    observeContributorAdmissionSync(undefined, target, "review", () => assert.fail("disabled"));
    observeContributorAdmissionSync(settings, target, "review", (_s, f) => assert.equal(f.reason, "origin-unreadable"), () => ({ status: 0, body: undefined }));
    realArmDeps(() => { throw Error("missing config"); }).contributorAdmission!(pr().prUrl);
    await realArmDepsAsync(() => { throw Error("missing config"); }).contributorAdmission!(pr().prUrl);
    realArmDeps(() => assert.fail("invalid url never reads config")).contributorAdmission!("not-a-url");
  } finally { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); }
});

test("default direct and sweep wiring records shadow results before protected effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-default-admission-"));
  const shim = ghShim([{ when: "", stdout: `HTTP/2 200 OK\ncontent-type: application/json\n\n${JSON.stringify(row(1, "User", checkoutSha))}` }], { kind: "default-admission" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const config = { root, claudeBin: "/bin/true", contributorAdmission: settings };
  try {
    const events: string[] = [];
    const effects = buildSweepEffects({ owner: "example", repo: "core", config, ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "default", plan: { tasks: [], byId: new Map() } as Plan, policy: DEFAULT_SWEEP_POLICY,
      log: (event) => events.push(event), reviewRunner: async () => { events.push("effect"); return 0; } });
    await effects.postReview!({ ...pr(), headSha: checkoutSha });
    assert.equal(events[0], "contributor_admission.shadow");
    assert.ok(events.includes("effect"));
    await assert.rejects(reviewCommand("42", ["--repo", "example/core"], {
      loadConfig: () => config, resolveOwnerRepo: () => ({ owner: "example", repo: "core" }),
      fetchView: () => ({ ...row(1, "User", checkoutSha), body: "Remudero-Task: W1-T7753", html_url: pr().prUrl }), fetchHead: () => {},
      postReviewPending: async () => ({ posted: true }) as never,
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: checkoutSha, originMainSha: checkoutSha, advance: "none" }),
      materialize: () => { throw Error("effect trap"); },
    }));
    await assert.rejects(depReviewCommand("42", ["--repo", "example/core"], { config,
      gh: () => ({ number: 42, url: pr().prUrl, headRefOid: checkoutSha }), prDiff: () => { throw Error("effect trap"); } }));
    assert.equal(await fixCommand(["42"], { config, self: { owner: "example", repo: "core" }, fetch: () => { throw Error("effect trap"); } }), 1);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(rows.filter((r) => r.step === "contributor_admission.shadow").map((r) => r.action), ["review", "review", "repair"]);
    assert.ok(shim.calls().length >= 8, "every entry reconciles current origin independently");
  } finally { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
