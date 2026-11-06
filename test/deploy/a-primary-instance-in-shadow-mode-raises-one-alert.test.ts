import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { ghShim } from "#test/helpers/gh-shim.js";

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
    const run = async (primary: boolean, concurrent = false) => {
      writeFileSync(selected, text(primary));
      await withInstanceRegistryRuntime(async () => {
        const makeEffects = () => buildSweepEffects({ owner: "owner", repo: "repo", repoMode: "shadow",
          config: { root } as Config, ledgerPath, runId: "SWEEP-primary-shadow",
          plan: { tasks: [], byId: new Map() } as unknown as Plan, issuesImpl: issues,
          log: step => { if (step === "primary_shadow.alert_failed") failures.push(step); },
          armImpl: () => { throw new Error("shadow must never arm"); } });
        const effects = makeEffects();
        const pr = (n: number) => ({ prNumber: n, prUrl: `https://github.com/owner/repo/pull/${n}`, headSha: "a".repeat(40) } as OpenPrView);
        if (concurrent) {
          const results = await Promise.all([effects.arm(pr(11)), makeEffects().arm(pr(12))]);
          assert.deepEqual(results, ["shadow-refused", "shadow-refused"]);
          assert.equal(await effects.arm(pr(13)), "shadow-refused");
          assert.equal(await effects.arm(pr(13)), "shadow-refused");
        } else for (const n of [11, 12, 12]) assert.equal(await effects.arm(pr(n)), "shadow-refused");
      }, { envPath: selected, instanceName: "core" });
    };
    await run(true, true);
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
    assert.equal(edits.length, 2, "the repeated identical refused-PR set adds no edit");
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
