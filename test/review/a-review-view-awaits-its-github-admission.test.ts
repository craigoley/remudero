import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewCommand, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { ghReadCadenceStampPath, stampGhRead, withDaemonGhTransportFloor } from "#src/lib/github-transport.js";
import type { Config } from "#src/lib/config.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET = { owner: "audit", repo: "fixture-target", prNumber: 7, headSha: SHA };
const CLOSED = { number: 7, state: "closed", html_url: "https://github.com/audit/fixture-target/pull/7",
  head: { sha: SHA, ref: "fixture-branch" }, merged_at: null };
const BRANCH = { number: 7, headRefOid: SHA, headRefName: "fixture-branch", body: "",
  url: "https://github.com/audit/fixture-target/pull/7" };
const HTTP = (row: unknown) => `HTTP/2.0 200 OK\n\n${JSON.stringify(row)}`;
function numericRoutes(row: unknown): GhShimRoute[] {
  return [
    { when: "api repos/audit/fixture-target/pulls/7 -i", stdout: HTTP(row) },
    { when: "api repos/audit/fixture-target/pulls/7", stdout: JSON.stringify(row) },
  ];
}
type Deps = NonNullable<Parameters<typeof reviewCommand>[3]>;

async function fixture<T>(routes: GhShimRoute[], body: (f: {
  root: string; shim: ReturnType<typeof ghShim>; counts: Record<string, number>;
  run: (pr?: string, overrides?: Deps) => Promise<number>;
}) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-initial-review-"));
  const shim = ghShim([...routes, { when: "", stderr: "unexpected private gh invocation", exit: 93 }]);
  const saved = { ...process.env };
  const counts = { fetch: 0, materialize: 0, review: 0, pending: 0, terminal: 0, admission: 0 };
  const forbidden = (kind: keyof typeof counts): never => { counts[kind]++; throw new Error(`unexpected downstream ${kind}`); };
  const host = {
    // Reading an existing attempt id during flag parsing neither acquires a claim nor starts work.
    acceptedReviewAttemptId: () => undefined,
    materializeReviewWorktree: () => forbidden("materialize"),
    realDeps: () => ({ reviewWorktree: { fetch: () => forbidden("fetch") } }),
    reviewPostedDescription: () => "private initial view fixture",
  } as unknown as ReviewCommandHost;
  try {
    for (const key of ["RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY_DIGEST",
      "RMD_INSTANCE_REGISTRY_FILE_BINDING", "REMUDERO_RUN_ID"]) delete process.env[key];
    Object.assign(process.env, { PATH: `${shim.dir}:${saved.PATH}`, RMD_GH_CACHE_HOME: join(root, "gh-cache"),
      RMD_GH_SHARED_READ_GAP_MS: "0", RMD_GH_COOLDOWN_S: "0" });
    mkdirSync(process.env.RMD_GH_CACHE_HOME!, { recursive: true });
    const deps: Deps = {
      resolveOwnerRepo: () => ({ owner: "fallback", repo: "wrong-target" }),
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      enforceReviewSubjectCheckout: false,
      fetchHead: () => forbidden("fetch"), materialize: () => forbidden("materialize"),
      runReview: async () => forbidden("review"), postReviewPending: async () => forbidden("pending"),
      postStatus: async () => forbidden("terminal"), contributorAdmission: async () => forbidden("admission"),
    };
    const run = (pr = "7", overrides: Deps = {}) => reviewCommand(host, pr,
      ["--repo", "audit/fixture-target"], { ...deps, ...overrides });
    return await body({ root, shim, counts, run });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

function noDownstream(counts: Record<string, number>) {
  assert.deepEqual(counts, { fetch: 0, materialize: 0, review: 0, pending: 0, terminal: 0, admission: 0 });
}

test("W1-T11631 criterion 1: real initial view waits for shared admission with a heartbeat and one qualified CLI child", async () => {
  await fixture(numericRoutes(CLOSED), async (f) => {
    process.env.RMD_GH_SHARED_READ_GAP_MS = "25";
    const stamp = ghReadCadenceStampPath(process.env)!;
    // Positive control: the private cache really contains a foreign, pending stamp.
    // A small offset can disappear on the bounded volume's coarser file clock.
    stampGhRead(stamp, "advisory\n", Date.now() + 20000);
    assert.equal(readFileSync(stamp, "utf8"), "advisory\n");
    assert.ok(statSync(stamp).mtimeMs > Date.now(), "the cadence observation is still pending");
    let beat = false;
    let callsAtBeat: number | undefined;
    const timer = setTimeout(() => { beat = true; callsAtBeat = f.shim.calls().length; }, 0);
    try {
      await withDaemonGhTransportFloor(async () => {
        assert.equal(await f.run(), 2, "a settled, closed numeric view safely declines");
        assert.equal(beat, true, "the event loop turns while real default admission is pending");
        assert.equal(callsAtBeat, 0, "the early heartbeat precedes the admitted private read");
        const calls = f.shim.calls();
        assert.equal(calls.length, 1, "exactly one real CLI read after admission");
        assert.match(calls[0]!, /^api repos\/audit\/fixture-target\/pulls\/7(?:\s|$)/);
        const events = f.shim.events();
        assert.deepEqual(events.map((row) => row.phase), ["start", "end"]);
        assert.equal(events[0]!.id, events[1]!.id, "the same contained child completes");
        noDownstream(f.counts);
      });
    } finally { clearTimeout(timer); }
  });
});

test("W1-T11631 criterion 2: settled numeric and branch views preserve qualification; denied and malformed reads do no downstream work", async () => {
  // This first case is also the isolated remove-await control: its injected promise
  // starts no subprocess, even when the baseline fails before consuming its result.
  await fixture([], async (f) => {
    let settled = false;
    const read: NonNullable<Deps["fetchView"]> = async (args) => {
      assert.match(args.join(" "), /^api repos\/audit\/fixture-target\/pulls\/7(?:\s|$)/);
      await Promise.resolve(); settled = true; return CLOSED;
    };
    assert.equal(await f.run("7", { fetchView: read }), 2);
    assert.equal(settled, true, "view is resolved before the closed-state decision");
    assert.equal(f.shim.calls().length, 0, "existing injected readers remain injected");
    noDownstream(f.counts);
    assert.equal(await f.run("7", { fetchView: () => CLOSED }), 2, "legacy synchronous fixture remains supported");
    noDownstream(f.counts);
  });

  const reached = new Error("private normalized-view boundary");
  for (const injected of [false, true]) {
    await fixture([{ when: "pr view fixture-branch --repo audit/fixture-target", stdout: JSON.stringify(BRANCH) }], async (f) => {
      const reader: NonNullable<Deps["fetchView"]> = async (args) => {
        assert.match(args.join(" "), /^pr view fixture-branch --repo audit\/fixture-target(?:\s|$)/);
        await Promise.resolve(); return BRANCH;
      };
      await assert.rejects(f.run("fixture-branch", {
        ...(injected ? { fetchView: reader } : {}),
        contributorAdmission: async (target) => { assert.deepEqual(target, TARGET); throw reached; },
      }), (error) => error === reached);
      assert.equal(f.shim.calls().length, injected ? 0 : 1);
      assert.equal(f.counts.fetch + f.counts.materialize + f.counts.review + f.counts.pending + f.counts.terminal, 0);
    });
  }

  const denied = new Error("private injected read denied");
  await fixture([], async (f) => {
    const failed = Promise.reject(denied);
    void failed.catch(() => {}); // Observe it even when a remove-await mutant does not.
    await assert.rejects(f.run("7", { fetchView: () => failed }), (error) => error === denied);
    noDownstream(f.counts);
    assert.equal(f.shim.calls().length, 0);
    assert.equal(existsSync(join(f.root, "state", "ledger.ndjson")), false);
  });

  for (const route of [
    { when: "api repos/audit/fixture-target/pulls/7", stderr: "gh: authentication denied (HTTP 403)", exit: 1 },
    { when: "api repos/audit/fixture-target/pulls/7", stdout: "not-json" },
  ]) {
    await fixture([route], async (f) => {
      await withDaemonGhTransportFloor(async () => {
        await assert.rejects(f.run(), /authentication denied|403|JSON|Unexpected|token|parse/i);
        assert.equal(f.shim.calls().length, 1, "failure is not retried into success");
        noDownstream(f.counts);
        assert.equal(existsSync(join(f.root, "state", "ledger.ndjson")), false);
      });
    });
  }
  await fixture([], async (f) => {
    await assert.rejects(f.run("7", { fetchView: async () => null }), TypeError);
    noDownstream(f.counts);
    assert.equal(f.shim.calls().length, 0);
  });
});
