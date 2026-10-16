/**
 * W1-T9602 — A PUSH-GATE VERDICT ON A TREE IS REUSED, NOT RE-RUN, AND ONLY A VERDICT THE HARNESS OBSERVED ITSELF COUNTS.
 *
 * The push leaf (git-push.ts) runs the HARNESS's hooks/pre-push with an allowlisted env, the branch's own code in the
 * proof sandbox, and awaits its exit status. That pass is a harness-observed verdict, so it is recorded here, keyed
 * by everything the hook reads: the tree, the head commit, the base it judges against, the push line it receives,
 * and the recipe (the harness's own code). An exact key match lets the next push of that same tree skip the hook.
 *
 * TRUST BOUNDARY: a record lives under `<config.root>/state/gate-verdicts/`, outside every worktree, and only the
 * daemon writes it, only for a pass. Nothing is ever read from, or derived from, a path under a worktree — a
 * `coverage/preflight-summary.json` or a planted record there is never a verdict. A missing, unreadable, malformed
 * or mismatched record means "run the hook", never "pass".
 *
 * git-push.ts drives it: the push leaf (worktreePushExec / worktreePushExecAsync) reuses an exact pass, and
 * `runPushGate` asks the same gate for `git push origin HEAD` early (the pre-open gate does), without pushing.
 */
import { createHash, randomInt } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";

export const GATE_VERDICTS_DIR = "gate-verdicts";
/** OPERATOR DECISION (W1-T9602, pending): one reuse in this many runs the hook anyway, ledgering agreement; 0 = none. */
export const PUSH_GATE_REUSE_AUDIT_ONE_IN = 10;

/** Whether this reuse is audited: one in `oneIn`, and 0 (or less) audits none. */
export function auditThisReuse(oneIn: number = PUSH_GATE_REUSE_AUDIT_ONE_IN, pick: (n: number) => number = randomInt): boolean {
  return oneIn > 0 && pick(oneIn) === 0;
}
export const PUSH_GATE_TRUST = "harness-observed";

/** Everything the pre-push hook's verdict depends on. head and the push line are in it because head-identity-gate
 *  and worker-branch-shape read the commit and the remote sha, not only the tree. */
export interface PushGateKey {
  tree: string;
  head: string;
  /** The origin/main sha the hook judges against. */
  base: string;
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
  /** The harness's own code: a changed hook or script is a new recipe. */
  recipe: string;
}

export interface PushGatePassRecord {
  schema: 1;
  key: PushGateKey;
  result: "pass";
  duration_ms: number;
  ts: string;
  /** The harness function that awaited the hook's exit status. */
  observed_by: string;
  trust: typeof PUSH_GATE_TRUST;
}

const KEY_FIELDS = ["tree", "head", "base", "localRef", "localSha", "remoteRef", "remoteSha", "recipe"] as const;

/** `<stateRoot>/gate-verdicts`. */
export function gateVerdictsDir(stateRoot: string): string {
  return join(stateRoot, GATE_VERDICTS_DIR);
}

/** The record's file name: a digest over every key field, in a fixed order. */
export function pushGateKeyDigest(key: PushGateKey): string {
  return createHash("sha256").update(KEY_FIELDS.map((f) => `${f}=${key[f]}`).join("\n")).digest("hex");
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path); // not created yet: its spelled location is where it would be
  }
}

/** A verdict store inside the worktree it would judge is a worker-writable path: refused, whatever it holds. */
function storeIsOutside(dir: string, worktreePath: string): boolean {
  return isAbsolute(dir) && !within(realOrResolved(dir), realOrResolved(worktreePath));
}

function isPassRecord(value: unknown): value is PushGatePassRecord {
  const r = value as Partial<PushGatePassRecord> | null;
  return !!r && r.schema === 1 && r.result === "pass" && r.trust === PUSH_GATE_TRUST && typeof r.ts === "string" &&
    typeof r.observed_by === "string" && typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms) &&
    !!r.key && KEY_FIELDS.every((f) => typeof r.key![f] === "string" && r.key![f] !== "");
}

/**
 * The harness-observed pass recorded for exactly `key`, or `undefined`. Undefined is "run the hook": an absent,
 * unreadable, malformed or mismatched record, and any store inside `worktreePath`.
 */
export function reusablePushGatePass(
  dir: string, key: PushGateKey, worktreePath: string, read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): PushGatePassRecord | undefined {
  if (!storeIsOutside(dir, worktreePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(join(dir, `${pushGateKeyDigest(key)}.json`)));
  } catch {
    return undefined; // no record, or one that cannot be read: the hook runs as it always did
  }
  if (!isPassRecord(parsed)) return undefined;
  return KEY_FIELDS.every((f) => parsed.key[f] === key[f]) ? parsed : undefined;
}

export interface RecordPushGatePassInput {
  durationMs: number;
  observedBy: string;
  /** The HEAD trees of the registered worktrees; every record whose tree is not among them is dropped. Unread
   *  (`undefined`) drops nothing this time. */
  liveTrees: ReadonlySet<string> | undefined;
  /** When the pass was observed, ISO-8601, from the caller's clock. */
  ts: string;
}

/**
 * Record a harness-observed pass, atomically (stage, then rename), then drop every record whose tree no registered
 * worktree holds — the retention rule, so no constant bounds the store. Returns what it wrote and dropped; a store
 * inside the worktree is refused (nothing written).
 */
export function recordPushGatePass(
  dir: string, key: PushGateKey, worktreePath: string, input: RecordPushGatePassInput,
): { written: boolean; dropped: number } {
  if (!storeIsOutside(dir, worktreePath)) return { written: false, dropped: 0 };
  const record: PushGatePassRecord = {
    schema: 1, key, result: "pass", duration_ms: input.durationMs, ts: input.ts,
    observed_by: input.observedBy, trust: PUSH_GATE_TRUST,
  };
  const name = `${pushGateKeyDigest(key)}.json`;
  writeAtomic(join(dir, name), `${JSON.stringify(record)}\n`, { tmpTag: "verdict-tmp" });
  let dropped = 0;
  if (input.liveTrees === undefined) return { written: true, dropped };
  for (const entry of readdirSync(dir)) {
    if (entry === name || !entry.endsWith(".json")) continue;
    let tree: unknown;
    try {
      tree = (JSON.parse(readFileSync(join(dir, entry), "utf8")) as { key?: { tree?: unknown } }).key?.tree;
    } catch {
      tree = undefined; // unreadable: it can never be reused, so it goes too
    }
    if (typeof tree === "string" && input.liveTrees.has(tree)) continue;
    rmSync(join(dir, entry), { force: true });
    dropped += 1;
  }
  return { written: true, dropped };
}

/** Remove the record for `key` (an audited reuse the hook refused): the next push of that key runs the hook. */
export function dropPushGatePass(dir: string, key: PushGateKey): void {
  rmSync(join(dir, `${pushGateKeyDigest(key)}.json`), { force: true });
}

/**
 * The harness's recipe without a spawn: its HEAD COMMIT, read from its git dir (a `.git` directory or a linked
 * worktree's `gitdir:` file, a symbolic HEAD through loose refs then packed-refs). A commit fixes its tree, so this
 * is finer than the tree, never coarser. `undefined` when it cannot be read, and then nothing is reused or recorded.
 */
export function harnessRecipe(root: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  try {
    let gitDir = join(root, ".git");
    let pointerFile: string | undefined;
    try {
      pointerFile = read(gitDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EISDIR") return undefined; // no git dir: no recipe
    }
    if (pointerFile !== undefined) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(pointerFile)?.[1];
      if (pointer === undefined) return undefined;
      gitDir = resolve(root, pointer);
    }
    let common = gitDir;
    try {
      common = resolve(gitDir, read(join(gitDir, "commondir")).trim());
    } catch {
      // no commondir file: the git dir is its own common dir
    }
    const head = read(join(gitDir, "HEAD")).trim();
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (ref === undefined) return /^[0-9a-f]{40,64}$/.test(head) ? `commit:${head}` : undefined;
    for (const dir of [gitDir, common]) {
      try {
        const sha = read(join(dir, ref)).trim();
        if (/^[0-9a-f]{40,64}$/.test(sha)) return `commit:${sha}`;
      } catch {
        // not a loose ref here: packed-refs below
      }
    }
    const packed = read(join(common, "packed-refs")).split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0];
    return packed && /^[0-9a-f]{40,64}$/.test(packed) ? `commit:${packed}` : undefined;
  } catch {
    return undefined; // an unreadable recipe reuses nothing
  }
}
