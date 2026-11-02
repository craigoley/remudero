import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import { hostWorktreeGitAsync } from "./worktree-git.js";

/**
 * W1-T11094: a held task whose cited prerequisites have all merged is named for release, in shadow.
 *
 * A `dispatch_hold: true` shard waits on prose ("release when core W1-T10559 has merged credit and serves"), and
 * nothing re-reads that prose when its prerequisites land: CONSOLE-T143's core tasks merged 2026-10-27 and the hold
 * stood until an operator recon on 2026-11-02. This observer reads origin/main of the plan's own checkout and of
 * the core checkout, finds every held queued shard, and writes one `dispatch_hold.readiness` row per hold whose
 * picture changed: the ids it cites, which of them have merged credit, and the hold's own condition text. Merged
 * credit is a `Remudero-Task:` trailer or a `(<id>) (#<n>)` squash subject on origin/main. A hold can also wait on
 * a serve, a switch or elapsed time, which no git read proves, so `prerequisites-merged` is a release CANDIDATE for
 * the operator, never a release: this module writes ledger rows only.
 */

export const HOLD_READINESS_STEP = "dispatch_hold.readiness";
export const HOLD_READINESS_PASS_STEP = "dispatch_hold.readiness_pass";
export const HOLD_READINESS_INTERVAL_MS = 3_600_000;
export const HOLD_READINESS_FIRST_DELAY_MS = 600_000;

const TASK_ID = /\b[A-Z][A-Z0-9]*-T\d+\b/g;
const TRAILER_ID = /^Remudero-Task: ([A-Z][A-Z0-9]*-T\d+)\s*$/gm;
const SUBJECT_ID = /\(([A-Z][A-Z0-9]*-T\d+)\) \(#\d+\)\s*$/gm;
const HELD_LINE = /^plan\/tasks\.d\/[^:]+\.yaml:\d+:\s*dispatch_hold:\s*true\b/;
const CONDITION_MAX_CHARS = 400;

export type HoldReadinessState = "prerequisites-merged" | "waiting" | "cites-nothing";

export interface HoldReadiness {
  id: string;
  path: string;
  state: HoldReadinessState;
  cited: string[];
  unmerged: string[];
  condition: string;
}

type Shard = Record<string, unknown>;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export function holdCondition(shard: Shard): string {
  const prose = ["note", "design", "rationale"].map((key) => (typeof shard[key] === "string" ? shard[key] : "")).join("\n");
  const at = prose.search(/DISPATCH HOLD|HOLD PRECONDITION/i);
  return (at < 0 ? "" : prose.slice(at, at + CONDITION_MAX_CHARS)).replace(/\s+/g, " ").trim();
}

export function citedPrerequisites(shard: Shard): string[] {
  const own = String(shard.id ?? "");
  const named = [...strings(shard.depends_on), ...strings(shard.plan_refs), holdCondition(shard)].join(" ").match(TASK_ID) ?? [];
  return [...new Set(named)].filter((id) => id !== own).sort();
}

export function mergedTaskIds(log: string): Set<string> {
  const ids = new Set<string>();
  for (const pattern of [TRAILER_ID, SUBJECT_ID]) for (const match of log.matchAll(pattern)) ids.add(match[1]!);
  return ids;
}

export function assessHold(shard: Shard, path: string, merged: ReadonlySet<string>): HoldReadiness {
  const cited = citedPrerequisites(shard);
  const unmerged = cited.filter((id) => !merged.has(id));
  const state: HoldReadinessState = cited.length === 0 ? "cites-nothing" : unmerged.length === 0 ? "prerequisites-merged" : "waiting";
  return { id: String(shard.id), path, state, cited, unmerged, condition: holdCondition(shard) };
}

export function heldShardPaths(grepOutput: string): string[] {
  return [...new Set(grepOutput.split("\n").filter((line) => HELD_LINE.test(line)).map((line) => line.slice(0, line.indexOf(":"))))].sort();
}

export function heldQueuedShards(shardTexts: readonly { path: string; text: string }[]): Array<{ path: string; shard: Shard }> {
  return shardTexts.flatMap(({ path, text }) => {
    const parsed: unknown = parseYaml(text);
    const shards = (Array.isArray(parsed) ? parsed : [parsed]) as Shard[];
    return shards.filter((shard) => shard?.dispatch_hold === true && (shard.status ?? "queued") === "queued" && shard.retirement === undefined)
      .map((shard) => ({ path, shard }));
  });
}

export function readinessFingerprint(readiness: HoldReadiness): string {
  return createHash("sha256").update(JSON.stringify([readiness.state, readiness.unmerged, readiness.condition])).digest("hex").slice(0, 16);
}

export interface HoldReadinessDeps {
  planCheckout: string;
  creditCheckouts: readonly string[];
  log: (step: string, fields: Record<string, unknown>) => void;
  git?: typeof hostWorktreeGitAsync;
}

export type HoldReadinessPass = { readiness: HoldReadiness[] } | { unreadable: string };

export async function observeHoldReadiness(deps: HoldReadinessDeps, seen: Map<string, string>): Promise<HoldReadinessPass> {
  const git = deps.git ?? hostWorktreeGitAsync;
  let pass: HoldReadinessPass;
  try {
    const listing = await git(deps.planCheckout, ["grep", "-n", "-e", "^  dispatch_hold: true", "-e", "^- id:", "origin/main", "--", "plan/tasks.d"],
      { maxBuffer: 64 * 1024 * 1024 });
    const paths = heldShardPaths(listing.replace(/^origin\/main:/gm, ""));
    const texts = await Promise.all(paths.map(async (path) => ({ path, text: await git(deps.planCheckout, ["show", `origin/main:${path}`]) })));
    const logs = await Promise.all([...new Set([deps.planCheckout, ...deps.creditCheckouts])].map((dir) =>
      git(dir, ["log", "origin/main", "--format=%s%n%b"], { maxBuffer: 256 * 1024 * 1024 })));
    const merged = mergedTaskIds(logs.join("\n"));
    pass = { readiness: heldQueuedShards(texts).map(({ path, shard }) => assessHold(shard, path, merged)) };
  } catch (error) {
    pass = { unreadable: String((error as Error)?.message ?? error).slice(0, 300) };
  }
  if ("unreadable" in pass) {
    deps.log(HOLD_READINESS_PASS_STEP, { mode: "shadow", unreadable: pass.unreadable });
    return pass;
  }
  for (const readiness of pass.readiness) {
    const fingerprint = readinessFingerprint(readiness);
    if (seen.get(readiness.id) === fingerprint) continue;
    seen.set(readiness.id, fingerprint);
    deps.log(HOLD_READINESS_STEP, { mode: "shadow", hold_task: readiness.id, state: readiness.state, path: readiness.path,
      cited: readiness.cited, unmerged: readiness.unmerged, condition: readiness.condition, fingerprint });
  }
  const count = (state: HoldReadinessState) => pass.readiness.filter((readiness) => readiness.state === state).length;
  deps.log(HOLD_READINESS_PASS_STEP, { mode: "shadow", held: pass.readiness.length,
    prerequisites_merged: count("prerequisites-merged"), waiting: count("waiting"), cites_nothing: count("cites-nothing") });
  return pass;
}

export function startHoldReadinessObserver(deps: HoldReadinessDeps, intervalMs = HOLD_READINESS_INTERVAL_MS,
  firstDelayMs = HOLD_READINESS_FIRST_DELAY_MS): { close: () => void } {
  const seen = new Map<string, string>();
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void observeHoldReadiness(deps, seen).then(
      () => { running = false; },
      // Only a failed ledger write reaches here; a shadow row never outranks the daemon staying up.
      (error: unknown) => { running = false; console.error("hold readiness observer failed", String(error)); },
    );
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  const first = setTimeout(run, firstDelayMs);
  first.unref();
  return { close: () => { clearTimeout(first); clearInterval(timer); } };
}
