// @source-text-subject: the workflow trigger and edited-event job routing are this suite's subject.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");

type Workflow = { jobs?: Record<string, { if?: string }> };

function workflow(path: string): Workflow {
  return parseYaml(readFileSync(join(ROOT, ".github/workflows", path), "utf8")) as Workflow;
}

test("W1-T3332: a body repair is a subscribed pull_request edited event", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const trigger = ci.slice(ci.indexOf("on:\n"), ci.indexOf("\npermissions:"));

  assert.match(trigger, /pull_request:\s*\n\s*types:\s*\n(?:\s*-\s*\w+\s*\n){4}/);
  assert.match(trigger, /-\s*edited\s*\n/);
});

test("W1-T3332: edited re-evaluates body gates without starting ci.yml jobs", () => {
  const ciJobs = workflow("ci.yml").jobs ?? {};
  const bodyGateJobs = workflow("acceptance-author-gate.yml").jobs ?? {};
  const aggregateJobs = workflow("ci-gate.yml").jobs ?? {};

  assert.ok(Object.keys(bodyGateJobs).length > 0, "the body gate must remain present");
  assert.ok(Object.keys(aggregateJobs).length > 0, "the aggregate gate must remain present");
  const editedGuard = new RegExp(
    [
      String.raw`github\.event\.action\s*!=\s*['"]edited['"]`,
      String.raw`always\(\).*github\.event\.action\s*!=\s*['"]edited['"]`,
      String.raw`github\.event\.action\s*!=\s*['"]edited['"].*always\(\)`,
    ].join("|"),
  );
  for (const [jobId, job] of Object.entries(ciJobs)) {
    assert.match(String(job.if ?? ""), editedGuard, `ci.yml job '${jobId}' must not run for a body-only edited event`);
  }

  const acceptance = readFileSync(join(ROOT, ".github/workflows/acceptance-author-gate.yml"), "utf8");
  const aggregate = readFileSync(join(ROOT, ".github/workflows/ci-gate.yml"), "utf8");
  assert.match(acceptance, /types:\s*\[opened, synchronize, reopened, edited\]/);
  assert.match(aggregate, /types:\s*\[opened, synchronize, reopened, edited\]/);
});

test("W1-T3332: the edited routing stays pinned and the expensive matrix cannot drift back in", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = workflow("ci.yml").jobs ?? {};

  assert.deepEqual(Object.keys(jobs).length, 25, "the census must inspect every ci.yml job");
  assert.match(String(jobs.ci?.if), /github\.event\.action\s*!=\s*['"]edited['"]/);
  assert.match(String(jobs["coverage-ratchet"]?.if), /github\.event\.action\s*!=\s*['"]edited['"]/);
  assert.doesNotMatch(ci, /if:\s*github\.event_name\s*==\s*['"]pull_request['"]\s*(?:#|$)/);
});
