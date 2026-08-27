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
// THE ID GRAMMAR, DERIVED FROM WHAT THE PLAN ACTUALLY DECLARES, not from the `W1-T<n>` shorthand
// every brief uses. Measured 2026-08-26 over plan/tasks.yaml + plan/tasks.d/: 901 declared ids, of
// which 21 carry a single-letter suffix (W1-T1B, W1-T9a, W1-T12e, W1-T3F, ...) and 14 sit in another
// workstream (W2-T1, W3-T3, W12-T1). The previous `W1-T[0-9]+` form saw 866 of them and DROPPED 35.
//
// DROPPED, NEVER TRUNCATED, and the difference decides what kind of defect this was. The `$` anchor
// means `- id: W1-T1B` matches NOTHING; it does not read as `W1-T1`. So there was no false collision
// between lettered siblings — there was a HOLE: a re-issued lettered or non-W1 id was invisible to
// the collision check, which is the worse direction for a gate. Driven directly: the old regex
// returns NO MATCH for `W1-T1B`, `W1-T9a` and `W3-T3`, and `W1-T1` only for `- id: W1-T1`.
//
// THE BOUNDARY IS THE LINE ANCHOR, NOT A CHARACTER CLASS. This repo's other id matches use
// `W1-T<n>([^0-9]|$)`, which is right for finding an id inside prose and WRONG here for the same
// reason the old form was: it would accept `W1-T1` as a prefix of `W1-T1B`. A declared id is the
// WHOLE line after `- id:`, so `^...$` is the exact boundary and needs no class.
const DECLARED_ID_LINE_RE = /^\s*-\s*id:\s*(W[0-9]+-T[0-9]+[A-Za-z]?)\s*$/;
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
 * Every plan file that DECLARES each id in the working tree, keyed by id — the multiplicity
 * {@link scanDeclaredPlanIds}'s Set discards, and the whole signal this gate needs.
 */
export function scanDeclaredPlanIdOccurrences(cwd, opts = {}) {
  const planTasksFile = opts.planTasksFile ?? "plan/tasks.yaml";
  const planTasksDir = opts.planTasksDir ?? "plan/tasks.d";
  const byId = new Map();
  const scanFile = (abs, rel) => {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    text.split("\n").forEach((line, i) => {
      const m = DECLARED_ID_LINE_RE.exec(line);
      if (!m) return;
      if (!byId.has(m[1])) byId.set(m[1], []);
      byId.get(m[1]).push({ file: rel, line: i + 1 });
    });
  };
  scanFile(join(cwd, planTasksFile), planTasksFile);
  const dirAbs = join(cwd, planTasksDir);
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    scanFile(join(dirAbs, entry.name), `${planTasksDir}/${entry.name}`);
  }
  return byId;
}

/**
 * Ids DECLARED in the plan at `baseRef`, used to attribute which side of a collision this PR added.
 *
 * `origin/main` AT CHECK TIME, NOT the PR's merge-base, and the difference is the defect itself: a
 * merge-base answers "what did main look like when this branch was cut", and main landed a PR about
 * every twenty minutes on 2026-08-26. W1-T2316 merged at 14:59:02Z, AFTER the branch that reissued
 * it was cut, so a merge-base read would have found nothing. What this read cannot see is an id
 * added by another still-open PR (open-vs-open) — those ids sit on no ref it can reach; getting
 * them needs the mint's open-PR surface (W1-T2324's Q1: REST, never GraphQL — `openPrMintTexts`,
 * src/run-task.ts). That half is {@link evaluateOpenPrIdCollisions} below, cross-referencing
 * {@link addedIdsAtHead}'s output (this function's own "added" shape, generalized to every added
 * id rather than only ones that already collide with THIS base) against {@link fetchOpenPrRows}'s
 * REST read of every other open PR's title/body/head-ref text.
 *
 * `readable: false` is the read FAILING (shallow clone with no `origin/main`, unresolvable ref).
 * It is never "the base declares nothing" — reading an unreadable surface as an empty one is the
 * false zero that produced all three 2026-08-26 collisions, so the caller REFUSES on it.
 *
 * Returns id -> the plan files declaring it AT THE BASE. The files, not just the ids: an id whose
 * declaring file is the SAME on both sides is a shard this change merely carries along, while the
 * SAME id declared from a DIFFERENT file is a re-issue. `-l` with the ref prefix gives both.
 */
export function resolveBaseDeclaredIds(baseRef, cwd) {
  const result = spawnSync(
    "git",
    ["grep", "-lE", "^[[:space:]]*-[[:space:]]*id:[[:space:]]*W[0-9]+-T[0-9]+", baseRef, "--", "plan/tasks.yaml", "plan/tasks.d/"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // git grep exits 1 for "ref resolved, no matches" — a real answer. 128 (bad revision) is not.
  if (result.error || (result.status !== 0 && result.status !== 1)) return { readable: false, byId: new Map() };
  const byId = new Map();
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const file = line.startsWith(`${baseRef}:`) ? line.slice(baseRef.length + 1) : line;
    const show = spawnSync("git", ["show", `${baseRef}:${file}`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (show.error || show.status !== 0) return { readable: false, byId: new Map() };
    for (const l of show.stdout.split("\n")) {
      const m = DECLARED_ID_LINE_RE.exec(l);
      if (!m) continue;
      if (!byId.has(m[1])) byId.set(m[1], new Set());
      byId.get(m[1]).add(file);
    }
  }
  return { readable: true, byId };
}

/**
 * owner/repo, parsed from `remote`'s url at `cwd` — no hardcoded slug in the tree, mirroring
 * src/lib/repo-location.ts's `resolveOwnerRepo`. DELIBERATELY DUPLICATED rather than imported:
 * this script is a plain `.mjs` outside `tsconfig.json`'s `include` (this file's own header),
 * with no build step between it and `src/`'s TypeScript — the same reason {@link TASK_ID_RE}
 * above duplicates `lib/task-id.ts`'s id grammar instead of importing it.
 *
 * `undefined` on an unparsable/unreadable url — never a guessed owner/repo, which would send the
 * open-PR REST read below to a repo that is not this one.
 */
export function resolveOwnerRepoFromGit(remote, cwd) {
  const result = spawnSync("git", ["config", "--get", `remote.${remote}.url`], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(result.stdout.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** The checked-out branch at `cwd`, or `undefined` on a DETACHED HEAD (a PR checkout in CI,
 *  which is exactly why {@link main}'s `--head-ref` flag / `GITHUB_HEAD_REF` env both take
 *  priority over this — see the call site). Never guessed from anything else. */
export function currentBranch(cwd) {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch === "" || branch === "HEAD" ? undefined : branch;
}

/**
 * Every OPEN pull request's number, url, head ref and mention-scannable text, read over REST —
 * `GET /repos/<owner>/<repo>/pulls?state=open&per_page=100`, never `gh pr list --json`
 * (GraphQL) — the SAME discriminator W1-T2324's Q1 fixed in the mint itself
 * (`openPrMintTexts`, src/run-task.ts): the field set decides the transport, not the subcommand.
 *
 * `reachable: false` covers a `gh` that cannot run AT ALL (no network, no credentials — MEASURED:
 * CI's `task-id-existence` job carries no `GH_TOKEN` today, so `gh api` fails fast with "gh: To
 * use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable") as well as
 * a response this could not parse. The caller treats it exactly like {@link resolveReservedIds}'s
 * own `reachable: false` — read-only, degrade to a STATED SKIP, never fail the whole gate closed
 * on a blip, and never read it as "no other open PR claims this id".
 */
export function fetchOpenPrRows(owner, repo, cwd) {
  const result = spawnSync("gh", ["api", `repos/${owner}/${repo}/pulls?state=open&per_page=100`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return { reachable: false, rows: [] };
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return { reachable: false, rows: [] };
  }
  if (!Array.isArray(rows)) return { reachable: false, rows: [] };
  return { reachable: true, rows };
}

/** Any `W1-T<n>` MENTION in free text — deliberately loose, mirroring `lib/task-id.ts`'s
 *  `mentionedTaskIds` (the mint's own open-PR reader): over-counting here only ever refuses a PR
 *  that turns out to be innocent (fixable by renumbering, or by the id genuinely being free once
 *  re-checked), while under-counting would let a real open-vs-open collision merge silently. */
const MENTION_RE = /\bW1-T[0-9]+\b/g;
function mentionedIds(text) {
  const ids = new Set();
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) ids.add(m[0]);
  return ids;
}

/**
 * Ids THIS branch ADDS relative to `base` — {@link evaluateAddedIdCollisions}'s per-id "reissued"
 * shape, generalized to every declared id (not only ones that already collide with `base`), so
 * the open-vs-open check below has a complete claim set to cross-reference. An id whose declaring
 * file at HEAD is the SAME as at `base` is a shard this change merely carries along, not an add.
 *
 * `base.readable === false` propagates as `{ readable: false, ids: [] }` rather than guessing an
 * empty add set — the same false-zero {@link resolveBaseDeclaredIds} itself refuses on.
 */
export function addedIdsAtHead(occurrencesById, base) {
  if (!base.readable) return { readable: false, ids: [] };
  const ids = [];
  for (const [id, occurrences] of occurrencesById) {
    const headFiles = [...new Set(occurrences.map((o) => o.file))];
    const baseFiles = base.byId.get(id);
    const newFiles = baseFiles ? headFiles.filter((f) => !baseFiles.has(f)) : headFiles;
    if (newFiles.length > 0) ids.push(id);
  }
  return { readable: true, ids };
}

/**
 * Cross-reference ids THIS PR adds ({@link addedIdsAtHead}) against every OTHER open PR's mention
 * surface (title + body + head ref) — the OTHER half of Q3 {@link resolveBaseDeclaredIds}'s own
 * doc names as out of its reach: not just "does main already declare this id" but "has another
 * still-open PR already claimed it". MEASURED at filing (W1-T2324's rationale): of 4 open PRs
 * adding a plan id, exactly one collided with main and ZERO collided with another open PR — so
 * this check is expected to stay silent on a healthy board and fire only on the genuine defect
 * class it exists for.
 *
 * `ownHeadRef` EXCLUDES this PR's own row — otherwise every added id would trivially "collide"
 * with itself, since this branch's own title/body/branch name is exactly what mentions the id it
 * is adding. An `ownHeadRef` this cannot resolve (`undefined`) excludes nothing, which is the
 * FAIL-OPEN direction for the exclusion (a missed self-exclusion could only ever flag a PR's own
 * id against itself, which {@link main} would report as a false collision an author notices
 * immediately — never a silent miss of a REAL cross-PR collision).
 */
export function evaluateOpenPrIdCollisions(addedIds, openPrRows, ownHeadRef) {
  const others = openPrRows.filter((r) => (r.head && r.head.ref) !== ownHeadRef);
  const collisions = [];
  for (const id of addedIds) {
    const claimants = others.filter((r) => mentionedIds([r.title, r.body, r.head && r.head.ref].filter(Boolean).join("\n")).has(id));
    if (claimants.length > 0) collisions.push({ id, prs: claimants.map((r) => ({ number: r.number, url: r.html_url })) });
  }
  collisions.sort((a, b) => a.id.localeCompare(b.id));
  return collisions;
}

/**
 * Ids the working tree declares MORE THAN ONCE — two differently-named shards carrying one id, the
 * shape git merges cleanly and `loadPlan` then refuses on `origin/main`, taking every plan-reading
 * verb with it.
 *
 * DETECTION IS A DUPLICATE AT HEAD AND NEEDS NO BASE READ. `base` only ATTRIBUTES: an id the base
 * already declares is one this PR re-issued, which is the sentence an author needs. An unreadable
 * base therefore costs the attribution and never the refusal — deliberately, because the alternative
 * (treat an unreadable base as empty) is the exact false zero this gate exists to stop.
 *
 * ADDED IS A SET DIFFERENCE, NEVER A PER-FILE SCAN. Measured while retrofitting: reading every
 * `- id:` out of each plan file a PR merely TOUCHED reports 232 "added" ids for an open PR that
 * edits the monolith and adds none — every one a false collision. A PR that only CITES an existing
 * id declares nothing new and stays silent, which is what this gate already did and must keep doing.
 */
export function evaluateAddedIdCollisions(occurrencesById, base) {
  if (!base.readable) return { refused: true, unreadableBase: true, collisions: [] };
  const collisions = [];
  for (const [id, occurrences] of occurrencesById) {
    const headFiles = [...new Set(occurrences.map((o) => o.file))];
    // (a) the same id declared from two files IN THIS TREE.
    // (b) the same id declared from a file the BASE does not declare it in, while the base declares
    //     it elsewhere — the shape a branch that is BEHIND main produces, and the one every 2026-08-26
    //     collision took: locally each id appears once, so a head-only duplicate scan sees nothing.
    const baseFiles = base.byId.get(id);
    const reissued = baseFiles ? headFiles.filter((f) => !baseFiles.has(f)) : [];
    if (headFiles.length < 2 && reissued.length === 0) continue;
    collisions.push({ id, headFiles, baseFiles: baseFiles ? [...baseFiles] : [], occurrences });
  }
  collisions.sort((a, b) => a.id.localeCompare(b.id));
  return { refused: collisions.length > 0, unreadableBase: false, collisions };
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

/**
 * EXPORTED for the same reason the thirteen functions above are: this script is a plain `.mjs`
 * and its own suite covers error/degradation arms by importing them, because a subprocess's
 * coverage is not the parent run's (test/task-id-existence-check.test.ts says so in as many
 * words). The open-PR half's wiring below lives HERE rather than in an exported helper, so
 * without this export those lines are reachable only by a subprocess and therefore uncoverable.
 *
 * Behaviour is unchanged: the direct-execution guard at the bottom of this file still decides
 * whether `main` runs on `node scripts/task-id-existence-check.mjs`, and an importing caller must
 * invoke it deliberately. It communicates through `process.exitCode`, so an in-process caller is
 * responsible for saving and restoring that — see the test.
 */
export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", multiple: true },
      "plan-tasks-file": { type: "string", default: "plan/tasks.yaml" },
      "plan-tasks-dir": { type: "string", default: "plan/tasks.d" },
      baseline: { type: "string", default: "scripts/task-id-existence-baseline.json" },
      remote: { type: "string", default: "origin" },
      base: { type: "string" },
      cwd: { type: "string" },
      // W1-T2324 (Q3, open-vs-open half) — all three OPTIONAL and best-effort: `owner`/`repo`
      // default to parsing `remote`'s url (works offline, no `gh` needed for this half alone);
      // `head-ref` defaults to `GITHUB_HEAD_REF` (set by GitHub Actions on `pull_request`, where
      // `git rev-parse --abbrev-ref HEAD` reads a useless "HEAD" — the checkout is detached) and
      // then to the local branch name. None is required: an unresolved owner/repo or an
      // unreachable `gh` degrades this ONE half to a stated SKIP (see `main` below), never fails
      // the base-collision check above it closed on a network blip.
      owner: { type: "string" },
      repo: { type: "string" },
      "head-ref": { type: "string" },
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

  // W1-T2324 (Q3 half): an ADDED id that already exists is refused BEFORE the merge. git merges two
  // differently-named shards carrying one id with no conflict, `lint-plan` only notices afterwards at
  // exit 2, and `loadPlan` then refuses origin/main and takes every plan-reading verb with it.
  const occurrencesById = scanDeclaredPlanIdOccurrences(cwd, {
    planTasksFile: values["plan-tasks-file"],
    planTasksDir: values["plan-tasks-dir"],
  });
  // OPT-IN VIA `--base`, AND THE DEFAULT IS ANNOUNCED, NEVER SILENT. Failing closed on an
  // unreadable base is right when a base was ASKED for and wrong as a default: every existing
  // invocation drives this CLI against a scratch repo with no `origin/main`, and defaulting the
  // refusal on regressed three of them. CI passes `--base origin/main` (with `fetch-depth: 0`, or
  // the ref is absent and this refuses).
  if (values.base === undefined) {
    console.log(
      "task-id-existence: collision check SKIPPED -- no --base given, so no id was compared against " +
        "a base. Pass --base origin/main to enable it.",
    );
  }
  // Resolved ONCE and reused below by the open-vs-open half — `resolveBaseDeclaredIds` shells
  // `git grep` + one `git show` per matched file, and the open-vs-open check needs the exact same
  // base read `evaluateAddedIdCollisions` already took.
  const base = values.base === undefined ? undefined : resolveBaseDeclaredIds(values.base, cwd);
  const collisionVerdict =
    base === undefined ? { refused: false, unreadableBase: false, collisions: [] } : evaluateAddedIdCollisions(occurrencesById, base);
  if (collisionVerdict.unreadableBase) {
    console.error(
      `task-id-existence: FAILED -- could not read declared plan ids at base "${values.base}". This ` +
        `REFUSES rather than passing: an unreadable surface read as an empty one is the false zero ` +
        `that produced every id collision on 2026-08-26. Fetch the base (\`git fetch origin main\`, ` +
        `or \`fetch-depth: 0\` in CI) and re-run.`,
    );
    process.exitCode = 1;
  } else if (collisionVerdict.refused) {
    console.error("\ntask-id-existence: FAILED -- the following id(s) are ALREADY DECLARED:\n");
    for (const c of collisionVerdict.collisions) {
      const who = c.baseFiles.length
        ? `-- the base declares it in ${c.baseFiles.join(", ")}, so this change RE-ISSUED it`
        : "-- declared from two files within this change";
      console.error(`  ${c.id} ${who}`);
      for (const occ of c.occurrences) console.error(`    ${occ.file}:${occ.line}`);
    }
    console.error(
      "\nRenumber to a fresh reserved id. Two shards carrying one id merge with NO git conflict, and " +
        "`loadPlan` then refuses origin/main -- seven historical repairs exist with subjects like " +
        '"a duplicate id made the plan unreadable".\n',
    );
    process.exitCode = 1;
  }

  // W1-T2324 (Q3, open-vs-open half) — the collision class `resolveBaseDeclaredIds` cannot see:
  // an id claimed only by ANOTHER still-open PR, not yet on main. Runs ONLY when the base itself
  // was readable (an unreadable base already refused above; piling a second, less certain check
  // on top of that would just be noise) and only when this branch actually adds an id (nothing to
  // cross-reference otherwise). Every failure mode here is a STATED SKIP, never a silent pass
  // dressed up as a check that ran — an operator reading the log sees exactly which half of Q3
  // executed.
  if (base !== undefined && base.readable) {
    const added = addedIdsAtHead(occurrencesById, base);
    if (added.ids.length > 0) {
      const ownerRepo = values.owner && values.repo ? { owner: values.owner, repo: values.repo } : resolveOwnerRepoFromGit(values.remote, cwd);
      if (ownerRepo === undefined) {
        console.log(
          `task-id-existence: open-PR collision check SKIPPED -- could not resolve owner/repo from remote ` +
            `"${values.remote}"'s url. Pass --owner/--repo to enable it.`,
        );
      } else {
        const ownHeadRef = values["head-ref"] ?? process.env.GITHUB_HEAD_REF ?? currentBranch(cwd);
        const openPrs = fetchOpenPrRows(ownerRepo.owner, ownerRepo.repo, cwd);
        if (!openPrs.reachable) {
          console.log(
            `task-id-existence: open-PR collision check SKIPPED -- could not read the open-PR list for ` +
              `${ownerRepo.owner}/${ownerRepo.repo} (network blip, or \`gh\` has no credentials in this ` +
              `environment). An id claimed only by another still-open PR cannot be checked until this ` +
              "read succeeds; the base-collision check above already ran and is unaffected.",
          );
        } else {
          const openPrCollisions = evaluateOpenPrIdCollisions(added.ids, openPrs.rows, ownHeadRef);
          if (openPrCollisions.length > 0) {
            console.error("\ntask-id-existence: FAILED -- the following added id(s) are ALREADY CLAIMED by another OPEN PR:\n");
            for (const c of openPrCollisions) {
              console.error(`  ${c.id} -- claimed by ${c.prs.map((p) => p.url || `#${p.number}`).join(", ")}`);
            }
            console.error(
              "\nRenumber to a fresh reserved id. Whichever of the two PRs merges first leaves the other " +
                "carrying a duplicate id that merges with NO git conflict, exactly like the main-collision " +
                "case above.\n",
            );
            process.exitCode = 1;
          }
        }
      }
    }
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

  // W1-T2324: never CLEAR a refusal the collision check already set. `process.exitCode = 0` here
  // silently overwrote it — the existence half and the collision half are independent verdicts and
  // either one failing is a failure.
  if (process.exitCode) return;
  console.log(
    `\ntask-id-existence: OK -- every id cited under ${dirs.join(", ")} resolves to a reservation or a ` +
      `plan record (${baselined.length} baselined, ${unknown.length} unknown)` +
      (values.base === undefined ? "." : `, and no declared id collides with "${values.base}".`),
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/task-id-existence-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
