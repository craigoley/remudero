#!/usr/bin/env node
// scripts/task-id-existence-check.mjs
//
// TASK-ID EXISTENCE gate (W1-T1048).
//
// #2251 cited an id as its OWN task id in shipped code -- two comments in
// deploy/recycle-container.sh and five references in test/recycle-container.test.ts -- and named
// it three times in its PR body, yet no plan record ever declared it and no reservation ref ever
// held it. It was orphaned because the hand lane's only id source, `rmd next-task-id`, prints an
// id and reserves NOTHING (its own comment: "a process that exits microseconds later reserves
// nothing anyway"), so a later `rmd plan`/`rmd triage` mint handed the same number out as free.
// Nothing noticed until an open PR had to be renumbered.
//
// THE PREDICATE IS EXISTENCE, NEVER OWNERSHIP. Ids legitimately appear in shipped source -- a
// task that ships code routinely names itself in comments and test titles -- so a lint forbidding
// ids in source would break the house convention within a day. The rule this script enforces
// instead: every `W1-T<n>` cited under `src/` or `deploy/` must resolve to EITHER a reservation
// ref (`refs/rmd-id/W1-T<n>` on the remote) OR a declared plan record (`- id: W1-T<n>` in
// plan/tasks.yaml or plan/tasks.d/*.yaml). Either alone is a valid claim (W1-T509's reservation
// allocator predates most declared ids, and a freshly reserved id has no plan record yet).
//
// `test/` IS EXCLUDED BY CONSTRUCTION, NOT BY EXEMPTION -- the default scan roots are simply
// `src` and `deploy`; the fixture corpus test/ carries (~25 of the 31 ids that fail across all
// three trees, measured 2026-08-20) is synthetic test data, invented as fixture ids, and is never
// a claim. Widening the scan to test/ would turn a real gate into a permanent, growing exemption
// list instead.
//
// A SMALL, WRITTEN BASELINE IS UNAVOIDABLE AND SAID PLAINLY. A handful of ids predate the
// reservation allocator (W1-T509) or the plan schema itself, were filed/retired before either
// existed, and never got a plan record (the same phenomenon plan/tasks.d/W1-T278-*.yaml
// documents for its low-numbered siblings: completed/retired ids "absent from every source the
// minter consults"), so they resolve to neither surface today and never will. Each is exempted
// only with a written reason (scripts/task-id-existence-baseline.json) -- an entry with no reason
// is REJECTED, so the exemption list cannot grow silently. (The count is deliberately not quoted
// here -- re-run this script to see it live rather than trust a number that can drift.)
//
// THIS SCRIPT IS READ-ONLY. It shells out to `git ls-remote` (a read) to resolve reservation
// refs and reads files from disk; it never writes a ref, never mints an id, and never invokes any
// verb that would. An unreachable remote is a DEGRADED READ, not a failure: an id that would
// otherwise fail is reported as a STATED UNKNOWN rather than failing the whole gate closed on a
// network blip (the remote is the same origin the CI checkout already authenticated to, but a
// transient failure there says nothing about whether the id is real).
//
// Usage:
//   node scripts/task-id-existence-check.mjs
//     [--dir <path>]...            (default: src, deploy -- relative to --cwd)
//     [--plan-tasks-file <path>]   (default: plan/tasks.yaml)
//     [--plan-tasks-dir <path>]    (default: plan/tasks.d)
//     [--baseline <path>]         (default: scripts/task-id-existence-baseline.json)
//     [--remote <name-or-path>]   (default: origin)
//     [--cwd <path>]              (default: process.cwd())
//
// The pure pieces (scanCitedIds, scanDeclaredPlanIds, resolveReservedIds, loadBaseline,
// evaluateIds) are exported so the falsifier fixture test can drive each surface independently,
// plus the CLI directly (spawn + exit code) for the end-to-end proof.

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const TASK_ID_RE = /\bW1-T[0-9]+\b/g;
const DECLARED_ID_LINE_RE = /^\s*-\s*id:\s*(W1-T[0-9]+)\s*$/;
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tgz", ".pdf", ".wasm", ".node", ".map",
]);

function walkFiles(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return; // nothing to scan -- not an error.
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkFiles(abs, files);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (BINARY_EXTENSIONS.has(ext)) continue;
      files.push(abs);
    }
  }
}

/**
 * Scan `dirs` (resolved against `cwd`) for every `W1-T<n>` token, returning a Map from id to the
 * list of `{ file, line }` occurrences (file relative to `cwd`) -- so a failure can be reported
 * with a concrete pointer, not just a bare id. Read-only: no file is ever written.
 */
export function scanCitedIds(dirs, cwd) {
  const hits = new Map();
  for (const dir of dirs) {
    const files = [];
    walkFiles(join(cwd, dir), files);
    for (const abs of files) {
      const rel = relative(cwd, abs);
      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        TASK_ID_RE.lastIndex = 0;
        let m;
        while ((m = TASK_ID_RE.exec(line)) !== null) {
          const id = m[0];
          if (!hits.has(id)) hits.set(id, []);
          hits.get(id).push({ file: rel, line: idx + 1 });
        }
      });
    }
  }
  return hits;
}

/**
 * Every id declared via `- id: W1-T<n>` in `planTasksFile` and every `*.yaml`/`*.yml` under
 * `planTasksDir` (both resolved against `cwd`). A declared id is a valid claim on its own,
 * independent of whether it also holds a reservation ref.
 */
export function scanDeclaredPlanIds(cwd, opts = {}) {
  const planTasksFile = opts.planTasksFile ?? "plan/tasks.yaml";
  const planTasksDir = opts.planTasksDir ?? "plan/tasks.d";
  const ids = new Set();

  const scanFile = (abs) => {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const line of text.split("\n")) {
      const m = DECLARED_ID_LINE_RE.exec(line);
      if (m) ids.add(m[1]);
    }
  };

  scanFile(join(cwd, planTasksFile));

  const dirAbs = join(cwd, planTasksDir);
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.ya?ml$/.test(entry.name)) continue;
    scanFile(join(dirAbs, entry.name));
  }

  return ids;
}

/**
 * Every id holding a `refs/rmd-id/W1-T*` reservation ref on `remote`, read via `git ls-remote`
 * (a READ, never a write). `remote` may be a remote name (e.g. "origin") or a local/bare path --
 * the latter is how the falsifier tests drive this without any network access.
 *
 * `reachable: false` means the read itself failed (network blip, unresolvable remote, etc.) --
 * distinct from `reachable: true, ids: (empty set)`, which means the read SUCCEEDED and found no
 * reservations. Callers must treat an unreachable read as a STATED UNKNOWN, never as "nothing is
 * reserved" (the fail-closed direction task-id-reservation.ts's own remote reads already take).
 */
export function resolveReservedIds(remote, cwd) {
  const result = spawnSync("git", ["ls-remote", remote, "refs/rmd-id/W1-T*"], {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return { reachable: false, ids: new Set() };
  }
  const ids = new Set();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    const ref = tab === -1 ? "" : trimmed.slice(tab + 1);
    const m = /^refs\/rmd-id\/(W1-T[0-9]+)$/.exec(ref);
    if (m) ids.add(m[1]);
  }
  return { reachable: true, ids };
}

/**
 * Parse+validate scripts/task-id-existence-baseline.json into a Map from id to its written
 * reason. THROWS on a structurally invalid file OR on any entry missing a non-empty `reason` --
 * an exemption with no recorded reason would let the baseline grow silently, which is exactly the
 * failure this gate exists to prevent for itself.
 */
export function loadBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`task-id-existence: cannot read baseline file ${path}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`task-id-existence: ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(doc)) {
    throw new Error(`task-id-existence: ${path} must be a JSON array of { id, reason } entries`);
  }
  const map = new Map();
  doc.forEach((entry, idx) => {
    const id = entry && typeof entry.id === "string" ? entry.id : null;
    if (!id || !/^W1-T[0-9]+$/.test(id)) {
      throw new Error(`task-id-existence: ${path}[${idx}] has no valid "id" (expected "W1-T<n>"): ${JSON.stringify(entry)}`);
    }
    const reason = entry && typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === "") {
      throw new Error(
        `task-id-existence: ${path}[${idx}] (${id}) has NO WRITTEN REASON -- a baseline entry with no ` +
          `recorded reason is rejected, so the exemption list cannot grow silently.`,
      );
    }
    if (map.has(id)) {
      throw new Error(`task-id-existence: ${path} lists ${id} more than once`);
    }
    map.set(id, reason);
  });
  return map;
}

/**
 * Pure decision layer: given the cited-id occurrences and the three resolution surfaces, classify
 * every cited id as "resolved" (declared or reserved), "baselined" (unresolved but has a written
 * exemption), "unknown" (unresolved, but the reservation read was unreachable so it cannot be
 * told apart from a real reservation) or "failed" (unresolved, no exemption, and the reservation
 * read WAS reachable -- a genuine orphan).
 */
export function evaluateIds(citedHits, declaredIds, reservation, baseline) {
  const results = [];
  for (const [id, occurrences] of citedHits) {
    if (declaredIds.has(id) || reservation.ids.has(id)) {
      results.push({ id, status: "resolved", occurrences });
      continue;
    }
    if (baseline.has(id)) {
      results.push({ id, status: "baselined", occurrences, reason: baseline.get(id) });
      continue;
    }
    if (!reservation.reachable) {
      results.push({ id, status: "unknown", occurrences });
      continue;
    }
    results.push({ id, status: "failed", occurrences });
  }
  return results;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", multiple: true },
      "plan-tasks-file": { type: "string", default: "plan/tasks.yaml" },
      "plan-tasks-dir": { type: "string", default: "plan/tasks.d" },
      baseline: { type: "string", default: "scripts/task-id-existence-baseline.json" },
      remote: { type: "string", default: "origin" },
      cwd: { type: "string" },
    },
  });

  const cwd = values.cwd ?? process.cwd();
  const dirs = values.dir && values.dir.length > 0 ? values.dir : ["src", "deploy"];

  let baseline;
  try {
    baseline = loadBaseline(values.baseline);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const citedHits = scanCitedIds(dirs, cwd);
  const declaredIds = scanDeclaredPlanIds(cwd, {
    planTasksFile: values["plan-tasks-file"],
    planTasksDir: values["plan-tasks-dir"],
  });
  const reservation = resolveReservedIds(values.remote, cwd);

  if (!reservation.reachable) {
    console.error(
      `task-id-existence: WARNING -- could not read reservation refs from remote "${values.remote}" ` +
        `(network blip or unresolvable remote). Any id that fails to resolve against declared plan ` +
        `records alone is reported as an UNKNOWN, not a failure, until the remote is reachable again.`,
    );
  }

  const results = evaluateIds(citedHits, declaredIds, reservation, baseline);
  const failed = results.filter((r) => r.status === "failed").sort((a, b) => a.id.localeCompare(b.id));
  const baselined = results.filter((r) => r.status === "baselined").sort((a, b) => a.id.localeCompare(b.id));
  const unknown = results.filter((r) => r.status === "unknown").sort((a, b) => a.id.localeCompare(b.id));

  for (const r of baselined) {
    console.log(`BASELINE  ${r.id} -- ${r.reason} (first cited at ${r.occurrences[0].file}:${r.occurrences[0].line})`);
  }
  for (const r of unknown) {
    console.log(`UNKNOWN   ${r.id} -- reservation read was unreachable (first cited at ${r.occurrences[0].file}:${r.occurrences[0].line})`);
  }

  if (failed.length > 0) {
    console.error(
      "\ntask-id-existence: FAILED -- the following id(s) are cited under " +
        `${dirs.join(", ")} but resolve to NEITHER a reservation ref NOR a declared plan record:\n`,
    );
    for (const r of failed) {
      console.error(`  ${r.id}`);
      for (const occ of r.occurrences) console.error(`    ${occ.file}:${occ.line}`);
    }
    console.error(
      "\nIf this id was legitimately filed and its plan record was later compacted away, add it to " +
        `${values.baseline} with a written reason. If it was never reserved or filed, it should not ` +
        "have been written into shipped source -- reserve/file it, or remove the reference.",
    );
    // THE THIRD EXIT, AND THE ONE THIS GATE USED TO LEAVE UNSAID. The two remedies above both
    // assume the id was MEANT as a claim. The case that actually cost this repo was neither: a
    // doc example, written to illustrate a call, which `TASK_ID_MENTION_RE` then read as a real
    // ceiling. A code span does not help -- the extractor reads `W1-T9999`, "`W1-T9999`" and a
    // fenced block identically -- so an author who backticked it and moved on had no sanctioned
    // way to write an example at all. Say the placeholder form here, where the refusal is read.
    console.error(
      "\nIf it is an EXAMPLE rather than a claim, use the placeholder form instead: W1-T<n> (also " +
        "W1-T<id>, W1-TNNNN). Backticks and fenced blocks do NOT help -- the id extractor reads a " +
        "literal the same inside them as outside. The placeholder forms carry no digits, so neither " +
        "the mint's mention scan nor the plan-history scan can see them.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\ntask-id-existence: OK -- every id cited under ${dirs.join(", ")} resolves to a reservation or a ` +
      `plan record (${baselined.length} baselined, ${unknown.length} unknown).`,
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/task-id-existence-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
