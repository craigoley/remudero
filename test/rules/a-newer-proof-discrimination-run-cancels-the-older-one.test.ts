import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T15177: on 2026-11-27 a push and a PR-body edit started two proof-discrimination runs on one head; the newer hit
// the job's 10-minute bound and ci-gate, which keeps the latest-started run per check name, read the cancelled run.

const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "proof-discrimination-gate.yml");

type Workflow = {
  on?: { pull_request?: { types?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, { name?: string; "timeout-minutes"?: number }>;
};

async function load(): Promise<{ raw: string; doc: Workflow }> {
  const raw = await readFile(WORKFLOW, "utf8");
  return { raw, doc: parseYaml(raw) as Workflow };
}

test("W1-T15177 criterion 1: proof-discrimination cancels its own superseded run per pull request", async () => {
  const { raw, doc } = await load();
  assert.ok(doc.concurrency, "proof-discrimination-gate.yml must declare a top-level concurrency block");
  assert.equal(doc.concurrency.group, "proof-discrimination-${{ github.event.pull_request.number }}",
    "the group keys on the pull request number, so only one PR's own runs supersede each other");
  assert.equal(doc.concurrency["cancel-in-progress"], true, "a newer run cancels the older one");
  assert.ok(raw.includes("group: proof-discrimination-${{ github.event.pull_request.number }}"),
    "the literal group expression is in the file, not a parser-normalised equivalent");
});

test("W1-T15177 criterion 2: invariant:triggers-unchanged — the triggers and job name stay, and the bound is 20 minutes", async () => {
  const { doc } = await load();
  assert.deepEqual(doc.on?.pull_request?.types, ["opened", "synchronize", "reopened", "edited"],
    "edited stays: a body-only proof repair needs a fresh result");
  const job = doc.jobs?.["proof-discrimination"];
  assert.ok(job, "the proof-discrimination job is still declared");
  assert.equal(job.name, "proof-discrimination", "ci-gate reads the check by this name");
  // 2026-11-27: #20913's 17 whole-suite proofs, run one at a time, never finished inside 10 minutes on a runner.
  assert.equal(job["timeout-minutes"], 20);
});
