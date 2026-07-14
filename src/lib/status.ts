import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plan, Task, TaskStatus } from "./plan.js";

/**
 * Derived task status (MASTER-PLAN v2.1 decision, implemented here).
 *
 * Task merge-state is DERIVED FROM GITHUB, never written back to plan/tasks.yaml.
 * A YAML round-trip destroys comments, status commits spam a public repo, and a
 * machine writer racing a human editor is a conflict class we simply do not have.
 * The `status:` field in tasks.yaml is therefore DECORATIVE (initial-state only);
 * the truth of whether a task landed is computed on demand from GitHub, in a
 * fixed precedence, and cached to a machine-owned projection (state/status.json).
 *
 * Precedence for a task id:
 *   (a) state/ledger.ndjson `pr.opened` line for this task -> query that PR's state;
 *   (b) an explicit `pr:` field in tasks.yaml (tasks executed by hand, pre-ledger);
 *   (c) a merged PR whose body carries the trailer `Remudero-Task: <id>`.
 * First source that resolves a PR wins. If none resolve, the task is not merged.
 *
 * NOTHING in this module writes tasks.yaml. It reads the plan and the ledger and
 * queries GitHub; the only file it writes is the status.json cache.
 */

/** The three precedence sources, plus `none` when GitHub has no evidence. */
export type StatusSource = "ledger" | "pr-field" | "trailer" | "none";

/** A PR's identity + GitHub merge state, as seen by the {@link GitHub} gateway. */
export interface PrRef {
  number: number;
  url: string;
  /** GitHub PR state: "MERGED" | "OPEN" | "CLOSED". */
  state: string;
}

/** One task's projected merge-state, derived from GitHub (never from yaml). */
export interface StatusProjection {
  taskId: string;
  /** Derived status label in the plan's vocabulary. */
  status: TaskStatus;
  /** The single fact dependency-gating cares about: has this task landed? */
  merged: boolean;
  /** Which precedence source resolved it (or `none`). */
  source: StatusSource;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
}

/**
 * The GitHub queries deriveStatus needs, behind an interface so unit tests can
 * inject fixtures for all three precedence sources without touching the network.
 */
export interface GitHub {
  /** Resolve a PR by number or url within the gateway's repo. null if absent. */
  prByRef(ref: string | number): PrRef | null;
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): PrRef | null;
}

/** Reader for the append-only ledger; injectable for tests. */
export type LedgerReader = (path: string) => Array<Record<string, unknown>>;

export interface DeriveDeps {
  /** Absolute path to state/ledger.ndjson (source (a)). */
  ledgerPath: string;
  /** GitHub gateway scoped to the task's repo. */
  github: GitHub;
  /** Ledger reader; defaults to reading + parsing NDJSON from disk. */
  readLedger?: LedgerReader;
}

/** Default NDJSON ledger reader: one JSON object per non-blank line. */
export function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/** Map a GitHub PR state onto a plan status label + the merged predicate. */
function fromPrState(state: string): { status: TaskStatus; merged: boolean } {
  switch (state.toUpperCase()) {
    case "MERGED":
      return { status: "merged", merged: true };
    case "OPEN":
      return { status: "running", merged: false };
    case "CLOSED":
      return { status: "blocked", merged: false };
    default:
      return { status: "queued", merged: false };
  }
}

/** The most recent `pr.opened` ledger line for a task id, if any. */
function lastPrOpened(
  lines: Array<Record<string, unknown>>,
  taskId: string,
): string | undefined {
  let url: string | undefined;
  for (const line of lines) {
    if (line.step === "pr.opened" && line.task_id === taskId && typeof line.pr_url === "string") {
      url = line.pr_url; // keep scanning: last one wins
    }
  }
  return url;
}

/**
 * Derive one task's merge-state from GitHub, in the fixed precedence.
 * Pure over its injected deps — no writes, no tasks.yaml access.
 */
export function deriveStatus(task: Task, deps: DeriveDeps): StatusProjection {
  const readLedger = deps.readLedger ?? readLedgerLines;

  // (a) ledger `pr.opened` for this task -> query that PR.
  const openedUrl = lastPrOpened(readLedger(deps.ledgerPath), task.id);
  if (openedUrl) {
    const pr = deps.github.prByRef(openedUrl);
    if (pr) {
      return { taskId: task.id, source: "ledger", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
  }

  // (b) explicit `pr:` field (hand-executed, pre-ledger).
  if (task.pr !== undefined) {
    const pr = deps.github.prByRef(task.pr);
    if (pr) {
      return { taskId: task.id, source: "pr-field", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
  }

  // (c) a merged PR carrying the `Remudero-Task: <id>` trailer.
  const trailerPr = deps.github.findMergedByTrailer(task.id);
  if (trailerPr) {
    return { taskId: task.id, source: "trailer", ...fromPrState(trailerPr.state), prNumber: trailerPr.number, prUrl: trailerPr.url, prState: trailerPr.state };
  }

  // No GitHub evidence: not merged. The yaml `status:` is decorative, not trusted.
  return { taskId: task.id, status: "queued", merged: false, source: "none" };
}

/**
 * Derive every task in a plan and cache the projection to `cachePath`
 * (state/status.json). Returns a taskId -> projection map. Writes ONLY the cache.
 */
export function projectPlan(
  plan: Plan,
  deps: DeriveDeps,
  cachePath?: string,
): Map<string, StatusProjection> {
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) byId.set(task.id, deriveStatus(task, deps));
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    const projection = {
      generated_at: new Date().toISOString(),
      note: "Machine-owned projection derived from GitHub. tasks.yaml is never rewritten.",
      tasks: Object.fromEntries([...byId].map(([id, p]) => [id, p])),
    };
    writeFileSync(cachePath, JSON.stringify(projection, null, 2) + "\n");
  }
  return byId;
}

// ── Real GitHub gateway (execs `gh`; runs outside the sandbox — TLS only there).

/**
 * Build a {@link GitHub} gateway scoped to `owner/repo`. Every query is fail-soft:
 * a missing PR or a `gh` error resolves to null, so derivation degrades to the
 * next precedence source rather than throwing.
 */
export function ghGateway(owner: string, repo: string): GitHub {
  const slug = `${owner}/${repo}`;
  const tryJson = <T>(args: string[]): T | null => {
    try {
      return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as T;
    } catch {
      return null;
    }
  };
  return {
    prByRef(ref) {
      const pr = tryJson<PrRef>(["pr", "view", String(ref), "--repo", slug, "--json", "number,url,state"]);
      return pr && typeof pr.number === "number" ? pr : null;
    },
    findMergedByTrailer(taskId) {
      // GitHub body search for the exact trailer, merged PRs only, newest first.
      const list = tryJson<PrRef[]>([
        "pr", "list", "--repo", slug, "--state", "merged",
        "--search", `"Remudero-Task: ${taskId}" in:body`,
        "--json", "number,url,state", "--limit", "1",
      ]);
      return list && list.length > 0 ? list[0] : null;
    },
  };
}
