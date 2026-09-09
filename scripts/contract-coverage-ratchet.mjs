#!/usr/bin/env node
// contract-coverage-ratchet — every `/v1/` route a FIRST-PARTY CLIENT calls must be declared in
// openapi/daemon.yaml. The uncovered count is a ratchet: it may FALL and never RISE.
//
// WHY (W1-T3174). `scripts/no-hand-rolled-fetch-check.mjs` is a required gate that walks `apps` and
// `packages` and refuses any direct `fetch(`. That is the correct rule (MASTER-PLAN §7A) and this
// does not relax it — it means `apps/dashboard` CANNOT call a route the generated client does not
// expose, by CI rather than by convention. So the contract is the critical path for the console
// rebuild: every route the new screens need has to exist in the spec first.
//
// MEASURED 2026-09-09: the console's client calls 39 distinct `/v1/` routes; `openapi/daemon.yaml`
// declares 13.
//
// ⚠ IT MUST SEE THE STRING CONSOLE TOO. Counting only `apps/` reports a clean sheet while the
// routes in daily use go undeclared — the live console's client is `src/lib/console-shell-client.ts`
// and it is not under `apps/`. A census that looks only where the fetch gate looks measures the
// wrong population and reads as done.
//
// IT DOES NOT DOCUMENT ROUTES, BY DESIGN. W1-T3174 (i): per-screen, never all-27-up-front — a shard
// that lands speculative path definitions has written a schema nobody has read. This makes the gap
// LEGIBLE and stops it growing; W1-T3177 lowers it for the routes its screen actually consumes.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Where a first-party client's route calls live. The string console is listed EXPLICITLY because
 *  it is the one consumer that does not sit under `apps/`, and it is the largest. */
export const CLIENT_SOURCES = [
  "src/lib/console-shell-client.ts",
  "src/lib/console-shell-script.ts",
  "apps/dashboard/src",
  "packages/daemon-client-smoke/src",
];

export const BASELINE_PATH = "scripts/contract-coverage-baseline.json";

/** A `/v1/…` route as it appears in client source, INCLUDING a template-literal segment.
 *
 *  A character class that stops at `$` truncates `/v1/tasks/${id}` to `/v1/tasks`, which then never
 *  matches the spec's `/v1/tasks/{id}` — every parameterised route reads as uncovered even when it
 *  is declared, inflating the count and making the ratchet lie in the direction nobody checks. */
const ROUTE_RE = /\/v1\/(?:[a-zA-Z0-9_-]+|\$\{[^}]*\})(?:\/(?:[a-zA-Z0-9_-]+|\$\{[^}]*\}))*/g;

/** A declared path in the spec: two-space-indented under `paths:`, ending in a colon. */
const DECLARED_RE = /^ {2}(\/v1\/[^:]*):/gm;

/** Every distinct route a first-party client calls. A PATH PARAMETER is normalised away so
 *  `/v1/tasks/W1-T1` and the spec's `/v1/tasks/{id}` are the same route rather than two. */
export function routesCalled(sources, readTextTree) {
  const found = new Set();
  for (const src of sources) {
    for (const text of readTextTree(src)) {
      for (const m of text.matchAll(ROUTE_RE)) found.add(normalisePath(m[0]));
    }
  }
  return [...found].sort();
}

/** Every route the contract declares, with its `{param}` segments normalised the same way. */
export function routesDeclared(specText) {
  const found = new Set();
  for (const m of specText.matchAll(DECLARED_RE)) found.add(normalisePath(m[1]));
  return [...found].sort();
}

/**
 * Collapse a concrete or templated segment to a stable shape. Without this the census compares
 * `/v1/tasks/{id}` against `/v1/tasks/W1-T1` and reports a covered route as uncovered forever —
 * a ratchet that can never fall is one nobody can act on.
 */
export function normalisePath(p) {
  return p
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\{[^}]*\}/g, ":p")
    .split("/")
    .map((seg) => (/^(W\d+-T[\w-]+|\d+|[0-9a-f]{7,40})$/.test(seg) ? ":p" : seg))
    .join("/")
    .replace(/\/+$/, "");
}

/** The uncovered set: called by a first-party client, absent from the contract. */
export function uncovered(called, declared) {
  const have = new Set(declared);
  return called.filter((r) => !have.has(r));
}

export function classify(count, baseline) {
  if (count > baseline) return { ok: false, direction: "rose" };
  if (count < baseline) return { ok: true, direction: "fell" };
  return { ok: true, direction: "held" };
}

export function formatReport({ called, declared, missing, baseline }) {
  const out = [];
  const verdict = classify(missing.length, baseline);
  out.push(
    `contract-coverage: ${missing.length} of ${called.length} first-party route(s) are NOT declared in openapi/daemon.yaml ` +
      `(${declared.length} declared); recorded ceiling ${baseline}.`,
  );
  if (verdict.direction === "rose") {
    out.push(`ROSE — a first-party client now calls a route the contract does not declare.`);
    out.push(`Declare it in openapi/daemon.yaml, or if the growth is deliberate and reviewed, raise`);
    out.push(`the ceiling in ${BASELINE_PATH} and say why in the same PR.`);
  } else if (verdict.direction === "fell") {
    out.push(`FELL — lower the ceiling in ${BASELINE_PATH} to lock the improvement in.`);
  }
  if (missing.length) {
    out.push("");
    out.push("UNDECLARED:");
    for (const r of missing) out.push(`  ${r}`);
  }
  return out.join("\n");
}

/** Read every source file under a path (a file or a directory), via git so untracked scratch and
 *  ignored build output are never counted as a consumer. */
function readTextTree(target) {
  const listed = execFileSync("git", ["ls-files", "--", target], { encoding: "utf8" })
    .split("\n")
    .filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
  return listed.map((p) => readFileSync(p, "utf8"));
}

function main() {
  const called = routesCalled(CLIENT_SOURCES, readTextTree);
  const declared = routesDeclared(readFileSync("openapi/daemon.yaml", "utf8"));
  // A ZERO ON EITHER SIDE IS A BROKEN CENSUS, NOT A CLEAN SHEET. Both extractions are regexes over
  // text; if one stops matching, the uncovered count collapses toward zero and reads as success.
  if (called.length === 0 || declared.length === 0) {
    console.log(
      `contract-coverage: REFUSING — extraction returned ${called.length} called and ${declared.length} declared. ` +
        "A zero on either side means the census stopped seeing its corpus, which reads as a clean sheet.",
    );
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).uncoveredCeiling;
  const missing = uncovered(called, declared);
  console.log(formatReport({ called, declared, missing, baseline }));
  process.exit(classify(missing.length, baseline).ok ? 0 : 1);
}

export function writeBaseline(count, note) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ _comment: note, uncoveredCeiling: count }, null, 2) + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("contract-coverage-ratchet.mjs")) main();
