/**
 * `note` must be classified before its COMMANDS entry lands. `classifyVerbs` iterates the verb
 * names it is GIVEN, so a ROUTE_MATCH row for a verb that does not exist yet is never consulted —
 * which is what lets this instrument-only prerequisite land first and keeps the product PR
 * (W1-T3351) out of Standing rule 25 entanglement.
 *
 * The sibling preregistrations (test/ledger-compact-is-preregistered-as-cli-only.test.ts,
 * test/audit-is-preregistered-as-cli-only.test.ts) both preregister into CLI_ONLY, which is
 * ratcheted against scripts/console-parity-baseline.json. This one preregisters into ROUTE_MATCH,
 * which is NOT ratcheted — `note` writes the same store through the same `appendOperatorNote` as
 * `POST /v1/operator-notes/add`, so it is genuine parity rather than a carve-out, and the baseline
 * is deliberately left untouched. The last assertion below is what holds that distinction.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { declaredConsoleRoutes } from "./helpers/declared-routes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "console-parity-ratchet.mjs")).href)) as {
  BASELINE_PATH: string;
  ROUTE_MATCH: Record<string, string>;
  CLI_ONLY: Record<string, string>;
  classifyVerbs: (
    verbs: readonly string[],
    routes: readonly { method: string; path: string }[],
    routeMatch?: Record<string, string>,
    cliOnly?: Record<string, string>,
  ) => { mapped: string[]; cliOnlyVerbs: string[]; unmapped: string[] };
  ratchetVerdict: (
    cliOnlyVerbs: readonly string[],
    baselineVerbs: readonly string[],
  ) => { ok: boolean; added: string[]; removed: string[] };
};

const NOTE_ROUTE = "POST /v1/operator-notes/add";

test("note is pre-registered as console-routed without requiring its product command", () => {
  const routes = declaredConsoleRoutes();

  // Both halves of `mapped` asserted separately: a ROUTE_MATCH row alone is NOT enough — the route
  // it names must also be one the console really declares, or the verb falls through to unmapped.
  assert.equal(mod.ROUTE_MATCH.note, NOTE_ROUTE);
  assert.ok(
    routes.some((r) => `${r.method} ${r.path}` === NOTE_ROUTE),
    `${NOTE_ROUTE} must be a declared console route for the mapping to resolve`,
  );

  const classification = mod.classifyVerbs(["note"], routes, mod.ROUTE_MATCH, mod.CLI_ONLY);
  assert.deepEqual(classification.mapped, ["note"]);
  assert.deepEqual(classification.unmapped, [], "the future command already resolves to a real route");
  assert.deepEqual(classification.cliOnlyVerbs, [], "parity, so it must not fall back to a cli-only reason");
});

test("the classification discriminates on the mapping rather than always reporting mapped", () => {
  const routes = declaredConsoleRoutes();

  // Negative control. Without the ROUTE_MATCH row this suite exists to pin, the very same verb over
  // the very same routes is UNMAPPED — which `console-parity` fails on. This is what makes the
  // assertion above load-bearing instead of vacuous.
  const withoutRow = mod.classifyVerbs(["note"], routes, {}, mod.CLI_ONLY);
  assert.deepEqual(withoutRow.unmapped, ["note"]);
  assert.deepEqual(withoutRow.mapped, []);

  // And a row pointing at a route the console does not declare is equally unmapped, so the row's
  // VALUE is checked against reality rather than merely being present.
  const wrongRoute = mod.classifyVerbs(["note"], routes, { note: "POST /v1/no-such-route" }, mod.CLI_ONLY);
  assert.deepEqual(wrongRoute.unmapped, ["note"]);
});

test("preregistering a routed verb leaves the cli-only ratchet untouched", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, mod.BASELINE_PATH), "utf8")) as {
    uncoveredVerbs: string[];
  };

  assert.equal(
    Object.prototype.hasOwnProperty.call(mod.CLI_ONLY, "note"),
    false,
    "note is console-routed, so it must not also carry a cli-only reason",
  );
  assert.equal(baseline.uncoveredVerbs.includes("note"), false, "a routed verb is never in the cli-only baseline");

  // The ratchet only ever judges the cli-only key set, so this preregistration cannot move it.
  const verdict = mod.ratchetVerdict(
    mod.classifyVerbs(["note"], declaredConsoleRoutes(), mod.ROUTE_MATCH, mod.CLI_ONLY).cliOnlyVerbs,
    baseline.uncoveredVerbs,
  );
  assert.deepEqual(verdict.added, []);
});
