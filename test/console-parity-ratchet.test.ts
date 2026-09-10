import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMANDS } from "../src/run-task.js";
import { declaredConsoleRoutes, type DeclaredRoute } from "./helpers/declared-routes.js";

// W1-T2926 — 48 of 65 COMMANDS verbs were CLI-only and nothing measured the gap (audit
// recon-2026-09-05 §6, move 5). This suite falsifies scripts/console-parity-ratchet.mjs: every
// verb must map to a console route or carry a stated cli-only reason (an unmapped verb fails
// regardless of the baseline), and the recorded cli-only SET in
// scripts/console-parity-baseline.json may only shrink (a verb added to CLI_ONLY without also
// being added to the baseline fails too).
//
// `scripts/**` sits outside tsconfig's `include`, so this reaches the script through a runtime
// import — the convention test/the-contract-covers-its-own-console.test.ts documents.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "console-parity-ratchet.mjs")).href)) as {
  BASELINE_PATH: string;
  ROUTE_MATCH: Record<string, string>;
  CLI_ONLY: Record<string, string>;
  routeKeys: (routes: readonly { method: string; path: string }[]) => Set<string>;
  classifyVerbs: (
    verbNames: readonly string[],
    declaredRoutes: readonly { method: string; path: string }[],
    routeMatch?: Record<string, string>,
    cliOnly?: Record<string, string>,
  ) => { mapped: string[]; cliOnlyVerbs: string[]; unmapped: string[] };
  ratchetVerdict: (cliOnlyVerbs: readonly string[], baselineVerbs: readonly string[]) => { ok: boolean; added: string[]; removed: string[] };
  formatReport: (o: {
    verbNames: string[];
    mapped: string[];
    cliOnlyVerbs: string[];
    unmapped: string[];
    verdict: { ok: boolean; added: string[]; removed: string[] };
    baselinePath: string;
  }) => string;
};

const route = (method: string, path: string): DeclaredRoute => ({ method, path, where: "fixture" });

test("W1-T2926: a verb with neither a route nor a cli-only reason is UNMAPPED and fails", () => {
  const { unmapped, cliOnlyVerbs, mapped } = mod.classifyVerbs(
    ["status", "mystery-verb"],
    [route("GET", "/v1/status")],
    { status: "GET /v1/status" },
    { status: "already mapped, listed here only to prove cliOnly is consulted second" },
  );
  assert.deepEqual(mapped, ["status"]);
  assert.deepEqual(cliOnlyVerbs, [], "status is ROUTE-mapped, so it never falls through to cliOnly");
  assert.deepEqual(unmapped, ["mystery-verb"], "no route, no CLI_ONLY entry — unmapped");

  const verdict = mod.ratchetVerdict(cliOnlyVerbs, []);
  const overallOk = unmapped.length === 0 && verdict.ok;
  assert.equal(overallOk, false, "an unmapped verb fails independent of the baseline");
  const report = mod.formatReport({ verbNames: ["status", "mystery-verb"], mapped, cliOnlyVerbs, unmapped, verdict, baselinePath: mod.BASELINE_PATH });
  assert.match(report, /UNMAPPED/);
  assert.match(report, /mystery-verb/);
});

test("W1-T2926: a fully mapped fixture registry accepts with an unchanged baseline", () => {
  const verbNames = ["status", "deploy", "sync"];
  const routes = [route("GET", "/v1/status")];
  const routeMatch = { status: "GET /v1/status" };
  const cliOnly = { deploy: "operator-shell-only: fixture reason", sync: "operator-shell-only: fixture reason" };
  const { mapped, cliOnlyVerbs, unmapped } = mod.classifyVerbs(verbNames, routes, routeMatch, cliOnly);
  assert.deepEqual(mapped, ["status"]);
  assert.deepEqual(cliOnlyVerbs, ["deploy", "sync"]);
  assert.deepEqual(unmapped, []);

  const baselineVerbs = ["deploy", "sync"];
  const verdict = mod.ratchetVerdict(cliOnlyVerbs, baselineVerbs);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.added, []);
  assert.deepEqual(verdict.removed, [], "the baseline is UNCHANGED — nothing shrank, nothing grew");

  const overallOk = unmapped.length === 0 && verdict.ok;
  assert.equal(overallOk, true);
  const report = mod.formatReport({ verbNames, mapped, cliOnlyVerbs, unmapped, verdict, baselinePath: mod.BASELINE_PATH });
  assert.match(report, /OK — unchanged\./);
  assert.doesNotMatch(report, /UNMAPPED/);
  assert.doesNotMatch(report, /ADDED/);
});

test("W1-T2926: the ratchet — a verb added to CLI_ONLY without recording it in the baseline fails", () => {
  const cliOnlyVerbs = ["deploy", "sync"];
  const rose = mod.ratchetVerdict(cliOnlyVerbs, ["deploy"]);
  assert.equal(rose.ok, false, "sync was added to the cli-only set but never recorded");
  assert.deepEqual(rose.added, ["sync"]);
  const report = mod.formatReport({
    verbNames: cliOnlyVerbs,
    mapped: [],
    cliOnlyVerbs,
    unmapped: [],
    verdict: rose,
    baselinePath: mod.BASELINE_PATH,
  });
  assert.match(report, /ADDED to the cli-only set without recording it/);
  assert.match(report, /sync/);
  assert.match(report, new RegExp(mod.BASELINE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("W1-T2926: the ratchet — a verb that gained a route (shrank out of cli-only) is reported but PASSES", () => {
  const fell = mod.ratchetVerdict(["deploy"], ["deploy", "sync"]);
  assert.equal(fell.ok, true, "a shrink never fails the gate");
  assert.deepEqual(fell.removed, ["sync"]);
  const report = mod.formatReport({ verbNames: ["deploy"], mapped: ["sync"], cliOnlyVerbs: ["deploy"], unmapped: [], verdict: fell, baselinePath: mod.BASELINE_PATH });
  assert.match(report, /FELL/);
  assert.match(report, /sync/);
});

// @source-text-subject — this test's SUBJECT genuinely IS the real COMMANDS registry and the
// real declared console routes, the same corpus `npm run console-parity` reads in CI. Without a
// check against the LIVE data, ROUTE_MATCH/CLI_ONLY could drift from either registry (a renamed
// verb, a route moved, a new verb added with no table entry) and nothing here would catch it —
// only the fixture tests above, which by design cannot see the real corpus. Asserting on
// behaviour instead is not available: the property under test IS "the live registries agree
// with the ratchet's own tables," which has no synthetic stand-in.
test("W1-T2926: the real COMMANDS registry and the real declared routes are fully classified — no verb is unmapped", () => {
  const verbNames = COMMANDS.map((c) => c.name);
  assert.ok(verbNames.length > 0, "the real registry must not read as empty");
  const declaredRoutes = declaredConsoleRoutes();
  assert.ok(declaredRoutes.length > 0, "the real route derivation must not read as empty");

  const { mapped, cliOnlyVerbs, unmapped } = mod.classifyVerbs(verbNames, declaredRoutes);
  assert.deepEqual(unmapped, [], `every real COMMANDS verb needs a route or a CLI_ONLY reason — unmapped: ${unmapped.join(", ")}`);

  // Every ROUTE_MATCH entry must name a route that REALLY exists today — a stale entry would
  // silently fall its verb through to "unmapped" instead of the route it claims, masking a
  // route rename as this suite's own false green.
  const have = mod.routeKeys(declaredRoutes);
  for (const [verb, key] of Object.entries(mod.ROUTE_MATCH)) {
    assert.ok(have.has(key), `ROUTE_MATCH["${verb}"] names "${key}", which declaredConsoleRoutes() no longer has`);
  }

  const baselineDoc = JSON.parse(readFileSync(join(ROOT, mod.BASELINE_PATH), "utf8")) as { uncoveredVerbs: string[] };
  const verdict = mod.ratchetVerdict(cliOnlyVerbs, baselineDoc.uncoveredVerbs);
  assert.deepEqual(verdict.added, [], `cli-only verb(s) not recorded in ${mod.BASELINE_PATH}: ${verdict.added.join(", ")}`);
});

test("W1-T2926: the baseline's recorded set matches CLI_ONLY's own key set", () => {
  // THE WIRE. A baseline that drifts from CLI_ONLY (a key present in one but not the other)
  // makes the ratchet meaningless in whichever direction it drifted.
  const baselineDoc = JSON.parse(readFileSync(join(ROOT, mod.BASELINE_PATH), "utf8")) as { uncoveredVerbs: string[]; _comment: string };
  assert.deepEqual([...baselineDoc.uncoveredVerbs].sort(), Object.keys(mod.CLI_ONLY).sort());
  assert.match(baselineDoc._comment, /may only shrink|may SHRINK/i);
});
