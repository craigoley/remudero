import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "#src/lib/service.js";
import type { AddressInfo } from "node:net";
import { createBoardProjection } from "#src/lib/board-projection.js";
import { createLedgerProjector, openProjectorReadModel, isFactStep } from "#src/lib/ledger-projector.js";
import { acquireLease, flushReadModelTransactions } from "#src/lib/read-model-db.js";
import { appendLedger } from "#src/lib/ledger.js";
import { computeBoardSnapshot } from "#src/lib/board.js";
import { readLedgerLines } from "#src/lib/status.js";
import { escalationClasses, escalationDecisions } from "#src/lib/now-decisions.js";
import { buildApproveManualRoute, buildEscalationMarkHandledRoute } from "#src/lib/panel-actions.js";
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

async function displayedAlertDecision(ledgerPath: string, all: OpenIssue[], closed: Set<string>, digest: string) {
  const plan = { tasks: [], byId: new Map() } as unknown as Plan;
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined,
    prBody: () => undefined, listOpenHeadBranches: () => [], listMergedHeadBranches: () => [],
    issueByUrl: (url: string) => { const issue = all.find(i => i.url === url);
      return issue ? { state: closed.has(url) ? "CLOSED" : "OPEN", title: issue.title } : null; } };
  const full = computeBoardSnapshot({ plan, ledgerPath, github });
  // A later normal task row displaces lastActivity retention; the published binding must survive independently.
  appendLedger(ledgerPath, { run_id: "projection-followup", task_id: `PRIMARY-SHADOW-${digest}`,
    step: "sweep.disposed", pr_number: 11, disposition: "waiting", reason: "ordinary follow-up" });
  const root = join(ledgerPath, "..");
  const db = openProjectorReadModel(join(root, "read-model-home"), "core");
  try {
    const acquired = acquireLease(db, { holder: "primary-shadow-operator-fixture" }); assert.ok(acquired.ok);
    createLedgerProjector({ ledgerDir: root, db, lease: acquired.lease }).tick();
    const retained = createBoardProjection({ db, ledgerPath, readPlan: () => plan, github,
      readCreditStore: () => ({}), readCreditOverrideFile: () => "" });
    while (!retained.update({ force: true }).caughtUp) { /* ingest the actual fact store */ }
    for (const [board, rows] of [[full, readLedgerLines(ledgerPath)],
      [computeBoardSnapshot({ plan, ledgerPath, github, readLedger: () => [...retained.rows()] }), retained.rows()]] as const) {
      const decisions = escalationDecisions("core", board.tasks, escalationClasses(rows));
      assert.equal(decisions.length, 1, "both full and retained production boards offer exactly one live issue action");
      const decision = decisions[0]!;
      assert.equal(decision.answer.fields.taskId, `PRIMARY-SHADOW-${digest}`,
        "the board action acknowledges the delivered selection, not its birth or pending digest");
      assert.equal(decision.answer.path, "/v1/manual/approve", "the MANUAL notice uses its actual operator route");
    }
    return escalationDecisions("core", full.tasks, escalationClasses(readLedgerLines(ledgerPath)))[0]!;
  } finally { db.close(); await flushReadModelTransactions(); }
}

async function handleDisplayedAlert(root: string, ledgerPath: string, all: OpenIssue[], closed: Set<string>,
  digest: string, markHandled = false): Promise<void> {
  const decision = await displayedAlertDecision(ledgerPath, all, closed, digest);
  const deps = { root, ledgerPath, issues: { close: (url: string) => { closed.add(url); } } };
  const route = markHandled ? buildEscalationMarkHandledRoute(deps) : buildApproveManualRoute(deps);
  assert.equal(route.path, markHandled ? "/v1/escalation/mark-handled" : decision.answer.path);
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`, {
      method: "POST", headers: { authorization: "Bearer write", "content-type": "application/json" },
      body: JSON.stringify({ ...decision.answer.fields, ...(markHandled ? { class: "MANUAL", disposition: "acted" } : {}) }),
    });
    assert.equal(response.status, 200, await response.text());
    const row = readLedgerLines(ledgerPath).at(-1)!;
    assert.equal(row.step, markHandled ? "panel.escalation_marked_handled" : "panel.manual_approved");
    assert.equal(row.task_id, `PRIMARY-SHADOW-${digest}`);
    assert.equal(row.issue_url, decision.answer.fields.issueUrl);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

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
    let failEdit = false;
    const selection = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => {
        if (failEdit) throw new Error("selection edit delivery failed");
        all.find(i => i.url === url)!.body = body;
      },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "updated-ack", selection: () => ({ ...selection }), issues, clock: clockFromMillisFn(() => now) });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    selection.digest = "b".repeat(64); now += 1;
    failEdit = true;
    await channel().refuse(pr(12));
    await assert.rejects(channel().reconcile(), /selection edit delivery failed/);
    await displayedAlertDecision(ledgerPath, all, closed, "a".repeat(64));
    assert.ok(all[0]!.body!.includes(`Selection digest: ${"a".repeat(64)}`));
    failEdit = false;
    await channel().reconcile();
    assert.equal(all.length, 1, "a changed selection updates the unacknowledged issue in place");
    const taskId = /\*\*Task:\*\*\s*(\S+)/.exec(all[0]!.body!)![1];
    assert.equal(taskId, `PRIMARY-SHADOW-${selection.digest}`, "mark-handled must acknowledge the displayed selection");
    await handleDisplayedAlert(root, ledgerPath, all, closed, selection.digest);
    now += 1;
    await channel().refuse(pr(13)); await channel().reconcile();
    assert.equal(all.length, 1, "reconstructing the channel cannot unsilence the acknowledged selection");
    selection.digest = "c".repeat(64);
    await channel().refuse(pr(14));
    assert.equal(all.length, 2, "a new selection reopens the alert on its first refusal");
    assert.ok(all[1]!.body!.includes(selection.digest));
    assert.ok(all[1]!.body!.includes("/pull/14"));
    assert.equal(all[1]!.body!.includes("/pull/13"), false, "silenced observations must not leak into the reopened alert");
    selection.digest = "d".repeat(64);
    await channel().refuse(pr(15));
    await channel().reconcile();
    assert.equal(all.length, 2, "the reopened episode also updates its displayed selection in place");
    await handleDisplayedAlert(root, ledgerPath, all, closed, selection.digest, true);
    await channel().refuse(pr(16)); await channel().reconcile();
    assert.equal(all.length, 2, "mark-handled also silences an in-place updated selection after reconstruction");
    selection.digest = "e".repeat(64);
    await channel().refuse(pr(17));
    assert.equal(all.length, 3, "neither operator action silences a later selection");
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
    await handleDisplayedAlert(root, ledgerPath, all, closed, taskId!.slice("PRIMARY-SHADOW-".length));
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
      assert.match(all[0]!.body!, /1 refused PR/, "recovery defers the changed body to the ordinary boundary");
      const pending = readLedgerLines(ledgerPath).filter(row => row.step === "primary_shadow.observation").at(-1)!;
      assert.deepEqual(pending.refused_prs, [12, 13], "the durable pending set retires only the positively merged candidate");
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


test("W1-T11444 criterion 2: returning to an acknowledged selection never flushes another selection's pending body", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-digest-return-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [], closed = new Set<string>(), edits: string[] = [];
    const selected = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { edits.push(body); all.find(i => i.url === url)!.body = body; },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "digest-return", selection: () => ({ ...selected }), issues });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    await handleDisplayedAlert(root, ledgerPath, all, closed, selected.digest);
    selected.digest = "b".repeat(64); await channel().refuse(pr(12));
    selected.digest = "c".repeat(64); await channel().refuse(pr(13));
    assert.equal(edits.length, 0);
    await displayedAlertDecision(ledgerPath, all, closed, "b".repeat(64));
    selected.digest = "a".repeat(64); await channel().reconcile();
    assert.equal(edits.length, 0, "the actual selected acknowledged digest gates the boundary, not persisted pending C");
    assert.ok(all[1]!.body!.includes("b".repeat(64)));
    selected.digest = "c".repeat(64); await channel().reconcile();
    assert.equal(edits.length, 1, "returning to unacknowledged C delivers its durable pending PRs without another refusal");
    assert.ok(all[1]!.body!.includes("c".repeat(64)));
    await displayedAlertDecision(ledgerPath, all, closed, selected.digest);
    const births = readLedgerLines(ledgerPath).filter(row => row.step === "escalation.issue_opened");
    assert.equal(births.length, 2, "editing the same issue never invents another issue-opened event");
    await handleDisplayedAlert(root, ledgerPath, all, closed, selected.digest);
    await channel().refuse(pr(14)); await channel().reconcile();
    assert.equal(all.length, 2, "the delivered C acknowledgement stays silent across reconstruction");
    selected.digest = "d".repeat(64); await channel().refuse(pr(15));
    assert.equal(all.length, 3, "that acknowledgement cannot silence a later selection");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 2: an observed delivered body repairs its interrupted binding receipt without another edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-binding-retry-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [], closed = new Set<string>();
    let editCount = 0;
    const selected = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => all.filter(i => !closed.has(i.url)),
      editBody: (url, body) => { editCount += 1; all.find(i => i.url === url)!.body = body; },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "binding-retry", selection: () => ({ ...selected }), issues });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    selected.digest = "b".repeat(64); await channel().refuse(pr(12)); await channel().reconcile();
    assert.equal(editCount, 1);
    const delivered = readLedgerLines(ledgerPath);
    assert.equal(delivered.filter(row => row.step === "primary_shadow.issue_published").length, 1);
    // Simulate a crash after GitHub accepted the body and before the delivery row became durable.
    writeFileSync(ledgerPath, delivered.filter(row => row.step !== "primary_shadow.issue_published").map(row => JSON.stringify(row) + "\n").join(""));
    await channel().reconcile();
    assert.equal(editCount, 1, "an already matching body needs no second transport edit");
    await displayedAlertDecision(ledgerPath, all, closed, selected.digest);
    const recovered = readLedgerLines(ledgerPath);
    assert.equal(recovered.filter(row => row.step === "primary_shadow.issue_published").length, 1);
    assert.equal(recovered.filter(row => row.step === "escalation.issue_opened").length, 1);
    const legacy = openProjectorReadModel(join(root, "legacy-read-model"), "core");
    try {
      const acquired = acquireLease(legacy); assert.ok(acquired.ok);
      createLedgerProjector({ ledgerDir: root, db: legacy, lease: acquired.lease,
        factStep: step => isFactStep(step) && step !== "primary_shadow.issue_published" }).tick();
      assert.equal(Number(legacy.prepare("SELECT COUNT(*) AS n FROM fact WHERE step = 'escalation.issue_opened'").get()!.n), 1,
        "the old model saw this ledger's original opening, so its missing delivery fact is measured");
      assert.equal(Number(legacy.prepare("SELECT COUNT(*) AS n FROM fact WHERE step = 'primary_shadow.issue_published'").get()!.n), 0);
      // Version 3 is the actual pre-delivery-event fact set, not a value derived from the new constant.
      legacy.exec("UPDATE meta SET v = '3' WHERE k = 'projection:fact'");
      createLedgerProjector({ ledgerDir: root, db: legacy, lease: acquired.lease }).tick();
      assert.equal(Number(legacy.prepare("SELECT COUNT(*) AS n FROM fact WHERE step = 'primary_shadow.issue_published'").get()!.n), 1,
        "the maintained fact-set upgrade replays a previously unclassified delivered binding");
    } finally { legacy.close(); await flushReadModelTransactions(); }
    await handleDisplayedAlert(root, ledgerPath, all, closed, selected.digest);
    await channel().refuse(pr(13)); await channel().reconcile();
    assert.equal(all.length, 1, "the repaired binding reaches the real digest-scoped acknowledgement route");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("W1-T11444 criterion 2: a torn delivery binding refuses reconciliation without another issue or body edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-torn-delivery-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [];
    let edits = 0;
    const selected = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => [...all], editBody: () => { edits += 1; },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "torn-delivery", selection: () => ({ ...selected }), issues });
    await channel().refuse({ prNumber: 11, prUrl: "https://github.com/owner/repo/pull/11" });
    appendFileSync(ledgerPath, `{"step":"primary_shadow.issue_published","task_id":"PRIMARY-SHADOW-${selected.digest}","issue_url":`);
    await assert.rejects(channel().reconcile(), /history is unreadable/);
    assert.equal(all.length, 1, "damaged history is never permission to create another issue");
    assert.equal(edits, 0, "an unreadable delivery record cannot establish a safe body update");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 2: a torn primary opening refuses reconciliation without another issue or body edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-torn-opening-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson"), all: OpenIssue[] = [];
    let edits = 0;
    const selected = { instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const issues: IssueGateway = {
      create: (title, body) => { const number = all.length + 1, url = `https://github.com/owner/repo/issues/${number}`;
        all.push({ number, url, title, body }); return url; },
      listOpen: () => [...all], editBody: () => { edits += 1; },
    };
    const channel = () => escalation.primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath,
      runId: "torn-opening", selection: () => ({ ...selected }), issues });
    await channel().refuse({ prNumber: 11, prUrl: "https://github.com/owner/repo/pull/11" });
    appendFileSync(ledgerPath, `{"step":"escalation.issue_opened","task_id":"PRIMARY-SHADOW-${selected.digest}","issue_url":`);
    await assert.rejects(channel().reconcile(), /history is unreadable/);
    assert.equal(all.length, 1, "damaged history is never permission to create another issue");
    assert.equal(edits, 0, "an unreadable delivery record cannot establish a safe body update");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

