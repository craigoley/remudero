// scripts/pure-test-pool.mjs — which test files may share ONE node process (W1-T6085).
//
// WHY: `node --test` gives every file its own child, so every file pays node + tsx start and loads
// ~437 src modules. A "pure" file — one that writes no env, never chdirs, spawns nothing and patches
// no global — cannot tell whether it shares a process, so a shard can run all of them in one child
// under --experimental-test-isolation=none (measured 1.53 -> 0.74 s plain, 4.15 -> 1.56 s under
// coverage on 4 files, identical line hits).
//
// THE CENSUS IS STATIC AND CONSERVATIVE: a file is admitted only when its source is READABLE and
// matches none of the {@link POOL_REFUSALS}. Anything the census cannot read is refused, never
// admitted — a false refusal costs one process start, a false admission costs a cross-file leak.
//
// Plain .mjs on purpose: ci runs scripts/test-tier-manifest.mjs under plain node, with no tsx.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The node flag that makes `node --test` run every file in the runner's own process. */
export const POOL_ISOLATION_FLAG = "--experimental-test-isolation=none";

const ASSIGN_OP = String.raw`(?:\?\?|\|\||&&|\*\*|<<|>>>?|[-+*/%&|^])?=(?!=)`;

/** Each refusal: a stable `name` (what the census reports) and the `pattern` that triggers it. */
export const POOL_REFUSALS = [
  {
    name: "process.env write",
    pattern: new RegExp(
      String.raw`process\.env\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*${ASSIGN_OP}` +
        String.raw`|process\.env\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*(?:\+\+|--)` +
        String.raw`|\bdelete\s+process\.env\b` +
        String.raw`|\b(?:Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(?:set|defineProperty|deleteProperty))\s*\(\s*process\.env\b` +
        String.raw`|=\s*process\.env\s*(?:;|$)`,
      "m",
    ),
  },
  { name: "process.chdir", pattern: /\bchdir\s*\(/ },
  {
    name: "child_process / spawn / exec",
    pattern: /child_process|\b(?:spawnSync|execSync|execFileSync|execFile)\s*\(|(?<![.\w$])(?:spawn|exec|fork)\s*\(/,
  },
  {
    name: "global or prototype assignment",
    pattern: new RegExp(
      String.raw`\b(?:globalThis|global|window|self)\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])\s*${ASSIGN_OP}` +
        String.raw`|\.prototype\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*${ASSIGN_OP}` +
        String.raw`|\b(?:process|console|Date|Math|JSON|Object|Array|Promise|Buffer|Intl|Reflect|Symbol|Error)\s*\.\s*(?!env\b)[\w$.]+\s*${ASSIGN_OP}` +
        String.raw`|\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*(?:globalThis|global|process|console|[\w$.]*\.prototype)\b` +
        String.raw`|\bReflect\.(?:set|defineProperty|deleteProperty|setPrototypeOf)\s*\(\s*(?:globalThis|global|process|console)\b` +
        String.raw`|=\s*(?:globalThis|global)\s*(?:;|$)` +
        String.raw`|\bprocess\s*\[`,
      "m",
    ),
  },
  {
    name: "module mock",
    pattern: /\bmock\s*\.\s*(?:module|method|getter|setter|property)\s*\(|\bmock\.module\b|\bregister\s*\(\s*["'`]/,
  },
  {
    name: "timer fake",
    pattern: /\bmock\s*\.\s*timers\b|\buseFakeTimers\b|\bFakeTimers\b|\bsinon\b|\bjest\b/,
  },
  {
    name: "process-level listener",
    pattern:
      /\bprocess\s*\.\s*(?:on|once|off|addListener|prependListener|prependOnceListener|removeListener|removeAllListeners|setUncaughtExceptionCaptureCallback|setSourceMapsEnabled|umask|exit|abort|kill|emitWarning)\s*\(/,
  },
];

/**
 * Judge ONE test file's source. `source` that is not a non-empty string is unreadable and refused.
 * @returns {{ admitted: boolean, reasons: string[] }}
 */
export function censusSource(source) {
  if (typeof source !== "string" || source.trim() === "") {
    return { admitted: false, reasons: ["unreadable (census refuses what it cannot read)"] };
  }
  const reasons = POOL_REFUSALS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
  return { admitted: reasons.length === 0, reasons };
}

/** Read `file` under `root` and judge it. A read error is a refusal, never an admission. */
export function censusFile(file, { root = ".", readFile = (path) => readFileSync(path, "utf8") } = {}) {
  let source;
  try {
    source = readFile(join(root, file));
  } catch (error) {
    return { admitted: false, reasons: [`unreadable: ${error && error.message ? error.message : String(error)}`] };
  }
  return censusSource(source);
}

/**
 * Split a shard's `files` into the pool and everything else. A file is pooled only when it is in the
 * fast tier (`fast` is the tier's file list) AND the census admits it. Order is preserved.
 * @returns {{ pooled: string[], isolated: string[], refusals: Record<string, string[]> }}
 */
export function partitionPool(files, { fast, root = ".", readFile } = {}) {
  const fastSet = new Set(fast ?? []);
  const pooled = [];
  const isolated = [];
  const refusals = {};
  for (const file of files) {
    if (!fastSet.has(file)) {
      isolated.push(file);
      refusals[file] = ["not in the fast tier"];
      continue;
    }
    const verdict = censusFile(file, { root, readFile });
    if (verdict.admitted) pooled.push(file);
    else {
      isolated.push(file);
      refusals[file] = verdict.reasons;
    }
  }
  return { pooled, isolated, refusals };
}

/**
 * Run a shard: the pool in ONE child, everything else as the caller runs it today.
 *
 * `run(files, { pool, quiet, role })` spawns one `node --test` child over `files` (isolation=none when
 * `pool`) and returns its exit status. A pool of fewer than two files is not worth a pool.
 *
 * A pool child that FAILS is re-run isolated once. If that passes, the failure was the pool's own
 * (a cross-file leak), not a test failure: the leaking file is located and named, the shard is green
 * and the defect is reported. If it fails isolated too, the failure is the tests' own and is returned.
 *
 * @returns {{ status: number, poolDefect: null | { leaker: string | null, victim: string | null } }}
 */
export function runShardWithPool(files, { fast, root = ".", readFile, run, log = (line) => console.error(line) }) {
  const { pooled, isolated } = partitionPool(files, { fast, root, readFile });
  if (pooled.length < 2) return { status: run(files, { pool: false, role: "rest" }), poolDefect: null };

  let status = 0;
  let poolDefect = null;
  const poolStatus = run(pooled, { pool: true, role: "pool" });
  if (poolStatus !== 0) {
    log(`pure-test-pool: the pool of ${pooled.length} file(s) failed (status ${poolStatus}); re-running them isolated once.`);
    const again = run(pooled, { pool: false, role: "rerun" });
    if (again !== 0) {
      status = again;
      log("pure-test-pool: the pooled files also fail isolated — a test failure, not a pool defect.");
    } else {
      poolDefect = locateLeak(pooled, (subset) => run(subset, { pool: true, quiet: true, role: "locate" }));
      log(
        `pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; ` +
          `leaking file: ${poolDefect.leaker ?? "not isolated to one file"}` +
          (poolDefect.victim ? ` (first failing alongside it: ${poolDefect.victim})` : "") +
          `. Add the leak to the census in scripts/pure-test-pool.mjs.`,
      );
    }
  }
  if (isolated.length > 0) {
    const rest = run(isolated, { pool: false, role: "rest" });
    if (status === 0) status = rest;
  }
  return { status, poolDefect };
}

/**
 * Name the file that leaks. `runPool(subset)` returns a status. The smallest failing PREFIX ends at
 * the victim (the file that trips over the leak, or the leaker itself); the leaker is the file whose
 * removal from that prefix makes it pass.
 * @returns {{ leaker: string | null, victim: string | null }}
 */
export function locateLeak(pooled, runPool) {
  let lo = 1;
  let hi = pooled.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (runPool(pooled.slice(0, mid)) !== 0) hi = mid;
    else lo = mid + 1;
  }
  const prefix = pooled.slice(0, hi);
  if (runPool(prefix) === 0) return { leaker: null, victim: null }; // the failure did not reproduce
  const victim = prefix[prefix.length - 1];
  for (let i = 0; i < prefix.length; i++) {
    const without = prefix.filter((_, j) => j !== i);
    if (without.length > 0 && runPool(without) === 0) return { leaker: prefix[i], victim };
  }
  return { leaker: null, victim };
}
