import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// W1-T3174 — THE CONTRACT COVERS A FRACTION OF THE CONSOLE IT SERVES.
//
// `scripts/no-hand-rolled-fetch-check.mjs` is a required gate that walks `apps` and `packages` and
// refuses any direct `fetch(`. That rule is correct (MASTER-PLAN §7A) and stays — which is exactly
// why the contract is the critical path for the console rebuild: `apps/dashboard` CANNOT call a
// route the generated client does not expose, by CI rather than by convention.
//
// MEASURED 2026-09-09: first-party clients call 39 distinct `/v1/` routes; the spec declares 13.
//
// THIS SHARD DOES NOT DOCUMENT ROUTES, per its design (i) — per-screen, never all-27-up-front. The
// deliverable is the ratchet that makes the gap legible and stops it growing.
//
// `scripts/**` sits outside tsconfig's `include`, so this reaches the script through a runtime
// import — the convention test/clock-sweep.test.ts documents.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "contract-coverage-ratchet.mjs")).href)) as {
  CLIENT_SOURCES: readonly string[];
  BASELINE_PATH: string;
  routesCalled: (sources: readonly string[], read: (s: string) => string[]) => string[];
  routesDeclared: (spec: string) => string[];
  normalisePath: (p: string) => string;
  uncovered: (called: string[], declared: string[]) => string[];
  classify: (count: number, baseline: number) => { ok: boolean; direction: string };
  formatReport: (o: { called: string[]; declared: string[]; missing: string[]; baseline: number }) => string;
};

/** A fake tree: one "file" of source per entry. */
const tree = (byPath: Record<string, string[]>) => (p: string) => byPath[p] ?? [];

test("W1-T3174: the census enumerates what clients call, what the spec declares, and reports the uncovered set", () => {
  const called = mod.routesCalled(["a", "b"], tree({
    a: ['fetch("/v1/status")', 'fetch("/v1/inbox")'],
    b: ['await client.get("/v1/status");', 'fetch(`/v1/tasks/${id}`)'],
  }));
  assert.deepEqual(called, ["/v1/inbox", "/v1/status", "/v1/tasks/:p"], "distinct, sorted, params normalised");

  const declared = mod.routesDeclared("paths:\n  /v1/status:\n    get: {}\n  /v1/tasks/{id}:\n    get: {}\n");
  assert.deepEqual(declared, ["/v1/status", "/v1/tasks/:p"]);

  // NORMALISATION IS LOAD-BEARING. Without it the census compares `/v1/tasks/{id}` against
  // `/v1/tasks/W1-T1` and reports a covered route as uncovered forever — a ratchet that can never
  // fall is one nobody can act on.
  assert.equal(mod.normalisePath("/v1/tasks/{id}"), mod.normalisePath("/v1/tasks/W1-T1"));

  assert.deepEqual(mod.uncovered(called, declared), ["/v1/inbox"], "only the genuinely undeclared route");
});

test("W1-T3174: the uncovered count is a ratchet — it may FALL and never RISE", () => {
  assert.equal(mod.classify(28, 28).ok, true, "holding at the ceiling passes");
  assert.equal(mod.classify(27, 28).direction, "fell", "an improvement is named so it can be locked in");
  assert.equal(mod.classify(29, 28).ok, false, "a rise is refused");

  const rose = mod.formatReport({ called: ["/v1/a"], declared: [], missing: ["/v1/a"], baseline: 0 });
  assert.match(rose, /ROSE/);
  assert.match(rose, /raise\s+the ceiling/s, "and the refusal says what a deliberate bump looks like");
  assert.match(rose, /UNDECLARED:/, "naming the routes, because a bare count is not actionable");
});

// @source-text-subject — this test's SUBJECT genuinely IS a source file's text, in the sense
// W1-T2905's census carves out. The tool under test is a source-text census: `routesCalled` finds
// `fetch("/v1/…")` literals by scanning code. The read below is not a prose assertion standing in
// for behaviour — it is a POSITIVE CONTROL ON THE REAL CORPUS, feeding the live client's actual
// bytes through the extractor so that an extractor which stops matching fails HERE instead of
// reporting an empty uncovered set as a clean sheet. Asserting on behaviour instead is not
// available: the behaviour IS reading source text, and a synthetic fixture cannot catch the
// regression this control exists for.
test("W1-T3174: the census reads the STRING console too, not only where the fetch gate looks", () => {
  // COUNTING ONLY `apps/` REPORTS A CLEAN SHEET while 28 routes are in daily use: the live
  // console's client is src/lib/console-shell-client.ts, which is not under apps/ and is the
  // largest consumer in the tree.
  assert.ok(
    mod.CLIENT_SOURCES.includes("src/lib/console-shell-client.ts"),
    "the string console must be in the census population",
  );
  assert.ok(mod.CLIENT_SOURCES.some((s) => s.startsWith("apps/")), "and so must the new stack");

  // A POSITIVE CONTROL ON THE REAL CORPUS: that file really does call routes, so a census that
  // stops matching fails HERE rather than reporting an empty uncovered set as success.
  const live = readFileSync(join(ROOT, "src", "lib", "console-shell-client.ts"), "utf8");
  const inLive = mod.routesCalled(["x"], tree({ x: [live] }));
  assert.ok(inLive.length > 20, `the live client must still show its routes — measured ${inLive.length}`);

  const spec = mod.routesDeclared(readFileSync(join(ROOT, "openapi", "daemon.yaml"), "utf8"));
  assert.ok(spec.length > 0, "and the spec extraction must still see its paths");
});

test("W1-T3174: the census DISCRIMINATES — an undeclared caller is reported, a declared one is not", () => {
  // The falsifier that separates a working census from one that reports everything, or nothing.
  const spec = "paths:\n  /v1/status:\n    get: {}\n";
  const declaredOnly = mod.uncovered(mod.routesCalled(["c"], tree({ c: ['fetch("/v1/status")'] })), mod.routesDeclared(spec));
  assert.deepEqual(declaredOnly, [], "a client calling only a declared route is clean");

  const undeclared = mod.uncovered(mod.routesCalled(["c"], tree({ c: ['fetch("/v1/not-in-spec")'] })), mod.routesDeclared(spec));
  assert.deepEqual(undeclared, ["/v1/not-in-spec"], "and one calling an undeclared route is reported");
});

test("W1-T3174: the recorded ceiling matches what the tree actually measures", () => {
  // THE WIRE. A baseline that drifts from the corpus makes the ratchet meaningless in whichever
  // direction it drifted — too high forgives a real rise, too low reddens every PR.
  const baseline = JSON.parse(readFileSync(join(ROOT, mod.BASELINE_PATH), "utf8")) as {
    uncoveredCeiling: number;
    _comment: string;
  };
  assert.equal(typeof baseline.uncoveredCeiling, "number");
  assert.match(baseline._comment, /may FALL and must NEVER RISE/, "the never-raise rule lives with the number");
  assert.ok(baseline.uncoveredCeiling > 0, "recorded honestly rather than aspirationally — the gap is real today");
});
