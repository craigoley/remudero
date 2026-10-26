import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { WORKER_PROVIDER_IDS } from "#src/lib/config-schema.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import { TASK_TYPES } from "#src/lib/plan.js";
import {
  loadInjectableSkills, observeSkillSelection, scanSkillDraft, workerAllowlistFromCapabilityContext,
  type SkillDraft, type SkillWorkerCapabilityContext,
} from "#src/lib/skill-workshop.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { implementToolBound, resolveDispatchLaneToolBound, resolveGenericRouteToolBound } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const generation = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const settings: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "settings", "worker.json"), "utf8"));

/** This is a census of reporting/selection, never a provider invocation or a tool grant. */
function assertDiscovery(dir: string): string[] {
  const approved = loadInjectableSkills(dir);
  const optedIn = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && readdirSync(join(dir, entry.name)).includes("SKILL.md")).flatMap(entry => {
    const markdown = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
    const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    return front !== undefined && /^applies-to:/m.test(front) ? [{ name: entry.name, markdown }] : [];
  });
  for (const { name, markdown } of optedIn) {
    const label = `skill:${name}`;
    const skill = approved.find(candidate => candidate.name === name);
    assert.ok(skill, `${label}: applies-to metadata must load, including empty or malformed declarations`);
    assert.ok(skill.appliesTo.every(lane => (TASK_TYPES as readonly string[]).includes(lane)), `${label}: applies-to must name a TASK_TYPES member`);
    assert.ok(skill.body.length <= DEFAULT_KNOWLEDGE_BUDGET_CHARS, `${label}: body exceeds the knowledge budget`);
    for (const glob of skill.whenPaths ?? []) {
      const selected = observeSkillSelection([{ ...skill, whenPaths: [glob] }], skill.appliesTo[0], DEFAULT_KNOWLEDGE_BUDGET_CHARS, tracked).selected;
      assert.ok(selected.some(candidate => candidate.name === name), `${label}: when-paths glob ${glob} matches no tracked file`);
    }
    for (const lane of TASK_TYPES) {
      const selected = observeSkillSelection([skill], lane, DEFAULT_KNOWLEDGE_BUDGET_CHARS, tracked).selected;
      assert.equal(selected.some(candidate => candidate.name === name), skill.appliesTo.includes(lane), `${label}: selector mismatch for ${lane}`);
    }
    const consumers: SkillWorkerCapabilityContext["consumers"][number][] = [];
    for (const lane of skill.appliesTo) for (const provider of WORKER_PROVIDER_IDS) {
      const tools = lane === "implement" ? implementToolBound(provider, undefined)
        : lane === "recon" || lane === "diagnose" ? resolveDispatchLaneToolBound(lane, provider === "cash" || provider === "openweight" ? "openweight" : "claude")
        : implementToolBound(provider, resolveGenericRouteToolBound(lane));
      assert.ok(tools, `${label}: missing actual ${lane}/${provider} tool bound`);
      consumers.push({ lane, provider, source: `${generation}:src/lib/worker.ts`, tools });
    }
    const draft: SkillDraft = { name, markdown, description: `conformance of approved ${name}`, candidateHash: generation, procedureKey: name, supportingRuns: 0 };
    const allowlist = workerAllowlistFromCapabilityContext(settings, { generation, currentGeneration: generation, consumers });
    const scan = scanSkillDraft(draft, allowlist);
    assert.ok(scan.ok, `${label}: scanner refused ${scan.offendingLine ?? "<unknown>"}: ${scan.reason ?? "<unknown>"}`);
  }
  return optedIn.map(skill => skill.name).sort();
}

test("every applies-to skill satisfies the discovery invariants", () => {
  const names = assertDiscovery(join(REPO_ROOT, ".claude", "skills"));
  assert.ok(names.includes("proof-preflight") && names.includes("ci-state-forensics"), "positive controls prove the live approved tree was read");
});

test("discovery rejects malformed applies-to and dead when-paths by skill name", t => {
  const dir = makeTempDir("skill-discovery-conformance");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = (name: string, front: string, body = "Inspect the exact source before reporting the observed result.") => {
    const root = join(dir, name); mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\napplies-to: ${front}\n---\n\n${body}\n`);
    return root;
  };
  assert.deepEqual(assertDiscovery(fixture("healthy", "implement\nwhen-paths: src/lib/skill-workshop.ts")), ["healthy"]);
  assert.throws(() => assertDiscovery(fixture("typo-skill", "implemnt")), /skill:typo-skill: applies-to/);
  assert.throws(() => assertDiscovery(fixture("dead-path-skill", "implement\nwhen-paths: no-such-source-12345/**")), /skill:dead-path-skill: when-paths/);
  assert.throws(() => assertDiscovery(fixture("empty-lane-skill", "")), /skill:empty-lane-skill: applies-to/);
  assert.throws(() => assertDiscovery(fixture("oversized-skill", "implement", "x".repeat(DEFAULT_KNOWLEDGE_BUDGET_CHARS + 1))), /skill:oversized-skill: body/);
  assert.throws(() => assertDiscovery(fixture("forbidden-tool-skill", "implement", "WebSearch seeks material outside this implementation tool bound.")), /skill:forbidden-tool-skill: scanner/);
});
