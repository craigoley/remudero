// @census-reads: .github/workflows/ test/rules/every-workflow-job-runs-on-a-pinned-runner-image.test.ts — every workflow file and itself.
/**
 * W1-T13353 — EVERY WORKFLOW JOB RUNS ON A PINNED RUNNER IMAGE, NEVER A MOVING `-latest` LABEL.
 *
 * 2026-11-17: GitHub moved `ubuntu-latest` from ubuntu-24.04 to ubuntu-26.04 between two main pushes with no diff in
 * this repository. The new image ships bwrap, the proof sandbox started running in CI, and main went red on
 * test/proof-spawner-env-isolation.test.ts until #19011. A pinned label turns the next image move into a reviewed PR.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";

const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

/** Every `runs-on:` value in a workflow file, with its line number. */
function runsOnLabels(text: string): Array<{ line: number; label: string }> {
  return text.split("\n").flatMap((raw, i) => {
    const m = /^\s*runs-on:\s*(.+?)\s*$/.exec(raw);
    return m ? [{ line: i + 1, label: m[1]!.replace(/^["']|["']$/g, "") }] : [];
  });
}

test("W1-T13353 criterion 1: no workflow job runs on a -latest runner label", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 20, `positive control: the workflow directory was read (${files.length} files)`);
  const labels = files.flatMap((f) => runsOnLabels(readFileSync(join(WORKFLOWS, f), "utf8")).map((l) => ({ file: f, ...l })));
  assert.ok(labels.length >= 50, `positive control: runs-on lines were found (${labels.length})`);
  const moving = labels.filter((l) => /-latest\b/.test(l.label)).map((l) => `${l.file}:${l.line} ${l.label}`);
  assert.deepEqual(moving, [], "pin each job to a versioned image such as ubuntu-26.04");
});

test("W1-T13353 criterion 2: the census reads quoted and unquoted labels and flags a -latest one", () => {
  const sample = ["jobs:", "  a:", "    runs-on: ubuntu-latest", "  b:", '    runs-on: "ubuntu-26.04"', "  c:", "    runs-on: 'macos-latest'"].join("\n");
  const labels = runsOnLabels(sample);
  assert.deepEqual(labels, [{ line: 3, label: "ubuntu-latest" }, { line: 5, label: "ubuntu-26.04" }, { line: 7, label: "macos-latest" }]);
  assert.deepEqual(labels.filter((l) => /-latest\b/.test(l.label)).map((l) => l.line), [3, 7]);
});
