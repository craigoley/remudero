#!/usr/bin/env node
// scripts/task-id-existence-check.mjs
//
// TASK-ID EXISTENCE gate (W1-T1048). Every `W1-T<n>` cited under `src/` or `deploy/` must resolve
// to a reservation ref (`refs/rmd-id/W1-T<n>` on the remote) or a declared plan record (`- id:` in
// plan/tasks.yaml or plan/tasks.d/*.yaml). Either alone is a valid claim.
//
// INVARIANT: this checks EXISTENCE, never ownership -- citing an id in shipped source is normal
// and never itself forbidden, only citing one that resolves nowhere is. `test/` is excluded by
// construction (scan roots default to `src`, `deploy`): its fixture ids are synthetic, never real.
// Why: #2251 shipped an id neither reserved nor declared; nothing caught it until an open PR
// needed renumbering. docs/forensics/task-id-existence-check.md#module-header.
//
// A written baseline (scripts/task-id-existence-baseline.json) exempts ids that predate the
// reservation allocator or the plan schema; an entry with no reason is REJECTED. READ-ONLY: shells
// `git ls-remote`/`gh api` and reads files, never writes a ref or mints an id; an unreachable
// remote degrades an unresolved id to a stated UNKNOWN, never a hard failure.
//
// Usage: node scripts/task-id-existence-check.mjs [--dir <path>]... [--plan-tasks-file <path>]
//   [--plan-tasks-dir <path>] [--baseline <path>] [--remote <name>] [--base <ref>] [--cwd <path>]
//   [--owner <name>] [--repo <name>] [--head-ref <ref>] [--require-open-prs]. Defaults: src,deploy; plan/tasks.yaml; plan/tasks.d; origin.
//
// Exported pure pieces let the fixture test drive each surface independently; main is exported so
// the CLI itself (spawn + exit code) can be proved too.

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { join, relative } from "node:path";
import { git } from "./lib/git.mjs";

const TASK_ID_RE = /\bW1-T[0-9]+\b/g;
// DECLARED_ID_LINE_RE matches the WHOLE line after `- id:` (`^...$`, not a character class), so a
// lettered suffix (W1-T1B) or another workstream (W3-T3) is captured, never mismatched to W1-T1.
// Why: the old numeric-only form silently DROPPED such ids from the collision check.
// docs/forensics/task-id-existence-check.md#declared_id_line_re.
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
 * Scan `dirs` (resolved against `cwd`) for every `W1-T<n>` token, returning id -> the list of
 * `{ file, line }` occurrences (file relative to `cwd`), so a failure reports a concrete pointer.
 * Read-only.
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
 * Every id declared via `- id: W1-T<n>` in `planTasksFile` and any `*.yaml`/`*.yml` under
 * `planTasksDir` (both resolved against `cwd`). A declared id is a valid claim on its own.
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

/** Every id holding a `refs/rmd-id/W1-T*` reservation ref on `remote`, via `git ls-remote` (a
 *  READ). `reachable: false` means the read failed -- treat as a STATED UNKNOWN, never "nothing
 *  reserved". `remote` may be a local/bare path, for offline fixture tests. */
export function resolveReservedIds(remote, cwd) {
  const result = git(["ls-remote", remote, "refs/rmd-id/W1-T*"], { cwd });
  if (result.error || result.status !== 0) {
    return { reachable: false, ids: new Set(), holders: new Map() };
  }
  const ids = new Set();
  const holders = new Map();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    const ref = tab === -1 ? "" : trimmed.slice(tab + 1);
    const m = /^refs\/rmd-id\/(W1-T[0-9]+)$/.exec(ref);
    if (!m) continue;
    ids.add(m[1]);
    holders.set(m[1], readReservationHolder(remote, cwd, ref));
  }
  return { reachable: true, ids, holders };
}

function decodeHolderValue(raw) {
  return decodeURIComponent(raw.replace(/\+/g, "%20"));
}

export function parseReservationHolderLine(message) {
  const line = message.split(/\r?\n/).find((l) => l.startsWith("rmd-id holder "));
  if (!line) return { status: "legacy" };
  const values = new Map();
  for (const token of line.slice("rmd-id holder ".length).trim().split(/[ \t]+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 1) return { status: "unreadable", reason: `malformed token ${token}` };
    try {
      values.set(token.slice(0, eq), decodeHolderValue(token.slice(eq + 1)));
    } catch {
      return { status: "unreadable", reason: `malformed value for ${token.slice(0, eq)}` };
    }
  }
  const branch = values.get("branch");
  if (!branch || branch === "unknown") return { status: "unreadable", reason: "missing branch" };
  return { status: "known", branch };
}

function readReservationHolder(remote, cwd, ref) {
  const fetched = git(["fetch", remote, ref], { cwd });
  if (fetched.error || fetched.status !== 0) return { status: "unreadable", reason: `could not fetch ${ref}` };
  const body = git(["log", "-1", "--format=%B", "FETCH_HEAD"], { cwd });
  if (body.error || body.status !== 0) return { status: "unreadable", reason: `could not read ${ref}` };
  return parseReservationHolderLine(body.stdout ?? "");
}

export function shardNoteRecordsReservationHandoff(text, holderBranch, filerBranch) {
  const clean = (s) => s.trim().replace(/^['"]|['"]$/g, "");
  for (const raw of text.split(/\r?\n/)) {
    const m = /reservation hand-?off:\s*(.*?)\s*->\s*(.*?)\s*$/i.exec(raw.trim());
    if (m && clean(m[1]) === holderBranch && clean(m[2]) === filerBranch) return true;
  }
  return false;
}

function occurrenceFiles(occurrences) {
  return [...new Set(occurrences.map((o) => o.file))];
}

function hasRecordedHandoff(cwd, occurrences, holderBranch, filerBranch) {
  for (const file of occurrenceFiles(occurrences)) {
    let text;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    if (shardNoteRecordsReservationHandoff(text, holderBranch, filerBranch)) return true;
  }
  return false;
}

export function evaluateReservationHolderConflicts(addedIds, occurrencesById, reservation, filerBranch, cwd) {
  const conflicts = [];
  if (!reservation.reachable || !filerBranch) return conflicts;
  for (const id of addedIds) {
    if (!reservation.ids.has(id)) continue;
    const holder = reservation.holders?.get(id) ?? { status: "legacy" };
    if (holder.status === "legacy") continue;
    const occurrences = occurrencesById.get(id) ?? [];
    if (holder.status === "unreadable") {
      conflicts.push({ id, reason: holder.reason, holderBranch: undefined, occurrences });
      continue;
    }
    if (holder.branch === filerBranch) continue;
    if (hasRecordedHandoff(cwd, occurrences, holder.branch, filerBranch)) continue;
    conflicts.push({ id, reason: "holder differs", holderBranch: holder.branch, filerBranch, occurrences });
  }
  conflicts.sort((a, b) => a.id.localeCompare(b.id));
  return conflicts;
}

/** Every plan file that DECLARES each id, keyed by id -- the multiplicity {@link scanDeclaredPlanIds}'s
 *  Set discards, and the whole signal this gate needs. */
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

/** Ids DECLARED in the plan at `baseRef` (`origin/main` AT CHECK TIME, never the merge-base, which
 *  can miss an id landed after the branch was cut), keyed to the declaring files -- same file both
 *  sides is a carried-along shard, different a re-issue. `readable: false` is the read FAILING,
 *  never "declares nothing" (W1-T2316). docs/forensics/task-id-existence-check.md#resolvebasedeclaredids. */
export function resolveBaseDeclaredIds(baseRef, cwd) {
  const result = git(
    ["grep", "-lE", "^[[:space:]]*-[[:space:]]*id:[[:space:]]*W[0-9]+-T[0-9]+", baseRef, "--", "plan/tasks.yaml", "plan/tasks.d/"],
    { cwd },
  );
  // git grep exits 1 for "ref resolved, no matches" — a real answer. 128 (bad revision) is not.
  if (result.error || (result.status !== 0 && result.status !== 1)) return { readable: false, byId: new Map() };
  const byId = new Map();
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const file = line.startsWith(`${baseRef}:`) ? line.slice(baseRef.length + 1) : line;
    const show = git(["show", `${baseRef}:${file}`], { cwd });
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

/** owner/repo, parsed from `remote`'s url at `cwd`, mirroring src/lib/repo-location.ts. Duplicated,
 *  not imported: a plain `.mjs` outside tsconfig's build. `undefined` on an unparsable/unreadable
 *  url -- never guessed, which would send the open-PR read below to the wrong repo. */
export function resolveOwnerRepoFromGit(remote, cwd) {
  const result = git(["config", "--get", `remote.${remote}.url`], { cwd });
  if (result.error || result.status !== 0) return undefined;
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(result.stdout.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** The checked-out branch at `cwd`, or `undefined` on a detached HEAD (a PR checkout in CI) --
 *  callers prefer `--head-ref`/`GITHUB_HEAD_REF` first for exactly that reason. */
export function currentBranch(cwd) {
  const result = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (result.error || result.status !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch === "" || branch === "HEAD" ? undefined : branch;
}

/** Every OPEN PR's number, url, head ref and mentionable text, via REST (never `gh pr list --json`
 *  / GraphQL) -- same discriminator as the mint's own `openPrMintTexts`. `reachable: false` covers
 *  `gh` failing or an unparsable response; degrades to a STATED SKIP, never a silent pass.
 *  Why: W1-T3055 gave CI's job a `GH_TOKEN`. docs/forensics/task-id-existence-check.md#fetchopenprrows. */
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

/** Any `W1-T<n>` mention in free text, mirroring `lib/task-id.ts`'s `mentionedTaskIds`. Loose by
 *  design: over-counting only refuses an innocent PR; under-counting could merge a real collision. */
const MENTION_RE = /\bW1-T[0-9]+\b/g;
function mentionedIds(text) {
  const ids = new Set();
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) ids.add(m[0]);
  return ids;
}

/** Ids THIS branch ADDS relative to `base`, for the open-vs-open check's claim set -- a file
 *  unchanged from `base` is a carried-along shard, not an add. `base.readable === false` propagates
 *  as `{ readable: false, ids: [] }` rather than guessing an empty set. */
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

export const OPEN_PR_SURFACE_FAILURES = ["owner-repo", "open-pr-list", "no-base"];

/** Unreadable open-PR surface: SKIP when best-effort (text byte-identical to before), REFUSE when `required`. Why: W1-T3055, docs/forensics/task-id-existence-check.md#the-half-that-never-ran. */
export function classifyUnreadableOpenPrSurface(kind, ctx, required) {
  const what =
    kind === "owner-repo"
      ? `could not resolve owner/repo from remote "${ctx.remote}"'s url`
      : kind === "no-base"
        ? "no readable base was given, so no added-id set could be computed"
        : `could not read the open-PR list for ${ctx.owner}/${ctx.repo} (network blip, or \`gh\` has ` +
          "no credentials in this environment)";
  if (required !== true) {
    const tail =
      kind === "owner-repo"
        ? ". Pass --owner/--repo to enable it."
        : kind === "no-base"
          ? ". Pass --base origin/main to enable it."
          : ". An id claimed only by another still-open PR cannot be checked until this read " +
            "succeeds; the base-collision check above already ran and is unaffected.";
    return { refuse: false, message: `task-id-existence: open-PR collision check SKIPPED -- ${what}${tail}` };
  }
  return {
    refuse: true,
    message:
      `task-id-existence: FAILED -- the open-PR collision check was REQUIRED (--require-open-prs) ` +
      `but ${what}. REFUSING rather than reporting OK: an unreadable surface rendered as a clean ` +
      `one is exactly how this check ran green and mute on every pull request from the day it ` +
      `shipped. In CI the credentials are present by construction, so this is an anomaly to fix, ` +
      `not a condition to pass through -- check that the step passes \`GH_TOKEN\` and that the ` +
      `token can read pull requests. An id claimed only by another still-open PR is invisible ` +
      `until this read succeeds.`,
  };
}

/**
 * Cross-reference ids THIS PR adds against every OTHER open PR's mention surface (title+body+head
 * ref) -- the open-vs-open half {@link resolveBaseDeclaredIds} cannot see. `ownHeadRef` excludes
 * this PR's own row (unresolvable = excludes nothing, fail-open: a missed exclusion only self-flags).
 * Why: W1-T2324 (Q3). docs/forensics/task-id-existence-check.md#evaluateopenpridcollisions.
 */
/** The two plan surfaces a shard can be declared in -- the same pair `resolveBaseDeclaredIds`
 *  greps: a path this misses is a declaration read as a mention. */
const PLAN_DECLARING_PATH_RE = /^plan\/tasks\.yaml$|^plan\/tasks\.d\/[^/]+\.ya?ml$/;

/** One page only. A list AT the cap may be truncated, and a truncated list under-reports
 *  declarations -- the direction that turns a real collision into a pass -- so it reads unreadable. */
export const PR_FILES_PAGE_CAP = 100;

/**
 * Ids a PR actually DECLARES, read from its changed-file rows -- the authority that settles what a
 * bare mention only suspects. `readable: false` is the read FAILING, never "declares nothing":
 * reading an uninterpretable shape as an empty declaration is the false zero this gate refuses
 * (W1-T2316). A NON-PLAN file is IGNORED rather than unreadable -- it cannot declare an id at
 * all, and that distinction is what clears a build PR touching only src/ and test/.
 */
export function prDeclaredIdsFromFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { readable: false, ids: new Set() };
  if (files.length >= PR_FILES_PAGE_CAP) return { readable: false, ids: new Set() };
  const ids = new Set();
  let readable = true;
  for (const f of files) {
    const name = f && typeof f === "object" && typeof f.filename === "string" ? f.filename : undefined;
    if (name === undefined) {
      readable = false; // not a file row at all -- the shape is unrecognised, so nothing is concluded
      continue;
    }
    if (!PLAN_DECLARING_PATH_RE.test(name)) continue;
    if (typeof f.patch !== "string") {
      readable = false; // a plan file changed and the diff is withheld -- the one case that must refuse
      continue;
    }
    for (const line of f.patch.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const m = DECLARED_ID_LINE_RE.exec(line.slice(1));
      if (m) ids.add(m[1]);
    }
  }
  return { readable, ids };
}

/** One page of a PR's changed files. Mirrors `fetchOpenPrRows`: every failure folds to
 *  `readable: false`, which the caller turns into a KEPT refusal, never a pass. */
export function fetchPrChangedFiles(owner, repo, number, cwd) {
  const result = spawnSync("gh", ["api", `repos/${owner}/${repo}/pulls/${number}/files?per_page=${PR_FILES_PAGE_CAP}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return { readable: false, files: [] };
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return { readable: false, files: [] };
  }
  if (!Array.isArray(rows)) return { readable: false, files: [] };
  return { readable: true, files: rows };
}

/**
 * W1-T3070: A MENTION IS A SUSPICION, NOT A CLAIM.
 *
 * The scan below stays loose as a cheap PREFILTER, but it cannot tell a rival worker from THIS
 * TASK'S OWN SIBLING: `uniqueRunBranch` names every build branch `run-<runId>-*`, so the build PR
 * mentions the id its filing declares, by construction, on every task following standing rule 15
 * (65 of the last 100 closed PRs carry such a head ref, measured 2026-09-07). So a suspect is
 * CONFIRMED against `confirmDeclares`, and the asymmetry is ONE-WAY: only POSITIVE evidence of no
 * declaration clears, while an unreadable answer keeps the refusal. OMITTING `confirmDeclares`
 * leaves the original behaviour -- how W1-T2324's arms drive it, never reaching the network.
 */
export function evaluateOpenPrIdCollisions(addedIds, openPrRows, ownHeadRef, confirmDeclares) {
  const others = openPrRows.filter((r) => (r.head && r.head.ref) !== ownHeadRef);
  const collisions = [];
  for (const id of addedIds) {
    const suspects = others.filter((r) => mentionedIds([r.title, r.body, r.head && r.head.ref].filter(Boolean).join("\n")).has(id));
    const claimants =
      confirmDeclares === undefined
        ? suspects
        : suspects.filter((r) => {
            const seen = confirmDeclares(r, id);
            return !seen || seen.readable !== true || seen.ids.has(id);
          });
    if (claimants.length > 0) collisions.push({ id, prs: claimants.map((r) => ({ number: r.number, url: r.html_url })) });
  }
  collisions.sort((a, b) => a.id.localeCompare(b.id));
  return collisions;
}

/**
 * Ids the working tree declares MORE THAN ONCE -- two differently-named shards carrying one id,
 * which git merges cleanly and `loadPlan` then refuses on. Detection is a duplicate at HEAD alone;
 * `base` only attributes (a re-issue), so an unreadable base costs that, never the refusal. ADDED
 * is a SET DIFFERENCE, never a per-file scan: citing an existing id must stay silent.
 * Why: a per-file scan reported 232 false collisions. docs/forensics/task-id-existence-check.md#evaluateaddedidcollisions.
 */
export function evaluateAddedIdCollisions(occurrencesById, base) {
  if (!base.readable) return { refused: true, unreadableBase: true, collisions: [] };
  const collisions = [];
  for (const [id, occurrences] of occurrencesById) {
    const headFiles = [...new Set(occurrences.map((o) => o.file))];
    // Two files in this tree, or a file the base doesn't have it in while the base has it
    // elsewhere (a behind-main branch, where each id appears once locally).
    const baseFiles = base.byId.get(id);
    const reissued = baseFiles ? headFiles.filter((f) => !baseFiles.has(f)) : [];
    if (headFiles.length < 2 && reissued.length === 0) continue;
    collisions.push({ id, headFiles, baseFiles: baseFiles ? [...baseFiles] : [], occurrences });
  }
  collisions.sort((a, b) => a.id.localeCompare(b.id));
  return { refused: collisions.length > 0, unreadableBase: false, collisions };
}

/** Parse+validate scripts/task-id-existence-baseline.json into a Map from id to its written
 *  reason. THROWS on a structurally invalid file or any entry missing a non-empty `reason` --
 *  a silently-growable exemption is exactly what this gate exists to prevent for itself. */
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
 * Pure decision layer: classify every cited id as "resolved" (declared or reserved), "baselined"
 * (a written exemption), "unknown" (unresolved, but the reservation read was unreachable, so it
 * cannot be told apart from a real reservation) or "failed" (unresolved, no exemption, reachable).
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
 * Exported so its own suite can cover error/degradation arms in-process -- a subprocess's coverage
 * is not the parent run's, and the open-PR wiring lives here so it stays reachable that way.
 * Unchanged behaviour: the direct-execution guard at file end decides whether `main` runs, and it
 * communicates via `process.exitCode`, so an in-process caller must save and restore it.
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
      "require-open-prs": { type: "boolean", default: false },
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

  // W1-T2324 (Q3): an added id that already exists is refused BEFORE the merge -- git merges two
  // differently-named shards with no conflict, and `loadPlan` then refuses origin/main.
  const occurrencesById = scanDeclaredPlanIdOccurrences(cwd, {
    planTasksFile: values["plan-tasks-file"],
    planTasksDir: values["plan-tasks-dir"],
  });
  // Opt-in via --base, announced never silent: most invocations run with no origin/main, so
  // defaulting to fail-closed regressed them. CI passes --base origin/main with fetch-depth: 0.
  if (values.base === undefined) {
    console.log(
      "task-id-existence: collision check SKIPPED -- no --base given, so no id was compared against " +
        "a base. Pass --base origin/main to enable it.",
    );
  }
  // Resolved once and reused below by the open-vs-open half, which needs the same base read.
  const base = values.base === undefined ? undefined : resolveBaseDeclaredIds(values.base, cwd);
  const collisionVerdict =
    base === undefined ? { refused: false, unreadableBase: false, collisions: [] } : evaluateAddedIdCollisions(occurrencesById, base);
  const addedAtHead = base === undefined || !base.readable ? { readable: false, ids: [] } : addedIdsAtHead(occurrencesById, base);
  const ownHeadRef = values["head-ref"] ?? process.env.GITHUB_HEAD_REF ?? currentBranch(cwd);
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

  const holderConflicts = evaluateReservationHolderConflicts(addedAtHead.ids, occurrencesById, reservation, ownHeadRef, cwd);
  if (holderConflicts.length > 0) {
    console.error("\ntask-id-existence: FAILED -- the following added id(s) are HELD by a different reservation holder:\n");
    for (const c of holderConflicts) {
      const holder = c.holderBranch
        ? `reserved by ${c.holderBranch}, while this filing is ${c.filerBranch}`
        : `holder unreadable (${c.reason})`;
      console.error(`  ${c.id} -- ${holder}`);
      for (const occ of c.occurrences) console.error(`    ${occ.file}:${occ.line}`);
    }
    console.error(
      "\nRenumber to a fresh reserved id, or record the operator hand-off in the shard note as " +
        "`reservation hand-off: <holder> -> <filer>`.\n",
    );
    process.exitCode = 1;
  }

  // W1-T2324 (Q3, open-vs-open): what resolveBaseDeclaredIds cannot see -- another still-open PR
  // already claiming the id. Runs only when base was readable and this branch adds one.
  const requireOpenPrs = values["require-open-prs"] === true;
  const reportUnreadable = (kind, ctx) => {
    const verdict = classifyUnreadableOpenPrSurface(kind, ctx, requireOpenPrs);
    if (verdict.refuse) {
      console.error(verdict.message);
      process.exitCode = 1;
    } else {
      console.log(verdict.message);
    }
  };

  if (base === undefined || !base.readable) {
    reportUnreadable("no-base", {});
  } else {
    if (addedAtHead.ids.length > 0) {
      const ownerRepo = values.owner && values.repo ? { owner: values.owner, repo: values.repo } : resolveOwnerRepoFromGit(values.remote, cwd);
      if (ownerRepo === undefined) {
        reportUnreadable("owner-repo", { remote: values.remote });
      } else {
        const openPrs = fetchOpenPrRows(ownerRepo.owner, ownerRepo.repo, cwd);
        if (!openPrs.reachable) {
          reportUnreadable("open-pr-list", { owner: ownerRepo.owner, repo: ownerRepo.repo });
        } else {
          // One files read per SUSPECTED claimant, memoised by number. The verdict is ANNOUNCED, so
          // a wrong exemption is visible in the log, not a gate that quietly stopped biting.
          const declaredCache = new Map();
          const confirmDeclares = (row, id) => {
            if (!declaredCache.has(row.number)) {
              const fetched = fetchPrChangedFiles(ownerRepo.owner, ownerRepo.repo, row.number, cwd);
              declaredCache.set(row.number, fetched.readable ? prDeclaredIdsFromFiles(fetched.files) : { readable: false, ids: new Set() });
            }
            const seen = declaredCache.get(row.number);
            if (!seen.readable) {
              console.log(
                `task-id-existence: could not read PR #${row.number}'s changed files, so its mention of ${id} is treated as a claim -- an unreadable surface is never read as an empty one.`,
              );
            } else if (!seen.ids.has(id)) {
              console.log(
                `task-id-existence: PR #${row.number} mentions ${id} but declares no plan record for it ` +
                  `(W1-T3070: a build PR named run-${id}-* is its filing's sibling, not a rival claimant) -- CLEARED.`,
              );
            }
            return seen;
          };
          const openPrCollisions = evaluateOpenPrIdCollisions(addedAtHead.ids, openPrs.rows, ownHeadRef, confirmDeclares);
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
    // The third exit: a doc EXAMPLE reads identically to a real claim -- a code span doesn't help.
    // Why: docs/forensics/task-id-existence-check.md#third-exit-comment-main.
    console.error(
      "\nIf it is an EXAMPLE rather than a claim, use the placeholder form instead: W1-T<n> (also " +
        "W1-T<id>, W1-TNNNN). Backticks and fenced blocks do NOT help -- the id extractor reads a " +
        "literal the same inside them as outside. The placeholder forms carry no digits, so neither " +
        "the mint's mention scan nor the plan-history scan can see them.",
    );
    process.exitCode = 1;
    return;
  }

  // Never CLEAR a refusal the collision check already set: existence and collision are
  // independent verdicts, either failing is a failure.
  if (process.exitCode) return;
  console.log(
    `\ntask-id-existence: OK -- every id cited under ${dirs.join(", ")} resolves to a reservation or a ` +
      `plan record (${baselined.length} baselined, ${unknown.length} unknown)` +
      (values.base === undefined ? "." : `, and no declared id collides with "${values.base}".`),
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/task-id-existence-check.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
