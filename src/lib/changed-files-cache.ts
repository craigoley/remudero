/**
 * A PR's changed-file list, served to the BOARD without ever blocking the event loop.
 *
 * WHY. `rmd serve` restarts whenever its clone falls behind origin/main, and each restart used to
 * re-read every candidate PR's file list with one synchronous `gh api --paginate` per PR inside the
 * first board snapshot — measured 2026-09-23 at 85.8 s before the first GET /v1/status answered,
 * 92% of it in `spawn`. Two facts fix it:
 *  - a MERGED or CLOSED PR's file list is IMMUTABLE, so it is persisted once and never re-read;
 *  - a miss answers `undefined` AT ONCE — the "unreadable, fail open" answer every consumer of
 *    `GitHub.changedFiles` already handles — and the read runs asynchronously, so the NEXT
 *    snapshot has it.
 * An OPEN PR's list can change with a push, so it is memoised in memory only, never on disk.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { systemClock, type Clock } from "./clock.js";
import { DEFAULT_GH_CALL_TIMEOUT_MS } from "./github-transport.js";

const SCHEMA = 1;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_FAILURE_TTL_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

/** The board-path changed-files provider handed to `buildBatchedGithub` as `changedFilesCache`. */
export interface ChangedFilesCache {
  /** Never blocks: a hit, or `undefined` (unreadable, fail open) with an async read scheduled. `state` is the
   *  PR's state as the caller knows it; only `MERGED`/`CLOSED` makes the answer durable. */
  lookup(prUrl: string, state: string | undefined): string[] | undefined;
  /** Resolves once every scheduled read has finished and been persisted. */
  settle(): Promise<void>;
}

interface Entry {
  files: string[];
  at: number;
  immutable: boolean;
}

export function changedFilesCachePath(root: string, owner: string, repo: string): string {
  const repository = `${owner}/${repo}`;
  const safe = repository.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  return join(root, "state", "cache", "changed-files", `${safe}-${digest}.json`);
}

const isImmutableState = (state: string | undefined): boolean => state === "MERGED" || state === "CLOSED";

function isFileList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === "string" && f.length > 0);
}

export function createChangedFilesCache(
  root: string,
  owner: string,
  repo: string,
  options: {
    fetch?: (prNumber: string) => Promise<string[] | undefined>;
    ghBin?: string;
    clock?: Clock;
    maxEntries?: number;
    maxBytes?: number;
    concurrency?: number;
    failureTtlMs?: number;
    log?: (event: string, extra?: Record<string, unknown>) => void;
  } = {},
): ChangedFilesCache {
  const path = changedFilesCachePath(root, owner, repo);
  const repository = `${owner}/${repo}`;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const fetchFiles =
    options.fetch ??
    (async (prNumber: string): Promise<string[] | undefined> => {
      const { stdout } = await execFileAsync(
        options.ghBin ?? "gh",
        ["api", "--paginate", `repos/${owner}/${repo}/pulls/${prNumber}/files`, "--jq", ".[].filename"],
        { encoding: "utf8", maxBuffer: 1 << 26, timeout: DEFAULT_GH_CALL_TIMEOUT_MS },
      );
      const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      return lines.length > 0 ? lines : undefined;
    });

  const entries = new Map<string, Entry>();
  const failedAt = new Map<string, number>();
  const queue: Array<{ url: string; immutable: boolean }> = [];
  const pending = new Set<string>();
  let active = 0;
  let dirty = false;
  let idle: Promise<void> = Promise.resolve();
  let wakeIdle: (() => void) | undefined;

  const load = (): void => {
    let raw: string;
    try {
      if (fs.statSync(path).size > maxBytes) {
        log("changed_files_cache.load_refused", { repository, reason: "oversized" });
        return;
      }
      raw = fs.readFileSync(path, "utf8");
    } catch {
      return; // No cache yet (first boot) — every PR is a miss, fetched off the event loop.
    }
    let doc: { schema?: unknown; repository?: unknown; entries?: unknown };
    try {
      doc = JSON.parse(raw) as typeof doc;
    } catch {
      log("changed_files_cache.load_refused", { repository, reason: "invalid_json" });
      return;
    }
    if (doc?.schema !== SCHEMA || doc.repository !== repository || !Array.isArray(doc.entries)) {
      log("changed_files_cache.load_refused", { repository, reason: "invalid_schema" });
      return;
    }
    for (const e of doc.entries as Array<{ url?: unknown; files?: unknown; at?: unknown }>) {
      if (typeof e?.url === "string" && isFileList(e.files) && typeof e.at === "number") {
        entries.set(e.url, { files: e.files, at: e.at, immutable: true });
      }
    }
    log("changed_files_cache.loaded", { repository, entries: entries.size });
  };

  const persist = (): void => {
    if (!dirty) return;
    dirty = false;
    const durable = [...entries.entries()].filter(([, e]) => e.immutable).sort((a, b) => a[1].at - b[1].at);
    // Oldest first out: the board asks about recent PRs, and an evicted one is only ever re-fetched.
    const kept = durable.slice(Math.max(0, durable.length - maxEntries));
    for (const [url] of durable.slice(0, durable.length - kept.length)) entries.delete(url);
    const body = JSON.stringify({ schema: SCHEMA, repository, entries: kept.map(([url, e]) => ({ url, files: e.files, at: e.at })) });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, path);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      log("changed_files_cache.write_failed", { repository, error: String((e as Error).message) });
    }
  };

  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift() as { url: string; immutable: boolean };
      active += 1;
      const number = job.url.match(/\/pull\/(\d+)/)?.[1] as string;
      void fetchFiles(number)
        .then(
          (files) => {
            if (!files) {
              failedAt.set(job.url, clock.now());
              return;
            }
            entries.set(job.url, { files, at: clock.now(), immutable: job.immutable });
            failedAt.delete(job.url);
            if (job.immutable) dirty = true;
          },
          (e: unknown) => {
            failedAt.set(job.url, clock.now());
            log("changed_files_cache.fetch_failed", { repository, pr: number, error: String((e as Error)?.message ?? e) });
          },
        )
        .finally(() => {
          active -= 1;
          pending.delete(job.url);
          if (queue.length > 0) pump();
          else if (active === 0) {
            persist();
            wakeIdle?.();
            wakeIdle = undefined;
          }
        });
    }
  };

  const schedule = (url: string, immutable: boolean): void => {
    if (pending.has(url)) return;
    const failed = failedAt.get(url);
    if (failed !== undefined && clock.now() - failed < failureTtlMs) return;
    if (pending.size === 0) idle = new Promise<void>((resolve) => (wakeIdle = resolve));
    pending.add(url);
    queue.push({ url, immutable });
    // Deferred to a later tick so a board snapshot's synchronous derivation is never interleaved with a spawn.
    setImmediate(pump);
  };

  load();

  return {
    lookup(prUrl, state) {
      if (!/\/pull\/\d+/.test(prUrl)) return undefined;
      const immutable = isImmutableState(state);
      const hit = entries.get(prUrl);
      // A list read while the PR was OPEN can predate its last push, so a now-terminal PR re-reads once to
      // make its durable copy — still answering the older list meanwhile, as the memo always did.
      if (!hit || (immutable && !hit.immutable)) schedule(prUrl, immutable);
      return hit?.files;
    },
    settle() {
      return pending.size === 0 ? Promise.resolve() : idle;
    },
  };
}
