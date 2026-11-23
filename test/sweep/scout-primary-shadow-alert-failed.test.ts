import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, type OpenPrView } from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("W1-T12436: primary_shadow.alert_failed no longer recurs", async (t) => {
  const { dir: root } = ownedFixtureDir(t, "primary-shadow-alert");
  const registryDir = join(root, ".remudero");
  mkdirSync(registryDir);
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const open: OpenIssue[] = [];
  const failures: string[] = [];
  const closes: string[] = [];
  const pr = { prNumber: 11, prUrl: "https://github.com/owner/repo/pull/11" } as OpenPrView;
  let reads = 0;
  let unavailable = true;
  const issues: IssueGateway = {
    listOpen: () => {
      reads += 1;
      if (unavailable) throw new Error("fixture issue listing unavailable");
      return [...open];
    },
    create: (title, body) => {
      const url = "https://github.com/owner/repo/issues/1";
      open.push({ number: 1, url, title, body });
      return url;
    },
    closeWithComment: (url) => { closes.push(url); open.length = 0; },
  };
  const effects = (repoMode: "live" | "shadow") => {
    writeFileSync(join(registryDir, "daemon-instances.yaml"),
      `instances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: ${repoMode}\n`);
    return buildSweepEffects({
      owner: "owner", repo: "repo", repoMode, config: { root } as Config, ledgerPath,
      runId: "primary-shadow-alert", plan: { tasks: [], byId: new Map() } as unknown as Plan,
      issuesImpl: issues, ciGateRequired: [],
      ghLiveStateImpl: async () => ({ ok: true, state: repoMode === "live" ? "MERGED" : "OPEN" }),
      log: step => { if (step === "primary_shadow.alert_failed") failures.push(step); },
    });
  };
  for (const mode of ["live", "shadow"] as const) await effects(mode).reconcilePrimaryShadowAlert!();
  await effects("live").readLiveState!(pr);
  assert.deepEqual(failures, []);
  assert.equal(reads, 0, "a pass with no episode does not depend on the issue list");

  writeFileSync(ledgerPath, '{"step":"primary_shadow.observation"\n');
  await effects("live").reconcilePrimaryShadowAlert!();
  assert.equal(failures.length, 1, "a torn observation cannot establish that there is no episode");
  writeFileSync(ledgerPath, "");
  assert.equal(await effects("shadow").arm(pr), "shadow-refused");
  assert.equal(failures.length, 2, "the failed first delivery is recorded");
  assert.equal(open.length, 0);
  const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(root, `ledger.${archiveStamp}.ndjson.gz`), gzipSync(readFileSync(ledgerPath)));
  writeFileSync(ledgerPath, "");

  await effects("live").reconcilePrimaryShadowAlert!();
  assert.equal(failures.length, 3, "an archived observation without a receipt still makes recovery necessary");
  unavailable = false;
  await effects("shadow").reconcilePrimaryShadowAlert!();
  assert.equal(open.length, 1, "the next shadow pass publishes the archived refusal");
  await effects("live").reconcilePrimaryShadowAlert!();
  assert.deepEqual(closes, ["https://github.com/owner/repo/issues/1"]);
});
