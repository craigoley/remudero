import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { runSweep } from "#src/lib/sweep.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { OpenPrView } from "#src/lib/sweep.js";

test("W1-T11444 criterion 2: live recovery closes the alert and handling is selection-scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-recovery-"));
  try {
    const selected = join(root, "selection.yaml"), ledgerPath = join(root, "ledger.ndjson");
    const all: OpenIssue[] = [], closed = new Set<string>(), notes: string[] = [];
    const issues: IssueGateway = {
      create: (title, body) => { const url = `https://github.com/owner/repo/issues/${all.length + 1}`;
        all.push({ number: all.length + 1, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { all.find(i => i.url === url)!.body = body; },
      closeWithComment: (url, comment) => { closed.add(url); notes.push(comment); },
      comment: () => { throw new Error("unexpected duplicate comment"); },
    };
    const pass = async (mode: "shadow" | "live", revision: string) => {
      writeFileSync(selected, `# ${revision}\ninstances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: ${mode}\n`);
      await withInstanceRegistryRuntime(async () => {
        const effects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: mode,
          config: { root } as Config, ledgerPath, runId: "SWEEP-primary-recovery",
          plan: { tasks: [], byId: new Map() } as unknown as Plan, issuesImpl: issues, log: () => {} });
        if (mode === "shadow") await effects.arm({ prNumber: 11,
          prUrl: "https://github.com/owner/repo/pull/11", headSha: "a".repeat(40) } as OpenPrView);
        else {
          assert.ok("reconcilePrimaryShadowAlert" in effects && typeof effects.reconcilePrimaryShadowAlert === "function");
          const reconcile = effects.reconcilePrimaryShadowAlert;
          await runSweep([], { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
            ledgerPath, runId: "SWEEP-primary-recovery", readLedger: () => [], appendLine: () => {},
            readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
            reconcilePrimaryShadowAlert: async () => { await reconcile(); } });
        }
      }, { envPath: selected, instanceName: "core" });
    };
    await pass("shadow", "first");
    assert.equal(all.length, 1, "a primary refusal opens the alert before acknowledgment");
    const taskId = /\*\*Task:\*\*\s*`?([^`\s]+)/.exec(all[0]!.body!)![1];
    closed.add(all[0]!.url);
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "PANEL", task_id: taskId,
      step: "panel.escalation_marked_handled", issue_url: all[0]!.url, class: "MANUAL", disposition: "acted" }) + "\n");
    await pass("shadow", "first");
    assert.equal(all.length, 1, "a handled selection must stay silent across effect reconstruction");
    await pass("shadow", "second");
    assert.equal(all.length, 2, "a changed selection gets its own notice");
    const unknown = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "live", config: { root } as Config,
      ledgerPath, runId: "unknown-selection", plan: { tasks: [], byId: new Map() } as unknown as Plan,
      issuesImpl: issues, log: () => {} });
    assert.ok("reconcilePrimaryShadowAlert" in unknown && typeof unknown.reconcilePrimaryShadowAlert === "function");
    await unknown.reconcilePrimaryShadowAlert();
    assert.equal(closed.has(all[1]!.url), false, "unknown selection is not evidence of live recovery");
    await pass("shadow", "second");
    assert.equal(closed.has(all[1]!.url), false, "another shadow pass is not evidence of recovery");
    await pass("live", "recovered");
    assert.ok(closed.has(all[1]!.url), "the first live pass closes the outstanding shadow alert");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /live/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 2: only fresh merged observations retire the recorded refused PR set", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-merged-"));
  try {
    const selected = join(root, "selection.yaml"), ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(selected, `instances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: shadow\n`);
    const all: OpenIssue[] = [], closed = new Set<string>(), notes: string[] = [];
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { all.find(i => i.url === url)!.body = body; },
      closeWithComment: (url, comment) => { closed.add(url); notes.push(comment); },
    };
    let observation = { ok: false, state: "MERGED" };
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}`, headSha: "a".repeat(40) } as OpenPrView);
    await withInstanceRegistryRuntime(async () => {
      const effects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow", config: { root } as Config,
        ledgerPath, runId: "primary-merged", plan: { tasks: [], byId: new Map() } as unknown as Plan,
        issuesImpl: issues, ghLiveStateImpl: async () => observation, log: () => {} });
      await effects.arm(pr(11)); await effects.arm(pr(12)); await effects.arm(pr(13));
      assert.equal(all.length, 1);
      await effects.readLiveState!(pr(11));
      assert.equal(closed.size, 0, "an unsuccessful read cannot establish a merge");
      observation = { ok: true, state: "CLOSED" };
      await effects.readLiveState!(pr(11));
      assert.equal(closed.size, 0, "closed without a merged observation is not lane recovery");
      observation = { ok: true, state: "MERGED" };
      await effects.readLiveState!({ ...pr(11), prUrl: "https://github.com/other/repo/pull/11" });
      assert.equal(closed.size, 0, "a different repository's merge cannot resolve this refusal");
      await effects.readLiveState!(pr(11));
      assert.equal(closed.size, 0, "another recorded refused PR is still outstanding");
      assert.match(all[0]!.body!, /2 refused PR/);
      assert.equal(all[0]!.body!.includes("https://github.com/owner/repo/pull/11"), false);
      const otherEffects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow", config: { root } as Config,
        ledgerPath, runId: "primary-merged-other-effect", plan: { tasks: [], byId: new Map() } as unknown as Plan,
        issuesImpl: issues, ghLiveStateImpl: async () => observation, log: () => {} });
      await Promise.all([effects.readLiveState!(pr(12)), otherEffects.readLiveState!(pr(13))]);
      assert.equal(closed.size, 1, "both concurrent merged observations must retire the whole refused set");
      assert.match(notes[0]!, /fresh MERGED observation/);
      await effects.arm(pr(14));
      assert.equal(all.length, 2, "a new refusal after verified recovery opens a new episode");
      assert.match(all[1]!.body!, /1 refused PR/);
      assert.equal(all[1]!.body!.includes("https://github.com/owner/repo/pull/11"), false);
    }, { envPath: selected, instanceName: "core" });
    writeFileSync(selected, `instances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: live\n`);
    await withInstanceRegistryRuntime(async () => {
      const liveEffects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "live", config: { root } as Config,
        ledgerPath, runId: "primary-live-observation", plan: { tasks: [], byId: new Map() } as unknown as Plan,
        issuesImpl: issues, ghLiveStateImpl: async () => ({ ok: true, state: "MERGED" }), log: () => {} });
      await liveEffects.readLiveState!(pr(14));
      assert.equal(closed.size, 2, "a fresh observation also reconciles a positively live selection");
      assert.match(notes[1]!, /live again/);
    }, { envPath: selected, instanceName: "core" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
