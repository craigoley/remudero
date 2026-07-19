#!/usr/bin/env node
// scripts/learnings-assert-check.mjs
//
// SELF-VERIFYING LEARNINGS gate (W1-T34, extends W1-T29 plan-claims to KNOWLEDGE).
//
// Provenance decays: a fact pinned to a specific file/SDK shape must not keep being injected once
// that shape changes. A learnings entry may carry an optional `assertion:` (a shell command that
// must exit 0 for its `fact` to still be considered true, same shape as plan/claims.yaml's
// assertions). This script runs every entry's assertion and compares the OUTCOME against the
// entry's currently-committed `lifecycle`:
//
//   - an `active` entry whose assertion now FAILS is STALE -- it should be `quarantined`.
//   - a `quarantined` entry whose assertion now PASSES is STALE -- it should be restored to `active`.
//
// Mirrors the generate-and-`--check` shape scripts/generate-learnings-index.mjs already
// established for the W1-T33 index:
//   node scripts/learnings-assert-check.mjs [--dir learnings]           # MUTATE: fix the drift,
//                                                                       #   write the shard(s), exit 0
//   node scripts/learnings-assert-check.mjs --check [--dir learnings]  # GATE: exit 1 on ANY drift,
//                                                                       #   naming the stale entry(ies)
//
// The mutation is TEXT SURGERY scoped to exactly the drifting entry's block (`- id: <id>` up to
// the next top-level `- id:` or EOF), not a full YAML re-serialize -- round-tripping the whole
// document through the `yaml` library's stringifier reflows unrelated entries (rewraps `files:`
// flow sequences, refolds `fact: >-` block scalars), which would turn every regeneration into a
// noisy whole-file diff. Surgery keeps the diff to exactly the two lines that changed.
//
// src/lib/learnings.ts (the injector) NEVER executes an assertion itself -- it only ever reads
// the persisted `lifecycle` field, so prompt rendering stays a pure, fast, non-shelling lookup.
// This script is the ONLY place a learnings entry's shell command runs.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const VALID_LIFECYCLES = new Set(["active", "superseded", "quarantined"]);

/**
 * Parse one shard YAML file into the fields this script needs (id, lifecycle, assertion,
 * quarantined_reason) -- intentionally NOT the full LearningEntry schema src/lib/learnings.ts
 * enforces; that module is the runtime source of truth for shape, this script only needs enough
 * to plan + apply a lifecycle mutation. Returns `[]` for an empty/absent document.
 */
export function loadShardEntries(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw new Error(`learnings-assert-check: ${path} must be a YAML list of entries`);
  }
  return doc.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`learnings-assert-check: ${path} entry ${i} must be a mapping`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`learnings-assert-check: ${path} entry ${i} missing string 'id'`);
    }
    const lifecycle = entry.lifecycle === undefined ? "active" : entry.lifecycle;
    if (!VALID_LIFECYCLES.has(lifecycle)) {
      throw new Error(`learnings-assert-check: ${path} entry '${entry.id}' has invalid lifecycle '${lifecycle}'`);
    }
    if (entry.assertion !== undefined && (typeof entry.assertion !== "string" || entry.assertion.length === 0)) {
      throw new Error(`learnings-assert-check: ${path} entry '${entry.id}': 'assertion' must be a non-empty string`);
    }
    return {
      id: entry.id,
      lifecycle,
      assertion: typeof entry.assertion === "string" ? entry.assertion : undefined,
      quarantinedReason: typeof entry.quarantined_reason === "string" ? entry.quarantined_reason : undefined,
    };
  });
}

/** Run one entry's assertion as a shell command from `cwd` (repo root by default). */
export function runAssertion(assertion, cwd) {
  const result = spawnSync(assertion, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Escape a string for a YAML double-quoted scalar (the format quarantined_reason is written in). */
export function escapeYamlDoubleQuoted(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Find the `[start, end)` character range of one entry's block (`- id: <id>` line through the char before the next top-level `- id:` line, or EOF). */
export function findEntryBlock(text, id) {
  const startRe = new RegExp(`^- id: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const startMatch = startRe.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index;
  const nextRe = /^- id: /m;
  nextRe.lastIndex = start + startMatch[0].length;
  const rest = text.slice(start + startMatch[0].length);
  const nextMatch = /^- id: /m.exec(rest);
  const end = nextMatch ? start + startMatch[0].length + nextMatch.index : text.length;
  return { start, end };
}

/**
 * Rewrite one entry's block to `lifecycle: quarantined`, adding/replacing `quarantined_reason`.
 * Pure text surgery -- every other byte in the shard is untouched.
 */
export function quarantineEntryInText(text, id, reason) {
  const range = findEntryBlock(text, id);
  if (!range) throw new Error(`learnings-assert-check: entry '${id}' not found while quarantining`);
  let block = text.slice(range.start, range.end);
  const reasonLine = `  quarantined_reason: "${escapeYamlDoubleQuoted(reason)}"`;
  if (/^  lifecycle:.*$/m.test(block)) {
    block = block.replace(/^  lifecycle:.*$/m, `  lifecycle: quarantined\n${reasonLine}`);
  } else if (/^  subsystem:.*$/m.test(block)) {
    block = block.replace(/^  subsystem:.*$/m, (m) => `${m}\n  lifecycle: quarantined\n${reasonLine}`);
  } else {
    block = block.replace(/^- id: .*$/m, (m) => `${m}\n  lifecycle: quarantined\n${reasonLine}`);
  }
  return text.slice(0, range.start) + block + text.slice(range.end);
}

/** Restore one entry's block to `lifecycle: active`, dropping `quarantined_reason`. */
export function restoreEntryInText(text, id) {
  const range = findEntryBlock(text, id);
  if (!range) throw new Error(`learnings-assert-check: entry '${id}' not found while restoring`);
  let block = text.slice(range.start, range.end);
  block = block.replace(/^  lifecycle:.*$/m, "  lifecycle: active");
  block = block.replace(/^  quarantined_reason:.*\n/m, "");
  return text.slice(0, range.start) + block + text.slice(range.end);
}

/**
 * Run every assertion in every `*.yaml` shard under `dir` and plan the mutations needed to make
 * the committed corpus match a fresh re-verification. `superseded` entries and entries with no
 * `assertion` are never evaluated (nothing to verify, nothing to plan). `assertionCwd` is the
 * directory assertions execute from (repo root in real use; a fixture dir in tests).
 */
export function planMutations(dir, assertionCwd) {
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  const results = [];
  const mutations = [];
  for (const filename of filenames) {
    const path = join(dir, filename);
    const entries = loadShardEntries(path);
    for (const entry of entries) {
      if (!entry.assertion || entry.lifecycle === "superseded") continue;
      const verdict = runAssertion(entry.assertion, assertionCwd);
      results.push({ filename, id: entry.id, assertion: entry.assertion, lifecycle: entry.lifecycle, verdict });
      if (entry.lifecycle === "active" && !verdict.ok) {
        mutations.push({
          filename,
          id: entry.id,
          from: "active",
          to: "quarantined",
          reason: `assertion failed (exit ${verdict.status}): ${entry.assertion}`,
        });
      } else if (entry.lifecycle === "quarantined" && verdict.ok) {
        mutations.push({ filename, id: entry.id, from: "quarantined", to: "active" });
      }
    }
  }
  return { results, mutations };
}

/** Apply planned mutations to their shard files on disk (MUTATE mode). Returns the mutation list actually applied. */
export function applyMutations(dir, mutations) {
  const byFile = new Map();
  for (const m of mutations) {
    if (!byFile.has(m.filename)) byFile.set(m.filename, readFileSync(join(dir, m.filename), "utf8"));
    let text = byFile.get(m.filename);
    text = m.to === "quarantined" ? quarantineEntryInText(text, m.id, m.reason) : restoreEntryInText(text, m.id);
    byFile.set(m.filename, text);
  }
  for (const [filename, text] of byFile) {
    writeFileSync(join(dir, filename), text);
  }
  return mutations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", default: "learnings" },
      cwd: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const assertionCwd = values.cwd ?? process.cwd();

  let plan;
  try {
    plan = planMutations(values.dir, assertionCwd);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  for (const r of plan.results) {
    console.log(`${r.verdict.ok ? "PASS" : "FAIL"}  ${r.filename}#${r.id} (lifecycle: ${r.lifecycle}) -- ${r.assertion}`);
  }

  if (values.check) {
    if (plan.mutations.length > 0) {
      console.error(
        "\nlearnings-assert-check: STALE -- the committed corpus does not match a fresh re-verification:\n",
      );
      for (const m of plan.mutations) {
        console.error(
          `  [${m.id}] (${m.filename}) lifecycle is '${m.from}' but should be '${m.to}'${m.reason ? ` -- ${m.reason}` : " (assertion now passes -- re-verification restores it)"}`,
        );
      }
      console.error("\nRun 'npm run learnings-assert' and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log(`\nlearnings-assert-check: OK -- every asserted entry's lifecycle matches a fresh re-verification.`);
    process.exitCode = 0;
    return;
  }

  applyMutations(values.dir, plan.mutations);
  if (plan.mutations.length === 0) {
    console.log(`\nlearnings-assert: OK -- no drift, nothing to mutate.`);
  } else {
    for (const m of plan.mutations) {
      console.log(`\nlearnings-assert: ${m.filename}#${m.id}: ${m.from} -> ${m.to}${m.reason ? ` (${m.reason})` : ""}`);
    }
  }
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/learnings-assert-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
