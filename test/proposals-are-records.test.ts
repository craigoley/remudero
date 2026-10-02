import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProposalRecords, ProposalRecordError } from "../src/lib/plan-proposals.js";
import { lintPlanCommand } from "../src/run-task.js";

function fixture(): { root: string; proposals: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-proposals-"));
  const proposals = join(root, "plan", "proposals.d");
  mkdirSync(proposals, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  return { root, proposals, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function record(id = "P1", status = "open", falsifier = "grep: test in test/proposals-are-records.test.ts"): string {
  return `id: ${id}\ntitle: Example proposal\nstatus: ${status}\nfalsifier: '${falsifier}'\nrank: 2\nsource: retro\n`;
}

async function lint(root: string): Promise<{ code: number; errors: string }> {
  const errors: string[] = [];
  const previous = { error: console.error, log: console.log };
  console.error = (message: string) => errors.push(message);
  console.log = () => {};
  try {
    return {
      code: await lintPlanCommand(["--plan", join(root, "plan", "tasks.yaml")], { repoRoot: root, offline: true }),
      errors: errors.join("\n"),
    };
  } finally {
    console.error = previous.error;
    console.log = previous.log;
  }
}

test("W1-T4047: a well-formed proposal record loads with its status and falsifier", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proposals, "P1.yaml"), record());
    assert.deepEqual(loadProposalRecords(f.proposals), [{
      id: "P1", title: "Example proposal", status: "open",
      falsifier: "grep: test in test/proposals-are-records.test.ts", rank: 2, source: "retro",
    }]);
  } finally {
    f.dispose();
  }
});

test("W1-T4047: a prose falsifier is refused", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proposals, "P1.yaml"), record("P1", "open", "the existing suite passes"));
    assert.throws(() => loadProposalRecords(f.proposals), ProposalRecordError);
  } finally {
    f.dispose();
  }
});

test("W1-T4047: a dialect label still needs a parseable executable proof", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proposals, "P1.yaml"), record("P1", "open", "grep: missing path"));
    assert.throws(() => loadProposalRecords(f.proposals), /falsifier/);
    writeFileSync(join(f.proposals, "P1.yaml"), record("P1", "open", "demonstration: inspect manually"));
    assert.throws(() => loadProposalRecords(f.proposals), /falsifier/);
  } finally {
    f.dispose();
  }
});

test("W1-T4047: an unknown status or a duplicate id is refused", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proposals, "P1.yaml"), record("P1", "unknown"));
    assert.throws(() => loadProposalRecords(f.proposals), /status/);
    writeFileSync(join(f.proposals, "P1.yaml"), record());
    writeFileSync(join(f.proposals, "copy.yaml"), record());
    assert.throws(() => loadProposalRecords(f.proposals), /duplicate proposal id/);
  } finally {
    f.dispose();
  }
});

test("W1-T4047: lint-plan reports a malformed proposal", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.proposals, "P1.yaml"), record("P1", "unknown"));
    const result = await lint(f.root);
    assert.equal(result.code, 1);
    assert.match(result.errors, /plan\/proposals\.d.*status/);
  } finally {
    f.dispose();
  }
});

test("W1-T4047: an absent proposals directory is not a violation", async () => {
  const f = fixture();
  try {
    rmSync(f.proposals, { recursive: true });
    assert.deepEqual(loadProposalRecords(f.proposals), []);
    const result = await lint(f.root);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.errors, /plan\/proposals\.d/);
  } finally {
    f.dispose();
  }
});
