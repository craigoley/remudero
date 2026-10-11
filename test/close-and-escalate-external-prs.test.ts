import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { executeAdmissionDisposition, admissionDispositionStore, observeAdmissionDisposition,
  type AdmissionDispositionReceipt, type AdmissionDispositionStore,
  type AdmissionDispositionSimulation } from "../src/lib/action-executor.js";
import type { AdmissionRead, AdmissionSettings } from "../src/lib/contributor-admission.js";
import { ghShim } from "./helpers/gh-shim.js";
import { depReviewCommand, fixCommand, reviewCommand } from "./helpers/run-task-test.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";

const sha = "a".repeat(40);
const target = { owner: "acme", repo: "core", prNumber: 42, headSha: sha };
const settings: AdmissionSettings = { mode: "shadow", disposition: "shadow", repositoryId: 3,
  policy: { version: "fixture-v1", ownerIds: [1], organizationIds: [], services: [{ id: 2, actions: ["disposition"] }], maxEvidenceAgeMs: 60_000 },
  organizations: [] };
const NOW = Date.parse("2026-10-11T12:00:00Z");
const clock = { now: () => NOW };
const pull = (id = 8, head = sha, state = "open") => ({ id: 1042, number: 42, state, merged: false, merged_at: null,
  user: { id, type: id === 2 ? "Bot" : "User", login: `actor-${id}` },
  head: { sha: head, ref: "feature", repo: { id: 4, full_name: "outside/core", private: false } },
  base: { ref: "main", repo: { id: 3, full_name: "acme/core", private: false } } });

function memoryStore(domain: AdmissionDispositionStore["domain"] = "shadow") {
  const rows: AdmissionDispositionReceipt[] = [];
  const store: AdmissionDispositionStore = { domain,
    load: async cause => structuredClone(rows.filter(r => r.cause === cause)),
    append: async receipt => { assert.equal(receipt.sequence, rows.filter(r => r.cause === receipt.cause).length);
      rows.push(structuredClone(receipt)); } };
  return { store, rows };
}
function source(row: ReturnType<typeof pull> = pull()): AdmissionRead {
  return async path => ({ status: 200, body: path === "repos/acme/core" ? { id: 3, full_name: "acme/core", private: false }
    : path.includes("/pulls/") ? structuredClone(row) : {} });
}
function rehearsal() {
  let closes = 0, escalations = 0;
  const simulation: AdmissionDispositionSimulation = { domain: "rehearsal",
    simulateClose: async () => { closes++; }, simulateEscalation: async () => { escalations++; },
    reconcile: async () => ({ closed: closes > 0, escalated: escalations > 0 }) };
  return { simulation, counts: () => [closes, escalations] };
}

test("W1-T7755: close preflight rejects unknown trusted changed and terminal PRs", async () => {
  for (const [row, expected] of [[pull(1), "trusted"], [pull(2), "trusted"],
    [pull(8, "b".repeat(40)), "pending"], [pull(8, sha, "closed"), "noop"],
    [{ ...pull(), merged: true }, "noop"]] as const) {
    const { store } = memoryStore("rehearsal"); const sim = rehearsal();
    const result = await executeAdmissionDisposition({ settings, target }, store, source(row), () => {}, clock, sim.simulation);
    assert.equal(result.status, expected); assert.deepEqual(sim.counts(), [0, 0]);
    assert.equal(result.permission, "not-granted");
  }
  const { store } = memoryStore("rehearsal"); const sim = rehearsal();
  const result = await executeAdmissionDisposition({ settings, target }, store, async () => ({ status: 403, body: {} }), () => {}, clock, sim.simulation);
  assert.equal(result.status, "pending"); assert.deepEqual(sim.counts(), [0, 0]);
});

test("W1-T7755: close and escalation replay produces one durable terminal receipt", async () => {
  const { store, rows } = memoryStore("rehearsal"); const sim = rehearsal();
  const result = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock, sim.simulation);
  assert.equal(result.status, "simulated-closed");
  const replay = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock, sim.simulation);
  assert.equal(replay.status, "simulated-closed"); assert.deepEqual(sim.counts(), [1, 1]);
  assert.equal(rows.filter(r => r.status === "simulated-closed").length, 1);
  assert.equal(rows.at(-1)?.closeAttempts, 1); assert.equal(rows.at(-1)?.escalationAttempts, 1);
  assert.equal(rows.at(-1)?.domain, "rehearsal");
});

test("W1-T7755: unknown recovery is bounded without closing or blocking trusted PRs", async () => {
  const { store, rows } = memoryStore("rehearsal"); const sim = rehearsal(); let reads = 0;
  const outage: AdmissionRead = async () => { reads++; throw Error("unavailable"); };
  for (let attempt = 0; attempt < 5; attempt++) {
    const revision = { ...settings, policy: { ...settings.policy, version: `v${attempt}` } };
    await executeAdmissionDisposition({ settings: revision, target: { ...target, headSha: String(attempt).repeat(40) } }, store, outage, () => {}, clock, sim.simulation);
  }
  assert.equal(rows.at(-1)?.status, "owner-action"); assert.equal(rows.at(-1)?.identityAttempts, 3);
  assert.ok(reads <= 3); assert.deepEqual(sim.counts(), [0, 0]);
  assert.equal(rows.every(r => r.firstReason === rows[0].firstReason), true);
  const trusted = await executeAdmissionDisposition({ settings, target: { ...target, prNumber: 43 } }, store,
    async path => ({ status: 200, body: path.endsWith("/43") ? { ...pull(1), number: 43, id: 1043 }
      : { id: 3, full_name: "acme/core", private: false } }), () => {}, clock, sim.simulation);
  assert.equal(trusted.status, "trusted"); assert.equal(trusted.laneReleased, true);
});

test("W1-T7755: owner adoption resumes flow with honest required checks", async () => {
  const { store } = memoryStore();
  for (let i = 0; i < 3; i++) await executeAdmissionDisposition({ settings, target }, store,
    async () => ({ status: 503, body: {} }), () => {}, clock);
  const instruction = { id: 9, user: { id: 1, type: "User" }, updated_at: new Date(NOW).toISOString(),
    issue_url: "https://api.github.com/repos/acme/core/issues/42", body: `Remudero-Admission: adopt 3/42@${sha}` };
  const read: AdmissionRead = async path => path.endsWith("/comments/9") ? { status: 200, body: instruction } : source()(path);
  const adopted = await executeAdmissionDisposition({ settings, target, ownerInstructionId: 9 }, store, read, () => {}, clock);
  assert.equal(adopted.status, "adopted"); assert.equal(adopted.laneReleased, true);
  assert.equal(adopted.requiredChecks, "ordinary-current-head-checks-required");
  assert.equal(adopted.permission, "not-granted");
  const bad = await executeAdmissionDisposition({ settings, target: { ...target, headSha: "b".repeat(40) }, ownerInstructionId: 9 }, store, read, () => {}, clock);
  assert.notEqual(bad.status, "adopted");
});

test("W1-T7755: shadow and absent config never invoke disposable effects", async () => {
  const { store } = memoryStore(); let reads = 0;
  const read: AdmissionRead = async path => { reads++; return source()(path); };
  const absent = await executeAdmissionDisposition({ target }, store, read, () => {}, clock);
  assert.equal(absent.status, "not-enabled"); assert.equal(reads, 0);
  const observed = await executeAdmissionDisposition({ settings, target }, store, read, () => {}, clock);
  assert.equal(observed.status, "would-close"); assert.equal(observed.permission, "not-granted");
});

test("W1-T7755: persistent history cannot reset when its record disappears or its last bytes change", async () => {
  for (const damage of ["missing", "changed", "truncated", "gap"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rmd-disposition-journal-"));
    try {
      const store = admissionDispositionStore(root);
      const first = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock);
      assert.equal(first.status, "would-close");
      const directory = join(root, "state", "contributor-disposition", "shadow", first.receipt!.cause);
      const names = readdirSync(directory).filter(f => f.endsWith(".json")).sort();
      if (damage === "missing") for (const file of names) unlinkSync(join(directory, file));
      if (damage === "gap") unlinkSync(join(directory, names[0]));
      if (damage === "truncated") writeFileSync(join(directory, names.at(-1)!), "{");
      if (damage === "changed") {
        const file = join(directory, names.at(-1)!);
        writeFileSync(file, readFileSync(file, "utf8").replace("not-admitted", "unlisted-service"));
      }
      let reads = 0;
      const replay = await executeAdmissionDisposition({ settings, target }, admissionDispositionStore(root), async path => {
        reads++; return source()(path);
      }, () => {}, clock);
      assert.equal(replay.status, "owner-action", damage); assert.equal(replay.reason, "journal-unreadable");
      assert.equal(reads, 0, "bad history is not an empty new budget");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("W1-T7755: lost close and escalation acknowledgements reconcile without repeating effects", async () => {
  for (const lost of ["close", "escalation", "unresolved", "unreadable"] as const) {
    const { store, rows } = memoryStore("rehearsal"); let closes = 0, escalations = 0;
    const simulation: AdmissionDispositionSimulation = { domain: "rehearsal",
      simulateClose: async () => { closes++; if (lost !== "escalation") throw Error("lost response"); },
      simulateEscalation: async () => { escalations++; if (lost === "escalation") throw Error("lost response"); },
      reconcile: async () => { if (lost === "unreadable") throw Error("unreadable");
        return { closed: lost !== "unresolved", escalated: escalations > 0 }; } };
    const first = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock, simulation);
    assert.equal(first.status, "pending");
    let current = first;
    for (let i = 0; i < 4; i++) current = await executeAdmissionDisposition({ settings: { ...settings,
      policy: { ...settings.policy, version: `new-${i}` } }, target: { ...target, headSha: "b".repeat(40) } },
    store, source(), () => {}, clock, simulation);
    assert.equal(closes, 1); assert.equal(escalations, lost === "close" || lost === "escalation" ? 1 : 0);
    assert.equal(current.status, lost === "close" || lost === "escalation" ? "simulated-closed" : "owner-action");
    assert.ok(rows.at(-1)!.reconciliationAttempts <= 2); assert.equal(current.laneReleased, true);
  }
});

test("W1-T7755: failed durable intent and concurrent stale snapshots never duplicate simulated effects", async () => {
  const failure = memoryStore("rehearsal"), sim = rehearsal();
  const refused = await executeAdmissionDisposition({ settings, target }, { ...failure.store,
    append: async () => { throw Error("disk unavailable"); } }, source(), () => {}, clock, sim.simulation);
  assert.equal(refused.status, "owner-action"); assert.deepEqual(sim.counts(), [0, 0]);
  const root = mkdtempSync(join(tmpdir(), "rmd-disposition-race-"));
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => executeAdmissionDisposition({ settings, target },
      admissionDispositionStore(root, "rehearsal"), source(), () => {}, clock, sim.simulation)));
    assert.ok(results.every(r => r.permission === "not-granted"));
    assert.ok(sim.counts().every(count => count <= 1));
    const replay = await executeAdmissionDisposition({ settings, target }, admissionDispositionStore(root, "rehearsal"), source(), () => {}, clock, sim.simulation);
    assert.notEqual(replay.reason, "journal-unreadable", "exclusive complete records form an intact chain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7755: simulated success cannot deserialize as production authority", async () => {
  const rehearsalStore = memoryStore("rehearsal"), sim = rehearsal();
  await executeAdmissionDisposition({ settings, target }, rehearsalStore.store, source(), () => {}, clock, sim.simulation);
  const mixed = await executeAdmissionDisposition({ settings, target }, { domain: "shadow",
    load: async () => rehearsalStore.rows, append: async () => assert.fail("mixed evidence cannot append") }, source(), () => {}, clock);
  assert.equal(mixed.reason, "journal-unreadable"); assert.equal(mixed.permission, "not-granted");
  const invalid = await executeAdmissionDisposition({ settings, target }, memoryStore().store, source(), () => {}, clock, sim.simulation);
  assert.equal(invalid.reason, "domain-mismatch"); assert.deepEqual(sim.counts(), [1, 1]);
});

test("W1-T7755: final post-intent recheck catches changed origin private targets and policy", async () => {
  for (const change of ["head", "actor", "private", "policy"] as const) {
    const { store, rows } = memoryStore("rehearsal"), sim = rehearsal();
    const policy = structuredClone(settings); let changed = false;
    const wrapped: AdmissionDispositionStore = { ...store, append: async receipt => {
      await store.append(receipt); if (receipt.stage === "close") {
        changed = true; if (change === "policy") policy.policy.version = "revised";
      }
    } };
    const read: AdmissionRead = async path => {
      const response = await source(changed && change === "head" ? pull(8, "b".repeat(40)) : changed && change === "actor" ? pull(1) : pull())(path);
      if (changed && change === "private" && path === "repos/acme/core") response.body = { id: 3, full_name: "acme/core", private: true };
      return response;
    };
    const result = await executeAdmissionDisposition({ settings: policy, target }, wrapped, read, () => {}, clock, sim.simulation);
    assert.equal(result.status, "owner-action"); assert.deepEqual(sim.counts(), [0, 0]);
    assert.equal(rows.at(-1)?.closeAttempts, 1, "reserved intent does not replenish on a changed head");
  }
});

test("W1-T7755: real asynchronous default and private journal leave the event loop responsive", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-disposition-default-"));
  const shim = ghShim([{ when: "api repos/acme/core/pulls/42 -i", stdout: `HTTP/2 200 OK\n\n${JSON.stringify(pull())}` },
    { when: "api repos/acme/core -i", stdout: 'HTTP/2 200 OK\n\n{"id":3,"full_name":"acme/core","private":false}', delaySeconds: 0.1 }]);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${previousPath}`;
    let finished = false;
    const pending = observeAdmissionDisposition(settings, target, root, () => {}, undefined, undefined, clock).finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(finished, false);
    const observed = await pending;
    assert.equal(observed?.status, "would-close"); assert.equal(observed?.receipt?.domain, "shadow");
    assert.ok(shim.calls().every(call => call.startsWith("api ") && !/--method|-X|pr close|comment/.test(call)));
    assert.equal((await admissionDispositionStore(root).load(observed!.receipt!.cause)).at(-1)?.status, "would-close");
  } finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); rmSync(shim.dir, { recursive: true, force: true }); }
});

test("W1-T7755: absent shadow disposition does no disk work and a symlink cannot redirect its journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-disposition-path-"));
  try {
    await observeAdmissionDisposition(undefined, target, root, () => assert.fail("off means no rows"));
    await observeAdmissionDisposition({ ...settings, disposition: undefined }, target, root, () => assert.fail("not enabled"));
    assert.deepEqual(readdirSync(root), []);
    mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(root, "state"));
    const result = await observeAdmissionDisposition(settings, target, root, () => {}, undefined, source(), clock);
    assert.equal(result?.reason, "journal-unreadable"); assert.deepEqual(readdirSync(join(root, "elsewhere")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7755: selected sweep and CLI callers record shadow disposition without withholding ordinary effects", async () => {
  for (const caller of ["sweep", "dep-review", "review", "fix"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rmd-disposition-caller-"));
    const sourceHead = caller === "review" ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() : sha;
    const shim = ghShim([{ when: "api repos/acme/core/pulls/42 -i", stdout: `HTTP/2 200 OK\n\n${JSON.stringify(pull(8, sourceHead))}` },
      { when: "api repos/acme/core -i", stdout: 'HTTP/2 200 OK\n\n{"id":3,"full_name":"acme/core","private":false}' }]);
    const previousPath = process.env.PATH; const config = { root, contributorAdmission: settings, claudeBin: "/bin/true" } as Config;
    const events: string[] = [];
    try {
      process.env.PATH = `${shim.dir}:${previousPath}`;
      if (caller === "sweep") {
        const pr: OpenPrView = { prNumber: 42, prUrl: "https://github.com/acme/core/pull/42", taskId: "W1-T7755", headSha: sha,
          reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
          lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false };
        const effects = buildSweepEffects({ owner: "acme", repo: "core", config, ledgerPath: join(root, "ledger.ndjson"),
          runId: "test", plan: { tasks: [], byId: new Map() } as Plan, policy: DEFAULT_SWEEP_POLICY,
          log: step => events.push(step), contributorAdmissionImpl: async () => {}, reviewRunner: async () => { events.push("ordinary-review"); return 0; } });
        await effects.postReview!(pr);
        assert.ok(events.includes("contributor_disposition.shadow")); assert.ok(events.includes("ordinary-review"));
      } else if (caller === "dep-review") {
        await assert.rejects(depReviewCommand("42", ["--repo", "acme/core"], { config, contributorAdmission: async () => {},
          gh: () => ({ number: 42, url: "https://github.com/acme/core/pull/42", headRefOid: sha }),
          prDiff: () => { events.push("ordinary-diff"); throw Error("effect trap"); } }));
        assert.ok(events.includes("ordinary-diff"));
      } else if (caller === "fix") {
        assert.equal(await fixCommand(["42"], { config, self: { owner: "acme", repo: "core" }, contributorAdmission: async () => {},
          fetch: () => { events.push("ordinary-fix-read"); throw Error("effect trap"); } }), 1);
        assert.ok(events.includes("ordinary-fix-read"));
      } else {
        await assert.rejects(reviewCommand("42", ["--repo", "acme/core"], { loadConfig: () => config,
          resolveOwnerRepo: () => ({ owner: "acme", repo: "core" }), contributorAdmission: async () => {},
          fetchView: () => ({ ...pull(8, sourceHead), body: "Remudero-Task: W1-T7755", html_url: "https://github.com/acme/core/pull/42" }),
          reviewerCodeFreshness: () => ({ status: "fresh", codeSha: sha, originMainSha: sha, advance: "none" }),
          postReviewPending: async () => ({ posted: true }) as never, fetchHead: () => {},
          materialize: () => { events.push("ordinary-materialize"); throw Error("effect trap"); } }));
        assert.ok(events.includes("ordinary-materialize"));
      }
      assert.ok(shim.calls().length >= 5, `${caller} drives the actual default disposition source reader`);
      assert.ok(shim.calls().every(call => !/--method|-X|pr close|issue comment/.test(call)));
      const directories = readdirSync(join(root, "state", "contributor-disposition", "shadow"));
      assert.ok(directories.some(name => name.endsWith(".registered")));
    } finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); rmSync(shim.dir, { recursive: true, force: true }); }
  }
});

test("W1-T7755: healthy replay does not exhaust unknown recovery or claim a new current assessment", async () => {
  for (const actor of [1, 8]) {
    const { store, rows } = memoryStore();
    const first = await executeAdmissionDisposition({ settings, target }, store, source(pull(actor)), () => {}, clock);
    assert.equal(first.status, actor === 1 ? "trusted" : "would-close");
    for (let i = 0; i < 6; i++) {
      const replay = await executeAdmissionDisposition({ settings, target: { ...target, headSha: "b".repeat(40) } }, store,
        () => assert.fail("retained terminal is not another recovery attempt or authority grant"), () => {}, clock);
      assert.equal(replay.status, first.status);
      assert.equal(replay.permission, "not-granted");
      assert.equal(replay.evidence, "retained");
    }
    assert.equal(rows.at(-1)?.identityAttempts, 1);
    assert.equal(rows.filter(r => r.status === "owner-action").length, 0);
  }
});

test("W1-T7755: a changed owner instruction and broken observation cannot become adoption or a hold", async () => {
  const { store } = memoryStore();
  for (let i = 0; i < 3; i++) await executeAdmissionDisposition({ settings, target }, store,
    async () => ({ status: 503, body: {} }), () => {}, clock);
  let comments = 0;
  const instruction = { id: 9, user: { id: 1, type: "User" }, updated_at: new Date(NOW).toISOString(),
    issue_url: "https://api.github.com/repos/acme/core/issues/42", body: `Remudero-Admission: adopt 3/42@${sha}` };
  const read: AdmissionRead = async path => path.endsWith("/comments/9")
    ? { status: 200, body: { ...instruction, body: ++comments === 1 ? instruction.body : "withdrawn" } } : source()(path);
  const changed = await executeAdmissionDisposition({ settings, target, ownerInstructionId: 9 }, store, read, () => {}, clock);
  assert.equal(changed.reason, "owner-target-changed"); assert.notEqual(changed.status, "adopted");
  const root = mkdtempSync(join(tmpdir(), "rmd-disposition-broken-"));
  try {
    const invalid = structuredClone(settings); (invalid as unknown as Record<string, unknown>).cycle = invalid;
    const unknown = await observeAdmissionDisposition(invalid, target, root, () => { throw Error("log offline"); }, undefined, source(), clock);
    assert.equal(unknown?.status, "owner-action"); assert.equal(unknown?.permission, "not-granted");
    assert.equal(unknown?.laneReleased, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
