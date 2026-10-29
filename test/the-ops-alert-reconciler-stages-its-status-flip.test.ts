import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { feedbackEntryPath, readFeedbackEntry, stageFeedbackCapture } from "#src/lib/feedback.js";
import { LANDING_BRANCH, queuedFeedbackDir, queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { alertFeedbackId, pollAlerts, type OpsPollDeps } from "#src/lib/ops.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function fixture(t: TestContext) {
  const root = gitRepo({ scope: t, kind: "w9661-checkout" });
  const origin = gitRepo({ scope: t, bare: true, kind: "w9661-origin" });
  const stateRoot = ownedFixtureDir(t, "w9661-state").dir;
  const id = alertFeedbackId("o", "r", { source: "code-scanning", id: "60" });
  stageFeedbackCapture(root.dir, undefined, {
    id, raw: "dismissed alert #60", origin: "alert#code-scanning-60",
  });
  root.git("add", "plan/feedback");
  root.git("commit", "--quiet", "-m", "test: seed stale alert feedback");
  root.addRemote("origin", origin.dir);
  root.git("push", "--quiet", "origin", "HEAD:main");
  root.git("fetch", "--quiet", "origin");
  const preflights: string[] = [];
  const ghCalls: string[][] = [];
  const deps: OpsPollDeps = {
    root: root.dir,
    ledgerPath: join(stateRoot, "state", "ledger.ndjson"),
    runId: "OPS-W9661",
    alerts: { codeScanning: () => [], dependabot: () => [], secretScanning: () => [] },
    issues: { create: () => { throw new Error("no open alerts to escalate"); } },
    land: {
      sourceRepository: { owner: "o", repo: "r" },
      targetRepository: { owner: "o", repo: "r" },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "list") return "[]";
        if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/9661";
        throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
      },
      planPrPreflight: (sha) => {
        preflights.push(sha);
        return { ok: true, failures: [], unreadable: [] };
      },
    },
  };
  return { root, origin, stateRoot, id, preflights, ghCalls, deps };
}

describe("test/the-ops-alert-reconciler-stages-its-status-flip.test.ts", () => {
  test("W1-T9661: the daemon alert reconciler stages its status flip and never lands it inline", async (t) => {
    for (const options of ["default", "explicit", "other-state-root"] as const) {
      await t.test(options, async (t) => {
        const f = fixture(t);
        const otherStateRoot = ownedFixtureDir(t, "w9661-other-state").dir;
        f.deps.landingStateRoot = f.stateRoot;
        if (options === "default") delete f.deps.land;
        if (options === "other-state-root") f.deps.land!.stateRoot = otherStateRoot;

        // The inline control below uses this same preflight seam and a real local git origin.
        const result = await withLiveWritesAllowed(() => pollAlerts("o", "r", f.deps));

        assert.deepEqual(result.reconciled, [f.id]);
        assert.deepEqual(f.preflights, []);
        assert.deepEqual(f.ghCalls, []);
        assert.deepEqual(queuedFeedbackLandings(f.stateRoot), [`plan/feedback/${f.id}.yaml`]);
        assert.deepEqual(queuedFeedbackLandings(otherStateRoot), []);
        const queuedPath = join(queuedFeedbackDir(f.stateRoot), `${f.id}.yaml`);
        const queued = readFileSync(queuedPath, "utf8");
        assert.equal(parseYaml(queued).status, "rejected");
        assert.equal(readFeedbackEntry(f.root.dir, f.id).status, "new");
        assert.equal(f.root.git("status", "--porcelain"), "");
        assert.equal(f.origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads"), "main");

        const second = await withLiveWritesAllowed(() => pollAlerts("o", "r", f.deps));
        assert.deepEqual(second.reconciled, [], "the poll's ledger prevents restaging before the sweep");
        assert.equal(readFileSync(queuedPath, "utf8"), queued);
        assert.deepEqual(f.preflights, []);
      });
    }
  });

  test("W1-T9661: the cli alert reconciler still lands its status flip inline", async (t) => {
    const f = fixture(t);
    const before = readFileSync(feedbackEntryPath(f.root.dir, f.id), "utf8");

    const result = await withLiveWritesAllowed(() => pollAlerts("o", "r", f.deps));

    assert.deepEqual(result.reconciled, [f.id]);
    const landedSha = f.origin.git("rev-parse", LANDING_BRANCH);
    assert.deepEqual(f.preflights, [landedSha], "the sync preflight judges the commit landed inline");
    const landed = parseYaml(f.origin.git("show", `${LANDING_BRANCH}:plan/feedback/${f.id}.yaml`));
    assert.equal(landed.status, "rejected");
    assert.ok(f.ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));
    assert.deepEqual(queuedFeedbackLandings(f.stateRoot), []);
    assert.equal(readFileSync(feedbackEntryPath(f.root.dir, f.id), "utf8"), before);
    assert.equal(f.root.git("status", "--porcelain"), "");
  });
});
