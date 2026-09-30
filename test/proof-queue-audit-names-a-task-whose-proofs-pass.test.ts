import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { proofQueueAuditCommand } from "../src/run-task.js";

type Verdict = "pass" | "fail" | "unreadable";

function taskYaml(id: string, proofs: string[], status = "queued"): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  acceptance:",
    ...proofs.flatMap((proof) => ['    - claim: "the thing holds"', `      proof: "${proof}"`]),
    "",
  ].join("\n");
}

async function audit(
  tasks: string,
  executeProof: (parsed: unknown, proof: string) => Verdict,
): Promise<{ exitCode: number; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4937-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, tasks, "utf8");
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (m: string) => lines.push(m);
  console.error = (m: string) => lines.push(m);
  try {
    const exitCode = await proofQueueAuditCommand(["--plan", planPath], {
      readMergeEvidenceLog: () => ({ dump: "\x01", ref: "fixture-ref" }),
      executeProof,
    });
    return { exitCode, stdout: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

const TITLES = ["w1-t3558 bridge one", "w1-t3558 bridge two", "w1-t3558 bridge three"];
const titleProofs = TITLES.map((title) => `unit test: ${title}`);

test("W1-T4937: a queued task whose every discriminating proof passes is named", async () => {
  const { stdout } = await audit(taskYaml("W9-PASSES", titleProofs), () => "pass");
  assert.match(stdout, /passes-at-main\s+1 task\(s\): W9-PASSES\n/);
  for (const proof of titleProofs) assert.ok(stdout.includes(`    pass: ${proof}`), proof);
  assert.match(stdout, /a pass at main is where to LOOK, not a verdict that the task is done/);
});

test("W1-T4937: a task with one failing proof is not named", async () => {
  const { stdout } = await audit(
    taskYaml("W9-ONE-FAILS", titleProofs),
    (_parsed, proof) => (proof.endsWith("two") ? "fail" : "pass"),
  );
  assert.match(stdout, /passes-at-main\s+0 task\(s\): \(none\)\n/);
  assert.doesNotMatch(stdout, /passes-at-main[^\n]*W9-ONE-FAILS/);
});

test("W1-T4937: a whole-file or prose criterion keeps the task off the list", async () => {
  const { stdout } = await audit(
    taskYaml("W9-WHOLE-FILE", [...titleProofs, "unit test: test/satisfied-task-census.test.ts"]) +
      taskYaml("W9-PROSE", [...titleProofs, "the operator confirms it by hand"]),
    () => "pass",
  );
  assert.match(stdout, /passes-at-main\s+0 task\(s\): \(none\)\n/);
});

test("W1-T4937: the audit exits 0 while naming a passing task", async () => {
  const { exitCode, stdout } = await audit(taskYaml("W9-EXITS-ZERO", titleProofs), () => "pass");
  assert.equal(exitCode, 0);
  assert.match(stdout, /passes-at-main\s+1 task\(s\): W9-EXITS-ZERO\n/);
});

test("W1-T4937: proof rows print for the first ten tasks and the rest collapse to a count", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `W9-MANY-${String(i).padStart(2, "0")}`);
  const { stdout } = await audit(ids.map((id) => taskYaml(id, [`unit test: ${id} title`])).join(""), () => "pass");
  assert.match(stdout, /passes-at-main\s+12 task\(s\): W9-MANY-00, /);
  assert.ok(stdout.includes("pass: unit test: W9-MANY-09 title"));
  assert.ok(!stdout.includes("pass: unit test: W9-MANY-10 title"));
  assert.match(stdout, /\+2 more/);
});
