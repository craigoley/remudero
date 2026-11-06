import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { runSweep } from "#src/lib/sweep.js";
import { runEscalationReconcile } from "#src/lib/sweep.js";
import { buildEscalationReconcileCandidates } from "#src/lib/tick-read-worker.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import * as escalation from "#src/lib/escalate.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

test("W1-T11444 criterion 2: the general lifecycle cannot retire the primary episode through one terminal PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-general-close-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), open: OpenIssue[] = [], closes: string[] = [];
    const issues: IssueGateway = {
      create: (title, body) => { const url = "https://github.com/owner/repo/issues/1";
        open.push({ number: 1, url, title, body }); return url; },
      listOpen: () => open,
      editBody: (url, body) => { open.find(i => i.url === url)!.body = body; },
    };
    const channel = escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath, runId: "general-close",
      selection: () => ({ instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" }), issues });
    for (const prNumber of [11, 12]) await channel.refuse({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    const plan = { tasks: [], byId: new Map() } as unknown as Plan;
    for (const state of ["CLOSED", "MERGED"]) {
      const candidates = buildEscalationReconcileCandidates("owner", "repo", plan, ledgerPath, () => {}, {
        issues, evidenceRootFor: () => undefined,
        github: { prByRef: (number: number) => ({ number, url: `https://github.com/owner/repo/pull/${number}`, state }) } as never,
      });
      assert.equal(candidates.length, 1, "the actual intake resolves the primary notice's first PR referent");
      assert.equal(candidates[0]!.derived.prNumber, 11);
      const summary = await runEscalationReconcile([...candidates, { ...candidates[0]!, taskId: "PR-99", issueUrl: "https://github.com/owner/repo/issues/99" }],
        { ledgerPath, runId: "general-close", closeIssue: url => { closes.push(url); }, appendLine: () => {} });
      assert.equal(summary.results[0]!.outcome, "left-live", "the instance channel owns recovery of the complete refused set");
      assert.equal(summary.results[1]!.outcome, "closed", "ordinary terminal PR escalations still close");
    }
    assert.deepEqual(closes, ["https://github.com/owner/repo/issues/99", "https://github.com/owner/repo/issues/99"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 2: acknowledgement after an in-place selection update silences only its displayed digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-updated-ack-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [], closed = new Set<string>();
    let now = 1_800_000_000_000;
    const selection = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { all.find(i => i.url === url)!.body = body; },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "updated-ack", selection: () => ({ ...selection }), issues, clock: clockFromMillisFn(() => now) });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    selection.digest = "b".repeat(64); now += 1;
    await channel().refuse(pr(12));
    assert.equal(all.length, 1, "a changed selection updates the unacknowledged issue in place");
    const taskId = /\*\*Task:\*\*\s*(\S+)/.exec(all[0]!.body!)![1];
    assert.equal(taskId, `PRIMARY-SHADOW-${selection.digest}`, "mark-handled must acknowledge the displayed selection");
    closed.add(all[0]!.url);
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "PANEL", task_id: taskId,
      step: "panel.escalation_marked_handled", issue_url: all[0]!.url, class: "MANUAL", disposition: "acted" }) + "\n");
    now += 1;
    await channel().refuse(pr(13)); await channel().reconcile();
    assert.equal(all.length, 1, "reconstructing the channel cannot unsilence the acknowledged selection");
    selection.digest = "c".repeat(64);
    await channel().refuse(pr(14));
    assert.equal(all.length, 2, "a new selection reopens the alert on its first refusal");
    assert.ok(all[1]!.body!.includes(selection.digest));
    assert.ok(all[1]!.body!.includes("/pull/14"));
    assert.equal(all[1]!.body!.includes("/pull/13"), false, "silenced observations must not leak into the reopened alert");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 2: a fresh pass retires merged refusals absent from the open PR list", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-pass-recovery-"));
  try {
    const selected = join(root, "selection.yaml"), ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(selected, `instances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: shadow\n`);
    const all: OpenIssue[] = [], closed = new Set<string>(), notes: string[] = [], reads: string[] = [];
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { all.find(i => i.url === url)!.body = body; },
      closeWithComment: (url, note) => { closed.add(url); notes.push(note); },
    };
    const observations = new Map<number, { ok: boolean; state?: string }>();
    const makeEffects = () => buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow", config: { root } as Config,
      ledgerPath, runId: "pass-recovery", plan: { tasks: [], byId: new Map() } as unknown as Plan, issuesImpl: issues,
      ghLiveStateImpl: async (url: string) => { reads.push(url); return observations.get(Number(url.split("/").at(-1))) ?? { ok: false }; }, log: () => {} });
    const pass = async () => {
      const effects = makeEffects();
      await runSweep([], { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
        ledgerPath, runId: "pass-recovery", readLedger: () => [], appendLine: () => {},
        readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
        reconcilePrimaryShadowAlert: effects.reconcilePrimaryShadowAlert });
    };
    await withInstanceRegistryRuntime(async () => {
      const effects = makeEffects();
      for (const prNumber of [11, 12]) await effects.arm({ prNumber,
        prUrl: `https://github.com/owner/repo/pull/${prNumber}`, headSha: "a".repeat(40) } as OpenPrView);
      await pass();
      assert.deepEqual(new Set(reads), new Set([11, 12].map(n => `https://github.com/owner/repo/pull/${n}`)),
        "reconciliation must read recorded refusals even when production supplies no open PRs");
      assert.equal(closed.size, 0, "unreadable observations cannot establish recovery");
      observations.set(11, { ok: true, state: "MERGED" });
      observations.set(12, { ok: true, state: "CLOSED" });
      await pass();
      assert.equal(closed.size, 0, "a closed but unmerged candidate keeps the alert open");
      observations.set(12, { ok: true, state: "MERGED" });
      await pass();
      assert.equal(closed.size, 1, "the first all-merged pass closes the same alert");
      assert.match(notes[0]!, /MERGED/);
      assert.ok(notes[0]!.includes("/pull/12"));
      assert.equal(all.length, 1);
      const count = reads.length;
      await pass();
      assert.equal(reads.length, count, "recovered episodes no longer query their old candidates");
      assert.equal(notes.length, 1);
    }, { envPath: selected, instanceName: "core" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    let now = 1_800_000_000_000;
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}`, headSha: "a".repeat(40) } as OpenPrView);
    await withInstanceRegistryRuntime(async () => {
      const effects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow", config: { root } as Config,
        ledgerPath, runId: "primary-merged", plan: { tasks: [], byId: new Map() } as unknown as Plan,
        issuesImpl: issues, ghLiveStateImpl: async () => observation, nowMsImpl: () => now, log: () => {} });
      await effects.arm(pr(11)); await effects.arm(pr(12)); await effects.arm(pr(13));
      assert.equal(all.length, 1);
      await effects.readLiveState!(pr(11));
      assert.equal(closed.size, 0, "an unsuccessful read cannot establish a merge");
      observation = { ok: true, state: "CLOSED" };
      await effects.readLiveState!(pr(11));
      assert.equal(closed.size, 0, "closed without a merged observation is not lane recovery");
      observation = { ok: true, state: "MERGED" };
      now += 1;
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
test("W1-T11444 criterion 2: failed recovery delivery survives reconstruction and retries on the next pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-close-retry-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [], closed = new Set<string>();
    const notes: string[] = []; let failClose = false; let closeAttempts = 0;
    const selected = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as "shadow" | "live" };
    const issues = {
      create: async (title: string, body: string) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: async () => all.filter(i => !closed.has(i.url)),
      editBody: async (url: string, body: string) => { all.find(i => i.url === url)!.body = body; },
      closeWithComment: async (url: string, comment: string) => { closeAttempts += 1;
        if (failClose) throw new Error("private close transport failure");
        closed.add(url); notes.push(comment); },
    };
    const channel = () => { assert.equal(typeof escalation.primaryShadowOperatorChannel, "function", "the primary-shadow channel is available"); return escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath, runId: "close-retry", selection: () => ({ ...selected }), issues }); };
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    const first = channel(); await first.refuse(pr(11));
    failClose = true;
    await assert.rejects(first.resolved(pr(11)), /private close transport failure/);
    assert.equal(closed.size, 0);
    failClose = false;
    await channel().reconcile();
    assert.equal(closed.size, 1, "a fresh shadow pass retries the durable pending recovery without another PR observation");
    assert.equal(closeAttempts, 2);
    assert.match(notes[0]!, /fresh MERGED observation/);
    await channel().reconcile();
    assert.equal(closeAttempts, 2, "a delivered recovery is not repeated");

    // A selection change preserves the outstanding PRs in the same episode.
    await channel().refuse(pr(12));
    const older = all[1]!.url;
    failClose = true;
    await assert.rejects(channel().resolved(pr(12)), /private close transport failure/);
    failClose = false;
    await channel().refuse(pr(14));
    await channel().reconcile();
    assert.equal(closed.has(older), false, "a new refusal cancels a pending all-merged recovery");
    selected.digest = "b".repeat(64);
    await channel().refuse(pr(13));
    await channel().resolved(pr(13));
    assert.equal(all.length, 2, "the changed digest reuses the still-open episode");
    assert.equal(closed.has(older), false, "one merged candidate cannot close an episode with an unmerged refusal");
    selected.mode = "live";
    failClose = true;
    await assert.rejects(channel().reconcile(), /private close transport failure/);
    failClose = false;
    await channel().reconcile();
    assert.equal(closed.has(older), true, "positive live recovery retries and closes prior digest notices");
    assert.match(notes.at(-1)!, /live again/);
    selected.mode = "shadow";
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "MALFORMED",
      task_id: "PRIMARY-SHADOW-" + selected.digest, step: "primary_shadow.observation", revision: 999,
      first_refusal_at: "", refused_prs: [], pending_recovery: 3 }) + "\n");
    await assert.rejects(channel().reconcile(), /observation is malformed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

