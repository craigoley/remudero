import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import { ghIssueGatewayAsync, primaryShadowOperatorChannel, type AsyncIssueGateway, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { ghShim } from "#test/helpers/gh-shim.js";

test("W1-T11444 criterion 1: alert edits inherit the escalation gateway timing without an idle-poll delay", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-cadence-"));
  try {
    let now = 1_800_000_000_000;
    const selection = { instance: "core", sourcePath: join(root, "first.yaml"), digest: "a".repeat(64), mode: "shadow" as const };
    const all: OpenIssue[] = [], edits: string[] = [], controlEdits: number[] = [], alertEdits: number[] = [];
    let failEdit = false;
    const gateway = ghIssueGatewayAsync("owner", "repo", { exec: async args => {
      assert.deepEqual(args.slice(0, 2), ["issue", "edit"]);
      assert.equal(args[args.indexOf("--repo") + 1], "owner/repo");
      if (failEdit) throw new Error("fixture edit delivery failed");
      const body = args[args.indexOf("--body") + 1]!;
      if (args[2] === "https://github.com/owner/repo/issues/99") controlEdits.push(now);
      else {
        alertEdits.push(now); edits.push(body); all.find(i => i.url === args[2])!.body = body;
      }
      return "";
    } });
    const issues: AsyncIssueGateway = {
      create: (title, body) => { const url = `https://github.com/owner/repo/issues/${all.length + 1}`;
        all.push({ number: all.length + 1, url, title, body }); return url; },
      listOpen: () => [...all],
      editBody: gateway.editBody,
    };
    const channel = () => primaryShadowOperatorChannel({ owner: "owner", repo: "repo", ledgerPath: join(root, "ledger.ndjson"),
      runId: "cadence", selection: () => ({ ...selection }), issues, clock: clockFromMillisFn(() => now) });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    const first = /Refusals began: ([^\n]+)/.exec(all[0]!.body!)![1];
    now += 1;
    await gateway.editBody!("https://github.com/owner/repo/issues/99", "ordinary escalation update");
    selection.digest = "b".repeat(64); selection.sourcePath = join(root, "second.yaml");
    await channel().refuse(pr(12));
    assert.equal(all.length, 1, "an unacknowledged selection change must reuse the instance's open issue");
    assert.deepEqual(alertEdits, controlEdits, "a primary alert must reach the same gateway at the same time as an ordinary edit");
    assert.equal(edits.length, 1, "the existing gateway accepts updates one millisecond after creation");
    now += 1;
    await gateway.editBody!("https://github.com/owner/repo/issues/99", "next ordinary escalation update");
    await channel().refuse(pr(13));
    assert.deepEqual(alertEdits, controlEdits, "successive edits inherit gateway timing without another delay");
    await channel().reconcile();
    assert.equal(edits.length, 2, "an unchanged observation needs no edit");
    assert.equal(all.length, 1);
    assert.match(all[0]!.body!, /3 refused PRs:/);
    for (const n of [11, 12, 13]) assert.ok(all[0]!.body!.includes(`/pull/${n}`));
    assert.ok(all[0]!.body!.includes(selection.digest));
    assert.ok(all[0]!.body!.includes(selection.sourcePath));
    assert.equal(/Refusals began: ([^\n]+)/.exec(all[0]!.body!)![1], first);
    failEdit = true;
    await assert.rejects(channel().refuse(pr(14)), /fixture edit delivery failed/);
    assert.equal(edits.length, 2, "a failed delivery leaves the published body intact");
    failEdit = false;
    await channel().reconcile();
    assert.equal(edits.length, 3, "reconstruction retries the pending observation without a new refusal or clock advance");
    assert.match(all[0]!.body!, /4 refused PRs:/);
    assert.equal(all.length, 1);
    assert.equal(/Refusals began: ([^\n]+)/.exec(all[0]!.body!)![1], first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 1: a pending gateway edit holds later refusals until delivery completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-edit-delivery-"));
  let releaseEdit!: () => void;
  const delivery = new Promise<void>(resolve => { releaseEdit = resolve; });
  let editStarted!: () => void;
  const started = new Promise<void>(resolve => { editStarted = resolve; });
  const pending: Promise<void>[] = [];
  try {
    const all: OpenIssue[] = [], edits: string[] = [];
    const gateway = ghIssueGatewayAsync("owner", "repo", { exec: async args => {
      assert.deepEqual(args.slice(0, 2), ["issue", "edit"]);
      const body = args[args.indexOf("--body") + 1]!;
      edits.push(body);
      if (edits.length === 1) { editStarted(); await delivery; }
      all[0]!.body = body;
      return "";
    } });
    const issues: AsyncIssueGateway = {
      create: (title, body) => { const url = "https://github.com/owner/repo/issues/1";
        all.push({ number: 1, url, title, body }); return url; },
      listOpen: () => [...all], editBody: gateway.editBody,
    };
    const channel = () => primaryShadowOperatorChannel({ owner: "owner", repo: "repo",
      ledgerPath: join(root, "ledger.ndjson"), runId: "pending-edit",
      selection: () => ({ instance: "core", sourcePath: join(root, "selection.yaml"), digest: "a".repeat(64), mode: "shadow" }),
      issues, clock: clockFromMillisFn(() => 1_800_000_000_000) });
    const pr = (prNumber: number) => ({ prNumber, prUrl: `https://github.com/owner/repo/pull/${prNumber}` });
    await channel().refuse(pr(11));
    let completed = false;
    pending.push(channel().refuse(pr(12)).then(() => { completed = true; }));
    // Observe a settled operation too, so an implementation that suppresses edits fails instead of hanging.
    await Promise.race([started, pending[0]]);
    assert.equal(edits.length, 1, "a changed refusal reaches the gateway without advancing the clock");
    pending.push(channel().refuse(pr(13)));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, "the channel must await the gateway's delivery receipt");
    assert.equal(edits.length, 1, "another channel for this episode cannot overtake its pending edit");
    assert.match(all[0]!.body!, /1 refused PRs:/);
    releaseEdit();
    await Promise.all(pending);
    assert.equal(completed, true);
    assert.equal(all.length, 1);
    assert.equal(edits.length, 2, "gateway completion permits the next edit at the same clock time");
    assert.match(all[0]!.body!, /3 refused PRs:/);
    for (const n of [11, 12, 13]) assert.ok(all[0]!.body!.includes(`/pull/${n}`));
  } finally {
    releaseEdit(); await Promise.allSettled(pending);
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T11444 criterion 1: primary shadow refusals open and update one durable alert", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-alert-"));
  try {
    const selected = join(root, "selection.yaml");
    const open: OpenIssue[] = [];
    const edits: string[] = [], failures: string[] = [];
    let unreadable = false;
    const issues: IssueGateway = {
      create: (title, body) => { const url = `https://github.com/owner/repo/issues/${open.length + 1}`;
        open.push({ number: open.length + 1, url, title, body }); return url; },
      listOpen: () => { if (unreadable) throw new Error("fixture issue listing unavailable"); return [...open]; },
      editBody: (url, body) => { edits.push(body); open.find(i => i.url === url)!.body = body; },
      comment: () => { throw new Error("a repeated refusal must update the body, not add comments"); },
    };
    const text = (primary: boolean) => `instances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: ${primary}\n    mode: shadow\n`;
    const ledgerPath = join(root, "ledger.ndjson");
    let now = 1_800_000_000_000;
    const run = async (primary: boolean, concurrent = false, named = true) => {
      writeFileSync(selected, text(primary));
      await withInstanceRegistryRuntime(async () => {
        const makeEffects = () => buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow",
          config: { root } as Config, ledgerPath, runId: "SWEEP-primary-shadow", nowMsImpl: () => now,
          plan: { tasks: [], byId: new Map() } as unknown as Plan, issuesImpl: issues,
          ghLiveStateImpl: async () => ({ ok: false }),
          log: step => { if (step === "primary_shadow.alert_failed") failures.push(step); },
          armImpl: () => { throw new Error("shadow must never arm"); } });
        const effects = makeEffects();
        const pr = (n: number) => ({ prNumber: n, prUrl: `https://github.com/owner/repo/pull/${n}`, headSha: "a".repeat(40) } as OpenPrView);
        if (concurrent) {
          const results = await Promise.all([effects.arm(pr(11)), makeEffects().arm(pr(12))]);
          assert.deepEqual(results, ["shadow-refused", "shadow-refused"]);
          assert.equal(await effects.arm(pr(13)), "shadow-refused");
          assert.equal(await effects.arm(pr(13)), "shadow-refused");
          assert.equal(edits.length, 2, "each changed observation awaits the shared gateway; identical refusals do not edit");
          await effects.reconcilePrimaryShadowAlert!();
        } else for (const n of [11, 12, 12]) assert.equal(await effects.arm(pr(n)), "shadow-refused");
      }, { envPath: selected, ...(named ? { instanceName: "core" } : {}) });
    };
    await run(true, true, false);
    assert.equal(open.length, 1, "concurrent primary refusals must open one escalation");
    assert.ok(edits.length > 0, "later refusals must update that escalation");
    const body = open[0]!.body!;
    assert.ok(body.includes(selected));
    assert.ok(body.includes(createHash("sha256").update(text(true)).digest("hex")));
    assert.match(body, /core/);
    assert.match(body, /\/pull\/11/);
    assert.match(body, /\/pull\/12/, "all concurrent refusals must survive a later update from the first factory");
    assert.match(body, /\/pull\/13/);
    assert.match(body, /3 refused PR/);
    assert.equal(edits.length, 2, "serialized edits preserve every concurrent refused PR");
    assert.equal(body.includes("state_dir:"), false, "registry contents must never enter the alert");
    assert.match(readFileSync(ledgerPath, "utf8"), /escalation.issue_opened/);
    const began = /Refusals began: ([^\n]+)/.exec(body)![1];
    const archive = join(root, `ledger.${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson.gz`);
    writeFileSync(archive, gzipSync(readFileSync(ledgerPath)));
    writeFileSync(ledgerPath, "");
    unreadable = true;
    await run(true);
    assert.equal(open.length, 1, "an unreadable issue list never permits another issue");
    assert.equal(failures.length, 3, "each failed alert attempt is visible while shadow refusal remains intact");
    unreadable = false;
    await run(true);
    assert.equal(open.length, 1, "a reconstructed effects object reuses the durable alert");
    assert.equal(/Refusals began: ([^\n]+)/.exec(open[0]!.body!)![1], began);
    assert.equal(edits.length, 2, "reconstruction preserves the refused set without another edit");
    await run(false);
    assert.equal(open.length, 1, "non-primary shadow instances stay quiet");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11444 criterion 1: the default alert gateway really shells out through the private gh fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-primary-shadow-default-"));
  const shim = ghShim([
    { when: "api repos/owner/repo/issues?", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/owner/repo/issues/1" },
  ], { kind: "primary-shadow-default" });
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR"] as const;
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  try {
    const selected = join(root, "selection.yaml");
    writeFileSync(selected, `# PRIVATE_FIXTURE_VALUE\ninstances:\n  core:\n    github_repo: owner/repo\n    state_dir: ${root}\n    primary: true\n    mode: shadow\n`);
    await withInstanceRegistryRuntime(async () => {
      const effects = buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow", config: { root } as Config,
        ledgerPath: join(root, "ledger.ndjson"), runId: "primary-default", plan: { tasks: [], byId: new Map() } as unknown as Plan,
        log: () => {}, armImpl: () => { throw new Error("shadow cannot arm"); } });
      await withLiveWritesAllowed(async () => {
        assert.equal(await effects.arm({ prNumber: 11, prUrl: "https://github.com/owner/repo/pull/11", headSha: "a".repeat(40) } as OpenPrView), "shadow-refused");
      });
    }, { envPath: selected, instanceName: "core" });
    const creates = shim.events().filter(e => e.phase === "start" && e.args[0] === "issue" && e.args[1] === "create");
    assert.equal(creates.length, 1, shim.calls().join("\n"));
    // The shared shim records joined argv; its event tokens do not preserve a multiline body.
    const transcript = shim.calls().join("\n");
    assert.ok(transcript.includes(selected));
    assert.equal(transcript.includes("PRIVATE_FIXTURE_VALUE"), false);
    assert.equal(transcript.includes("state_dir:"), false);
  } finally {
    for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
