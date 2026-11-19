/**
 * W1-T13610 — A PLAN SNAPSHOT CHECK PARSES AN UNCHANGED PLAN ONCE.
 *
 * composeSecondaryPlan checks both plans with isParsedPlanSnapshot, which serializes the tasks and parses that text
 * again with the canonical parser. The daemon composes the public plan with the ops catalog on every dispatch tick,
 * so the whole public plan was parsed again each tick. The parser's verdict is now kept per serialized content; the
 * structural checks still run on every call.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import { composeSecondaryPlan, snapshotParseCount } from "#src/lib/task-lookup.js";

function yaml(prefix: string, count: number, extra: (i: number) => string = () => ""): string {
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`- id: ${prefix}${i}\n  title: ${prefix} task ${i}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n${extra(i)}`);
  }
  return rows.join("");
}

const plan = (prefix: string, count: number, extra?: (i: number) => string): Plan => loadPlanFromYaml(yaml(prefix, count, extra), `${prefix} plan`);

/** The outcome code and how many canonical parses the call ran. Since W1-T13749 a bad edge holds its own tasks
 *  inside an ok composition: such a composition reads `held:<reason>`. */
function compose(primary: Plan, secondary: Plan): { outcome: string; parses: number } {
  const before = snapshotParseCount();
  const composition = composeSecondaryPlan(primary, secondary);
  const held = composition.outcome === "ok" ? [...composition.held.values()][0] : undefined;
  const outcome = held ? `held:${held.reason}` : composition.outcome;
  return { outcome, parses: snapshotParseCount() - before };
}

test("W1-T13610 criterion 1: three composes parse each unchanged plan once in all, and a changed plan alone again", () => {
  const primary = plan("W1-A", 2000);
  const secondary = plan("OPS-A", 20);
  assert.deepEqual(compose(primary, secondary), { outcome: "ok", parses: 2 }, "the first call parses each plan once");
  assert.deepEqual(compose(primary, secondary), { outcome: "ok", parses: 0 });
  assert.deepEqual(compose(primary, secondary), { outcome: "ok", parses: 0 }, "three calls, two parses in all");

  secondary.tasks[3]!.title = "OPS-A task 4, retitled in place";
  assert.deepEqual(compose(primary, secondary), { outcome: "ok", parses: 1 }, "only the changed secondary plan is parsed again");
});

test("W1-T13610 criterion 2: each outcome is the same on the first call, which parses, and on a repeat call, which keeps the verdict", () => {
  const cases: Array<{ name: string; make: () => [Plan, Plan]; outcome: string }> = [
    { name: "a parsed plan", make: () => [plan("W1-B", 30), plan("OPS-B", 5)], outcome: "ok" },
    {
      name: "an invalid not_before", outcome: "malformed",
      make: () => { const s = plan("OPS-C", 5); s.tasks[1]!.not_before = "not a date"; return [plan("W1-C", 30), s]; },
    },
    {
      name: "an invalid precondition", outcome: "malformed",
      make: () => { const s = plan("OPS-D", 5); (s.tasks[2] as { precondition?: unknown }).precondition = { read: ["rm", "-rf"], expect: "x" }; return [plan("W1-D", 30), s]; },
    },
    {
      name: "a byId map that does not match tasks", outcome: "malformed",
      make: () => { const p = plan("W1-E", 30); p.byId.set("W1-E7", { ...p.byId.get("W1-E7")! }); return [p, plan("OPS-E", 5)]; },
    },
    { name: "a duplicate id", outcome: "held:duplicate_task_id", make: () => [plan("W1-F", 30), plan("W1-F", 2)] },
    {
      name: "a getter that throws", outcome: "malformed",
      make: () => {
        const s = plan("OPS-G", 5);
        Object.defineProperty(s.tasks[0]!, "title", { enumerable: true, get: () => { throw new Error("hostile getter"); } });
        return [plan("W1-G", 30), s];
      },
    },
    {
      name: "a primary task that depends on a secondary one", outcome: "held:invalid_cross_catalog_dependency",
      make: () => { const p = plan("W1-H", 30); const s = plan("OPS-H", 5); p.tasks[0]!.depends_on = ["OPS-H1"]; return [p, s]; },
    },
  ];
  for (const c of cases) {
    const [primary, secondary] = c.make();
    const first = compose(primary, secondary);
    const repeat = compose(primary, secondary);
    assert.equal(first.outcome, c.outcome, `${c.name}: the first call`);
    assert.equal(repeat.outcome, c.outcome, `${c.name}: the repeat call`);
    assert.equal(repeat.parses, 0, `${c.name}: the repeat call runs no canonical parse`);
  }
});

test("W1-T13610 criterion 3: an in-place change to a refused value is malformed, structure is checked each call, and verdicts follow content", () => {
  const text = yaml("OPS-J", 8);
  const primary = plan("W1-J", 40);
  const secondary = loadPlanFromYaml(text, "OPS-J plan");
  assert.equal(compose(primary, secondary).outcome, "ok");

  // valid, then changed in place to fail the parser: a new content key, a new parse, malformed.
  secondary.tasks[5]!.not_before = "tomorrow-ish";
  assert.deepEqual(compose(primary, secondary), { outcome: "malformed", parses: 1 });
  delete secondary.tasks[5]!.not_before;
  assert.deepEqual(compose(primary, secondary), { outcome: "ok", parses: 0 }, "the original content's verdict is kept");

  // the kept verdict for the same content never skips the structural checks.
  const mismatched = loadPlanFromYaml(text, "OPS-J plan");
  mismatched.byId.set("OPS-J2", { ...mismatched.byId.get("OPS-J2")! });
  assert.deepEqual(compose(primary, mismatched), { outcome: "malformed", parses: 0 }, "byId identity is checked with a kept verdict");
  // a task whose serialization is the checked content but whose own type is not a task type.
  const badTask = loadPlanFromYaml(text, "OPS-J plan");
  const original = badTask.tasks[0]!;
  const forged = { ...original, type: "not-a-type" } as unknown as typeof original;
  Object.defineProperty(forged, "toJSON", { enumerable: false, value: () => ({ ...original }) });
  badTask.tasks[0] = forged;
  badTask.byId.set(forged.id, forged);
  assert.deepEqual(compose(primary, badTask), { outcome: "malformed", parses: 0 }, "isParsedPlanTask runs with a kept verdict");

  // a new object with content already checked reuses the verdict.
  assert.deepEqual(compose(plan("W1-J", 40), loadPlanFromYaml(text, "OPS-J plan")), { outcome: "ok", parses: 0 });
});
