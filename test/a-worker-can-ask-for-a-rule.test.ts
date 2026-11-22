import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult } from "../src/lib/run-result.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { slugifyRuleId } from "../src/lib/doctrine-lifecycle.js";
import { lookupWorkerRule, parseRuleHeadlines } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { wipeTestCommand } from "../src/run-task.js";
import { computeMatchedLearningsForArm } from "#src/lib/wipe-test.js";
import type { WorkerRulePullMeta } from "#src/lib/worker.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  IMPLEMENT_CLAUDE_TOOLS,
  WORKER_RULE_TOOL_NAME,
  createClaudeExecutableCache,
  createWorkerRuleTool,
  spawnWorker,
} from "../src/lib/worker.js";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}worker-rule-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "doctrine"));
  mkdirSync(join(root, "learnings"));
  writeFileSync(join(root, "CLAUDE.md"),
    "# Rules\n\n- **Read the installed schema before trusting a prompt.** → doctrine/schema.md\n" +
    "- **Keep every fetch visible.** → doctrine/ledger.md\n");
  writeFileSync(join(root, "doctrine", "schema.md"),
    "- **Read the installed schema before trusting a prompt.**\nMeasured schema evidence.\n");
  writeFileSync(join(root, "doctrine", "ledger.md"),
    "- **Keep every fetch visible.**\nMeasured ledger evidence.\n");
  writeFileSync(join(root, "learnings", "fixture.yaml"),
    "- id: fixture-learning\n  files: [src/lib/worker.ts]\n  fact: Read the real schema.\n  evidence: The installed type differs.\n  src: fixture\n");
  return root;
}

function readText(result: Awaited<ReturnType<ReturnType<typeof createWorkerRuleTool>["handler"]>>): string {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first.text;
}

test("W1-T4094: a worker can fetch a rule body by id or phrase", async (t) => {
  const root = fixture(t);
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  let options: Options | undefined;
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions",
    settingsFile,
    prompt: "read a rule",
    tools: [...IMPLEMENT_CLAUDE_TOOLS],
    ruleLookup: { onPulled: () => {} },
    config: { claudeBin: "/unused", root },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: root, exists: () => true, canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux",
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    queryFn: ((params: { options: Options }) => {
      options = params.options;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-rule", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"],
  });
  assert.ok(Array.isArray(options?.tools) && options.tools.includes(WORKER_RULE_TOOL_NAME),
    "the implement worker can call the named tool");
  assert.ok(options?.mcpServers?.knowledge, "the SDK receives its in-process knowledge server");

  const rule = createWorkerRuleTool(root, () => {});
  const byId = await rule.handler({ query: "read-the-installed-schema-before-trusting-a-prompt" }, {});
  const byPhrase = await rule.handler({ query: "installed schema" }, {});
  assert.equal(readText(byId), readText(byPhrase));
  assert.match(readText(byId), /Measured schema evidence/);
  const learning = await rule.handler({ query: "learnings#fixture-learning" }, {});
  assert.match(readText(learning), /Read the real schema\.\n\nThe installed type differs\./);

  const overall = join(root, "overall-learnings");
  mkdirSync(overall);
  writeFileSync(join(overall, "fixture.yaml"),
    "- id: overall-learning\n  files: [src/lib/worker.ts]\n  fact: Check the shared store.\n  evidence: Shared evidence is readable.\n  src: fixture\n");
  const layered = createWorkerRuleTool(root, () => {}, {
    homes: { projectDir: join(root, "learnings"), userOverallDir: overall },
    allowedIds: ["overall-learning"],
  });
  assert.match(readText(await layered.handler({ query: "learnings#overall-learning" }, {})), /Shared evidence is readable/);
  assert.equal((await layered.handler({ query: "learnings#fixture-learning" }, {})).isError, true,
    "an unselected learning is not exposed through the worker tool");
});

test("W1-T4094: every fetch is ledgered", async (t) => {
  const root = fixture(t);
  const ledgerPath = join(root, "ledger.ndjson");
  const rule = createWorkerRuleTool(root, (id, status) =>
    appendLedger(ledgerPath, { run_id: "RULE-1", task_id: "W1-T4094", step: "knowledge.pulled", id, status }));
  await rule.handler({ query: "installed schema" }, {});
  await rule.handler({ query: "learnings#fixture-learning" }, {});
  await rule.handler({ query: "absent-rule" }, {});
  writeFileSync(join(root, "doctrine", "ledger.md"), "- **Wrong headline.**\n");
  await rule.handler({ query: "keep-every-fetch-visible" }, {});
  assert.deepEqual(readLedgerLines(ledgerPath).map(({ step, id, status }) => ({ step, id, status })), [
    { step: "knowledge.pulled", id: "read-the-installed-schema-before-trusting-a-prompt", status: "found" },
    { step: "knowledge.pulled", id: "learnings#fixture-learning", status: "found" },
    { step: "knowledge.pulled", id: "absent-rule", status: "missing" },
    { step: "knowledge.pulled", id: "keep-every-fetch-visible", status: "error" },
  ]);
});

test("W1-T4094: the tool is read-only", async (t) => {
  const root = fixture(t);
  const before = ["CLAUDE.md", "doctrine/schema.md", "doctrine/ledger.md", "learnings/fixture.yaml"]
    .map((path) => readFileSync(join(root, path), "utf8"));
  const rule = createWorkerRuleTool(root, () => {});
  assert.equal(rule.annotations?.readOnlyHint, true);
  const response = await rule.handler({ query: "../worker.json" }, {});
  assert.equal(response.isError, true, "a caller cannot turn the query into a path read");
  assert.deepEqual(readdirSync(root).sort(), ["CLAUDE.md", "doctrine", "learnings"]);
  assert.deepEqual(
    ["CLAUDE.md", "doctrine/schema.md", "doctrine/ledger.md", "learnings/fixture.yaml"]
      .map((path) => readFileSync(join(root, path), "utf8")),
    before,
  );
});

test("W1-T4094: rules ablation enables headlines only in its unmasked arm", async (t) => {
  const root = fixture(t);
  const seen: Array<{ maskRules?: boolean; workerRuleHeadlinesEnabled?: boolean }> = [];
  const runTaskFn = (async (_id: string, options: { maskRules?: boolean; workerRuleHeadlinesEnabled?: boolean }) => {
    seen.push({ maskRules: options.maskRules, workerRuleHeadlinesEnabled: options.workerRuleHeadlinesEnabled });
    return {
      taskId: "W1-T4094", runId: options.maskRules ? "B" : "A", merged: false, costUsd: 1,
      verdict: "awaiting_merge",
    } satisfies RunResult;
  }) as typeof import("../src/run-task.js").runTask;
  const code = await wipeTestCommand(
    ["W1-T4094", "--factor", "rules", "--repo", "remudero", "--allow-non-sandbox"],
    { config: { claudeBin: "/bin/true", root }, runTaskFn, resolveMergedState: () => ({ merged: false }) },
  );
  assert.equal(code, 0);
  assert.deepEqual(seen, [
    { maskRules: undefined, workerRuleHeadlinesEnabled: true },
    { maskRules: true, workerRuleHeadlinesEnabled: true },
  ]);
});

test("W1-T4094: every live doctrine id agrees with the canonical id", () => {
  const root = process.cwd();
  const source = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const rules = parseRuleHeadlines(source);
  assert.ok(rules.length > 10, "the parity check covers the real rule index");
  for (const rule of rules) {
    const canonicalId = slugifyRuleId(rule.headline);
    const result = lookupWorkerRule(canonicalId, source, (path) => readFileSync(join(root, path), "utf8"), []);
    assert.equal(result?.id, canonicalId, rule.headline);
  }
});

// ── 2026-10-11: AN ID A FOLD RETIRED STILL REACHES ITS RULE ──────────────────────────────────────
// A frozen W1-T3323 row leaves the index by moving verbatim into a live rule's body, its id aliased
// in `doctrine/merged-rules.json`. The lookup matched only ids still IN the index, so a worker (or a
// brief) quoting a retired id was told "No rule matches" about a rule that is still there.

test("a worker asking for a retired rule id gets the live rule that carries its frozen bullet", (t) => {
  const root = fixture(t);
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  writeFileSync(join(root, "doctrine", "ledger.md"),
    "- **Keep every fetch visible.**\nMeasured ledger evidence.\n\n- **AN OLD FROZEN LINE ENDING ON A COLON:**\nits verbatim body.\n");
  const source = read("CLAUDE.md");
  assert.equal(lookupWorkerRule("an-old-frozen-line-ending-on-a-colon", source, read, []), undefined,
    "CONTROL: with no registry, the retired id is not in the index");
  writeFileSync(join(root, "doctrine", "merged-rules.json"),
    JSON.stringify([{ canonicalId: "keep-every-fetch-visible", aliasIds: ["an-old-frozen-line-ending-on-a-colon"] }]));
  const found = lookupWorkerRule("an-old-frozen-line-ending-on-a-colon", source, read, []);
  assert.equal(found?.id, "keep-every-fetch-visible");
  assert.match(found?.text ?? "", /AN OLD FROZEN LINE ENDING ON A COLON:\*\*\nits verbatim body\./);
  assert.equal(lookupWorkerRule("never-merged-anywhere", source, read, []), undefined, "an unrelated id still misses");
});

test("a worker asking for a retired rule id — every alias in the real registry reaches its carrier", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const source = read("CLAUDE.md");
  const groups = JSON.parse(read("doctrine/merged-rules.json")) as Array<{ canonicalId: string; aliasIds: string[] }>;
  const aliases = groups.flatMap((g) => g.aliasIds.map((alias) => ({ alias, canonicalId: g.canonicalId })));
  assert.ok(aliases.length >= 5, `positive control: the registry must carry the retired ids; got ${aliases.length}`);
  for (const { alias, canonicalId } of aliases) {
    assert.equal(lookupWorkerRule(alias, source, read, [])?.id, canonicalId, alias);
  }
});

test("a worker asking for a retired rule id — a broken registry is an error, never a silent miss", (t) => {
  const root = fixture(t);
  const source = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const reader = (registry: () => string) => (path: string) =>
    path === "doctrine/merged-rules.json" ? registry() : readFileSync(join(root, path), "utf8");
  assert.throws(() => lookupWorkerRule("retired-id", source, reader(() => "{not json"), []), /is not JSON/);
  assert.throws(() => lookupWorkerRule("retired-id", source, reader(() => "{}"), []), /is not an array/);
  assert.throws(() => lookupWorkerRule("retired-id", source, reader(() => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  }), []), /is unreadable/);
  // A phrase that matches never consults the registry, so a broken registry cannot break it.
  assert.match(lookupWorkerRule("installed schema", source, reader(() => "{not json"), [])?.text ?? "", /Measured schema evidence/);
});

// ── W1-T11159: a lookup binds the selected store and payload, and still honors CURRENT eligibility ──

const SHARED_SLUG = "shared-slug";
const FACT_A = "PROJECT-A fact sentinel";
const FACT_B = "USER-B fact sentinel";
const EVIDENCE_A = "PROJECT-A evidence sentinel";
const EVIDENCE_B = "USER-B evidence sentinel";

function entryYaml(id: string, over: { files?: string; fact: string; evidence: string; lifecycle?: string }): string {
  return `- id: ${id}\n  files: [${over.files ?? "src/lib/worker.ts"}]\n${over.lifecycle ? `  lifecycle: ${over.lifecycle}\n` : ""}` +
    `  fact: ${over.fact}\n  evidence: ${over.evidence}\n  src: fixture\n`;
}

interface Stores { root: string; project: string; overall: string; homes: { projectDir: string; userOverallDir: string } }

/** Project A and user-overall B share one slug; ONLY the files each declares decides which one the task selects. */
function layeredStores(t: { after: (fn: () => void) => void }, matches: { a: boolean; b: boolean }): Stores {
  const root = fixture(t);
  const project = join(root, "learnings");
  const overall = join(root, "overall-learnings");
  mkdirSync(overall);
  writeFileSync(join(project, "fixture.yaml"), entryYaml(SHARED_SLUG, {
    files: matches.a ? "src/lib/worker.ts" : "docs/elsewhere.md", fact: FACT_A, evidence: EVIDENCE_A,
  }) + entryYaml("unrelated-c", { files: "docs/elsewhere.md", fact: "C fact", evidence: "C evidence" }));
  writeFileSync(join(overall, "fixture.yaml"), entryYaml(SHARED_SLUG, {
    files: matches.b ? "src/lib/worker.ts" : "docs/elsewhere.md", fact: FACT_B, evidence: EVIDENCE_B,
  }));
  return { root, project, overall, homes: { projectDir: project, userOverallDir: overall } };
}

function selectFor(stores: Stores) {
  return computeMatchedLearningsForArm("A", { homes: stores.homes, taskFiles: ["src/lib/worker.ts"] });
}

function toolFor(stores: Stores, selection: Awaited<ReturnType<typeof selectFor>>) {
  const pulls: Array<{ id: string; status: string; meta?: WorkerRulePullMeta }> = [];
  const rule = createWorkerRuleTool(stores.root, (id, status, meta) => pulls.push({ id, status, meta }), {
    homes: stores.homes,
    allowedIds: selection.selectedIds,
    selected: selection.selectedLearnings,
  });
  return { rule, pulls };
}

const ask = async (rule: ReturnType<typeof createWorkerRuleTool>, query: string) => {
  const result = await rule.handler({ query }, {});
  return { isError: result.isError === true, text: readText(result) };
};

test("selected learning lookup preserves the exact selected source and payload revision", async (t) => {
  const stores = layeredStores(t, { a: false, b: true });
  const selection = await selectFor(stores);
  assert.deepEqual(selection.selectedIds, [SHARED_SLUG]);
  assert.equal(selection.selectedLearnings.length, 1);
  const [handle] = selection.selectedLearnings;
  assert.equal(handle.id, SHARED_SLUG);
  assert.equal(handle.source, "user-overall", "the handle names the store the selected record came from");
  assert.match(handle.payloadRevision, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(handle), "the handle is immutable for the run");

  const { rule, pulls } = toolFor(stores, selection);
  const got = await ask(rule, `learnings#${SHARED_SLUG}`);
  assert.equal(got.isError, false);
  assert.equal(got.text, `${FACT_B}\n\n${EVIDENCE_B}`, "the exact selected fact and evidence payload is served");
  assert.deepEqual(pulls.map(({ id, status, meta }) => ({ id, status, meta })), [{
    id: `learnings#${SHARED_SLUG}`, status: "found",
    meta: { outcome: "delivered", source: "user-overall", revision: handle.payloadRevision.slice(0, 16) },
  }]);

  const projectSelected = await selectFor(layeredStores(t, { a: true, b: false }));
  assert.equal(projectSelected.selectedLearnings[0].source, "project");
  assert.notEqual(projectSelected.selectedLearnings[0].payloadRevision, handle.payloadRevision);
});

test("selected learning lookup refuses cross-layer substitution and evidence-only drift", async (t) => {
  // Selected user-overall B must never resolve to the nonselected project A that shares its slug.
  const crossLayer = layeredStores(t, { a: false, b: true });
  const crossSelection = await selectFor(crossLayer);
  rmSync(join(crossLayer.overall, "fixture.yaml"));
  const afterRemoval = await ask(toolFor(crossLayer, crossSelection).rule, `learnings#${SHARED_SLUG}`);
  assert.equal(afterRemoval.isError, true, "B is gone; A must not be served in its place");
  assert.doesNotMatch(afterRemoval.text, /sentinel/);
  assert.match(afterRemoval.text, /unavailable \(missing\)/);

  // Both same-slug records selected: a bare slug cannot say which, so it is ambiguous rather than first-match.
  const both = layeredStores(t, { a: true, b: true });
  const bothSelection = await selectFor(both);
  assert.equal(bothSelection.selectedLearnings.length, 2);
  const ambiguous = await ask(toolFor(both, bothSelection).rule, `learnings#${SHARED_SLUG}`);
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /unavailable \(ambiguous\)/);
  assert.doesNotMatch(ambiguous.text, /sentinel/);

  // Same-ID edits to the selected record: an evidence-only edit and a fact-only edit each refuse.
  for (const [edit, label] of [
    [{ fact: FACT_A, evidence: "EDITED evidence sentinel" }, "evidence-only"],
    [{ fact: "EDITED fact sentinel", evidence: EVIDENCE_A }, "fact-only"],
  ] as const) {
    const stores = layeredStores(t, { a: true, b: false });
    const selection = await selectFor(stores);
    const { rule, pulls } = toolFor(stores, selection);
    assert.equal((await ask(rule, `learnings#${SHARED_SLUG}`)).isError, false, `${label}: unchanged A is readable`);
    writeFileSync(join(stores.project, "fixture.yaml"), entryYaml(SHARED_SLUG, edit));
    const drifted = await ask(rule, `learnings#${SHARED_SLUG}`);
    assert.equal(drifted.isError, true, `${label}: the edited payload is not silently substituted`);
    assert.match(drifted.text, /unavailable \(drift\)/);
    assert.doesNotMatch(drifted.text, /EDITED/);
    assert.equal(pulls.at(-1)?.meta?.outcome, "drift");
    assert.equal(pulls.at(-1)?.status, "missing");
  }
});

test("selected learning lookup separates live eligibility from content identity", async (t) => {
  // Quarantine after selection: a frozen snapshot would still serve it; current eligibility must not.
  const quarantined = layeredStores(t, { a: true, b: false });
  const quarantinedSelection = await selectFor(quarantined);
  const q = toolFor(quarantined, quarantinedSelection);
  writeFileSync(join(quarantined.project, "fixture.yaml"), entryYaml(SHARED_SLUG, {
    fact: FACT_A, evidence: EVIDENCE_A, lifecycle: "quarantined",
  }).replace("  src: fixture\n", "  quarantined_reason: failed\n  src: fixture\n"));
  const refused = await ask(q.rule, `learnings#${SHARED_SLUG}`);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /unavailable \(ineligible\)/);
  assert.equal(q.pulls.at(-1)?.meta?.outcome, "ineligible");

  // Changing an UNRELATED record in the same store must not invalidate the healthy read.
  const healthy = layeredStores(t, { a: true, b: false });
  const healthySelection = await selectFor(healthy);
  const h = toolFor(healthy, healthySelection);
  writeFileSync(join(healthy.project, "fixture.yaml"), entryYaml(SHARED_SLUG, { fact: FACT_A, evidence: EVIDENCE_A })
    + entryYaml("unrelated-c", { files: "docs/elsewhere.md", fact: "C fact CHANGED", evidence: "C evidence CHANGED" }));
  const still = await ask(h.rule, `learnings#${SHARED_SLUG}`);
  assert.equal(still.isError, false, "an unrelated edit leaves the selected learning readable");
  assert.equal(still.text, `${FACT_A}\n\n${EVIDENCE_A}`);
  assert.equal(h.pulls.at(-1)?.meta?.outcome, "delivered");

  // An unreadable source is unavailable, not a stale success.
  writeFileSync(join(healthy.project, "fixture.yaml"), "- id: [unterminated\n");
  const unreadable = await ask(h.rule, `learnings#${SHARED_SLUG}`);
  assert.equal(unreadable.isError, true);
  assert.match(unreadable.text, /unavailable \(unreadable\)/);
  assert.equal(h.pulls.at(-1)?.status, "error");
  assert.equal(h.pulls.at(-1)?.meta?.outcome, "unreadable");
});

test("selected learning lookup preserves masking privacy and observational authority", async (t) => {
  const stores = layeredStores(t, { a: false, b: true });
  const selection = await selectFor(stores);
  const { rule, pulls } = toolFor(stores, selection);

  // An unselected id stays refused even though it exists in the project store.
  const unselected = await ask(rule, "learnings#unrelated-c");
  assert.equal(unselected.isError, true);
  assert.equal(unselected.text, 'No rule matches "learnings#unrelated-c".');
  assert.equal(pulls.at(-1)?.meta?.outcome, "unselected");

  // Masked arm B selects nothing, so nothing is reachable through the tool.
  let loads = 0;
  const masked = await computeMatchedLearningsForArm("B", { homes: stores.homes, taskFiles: ["src/lib/worker.ts"] }, {
    loadLayeredLearningsForTaskFiles: () => { loads++; return { entries: [] }; },
    selectLearnings: () => { throw new Error("masked arm must not select"); },
    renderMatchedLearnings: () => { throw new Error("masked arm must not render"); },
  });
  assert.equal(loads, 0);
  assert.deepEqual(masked.selectedLearnings, []);
  const maskedTool = toolFor(stores, masked);
  assert.equal((await ask(maskedTool.rule, `learnings#${SHARED_SLUG}`)).isError, true, "masked arm cannot read a learning");
  assert.equal(maskedTool.pulls.at(-1)?.meta?.outcome, "unselected");

  // Telemetry is fixed-schema, carries no content, and delivery makes no change to any store.
  const before = [join(stores.project, "fixture.yaml"), join(stores.overall, "fixture.yaml")].map((path) => readFileSync(path, "utf8"));
  await ask(rule, `learnings#${SHARED_SLUG}`);
  const delivered = pulls.at(-1);
  assert.deepEqual(Object.keys(delivered?.meta ?? {}).sort(), ["outcome", "revision", "source"]);
  const logged = JSON.stringify(pulls);
  for (const secret of [FACT_A, FACT_B, EVIDENCE_A, EVIDENCE_B, stores.root]) {
    assert.ok(!logged.includes(secret), `telemetry never carries ${secret}`);
  }
  assert.equal(rule.annotations?.readOnlyHint, true);
  assert.deepEqual(
    [join(stores.project, "fixture.yaml"), join(stores.overall, "fixture.yaml")].map((path) => readFileSync(path, "utf8")),
    before,
  );
});
