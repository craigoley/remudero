import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPlan } from "../src/lib/plan.js";

// ── THE THIRD OCCURRENCE OF A CLASS, CLOSED ──────────────────────────────────────────
//
// `.remudero/mounts.yaml` has now shipped THREE rows that looked configured and were never
// consulted: `architect:` (#781 — the row was inert while a code-level default governed),
// `recon:` (#992 — 413 of 413 recon.done rows in the whole ledger carried model "default",
// so no recon in this repo's history ever used its configured mount), and `review:` (found
// by impl-BP, still unruled). Each cost a separate investigation to notice. This test makes
// the FOURTH one fail the build instead.
//
// ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────────────
//
// A `routes:` row is reachable only by its KEY reaching `resolveMount`/`resolveMountForClass`
// (src/lib/mounts.ts). That key arrives by exactly two routes, both checked here:
//
//   1. a STRING LITERAL at a call site      — e.g. resolveMountForClass(table, "recon", …)
//   2. a task's `type:` field               — resolveMountForClass(table, task.type, …)
//
// PROVES: no row is silently unreachable-in-practice today. If a row's key is neither passed
// as a literal anywhere in src/ nor carried by a single task in the committed plan, NOTHING
// currently routes to it, and this test says so by name.
//
// DOES NOT PROVE (stated because a test that oversells is worse than none):
//   (a) *unreachable forever*. `Task["type"]` (src/lib/plan.ts) is a closed TS union that
//       DECLARES "recon" | "review" alongside the three types tasks actually use — and the
//       parser casts (`req(e.type as Task["type"], …)`) rather than validating, so the union
//       is compile-time only. A future task carrying `type: review` would reach the row. An
//       unread row is dormant, not impossible.
//   (b) that a found reader is on a LIVE path. A literal inside dead code still counts here.
//   (c) that the resolved mount is USED. #992's defect was a row resolved and then ignored
//       for `max_turns`; `test/recon-mount-routing.test.ts` pins that separately.
//   (d) anything about the four scalar sections (`tiers`/`efforts`/`architect`/`judge`).
//       Their "reader" is a property access, and a naive detector is noisy — `service.ts`'s
//       HTTP `opts.routes` and `retro.ts`'s `PromotionJudgeDeps.judge` both match a
//       `.<section>` grep while having nothing to do with mounts. #781's `architect:` case is
//       that shape, so this test does NOT close that sub-shape; see impl-BS's report.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Rows deliberately kept while nothing reads them. EVERY entry needs a reason — the point of
 * the allowlist is that skipping a row is a recorded decision, not an oversight.
 */
const UNREAD_ROW_ALLOWLIST: Record<string, string> = {
  review:
    "pending operator ruling — see impl-BS. `routes.review` has no literal reader and no task " +
    "carries `type: review`, but `review` IS a declared member of Task['type'] (src/lib/plan.ts), " +
    "so it may be a dormant lane rather than a rename vestige of `reviewer:`. Deleting vs wiring " +
    "is a table-semantics call for the operator; the row is left untouched until it is made.",
};

/** Every `src/**\/*.ts`, read with readFileSync — NOT grep: `src/lib/task-linter.ts` and
 *  `src/lib/flight-signals.ts` each carry a raw NUL byte, which makes grep silently skip them. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Row keys under `routes:` in a mounts.yaml text (two-space indent, one level down). */
export function routeRowKeys(mountsYaml: string): string[] {
  const lines = mountsYaml.split("\n");
  const start = lines.findIndex((l) => /^routes:\s*$/.test(l));
  if (start < 0) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level section ends `routes:`
    const m = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * Row keys passed to the resolver as a STRING LITERAL, anywhere in the given sources.
 *
 * A DEPTH-AWARE SCAN, not a regex. Argument 1 is routinely itself a call — at
 * `run-task.ts:4745` it is `loadMounts(mountsPath(repoRoot))`, two levels deep — and a regex
 * that mis-parses it silently DROPS a real reader, which would report a live row as dead and
 * fail the build wrongly. That direction of error is the dangerous one, so this walks parens.
 */
export function literalRouteKeys(sources: string[]): Set<string> {
  const found = new Set<string>();
  const CALL = /\bresolveMount(?:ForClass)?\s*\(/g;
  for (const src of sources) {
    for (const m of src.matchAll(CALL)) {
      let i = m.index! + m[0].length;
      let depth = 0;
      // advance to the first comma at depth 0 — the end of argument 1
      while (i < src.length) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") { if (depth === 0) break; depth--; }
        else if (c === "," && depth === 0) { i++; break; }
        i++;
      }
      const rest = src.slice(i, i + 80);
      const key = /^\s*"([a-z][\w-]*)"/.exec(rest);
      if (key) found.add(key[1]);
    }
  }
  return found;
}

/** The reader verdict for one row: which mechanism reaches it, if any. */
export function rowReaders(
  key: string,
  literals: Set<string>,
  taskTypeCounts: Record<string, number>,
): { read: boolean; via: string } {
  if (literals.has(key)) return { read: true, via: "string literal at a resolver call site" };
  const n = taskTypeCounts[key] ?? 0;
  if (n > 0) return { read: true, via: `${n} task(s) carry type: ${key}` };
  return { read: false, via: "none found" };
}

const MOUNTS = readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8");
const SOURCES = srcFiles(join(REPO_ROOT, "src")).map((f) => readFileSync(f, "utf8"));
const LITERALS = literalRouteKeys(SOURCES);
const TASK_TYPES: Record<string, number> = {};
for (const t of loadPlan(join(REPO_ROOT, "plan", "tasks.yaml")).tasks) {
  TASK_TYPES[t.type] = (TASK_TYPES[t.type] ?? 0) + 1;
}

test("every routes row in the committed mounts.yaml has an observable reader, or an allowlist entry that says why not", () => {
  const rows = routeRowKeys(MOUNTS);
  assert.ok(rows.length > 0, "no routes rows parsed — the parser, not the table, is broken");

  const unread = rows.filter((k) => !rowReaders(k, LITERALS, TASK_TYPES).read && !(k in UNREAD_ROW_ALLOWLIST));
  assert.deepEqual(
    unread,
    [],
    `mounts.yaml routes row(s) with NO reader: ${unread.join(", ")}. A row nothing reaches is ` +
      `config that lies — it looks configured and governs nothing (#781 architect:, #992 recon:). ` +
      `Either wire it, delete it, or add it to UNREAD_ROW_ALLOWLIST with a reason.`,
  );
});

test("the unread-row detector actually fires — a junk row with no reader is reported by name", () => {
  // The falsifier for the test above. Runs the SAME predicate over a synthetic table, so the
  // check is proven capable of failing without mutating the committed mounts.yaml.
  const junk = `${MOUNTS.trimEnd()}\n  totally-unused-row:\n    high:\n      src: { model: haiku, effort: low, max_turns: 8, context_budget: 1000 }\n`;
  const rows = routeRowKeys(junk);
  assert.ok(rows.includes("totally-unused-row"), "the row parser must see the synthetic row");
  const unread = rows.filter((k) => !rowReaders(k, LITERALS, TASK_TYPES).read && !(k in UNREAD_ROW_ALLOWLIST));
  assert.deepEqual(unread, ["totally-unused-row"], "the detector must name exactly the unread row");
});

test("both reader mechanisms are exercised — a literal-read row and a task-type-read row each resolve", () => {
  // Guards against a detector that passes everything by accident (e.g. an over-broad regex).
  assert.equal(rowReaders("recon", LITERALS, TASK_TYPES).via, "string literal at a resolver call site");
  assert.match(rowReaders("implement", LITERALS, TASK_TYPES).via, /^\d+ task\(s\) carry type: implement$/);
  assert.equal(rowReaders("no-such-row", LITERALS, TASK_TYPES).read, false);
});

test("every allowlist entry names a real row, carries a reason, and is still genuinely unread", () => {
  const rows = new Set(routeRowKeys(MOUNTS));
  for (const [key, reason] of Object.entries(UNREAD_ROW_ALLOWLIST)) {
    assert.ok(rows.has(key), `allowlist names '${key}', which is not a routes row — stale entry, remove it`);
    assert.ok(reason.trim().length >= 40, `allowlist entry '${key}' needs a real reason, not a placeholder`);
    assert.equal(
      rowReaders(key, LITERALS, TASK_TYPES).read,
      false,
      `allowlist entry '${key}' is now READ — the exemption is stale and must be removed`,
    );
  }
});
