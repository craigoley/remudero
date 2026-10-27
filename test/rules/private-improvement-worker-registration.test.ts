import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Classified = { mapped: string[]; cliOnlyVerbs: string[]; unmapped: string[] };
type Parity = {
  ROUTE_MATCH: Record<string, string>;
  CLI_ONLY: Record<string, string>;
  classifyVerbs: (verbs: readonly string[], routes: readonly { method: string; path: string }[],
    routeMatch?: Record<string, string>, cliOnly?: Record<string, string>) => Classified;
  ratchetVerdict: (actual: readonly string[], baseline: readonly string[]) => { ok: boolean; added: string[]; removed: string[] };
};
const moduleSpecifier = "#scripts/console-parity-ratchet.mjs";
const parity = await import(moduleSpecifier) as Parity;

test("private improvement worker registration preserves console route and baseline guards", () => {
  const name = "improvement-action";
  const routes = [{ method: "GET", path: "/v1/status" }];
  const before = parity.classifyVerbs(["status"], routes);
  assert.deepEqual(before, { mapped: ["status"], cliOnlyVerbs: [], unmapped: [] }, "preregistration does not invent a command or alter an existing route");
  const reason = parity.CLI_ONLY[name];
  assert.ok(typeof reason === "string", "the private worker needs its own explicit recorded reason");
  assert.match(reason, /^daemon-owned internal worker:/);
  assert.equal(parity.ROUTE_MATCH[name], undefined, "saving an HTTP request is not worker execution parity");
  const projected = parity.classifyVerbs(["status", name], routes);
  assert.deepEqual(projected, { mapped: ["status"], cliOnlyVerbs: [name], unmapped: [] });
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/console-parity-baseline.json"), "utf8")) as { uncoveredVerbs: string[] };
  assert.equal(baseline.uncoveredVerbs.filter(verb => verb === name).length, 1, "the approved named addition is recorded exactly once");
  assert.equal(parity.ratchetVerdict(projected.cliOnlyVerbs, baseline.uncoveredVerbs).ok, true);
  const omitted = parity.ratchetVerdict(projected.cliOnlyVerbs, baseline.uncoveredVerbs.filter(verb => verb !== name));
  assert.equal(omitted.ok, false, "a private reason still cannot bypass the recorded-set gate");
  assert.deepEqual(omitted.added, [name]);
  const withoutReason = { ...parity.CLI_ONLY }; delete withoutReason[name];
  assert.deepEqual(parity.classifyVerbs([name], routes, parity.ROUTE_MATCH, withoutReason).unmapped, [name], "the recorded baseline alone grants no classification");
  assert.deepEqual(parity.classifyVerbs(["another-private-worker"], routes).unmapped, ["another-private-worker"], "this approval does not cover any other command");
});
