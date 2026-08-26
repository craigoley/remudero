import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import of the .mjs is a TS7016 —
// the SAME runtime-import idiom test/acceptance-author-gate.test.ts already documents for this
// very script. A dynamic specifier is not statically resolved, so this loads the REAL module with
// no shadow copy to drift from it.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "acceptance-author-gate.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  declaredPlanTaskIds: (root?: string) => Set<string> | undefined;
  planTrailerResolver: (root?: string) => ((taskId: string) => boolean) | undefined;
  evaluateGate: (input: { body: string; authorLogin?: string; trailerResolves?: (taskId: string) => boolean }) => {
    ok: boolean;
    defect?: string;
    message: string;
  };
};
const { declaredPlanTaskIds, evaluateGate, planTrailerResolver } = mod;

// ── W1-T2297's WIRING HALF: THE GATE SUPPLIES THE RESOLVER ──────────────────────────────────
//
// #2934 shipped the PREDICATE half — `acceptanceAuthorTimeCheck` (src/lib/review.ts) takes an
// optional `trailerResolves` and stops exempting a body whose `Remudero-Task:` trailer names an
// id the plan does not declare. Nothing passed it, so the predicate was correct and UNREACHED:
// `evaluateGate` called the old one-argument shape. This suite pins the caller.
//
// THE FAIL-OPEN PROPERTY IS THE LOAD-BEARING ONE AND IS ASSERTED BOTH WAYS. A gate that cannot
// read the plan must not start refusing bodies it used to accept, so `declaredPlanTaskIds`
// returns `undefined` — never an empty Set — on any read failure, and `evaluateGate` with no
// resolver must be byte-for-byte the pre-wiring verdict. An empty Set would resolve NOTHING and
// silently invert the gate; that is the specific accident these tests exist to prevent.
//
// Fixtures live under `mkdtemp`; nothing here writes the tracked tree.

/** A plan tree declaring exactly `ids`, split across tasks.yaml and one shard. */
function planWith(ids: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-gate-plan-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shardHalf = ids.slice(Math.ceil(ids.length / 2));
  const yamlHalf = ids.slice(0, Math.ceil(ids.length / 2));
  const body = (list: string[]) => list.flatMap((id) => [`- id: ${id}`, '  title: "fixture"', "  repo: remudero", "  type: implement"]).join("\n") + "\n";
  writeFileSync(join(root, "plan", "tasks.yaml"), body(yamlHalf), "utf8");
  writeFileSync(join(root, "plan", "tasks.d", "fixture.yaml"), body(shardHalf), "utf8");
  return root;
}

const TRAILER_ONLY = "some prose with no acceptance header at all\n\nRemudero-Task: W9-GATE-A\n";

test("declaredPlanTaskIds reads BOTH tasks.yaml and the shards", () => {
  const ids = declaredPlanTaskIds(planWith(["W9-GATE-A", "W9-GATE-B", "W9-GATE-C"]));
  assert.ok(ids, "a readable plan must yield a set, never undefined");
  assert.deepEqual([...ids!].sort(), ["W9-GATE-A", "W9-GATE-B", "W9-GATE-C"]);
});

test("declaredPlanTaskIds FAILS OPEN to undefined on an unreadable plan — never an empty set", () => {
  const missing = declaredPlanTaskIds(join(tmpdir(), "rmd-gate-nonexistent-xyzzy"));
  assert.equal(missing, undefined, "undefined means 'could not read'; an empty Set would resolve nothing and invert the gate");
  // THE DISCRIMINATOR: the same call against a readable plan does yield a set, so the undefined
  // above is the read failing and not the function always answering undefined.
  assert.ok(declaredPlanTaskIds(planWith(["W9-GATE-A"])), "the falsifier: a readable plan yields a set");
});

test("declaredPlanTaskIds treats a plan that declares NOTHING as unreadable", () => {
  const empty = mkdtempSync(join(tmpdir(), "rmd-gate-empty-"));
  mkdirSync(join(empty, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(empty, "plan", "tasks.yaml"), "# no task records at all\n", "utf8");
  assert.equal(declaredPlanTaskIds(empty), undefined, "zero declared ids resolves nothing, which is the same hazard as an unreadable file");
});

test("planTrailerResolver answers from the plan, and is undefined when the plan cannot be read", () => {
  const resolver = planTrailerResolver(planWith(["W9-GATE-A"]));
  assert.ok(resolver);
  assert.equal(resolver!("W9-GATE-A"), true);
  assert.equal(resolver!("W9-GATE-NOPE"), false);
  assert.equal(planTrailerResolver(join(tmpdir(), "rmd-gate-nonexistent-xyzzy")), undefined);
});

test("THE WIRING: a trailer the plan does NOT declare no longer exempts a body with no judgeable block", () => {
  const verdict = evaluateGate({ body: TRAILER_ONLY, trailerResolves: planTrailerResolver(planWith(["W9-SOMETHING-ELSE"])) });
  assert.equal(verdict.ok, false, "an unresolvable trailer must not buy an exemption once the caller can check");
  assert.equal(verdict.defect, "no-header", "and the refusal names the body's real defect, not a second spelling of it");
});

test("a trailer the plan DOES declare still exempts — the gate did not become stricter about resolving trailers", () => {
  const verdict = evaluateGate({ body: TRAILER_ONLY, trailerResolves: planTrailerResolver(planWith(["W9-GATE-A"])) });
  assert.equal(verdict.ok, true, "a resolving trailer is exactly as exempt as it was before this wiring");
});

test("FAIL-OPEN, END TO END: an unreadable plan accepts the body the readable plan refuses", () => {
  const unreadable = planTrailerResolver(join(tmpdir(), "rmd-gate-nonexistent-xyzzy"));
  assert.equal(unreadable, undefined, "sanity: the plan really is unreadable in this arm");
  const failOpen = evaluateGate({ body: TRAILER_ONLY, trailerResolves: unreadable });
  assert.equal(failOpen.ok, true, "a gate that cannot read the plan must not start refusing bodies it used to accept");
  // BOTH WAYS: the identical body, with a plan that CAN be read and does not declare the id, is
  // refused — so the acceptance above is the fail-open path and not an inert fixture.
  const refused = evaluateGate({ body: TRAILER_ONLY, trailerResolves: planTrailerResolver(planWith(["W9-SOMETHING-ELSE"])) });
  assert.equal(refused.ok, false);
});

test("omitting trailerResolves entirely is byte-for-byte the pre-wiring verdict", () => {
  const omitted = evaluateGate({ body: TRAILER_ONLY });
  const undefinedResolver = evaluateGate({ body: TRAILER_ONLY, trailerResolves: undefined });
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted, undefinedResolver, "an explicit undefined and an omission must be the same call");
});

test("the bot exemption still short-circuits BEFORE any plan read — an exempt author never depends on a readable plan", () => {
  const verdict = evaluateGate({ body: "", authorLogin: "dependabot[bot]", trailerResolves: planTrailerResolver(planWith(["W9-SOMETHING-ELSE"])) });
  assert.equal(verdict.ok, true);
  assert.match(verdict.message, /exempt/);
});

test("a body with a healthy Acceptance block passes regardless of what the trailer resolves to", () => {
  const healthy = "## Acceptance\n\n- the claim | unit test: test/foo.test.ts\n\nRemudero-Task: W9-GATE-NOPE\n";
  const verdict = evaluateGate({ body: healthy, trailerResolves: planTrailerResolver(planWith(["W9-SOMETHING-ELSE"])) });
  assert.equal(verdict.ok, true, "the rule refuses only when the trailer does NOT resolve AND the block is defective");
});
