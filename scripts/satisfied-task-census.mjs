#!/usr/bin/env node
// W1-T3961 — report queued tasks whose executable, name-filtered acceptance proofs already
// pass on the current checkout. This is deliberately a census, not a gate: a hit is evidence for
// an Architect/operator ruling, never an automatic retirement or refusal.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { execWhitelistedProof, parseWhitelistedProof } from "../src/lib/review.ts";
import { isMainModule } from "./lib/argv.mjs";

const DIALECT_PREFIXES = ["unit test:", "grep:"];

/** A proof is evidence for this census only when it names a test/title or a grep, rather than
 * an entire test file. A whole-file proof passes at main by construction and would flag most of
 * the plan on the first run. */
export function parseDiscriminatingProof(proof) {
  const text = String(proof ?? "").trim();
  if (!DIALECT_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  const parsed = parseWhitelistedProof(text);
  if (!parsed || (parsed.kind === "test" && parsed.nameFiltered !== true)) return null;
  return parsed;
}

/** Read the monolith plus every task shard without inventing a second task schema. */
export function readTaskRecords({ cwd = process.cwd(), planPath, shardDir } = {}) {
  const root = resolve(cwd);
  const monolith = planPath ?? join(root, "plan", "tasks.yaml");
  const shards = shardDir ?? join(root, "plan", "tasks.d");
  const files = [monolith];
  for (const name of readdirSync(shards).filter((entry) => entry.endsWith(".yaml")).sort()) {
    files.push(join(shards, name));
  }
  const tasks = [];
  for (const file of files) {
    const parsed = parseYaml(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`task plan is not a YAML list: ${file}`);
    for (const task of parsed) tasks.push({ ...task, sourcePath: file });
  }
  return tasks;
}

/**
 * Run the census over task records. `executeProof` returns `pass`, `fail`, or `unreadable`; the
 * default executes the reviewer's own parser/executor in this checkout. Tests inject it so the
 * population and fail direction are exercised without a full suite or network.
 */
export function censusSatisfiedTasks(tasks, executeProof = defaultExecuteProof) {
  const findings = [];
  for (const task of tasks) {
    if (task?.status !== "queued" || task?.retirement) continue;
    const criteria = Array.isArray(task.acceptance) ? task.acceptance : [];
    if (criteria.length === 0) continue;
    const proofs = criteria.map((criterion) => {
      const proof = String(criterion?.proof ?? "").trim();
      return { proof, parsed: parseDiscriminatingProof(proof) };
    });
    // Every criterion must be executable and discriminating. One stale/opaque criterion means
    // the census cannot conclude that the task is already satisfied.
    if (proofs.some((entry) => entry.parsed === null)) continue;
    const verdicts = proofs.map(({ proof, parsed }) => ({ proof, verdict: executeProof(parsed, proof) }));
    if (!verdicts.every((entry) => entry.verdict === "pass")) continue;
    findings.push({
      taskId: String(task.id),
      status: String(task.status),
      priority: task.priority ?? null,
      proofs: verdicts,
      sourcePath: task.sourcePath,
    });
  }
  return { scanned: tasks.length, findings };
}

function defaultExecuteProof(parsed) {
  try {
    return execWhitelistedProof(parsed, process.cwd());
  } catch {
    return "unreadable";
  }
}

export function renderReport(result) {
  const lines = [`satisfied-task-census: ${result.findings.length} queued task(s) whose discriminating proofs pass at main`, `scanned: ${result.scanned}`];
  for (const finding of result.findings) {
    lines.push(`- ${finding.taskId} status=${finding.status} priority=${finding.priority ?? "absent"}`);
    for (const proof of finding.proofs) lines.push(`  ${proof.verdict}: ${proof.proof}`);
  }
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console;
  const { values } = parseArgs({ args: argv, options: { cwd: { type: "string" }, "plan-tasks": { type: "string" }, "shard-dir": { type: "string" } } });
  try {
    const tasks = readTaskRecords({ cwd: values.cwd, planPath: values["plan-tasks"], shardDir: values["shard-dir"] });
    const result = censusSatisfiedTasks(tasks);
    log.log(renderReport(result));
    return 0;
  } catch (error) {
    log.error(`satisfied-task-census: REFUSED — ${String(error?.message ?? error)}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main();
