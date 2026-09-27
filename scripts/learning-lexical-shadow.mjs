#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { loadPlan } from "../src/lib/plan.js";
import {
  assessLexicalShadowLabels, evaluateLexicalShadow, loadLearningsCorpus,
} from "../src/lib/learnings.js";

const { values } = parseArgs({ options: {
  repo: { type: "string" }, limit: { type: "string" }, labels: { type: "string" }, help: { type: "boolean" },
}, strict: true });
if (values.help) {
  process.stdout.write("node --import tsx scripts/learning-lexical-shadow.mjs [--repo <path>] [--limit <n>] [--labels <json>]\n");
  process.exit(0);
}
const repo = resolve(values.repo ?? process.cwd());
const limit = values.limit === undefined ? 50 : Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
const source = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
};
const plan = loadPlan(join(repo, "plan", "tasks.yaml"));
const entries = loadLearningsCorpus(join(repo, "learnings"));
const report = evaluateLexicalShadow(plan.tasks, entries, source, { sampleLimit: limit });
const review = values.labels === undefined ? "unavailable-no-reviewed-labels"
  : assessLexicalShadowLabels(report, JSON.parse(readFileSync(resolve(values.labels), "utf8")));
process.stdout.write(`${JSON.stringify({ report, review }, null, 2)}\n`);
