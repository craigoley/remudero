import assert from "node:assert/strict";

/** Fixture-owned successful setup, derived from the real workflow's context references. */
export function successfulReporterSetupFixture(env: Record<string, string | undefined>): string {
  const template = env.SETUP_OUTCOMES;
  assert.ok(typeof template === "string" && template.trim(), "the reporter's setup template must exist");
  const context = /\$\{\{\s*steps\.[\w-]+\.outcome\s*\}\}/g;
  assert.ok([...template.matchAll(context)].length > 0, "setup must reference real step outcomes");
  const outcomes = template.replace(context, "success");
  assert.ok(!outcomes.includes("${{"), "every setup context must be explicitly resolved by the fixture");
  return outcomes;
}
