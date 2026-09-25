import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec, Outcome } from "./gardener.js";
import { adoptionLatestPath, readAdoptionLatest } from "./measurement-cadence.js";

/**
 * lib/export-gardener.ts (W1-T4117) — dead exports are pruned.
 *
 * The adoption scan (measurement-cadence.ts, shape `symbol-no-caller`) reports every `src/lib/`
 * export nothing calls, and its proposals retire themselves when a finding clears — but nothing
 * ever deleted one. This gardener has ONE class, DELETE-UNREFERENCED-EXPORT:
 *   - an export the scan reported in at least {@link EXPORT_GARDEN_SIGHTINGS} scans in a row,
 *   - whose name `git grep` finds NOWHERE outside its own declaration and comment — no string
 *     lookup, no registry, no test, no use in its own file (the scan reads calls only, and skips the
 *     defining file, so this check is what stands between a registry-named export and its deletion),
 *   - is deleted, at most {@link EXPORT_GARDEN_BATCH} to a pass, as one PR. The revert is the undo.
 * Deleting code is riskier than the other gardens' edits, so the class is judged on its metric,
 * not on a merge alone: CI must pass for the PR to merge (a closed PR debits the class), and each
 * later scan counts every landed deletion that is still deleted against every export still dead. A
 * deletion re-added within {@link EXPORT_GARDEN_WINDOW_DAYS} days — a revert, or the export written
 * back — is a failure, and that export is never proposed again.
 */

export type ExportGardenClass = "delete-unreferenced-export";
export const EXPORT_GARDEN_CLASSES: readonly ExportGardenClass[] = ["delete-unreferenced-export"];

/** PRIMARY CONTROL — the most exports one PR deletes. Small, so a PR stays reviewable and a bad
 *  deletion reverts without taking good ones with it; the backlog drains a batch per judged PR. */
export const EXPORT_GARDEN_BATCH = 5;

/** PRIMARY CONTROL — scans in a row that must report an export before it is deleted. One scan can
 *  catch an export mid-adoption (its caller in a PR not yet merged); two in a row cannot. */
export const EXPORT_GARDEN_SIGHTINGS = 2;

/** PRIMARY CONTROL — how long after landing a deletion is watched for a re-add, and how long an
 *  unlanded deletion waits for its PR before it is read as declined. */
export const EXPORT_GARDEN_WINDOW_DAYS = 14;

/** Longest declaration the span finder will delete; past it the export is left for a person. */
const MAX_DECLARATION_LINES = 400;

export interface ExportGardenAction extends GardenAction<ExportGardenClass> {
  /** The adoption proposal id: `adoption:symbol-no-caller:<file>:<name>`. */
  id: string;
  file: string;
  name: string;
  /** The scan that made it a candidate, recorded as when its deletion was proposed. */
  scannedAt: string;
}

export interface ExportDeletion {
  id: string;
  file: string;
  name: string;
  proposedAt: string;
  /** The first scan that found the export gone from the checkout — its PR merged. */
  landedAt?: string;
  /** Written back within the window of landing. */
  reAdded?: boolean;
  /** Never landed within the window: its PR was closed or never opened. */
  declined?: boolean;
}

/** The gardener's own memory, beside its framework state: what each scan reported, what it deleted,
 *  and the running tally its class is judged on. */
export interface ExportGardenRecord {
  /** Proposal id → the scans (generatedAt) that reported it, in a row, newest last. */
  sightings: Record<string, string[]>;
  deletions: ExportDeletion[];
  /** Scans already folded into the tally, so a scan is counted once. */
  seen: string[];
  trials: number;
  successes: number;
}

export interface ExportInventory {
  generatedAt?: string;
  /** Unreferenced exports in the latest scan. */
  population: number;
  /** Proposal ids reported in at least {@link EXPORT_GARDEN_SIGHTINGS} scans in a row, sorted. */
  twice: string[];
  record: ExportGardenRecord;
  tally: Outcome;
}

const SYMBOL_ID_RE = /^adoption:symbol-no-caller:(.+):([A-Za-z_$][\w$]*)$/;
const IDENT_RE = /^[A-Za-z_][\w]*$/;

/** The file and export an adoption `symbol-no-caller` proposal id names, or undefined for any other id. */
export function parseSymbolFinding(id: string): { file: string; name: string } | undefined {
  const m = SYMBOL_ID_RE.exec(id);
  return m ? { file: m[1]!, name: m[2]! } : undefined;
}

export function exportGardenRecordPath(stateDir: string): string {
  return join(stateDir, "export-gardener-record.json");
}

const emptyRecord = (): ExportGardenRecord => ({ sightings: {}, deletions: [], seen: [], trials: 0, successes: 0 });

export function readExportGardenRecord(stateDir: string): ExportGardenRecord {
  const path = exportGardenRecordPath(stateDir);
  if (!existsSync(path)) return emptyRecord();
  try {
    return { ...emptyRecord(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ExportGardenRecord>) };
  } catch {
    // deliberate: an unreadable record restarts the sightings and the tally. That can only DELAY a
    // deletion (two fresh scans are needed again), never cause one — but it also forgets which
    // deletions were declined or re-added, so the next scan's fold rewrites the record from scratch.
    return emptyRecord();
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `name` is declared as an export in `text` — a function or const, the two shapes the scan reads. */
function exportDeclRe(name: string): RegExp {
  return new RegExp(`^export\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*${escapeRe(name)}\\s*[(<]|const\\s+${escapeRe(name)}\\s*[=:])`);
}

/** Any top-level declaration of `name`, of any kind — more than one (an overload, a merged
 *  namespace) is a shape the span finder does not delete. */
function anyDeclRe(name: string): RegExp {
  return new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class|interface|type|enum|namespace)\\s+${escapeRe(name)}\\b`);
}

export function exportDeclaredIn(root: string, file: string, name: string): boolean {
  const path = join(root, file);
  if (!existsSync(path)) return false;
  const re = exportDeclRe(name);
  return readFileSync(path, "utf8").split("\n").some((l) => re.test(l));
}

/**
 * The 0-based, inclusive line span of `name`'s exported declaration in `text`, with the comment
 * directly above it — or undefined when it cannot be read safely: not declared exactly once, no end
 * found within {@link MAX_DECLARATION_LINES}, or brackets that do not balance. The end is the first
 * line closing a statement (`;` or `}`) that is followed by a blank line, the end of the file, or a
 * new top-level statement — the shape this repo's formatter gives every declaration.
 */
export function exportDeclarationSpan(text: string, name: string): { start: number; end: number } | undefined {
  if (!IDENT_RE.test(name)) return undefined;
  const lines = text.split("\n");
  const decl = exportDeclRe(name);
  const any = anyDeclRe(name);
  const declared = lines.flatMap((l, i) => (any.test(l) ? [i] : []));
  if (declared.length !== 1 || !decl.test(lines[declared[0]!]!)) return undefined;
  const at = declared[0]!;
  let end: number | undefined;
  for (let l = at; l < Math.min(lines.length, at + MAX_DECLARATION_LINES); l++) {
    if (!/[;}]\s*$/.test(lines[l]!)) continue;
    const next = lines[l + 1];
    if (next === undefined || next.trim() === "" || /^[^\s)\]}]/.test(next)) {
      end = l;
      break;
    }
  }
  if (end === undefined) return undefined;
  let start = at;
  for (;;) {
    const above = lines[start - 1];
    if (above === undefined) break;
    if (/^\s*\/\//.test(above)) {
      start -= 1;
      continue;
    }
    if (/\*\/\s*$/.test(above)) {
      let open = start - 1;
      while (open >= 0 && !/^\s*\/\*/.test(lines[open]!)) open -= 1;
      if (open < 0) break;
      start = open;
      continue;
    }
    break;
  }
  const body = lines.slice(start, end + 1).join("\n");
  const count = (c: string) => body.split(c).length - 1;
  if (count("{") !== count("}") || count("(") !== count(")") || count("[") !== count("]")) return undefined;
  return { start, end };
}

/**
 * Every place `git grep` finds `name` as a whole word in `root`'s tracked files, outside its own
 * declaration span — code, tests, scripts, JSON registries, string lookups. Only prose (`*.md` and
 * the plan) is not read. A grep that fails is reported as a reference, so an unreadable tree keeps
 * every export.
 */
export function referencesOutside(root: string, file: string, name: string, span: { start: number; end: number }): string[] {
  const r = spawnSync("git", ["-C", root, "grep", "-n", "-w", "-F", "-I", "-e", name, "--", ".", ":(exclude)*.md", ":(exclude)plan/**"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.status === 1) return [];
  if (r.status !== 0) return [`git grep failed (${r.status ?? r.signal}): ${String(r.stderr).trim()}`];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .filter((hit) => {
      const m = /^(.*?):(\d+):/.exec(hit);
      if (!m || m[1] !== file) return true;
      const line = Number(m[2]) - 1;
      return line < span.start || line > span.end;
    });
}

/** Remove the span, and one blank line beside it so no run of blank lines is left. */
export function deleteSpan(text: string, span: { start: number; end: number }): string {
  const lines = text.split("\n");
  const blank = (k: number) => k >= 0 && k < lines.length && lines[k]!.trim() === "";
  const end = blank(span.end + 1) && (span.start === 0 || blank(span.start - 1)) ? span.end + 1 : span.end;
  lines.splice(span.start, end - span.start + 1);
  return lines.join("\n");
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * Fold a NEW scan into the record once: its sightings (an export missing from a scan starts over),
 * each deletion's fate read from the checkout, and the tally — one trial per export still dead and
 * per landed deletion, one success per landed deletion not written back.
 */
export function foldScan(record: ExportGardenRecord, scan: { generatedAt: string; proposalIds: string[] }, repoRoot: string): ExportGardenRecord {
  if (record.seen.includes(scan.generatedAt)) return record;
  const now = scan.generatedAt;
  const ids = scan.proposalIds.filter((id) => parseSymbolFinding(id));
  const sightings: Record<string, string[]> = {};
  for (const id of ids) sightings[id] = [...(record.sightings[id] ?? []).filter((t) => t !== now), now].slice(-EXPORT_GARDEN_SIGHTINGS);
  const deletions = record.deletions.map((d): ExportDeletion => {
    if (d.declined || d.reAdded) return d;
    const present = exportDeclaredIn(repoRoot, d.file, d.name);
    if (!d.landedAt) {
      if (!present) return { ...d, landedAt: now };
      return daysBetween(d.proposedAt, now) > EXPORT_GARDEN_WINDOW_DAYS ? { ...d, declined: true } : d;
    }
    return present && daysBetween(d.landedAt, now) <= EXPORT_GARDEN_WINDOW_DAYS ? { ...d, reAdded: true } : d;
  });
  const landed = deletions.filter((d) => d.landedAt);
  return {
    sightings,
    deletions,
    seen: [...record.seen, now].slice(-50),
    trials: record.trials + ids.length + landed.length,
    successes: record.successes + landed.filter((d) => !d.reAdded).length,
  };
}

export function exportInventory(repoRoot: string, stateDir: string): ExportInventory {
  const latest = readAdoptionLatest(adoptionLatestPath(stateDir));
  let record = readExportGardenRecord(stateDir);
  // A scan that observed no symbol-no-caller finding at all cannot be said to have measured the
  // shape (measurement-cadence.ts's own guard): nothing is folded from it.
  if (latest && latest.shapesObserved.includes("symbol-no-caller") && !record.seen.includes(latest.generatedAt)) {
    record = foldScan(record, latest, repoRoot);
    writeAtomic(exportGardenRecordPath(stateDir), JSON.stringify(record, null, 2) + "\n");
  }
  const population = latest ? latest.proposalIds.filter((id) => parseSymbolFinding(id)).length : 0;
  const twice = Object.entries(record.sightings)
    .filter(([, seen]) => seen.length >= EXPORT_GARDEN_SIGHTINGS)
    .map(([id]) => id)
    .sort();
  return { generatedAt: latest?.generatedAt, population, twice, record, tally: { trials: record.trials, successes: record.successes } };
}

/** Up to {@link EXPORT_GARDEN_BATCH} exports reported twice, never proposed before, whose
 *  declaration reads whole and whose name grep finds nowhere else in `repoRoot`. */
export function exportGardenCandidates(inv: ExportInventory, repoRoot: string): ExportGardenAction[] {
  const proposed = new Set(inv.record.deletions.map((d) => d.id));
  const out: ExportGardenAction[] = [];
  for (const id of inv.twice) {
    if (out.length >= EXPORT_GARDEN_BATCH) break;
    const found = parseSymbolFinding(id);
    if (!found || proposed.has(id) || !found.file.startsWith("src/lib/") || !found.file.endsWith(".ts")) continue;
    const path = join(repoRoot, found.file);
    if (!existsSync(path)) continue;
    const span = exportDeclarationSpan(readFileSync(path, "utf8"), found.name);
    if (!span || referencesOutside(repoRoot, found.file, found.name, span).length > 0) continue;
    out.push({
      class: "delete-unreferenced-export",
      target: `${found.file}#${found.name}`,
      id,
      ...found,
      scannedAt: inv.generatedAt ?? "unknown",
      reason: `Reported unreferenced by ${EXPORT_GARDEN_SIGHTINGS} adoption scans in a row; grep finds its name nowhere outside its own declaration.`,
    });
  }
  return out;
}

/** Delete each action's export in `root`, re-checked there: a declaration that no longer reads
 *  whole, or a name something now mentions, is left alone. Returns the actions deleted. */
export function applyExportDeletions(root: string, actions: ExportGardenAction[]): ExportGardenAction[] {
  const done: ExportGardenAction[] = [];
  for (const a of actions) {
    const path = join(root, a.file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const span = exportDeclarationSpan(text, a.name);
    if (!span || referencesOutside(root, a.file, a.name, span).length > 0) continue;
    writeFileSync(path, deleteSpan(text, span));
    done.push(a);
  }
  return done;
}

function prBody(done: ExportGardenAction[]): string {
  return [
    `The export gardener (W1-T4117) deletes exports the adoption scan reported unreferenced in ${EXPORT_GARDEN_SIGHTINGS} scans in a row, whose name \`git grep\` finds nowhere outside its own declaration — no import, no string lookup, no registry, no test. Reverting this PR is the undo; a deletion reverted or written back within ${EXPORT_GARDEN_WINDOW_DAYS} days debits the gardener and is never proposed again.`,
    "",
    ...done.map((a) => `- \`${a.name}\` in \`${a.file}\` (\`${a.id}\`)`),
    "",
    "## Acceptance",
    ...done.flatMap((a) => [`- claim: \`${a.name}\` is deleted from ${a.file} and nothing else in the repository referenced it`, "  proof: the required CI checks pass on this PR"]),
  ].join("\n");
}

/** The adoption scan's output, so an idle tick reads one small record and nothing else. */
export function exportCheapFingerprint(stateDir: string): string {
  return readAdoptionLatest(adoptionLatestPath(stateDir))?.generatedAt ?? "none";
}

/** Dead exports as a gardener spec. */
export function exportGardenSpec(deps: GardenerDeps): GardenSpec<ExportGardenClass, ExportInventory, ExportGardenAction, GardenCheckout> {
  return {
    name: "export",
    classes: EXPORT_GARDEN_CLASSES,
    cheapFingerprint: () => exportCheapFingerprint(deps.stateDir),
    inventory: () => exportInventory(deps.repoRoot, deps.stateDir),
    fingerprint: (inv) => `${inv.generatedAt ?? "none"}:${createHash("sha256").update(inv.twice.join("\n")).digest("hex").slice(0, 16)}`,
    metric: (inv) => inv.tally,
    candidates: (inv) => exportGardenCandidates(inv, deps.repoRoot),
    scorecard: (inv, plan) => ({
      scan: inv.generatedAt ?? null,
      unreferenced: inv.population,
      reported_twice: inv.twice.length,
      proposed: plan.actions.length,
      landed: inv.record.deletions.filter((d) => d.landedAt).length,
      re_added: inv.record.deletions.filter((d) => d.reAdded).length,
    }),
    apply: (ws, plan) => {
      const done = applyExportDeletions(ws.root, plan.actions);
      if (done.length === 0) return undefined;
      const record = readExportGardenRecord(deps.stateDir);
      record.deletions.push(...done.map((a) => ({ id: a.id, file: a.file, name: a.name, proposedAt: a.scannedAt })));
      writeAtomic(exportGardenRecordPath(deps.stateDir), JSON.stringify(record, null, 2) + "\n");
      return {
        paths: [...new Set(done.map((a) => a.file))].sort(),
        title: `refactor(lib): the export gardener deletes ${done.length} unreferenced export(s)`,
        body: prBody(done),
      };
    },
  };
}
