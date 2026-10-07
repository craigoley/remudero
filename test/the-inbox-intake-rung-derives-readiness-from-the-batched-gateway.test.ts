import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { buildBatchedGithub, ghGateway } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildDepsReadinessAccessors, buildIntakeRungsDaemonHooks, inboxCommand, ledgerPathFor } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const PROOF = "unit test: test/the-inbox-intake-rung-derives-readiness-from-the-batched-gateway.test.ts";

test(`${PROOF} — 50 tasks use one fetch and the same gateway on the next intake pass`, async (t) => {
  t.mock.method(console, "log", () => {});
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5783-`));
  const config = { root, claudeBin: "/bin/true" };
  const shim = ghShim([{ when: "api", stdout: "[]" }], { kind: "t5783-gh" });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath ?? ""}`;
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(ledgerPathFor(config), "");
    const plan = loadPlan(new URL("../plan/tasks.yaml", import.meta.url).pathname);
    const tasks = [...plan.byId.values()].filter((t) => t.status === "queued" && !t.retirement).slice(0, 50);
    assert.equal(tasks.length, 50);
    const control = buildDepsReadinessAccessors(plan, { ledgerPath: ledgerPathFor(config), github: ghGateway("o", "r") });
    for (const task of tasks) control.isMerged(task);
    assert.ok(shim.calls().filter((call) => call.includes("search")).length >= 50);
    const before = shim.calls().length;
    const proposals = tasks.map((t) => ({ id: `proof-debt:${t.id}`, summary: "readiness probe", evidenceAnchors: [] }));
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
    writeFileSync(join(root, "state", "inbox-drafts.json"), JSON.stringify(Object.fromEntries(proposals.map((p) => [p.id, {
      proposalId: p.id, fragmentYaml: "[]", stampLine: `- ${p.id} (readiness probe)`, anchorFingerprint: "",
    }]))));
    let builds = 0;
    let fetches = 0;
    const queried = new Set<string>();
    const hooks = buildIntakeRungsDaemonHooks({
      config,
      buildBatchedGithub: (owner, repo) => {
        builds++;
        const gateway = buildBatchedGithub(owner, repo, {
          now: () => 0,
          fetchAll: () => { fetches++; return []; },
          fetchAllIssues: () => [],
          commitTrailerIndex: () => new Map(),
        });
        return {
          ...gateway,
          findMergedByTrailer: (id) => { queried.add(id); return gateway.findMergedByTrailer(id); },
        };
      },
    });
    assert.equal(builds, 1, "one gateway is built when the hooks are constructed");
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(await hooks.runIntakeRung({ rung: "inbox", fire: true, reason: "due" }), {
        rung: "inbox", status: "ok", exit_code: 0,
      });
      assert.equal(fetches, 1, "both passes share the gateway's warm batched cache");
      assert.equal(builds, 1);
    }
    assert.deepEqual([...queried].sort(), tasks.map((t) => t.id).sort(), "all 50 tasks reached the injected gateway");
    const rows = readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const classifications = rows.filter((row) => row.step === "inbox.classified");
    assert.equal(classifications.length, 100);
    assert.ok(classifications.every((row) => row.state === "ready"));
    assert.deepEqual(shim.calls().slice(before).filter((call) => call.includes("search")), []);
    const beforeCli = shim.calls().length;
    assert.equal(await inboxCommand([], { config }), 0);
    const cliCalls = shim.calls().slice(beforeCli);
    assert.ok(cliCalls.some((call) => call.startsWith("api ")), "the cli constructs its default gateway");
    assert.deepEqual(cliCalls.filter((call) => call.includes("search")), []);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test(`${PROOF} — the cli default still classifies an empty inbox`, async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5783-empty-`));
  try {
    assert.equal(await inboxCommand(["--dry-run"], { config: { root, claudeBin: "/bin/true" } }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
