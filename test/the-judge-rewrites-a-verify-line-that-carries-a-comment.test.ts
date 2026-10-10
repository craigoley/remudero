// 2026-10-10 18:08:49Z on the fleet host: the machine-filing judge ruled W1-T7736 `escalate` (deterministic backstop) and
// then refused its own landing with "plan/tasks.d/W1-T7736-….yaml has no verify: line". The shard has one:
// `verify: human  # writes a repository ruleset, …; the operator owns the queue decision`. That is valid YAML, the plan
// loads it as `human`, and lint passes it, but renderRuledShard matched the line with /^ {2}verify:\s*\S+\s*$/, which a
// trailing comment fails. So the ruling could never be written, and the judge re-asked about the record on every pass.
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderRuledShard } from "../src/lib/machine-filing-judge.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import type { FilingRiskRuling } from "../src/lib/risk-judge.js";
import { taskRulingPin } from "../src/lib/task-linter.js";

const REL = "plan/tasks.d/W1-T9890-a-commented-verify-line.yaml";
const WHY = "writes a repository ruleset, scratch branches and replay PRs on the live repo; the operator owns the queue decision";

/** W1-T7736's header as #10694 filed it, verify comment included. */
const SHARD = [
  "- id: W1-T9890",
  '  title: "a record whose verify line carries the reason it is parked"',
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  `  verify: human  # ${WHY}`,
  "  risk: high  # Rule 19: one concern",
  "  band_meaning: blast-radius",
  '  origin: "operator approval 2026-10-10"',
  "  files: [scripts/merge-queue-canary.mjs]",
  "  status: queued",
  "  priority: 2",
  "  attempts: 0",
  "  acceptance:",
  '    - claim: "the canary refuses a ruleset that names main"',
  '      proof: "unit test: the canary refuses a ruleset that names main"',
  "",
].join("\n");

const ruling = (action: "proceed" | "escalate"): FilingRiskRuling => ({
  verdict: action === "proceed" ? "low" : "high", action, confidence: 1,
  reasons: [action === "proceed" ? "a scoped harness" : "deterministic backstop: it declares scripts/merge-queue-canary.mjs"],
  judgedAt: "2026-10-10T18:08:13.509Z",
});

test("the judge writes its ruling onto a record whose verify: line carries a trailing comment, and keeps the comment", () => {
  const record = parseTasksFromYaml(SHARD, REL)[0]!;
  assert.equal(record.verify, "human", "control: the plan loads the commented line as human");
  const pin = taskRulingPin({ ...record, verify: "auto" });

  for (const action of ["escalate", "proceed"] as const) {
    const out = renderRuledShard(SHARD, REL, pin, ruling(action));
    assert.ok("contents" in out, `${action}: the ruling is written, not refused: ${"refused" in out ? out.refused : ""}`);
    const ruled = parseTasksFromYaml(out.contents, REL)[0]!;
    assert.equal(ruled.verify, action === "proceed" ? "auto" : "human");
    assert.equal(ruled.risk_ruling?.action, action);
    assert.equal(ruled.risk_ruling?.pin, taskRulingPin(ruled), `${action}: the pin covers the record as rewritten`);
    const lines = out.contents.split("\n");
    const at = lines.indexOf(`  verify: ${ruled.verify}`);
    assert.ok(at > 0, `${action}: the verify line is rewritten bare`);
    assert.equal(lines[at - 1], `  # ${WHY}`, `${action}: the filer's reason survives, on its own line above`);
  }
});

test("a shard with no verify: line at all is still refused by name", () => {
  const without = SHARD.replace(/^ {2}verify:.*\n/m, "");
  const out = renderRuledShard(without, REL, "unused", ruling("escalate"));
  assert.deepEqual(out, { refused: `${REL} has no verify: line` });
});
