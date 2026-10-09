import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import { anchorFingerprint, type Proposal } from "../src/lib/inbox.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildInboxDraftHook } from "../src/run-task.js";

const PROOF = "unit test: test/the-inbox-draft-hook-builds-no-readiness-its-selection-never-reads.test.ts";

test(`${PROOF} — a pass without tick facts preserves selection and constructs neither plan nor gateway`, async () => {
  const measuring = process.env.RMD_T5784_CONSTRUCTOR_PROBE === "1";
  if (!measuring) {
    // Precise profiling resets V8's coverage counters. Isolate it from the parent's coverage
    // session, then exercise selection normally in this process as well.
    const probe = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "", RMD_T5784_CONSTRUCTOR_PROBE: "1" },
    });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout, /^# tests 1$/m);
    assert.match(probe.stdout, /^# fail 0$/m);
  }
  const root = makeTempDir("t5784-draft-selection");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const anchor = { description: "present", pattern: "PRESENT", path: "note.md" };
  const proposals: Proposal[] = [
    { id: "P-READY", summary: "draftable", evidenceAnchors: [anchor] },
    { id: "P-STALE", summary: "stale draft", evidenceAnchors: [anchor] },
    { id: "proof-debt:W1-T5784", summary: "task referent is not draft readiness", evidenceAnchors: [] },
    { id: "P-RATIFIED", summary: "ratified", evidenceAnchors: [] },
    { id: "P-DECLINED", summary: "declined", evidenceAnchors: [] },
    { id: "P-TRIGGER", summary: "held", evidenceAnchors: [], trigger: { description: "wait", fired: false } },
    { id: "P-DRIFTED", summary: "anchor drifted", evidenceAnchors: [{ description: "gone", pattern: "GONE" }] },
    { id: "P-CONFLICT", summary: "conflicted", evidenceAnchors: [], conflictsWith: ["P-TRIGGER"] },
    { id: "P-CACHED", summary: "fresh draft", evidenceAnchors: [anchor] },
  ];
  const draft = (id: string, fingerprint: string) => ({
    proposalId: id, fragmentYaml: "[]", stampLine: `- ${id}`, anchorFingerprint: fingerprint,
  });
  writeFileSync(join(state, "inbox-proposals.json"), JSON.stringify({ proposals }));
  writeFileSync(join(state, "inbox-drafts.json"), JSON.stringify({
    "P-STALE": draft("P-STALE", "old"),
    "P-CACHED": draft("P-CACHED", anchorFingerprint([anchor])),
  }));
  writeFileSync(join(state, "ledger.ndjson"), [
    { step: "ratify.approved", task_id: "P-RATIFIED" },
    { step: "panel.proposal_declined", task_id: "P-DECLINED", reason: "operator declined" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const session = new Session();
  if (measuring) session.connect();
  try {
    if (measuring) {
      await session.post("Profiler.enable");
      await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    }
    const constructions = async () => {
      const { result } = await session.post("Profiler.takePreciseCoverage");
      const calls = (path: string, name: string) => result
        .filter((script) => script.url.endsWith(path))
        .flatMap((script) => script.functions)
        .filter((fn) => fn.functionName === name)
        .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
      return { plan: calls("/src/lib/plan.ts", "loadPlan"), gateway: calls("/src/lib/status.ts", "buildBatchedGithub") };
    };
    if (measuring) {
      const planPath = join(root, "tasks.yaml");
      writeFileSync(planPath, "[]\n");
      loadPlan(planPath);
      buildBatchedGithub("o", "r", { fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map() });
      assert.deepEqual(await constructions(), { plan: 1, gateway: 1 }, "the counters see both real constructors");
    }

    const batches: string[][] = [];
    const logs: string[] = [];
    const warmed: string[] = [];
    const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-5784", (step) => { logs.push(step); },
      async (due) => {
        batches.push(due.map((proposal) => proposal.id));
        return due.map((proposal) => ({ proposalId: proposal.id, ok: false as const, error: "ordinary failure" }));
      },
      () => { throw new Error("a warmed anchor must not fall back to synchronous grep"); },
      () => "sha",
      async (_ref, evidence) => { warmed.push(evidence.pattern); return evidence.pattern !== "GONE"; },
    );
    for (let pass = 0; pass < 2; pass++) {
      writeFileSync(join(state, "inbox-draft-attempts.json"), "{}");
      await hook();
      if (measuring) assert.deepEqual(await constructions(), { plan: 0, gateway: 0 }, "no tick facts require neither construction");
    }
    assert.deepEqual(batches, [
      ["P-STALE", "P-READY", "proof-debt:W1-T5784"],
      ["P-STALE", "P-READY", "proof-debt:W1-T5784"],
    ]);
    assert.ok(!logs.includes("inbox.draft_readiness_unavailable"));
    assert.ok(!logs.includes("inbox.draft_rung.error"));
    assert.deepEqual(warmed.sort(), ["GONE", "PRESENT"], "anchor warming is shared across passes");
    const attempts = JSON.parse(readFileSync(join(state, "inbox-draft-attempts.json"), "utf8"));
    assert.deepEqual(Object.keys(attempts).sort(), ["P-READY", "P-STALE", "proof-debt:W1-T5784"]);
    assert.deepEqual(JSON.parse(readFileSync(join(state, "inbox-draft-inflight.json"), "utf8")), {});
  } finally {
    if (measuring) {
      await session.post("Profiler.stopPreciseCoverage");
      session.disconnect();
    }
    rmSync(root, { recursive: true, force: true });
  }
});
