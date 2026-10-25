/**
 * W1-T9651 — no daemon-loop path bounds an async child process with a WALL-CLOCK timer.
 *
 * When a held loop resumes, Node runs due timers before it processes I/O. execFile's own `timeout` then kills a
 * child whose exit is already pending, destroys the unread stdout, and the call RESOLVES with whatever it had read
 * (#11985: an empty `git config --list`, and three pushes ran with no credential helper). A hand-rolled
 * `setTimeout(() => child.kill())` reports a finished child as timed out. src/lib/loop-bounded-child.ts bounds a
 * child by loop-available time instead; this census refuses the NEXT site that arms a wall-clock bound.
 *
 * Population: a top-level function whose comment-stripped body makes an ASYNC child call (execFile, spawn, fork, or
 * a `promisify(execFile)` alias, under the name its file imports it as) AND either passes a `timeout` option or arms
 * a `setTimeout`/`AbortSignal.timeout` beside a child kill. A sync call's own `timeout` is not counted (a sync child
 * does not race the loop; W1-T5689's census owns it). The helper module is the mechanism, not a site. Reach: the
 * shared walk (test/helpers/daemon-loop-walk.ts), seeded from `daemonCommand`, the same walk as the sync census.
 * The table is EXACT, like SYNC_SPAWN_LOOP_BASELINE, and EMPTY: a new site is named and refused.
 */
// @source-text-subject: src/**/*.ts — the claim is a property of EVERY function the loop can reach,
// including paths no single execution drives; the same shape as the sync-spawn census.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { loopReachable, topLevelFunctions, type Fn } from "./helpers/daemon-loop-walk.js";

/** Loop-reachable functions that still arm a wall-clock bound on an async child, with their count. EMPTY since
 *  W1-T9651: every site routes through src/lib/loop-bounded-child.ts. A new name is refused. */
const WALL_CLOCK_CHILD_LOOP_BASELINE: Readonly<Record<string, number>> = {};

/** The mechanism itself: its own `timeout` destructuring and deadline are the bound, not a site. */
const MECHANISM_FILE = "src/lib/loop-bounded-child.ts";

/** The names a file can start an ASYNC child under: execFile/spawn/fork as it imports them (aliases included),
 *  and every `promisify(execFile)` binding it makes. A default or namespace import is called dotted, which the
 *  bare names already match. */
function asyncChildNames(source: string): string[] {
  const names = new Set<string>(["execFile", "spawn", "fork"]);
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)) {
    for (const spec of m[1]!.split(",")) {
      const alias = /^\s*(?:execFile|spawn|fork|exec)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(spec);
      if (alias) names.add(alias[1]!);
      if (/^\s*exec\s*$/.test(spec)) names.add("exec");
    }
  }
  const promised = new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*promisify\\((?:${[...names].join("|")})\\)`, "g");
  for (const m of source.matchAll(promised)) names.add(m[1]!);
  return [...names];
}

/** The balanced `( … )` span opening at `open`. */
function parenSpan(body: string, open: number): string {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")" && --depth === 0) return body.slice(open, i + 1);
  }
  return body.slice(open);
}

const SYNC_PRIMITIVE = "(?:execFileSync|spawnSync|execSync|ghExecFile|ghExec)";

/** The body with every SYNC call removed (the primitives, and a local name bound to one: `execFile = execFileSync`
 *  as a seam default shadows the async name), and every call to the loop-bounded helpers, whose `timeout` is a
 *  loop-available budget. */
function withoutSyncOrBoundedCalls(body: string): string {
  const shadowed = [...body.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*(?::\\s*typeof\\s+[\\w$]+\\s*)?=\\s*${SYNC_PRIMITIVE}(?![\\w$])`, "g"))].map((m) => m[1]!);
  const names = ["execFileSync", "spawnSync", "execSync", "execFileLoopBounded", "boundChildByLoopTime", ...shadowed];
  const call = new RegExp(`(?<![\\w$])(?:${names.join("|")})\\(`, "g");
  const spans: Array<[number, number]> = [];
  for (const m of body.matchAll(call)) {
    const open = m.index! + m[0].length - 1;
    const end = open + parenSpan(body, open).length;
    // A call nested in one already removed goes with it.
    if (spans.length === 0 || m.index! >= spans[spans.length - 1]![1]) spans.push([m.index!, end]);
  }
  let out = body;
  for (const [from, to] of spans.reverse()) out = out.slice(0, from) + out.slice(to);
  return out;
}

/** Local names a body binds to an async child primitive: a seam defaulting to one (`execAsync = execFileAsync`) or
 *  typed as one (`execAsync: typeof execFileAsync`). A call through the seam starts that child in production. */
function seamsOver(body: string, childNames: readonly string[]): string[] {
  const named = childNames.join("|");
  const seam = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\??\\s*(?::\\s*typeof\\s+(?:${named})(?![\\w$])|(?::[^=,()]*)?=\\s*(?:${named})(?![\\w$(]))`, "g");
  // A multi-line parameter whose function type holds parens and commas: `exec: (cmd: string, …) => … = execFilePromise as never,`.
  const line = new RegExp(`^\\s*([A-Za-z_$][\\w$]*)\\s*\\??\\s*:.*=\\s*(?:${named})(?:\\s+as\\s+[\\w$]+)?\\s*,?\\s*$`, "gm");
  return [...new Set([...body.matchAll(seam), ...body.matchAll(line)].map((m) => m[1]!))];
}

/** W1-T9703: local names a body binds to a WRAPPER over a child — a parameter whose type is a function and whose
 *  DEFAULT is an arrow or function that calls a child primitive or the loop-bounded helpers (the `executeAsync`
 *  seam of ciLearningTaskIdMinter). The default is not a bare child name, so `seamsOver` cannot see it. */
function wrapperSeams(body: string, childNames: readonly string[]): string[] {
  const calls = new RegExp(`(?<![\\w$])(?:${[...childNames, "execFileLoopBounded", "boundChildByLoopTime"].join("|")})\\(`);
  const line = /(?:^|[(,])\s*([A-Za-z_$][\w$]*)\s*\??\s*:\s*\(.*[^=]=(?!>)\s*(?:async\s*)?(?:function\b[^(]*\([^)]*\)\s*\{|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)(.*)$/gm;
  return [...body.matchAll(line)].filter((m) => calls.test(m[2]!)).map((m) => m[1]!);
}

/** W1-T9703: wall-clock timers a body arms to stop a child through an AbortController — `controller.abort()` beside a
 *  `setTimeout`/`AbortSignal.timeout`, where `signal: controller.signal` reaches an async child call, a loop-bounded
 *  helper, or a seam over one. A signal that reaches only a fetch, a stream or an in-process function is not a child
 *  kill. `.kill(` is not in such a body, which is why the kill count below reads 0 for it. */
function abortKills(body: string, childNames: readonly string[]): number {
  const timers = (body.match(/\bsetTimeout\(|\bAbortSignal\.timeout\(/g) ?? []).length;
  if (timers === 0) return 0;
  const callees = [...childNames, ...seamsOver(body, childNames), ...wrapperSeams(body, childNames), "execFileLoopBounded", "boundChildByLoopTime"];
  const call = new RegExp(`(?<![\\w$])(?:${callees.join("|")})\\(`, "g");
  const spans = [...body.matchAll(call)].map((m) => parenSpan(body, m.index! + m[0].length - 1));
  const aborted = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.abort\(/g)].map((m) => m[1]!);
  const stopsChild = aborted.some((c) => spans.some((span) => new RegExp(`\\bsignal\\s*:\\s*${c}\\.signal\\b`).test(span)));
  return stopsChild ? timers : 0;
}

/** Wall-clock bounds one function arms on an async child: its `timeout` options, and the setTimeout or
 *  AbortSignal.timeout timers it arms beside a child kill. 0 when the body starts no async child. */
function wallClockChildArms(fn: Fn, childNames: readonly string[]): number {
  if (fn.file === MECHANISM_FILE) return 0;
  const aborts = abortKills(fn.body, childNames);
  const body = withoutSyncOrBoundedCalls(fn.body);
  const asyncCall = new RegExp(`(?<![\\w$])(?:${[...childNames, ...seamsOver(body, childNames)].join("|")})\\(|promisify\\((?:execFile|exec)\\)\\(`);
  if (!asyncCall.test(body)) return aborts;
  // A body that arms the loop bound reads its `timeout` as that bound's budget; there only a raw child call's own
  // `timeout` option counts. Elsewhere any `timeout` the body passes or forwards (`timeout?:` typed and spread into
  // the call, as a wrapper does) is execFile's own wall-clock timer.
  const options = /\b(?:boundChildByLoopTime|loopAvailableDeadline)\(/.test(fn.body)
    ? [...body.matchAll(new RegExp(asyncCall.source, "g"))].filter((m) => /\btimeout\s*[:,}]/.test(parenSpan(body, m.index! + m[0].length - 1))).length
    : (body.match(/\btimeout\s*\??\s*[:,}]/g) ?? []).length;
  const kills = /\.kill\(/.test(body) ? (body.match(/\bsetTimeout\(|\bAbortSignal\.timeout\(/g) ?? []).length : 0;
  return options + kills + aborts;
}

/** Wall-clock child bounds per function NAME (same-named functions in different files sum). */
function population(fns: Fn[]): Map<string, number> {
  const namesByFile = new Map<string, string[]>();
  const pop = new Map<string, number>();
  for (const f of fns) {
    let names = namesByFile.get(f.file);
    if (!names) {
      const url = new URL(`../${f.file}`, import.meta.url);
      names = existsSync(url) ? asyncChildNames(readFileSync(url, "utf8")) : asyncChildNames("");
      namesByFile.set(f.file, names);
    }
    const n = wallClockChildArms(f, names);
    if (n > 0) pop.set(f.name, (pop.get(f.name) ?? 0) + n);
  }
  return pop;
}

const BASELINE_FILE = "test/no-daemon-loop-path-arms-a-wall-clock-child-timeout.test.ts";

/** Every loop-reachable name whose count differs from its row. EXACT: growth is refused, and so is a row above
 *  its real count, so the table never holds slack a later regression could refill unseen. */
function refusals(fns: Fn[], baseline: Readonly<Record<string, number>>): string[] {
  const reach = loopReachable(fns, "daemonCommand");
  const pop = population(fns);
  const names = new Set([...pop.keys()].filter((n) => reach.has(n)));
  for (const n of Object.keys(baseline)) names.add(n);
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const count = reach.has(name) ? pop.get(name) ?? 0 : 0;
    const row = Object.hasOwn(baseline, name) ? baseline[name]! : undefined;
    if (row === undefined) {
      out.push(`${name} arms ${count} wall-clock bound(s) on an async child and is reachable from the daemon loop (daemonCommand) — bound it with execFileLoopBounded or boundChildByLoopTime (src/lib/loop-bounded-child.ts)`);
    } else if (count > row) {
      out.push(`${name} arms ${count} wall-clock bound(s) on an async child, above its WALL_CLOCK_CHILD_LOOP_BASELINE row of ${row} — bound it with src/lib/loop-bounded-child.ts`);
    } else if (count < row) {
      out.push(count === 0
        ? `${name} arms 0 wall-clock bound(s) < row ${row} — delete the \`${name}\` row from WALL_CLOCK_CHILD_LOOP_BASELINE (${BASELINE_FILE}) in this PR`
        : `${name} arms ${count} wall-clock bound(s) < row ${row} — lower WALL_CLOCK_CHILD_LOOP_BASELINE \`${name}\` to ${count} (${BASELINE_FILE}) in this PR`);
    }
  }
  return out;
}

test("W1-T9651: the census names a daemon-reachable async child call that arms a wall-clock timeout", () => {
  const fns = topLevelFunctions({ objectLiterals: true });
  const reach = loopReachable(fns, "daemonCommand");
  // The walk is real: the seed exists and the planted site below is reached.
  assert.ok(fns.some((f) => f.name === "daemonCommand"), "the walk must find daemonCommand to seed from");
  assert.ok(reach.has("sweepLandingSteps"), "the loop reaches sweepLandingSteps");
  assert.ok(reach.has("ghTextAsync") && reach.has("gitClaimRunnerAsync"), "the loop reaches the gh reads and the dispatch claim");

  // Zero on the real source: every site is bounded by loop-available time.
  assert.deepEqual(refusals(fns, WALL_CLOCK_CHILD_LOOP_BASELINE), [], "a daemon-loop path arms a wall-clock child timeout");

  // Positive control, on the real source: a reached function gains execFile's own `timeout`.
  const planted = fns.map((f) =>
    f.name === "sweepLandingSteps" ? { ...f, body: f.body + '\n  execFile("git", ["status"], { timeout: 1000 }, cb);' } : f,
  );
  const named = refusals(planted, WALL_CLOCK_CHILD_LOOP_BASELINE);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^sweepLandingSteps arms 1 wall-clock bound\(s\) on an async child and is reachable from the daemon loop/);

  // A setTimeout that kills a spawned child is named too.
  const killed = fns.map((f) =>
    f.name === "sweepLandingSteps"
      ? { ...f, body: f.body + '\n  const c = spawn("git", ["fetch"]);\n  setTimeout(() => c.kill("SIGTERM"), 1000);' }
      : f,
  );
  assert.match(refusals(killed, WALL_CLOCK_CHILD_LOOP_BASELINE)[0] ?? "", /^sweepLandingSteps arms 1 wall-clock bound/);

  // A sync call's own `timeout` does not count, and neither does a seam default that shadows the async name.
  for (const body of [
    '  execFileSync("git", ["status"], { timeout: 1000 });',
    '  spawnSync("git", ["status"], { encoding: "utf8", timeout: 1000 });',
    '  function f(execFile = execFileSync) { return execFile("git", [], { timeout: 1 }); }',
  ]) {
    assert.equal(wallClockChildArms({ name: "x", file: "x", body }, ["execFile", "spawn", "fork"]), 0, body);
  }
  // The loop-bounded helpers are the cure, not a site.
  for (const body of [
    '  await execFileLoopBounded("git", ["status"], { encoding: "utf8", timeout: 1000 });',
    '  const c = spawn("git", ["fetch"]); boundChildByLoopTime(c, 1000);',
  ]) {
    assert.equal(wallClockChildArms({ name: "x", file: "x", body }, ["execFile", "spawn", "fork"]), 0, body);
  }
  // A promisified alias and an import alias are child calls under the name the file gives them.
  const src = 'import { execFile, spawn as spawnChild } from "node:child_process";\nconst run = promisify(execFile);\n';
  const names = asyncChildNames(src);
  assert.ok(names.includes("spawnChild") && names.includes("run"), `aliases found: ${names.join(",")}`);
  assert.equal(wallClockChildArms({ name: "x", file: "x", body: '  await run("git", [], { timeout: 1 });' }, names), 1);

  // A seam typed as, or defaulting to, the promisified child is a child call (ghStdoutAsync/ghTextAsync's shape).
  for (const body of [
    '  async function g(args, execAsync: typeof run) { return execAsync("gh", args, { timeout: 1 }); }',
    '  async function g(args, execAsync: Executor = run) { return execAsync("gh", args, { timeout: 1 }); }',
    '  async function g(\n  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }> = run as never,\n) {\n  return exec("git", [], { timeout: 1 });\n}',
  ]) {
    assert.equal(wallClockChildArms({ name: "x", file: "x", body }, names), 1, body);
  }

  // A function the loop does NOT reach may arm one (CLI-only).
  const offLoop = [...fns, { name: "someCliOnlyVerb", file: "x", body: 'function someCliOnlyVerb() { execFile("x", [], { timeout: 1 }, cb); }' }];
  assert.deepEqual(refusals(offLoop, WALL_CLOCK_CHILD_LOOP_BASELINE), []);
});

test("a row above its real count is refused and names the row to delete", () => {
  const fns = topLevelFunctions({ objectLiterals: true });
  assert.deepEqual(refusals(fns, { ...WALL_CLOCK_CHILD_LOOP_BASELINE, ghTextAsync: 1 }), [
    `ghTextAsync arms 0 wall-clock bound(s) < row 1 — delete the \`ghTextAsync\` row from WALL_CLOCK_CHILD_LOOP_BASELINE (${BASELINE_FILE}) in this PR`,
  ]);
});

/** The pre-fix shape of ciLearningTaskIdMinter's async member (W1-T7742): a seam whose default WRAPS execFileLoopBounded,
 *  a re-arming setTimeout, and `controller.abort()` whose signal reaches the seam. No `.kill(` anywhere. */
const PRE_FIX_MINTER = `
  function mintLike(executeAsync: (file: string, args: string[], options: { timeout: number; signal: AbortSignal }) => Promise<{ stdout: string }> = (file, args, options) => execFileLoopBounded(file, args, { ...options, encoding: "utf8" })) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      const expire = () => {
        if (bound - (now() - started) > 0) { timer = setTimeout(expire, 1); return; }
        reject(new Error("timed out"));
        controller.abort();
      };
      timer = setTimeout(expire, bound);
    });
    return Promise.race([executeAsync(process.execPath, [], { timeout: bound, signal: controller.signal }), expired]);
  }`;

test("W1-T9703: the census names an AbortController-plus-timer kill of a daemon-reachable child", () => {
  const fns = topLevelFunctions({ objectLiterals: true });
  const reach = loopReachable(fns, "daemonCommand");
  assert.ok(reach.has("sweepLandingSteps"), "the walk reaches the function the shape is planted in");

  // Control on the real source: the minter's own body is counted 0 after the fix, and the table stays empty.
  assert.ok(fns.some((f) => f.name === "ciLearningTaskIdMinter"), "the minter is in the population");
  assert.deepEqual(refusals(fns, WALL_CLOCK_CHILD_LOOP_BASELINE), []);

  // Positive: the pre-fix shape, planted in a reached function, is named.
  const planted = fns.map((f) => (f.name === "sweepLandingSteps" ? { ...f, body: f.body + PRE_FIX_MINTER } : f));
  const named = refusals(planted, WALL_CLOCK_CHILD_LOOP_BASELINE);
  assert.equal(named.length, 1);
  assert.match(named[0]!, /^sweepLandingSteps arms 2 wall-clock bound\(s\) on an async child and is reachable from the daemon loop/);

  const childNames = ["execFile", "spawn", "fork"];
  // The seam may also be a bare child name, and the signal may go straight to a child call or a loop-bounded helper.
  for (const body of [
    '  const c = new AbortController(); setTimeout(() => c.abort(), 1000); await execFileLoopBounded("git", [], { signal: c.signal });',
    '  const c = new AbortController(); setTimeout(() => c.abort(), 1000); execFile("git", [], { signal: c.signal }, cb);',
    '  async function g(run: typeof execFile) { const c = new AbortController(); setTimeout(() => c.abort(), 1000); return run("git", [], { signal: c.signal }); }',
  ]) {
    assert.equal(wallClockChildArms({ name: "x", file: "x", body }, childNames), 1, body);
  }

  // Not counted: a controller whose signal reaches only a fetch, a stream or an in-process function.
  for (const body of [
    '  const c = new AbortController(); setTimeout(() => c.abort(), 1000); return fetch(url, { signal: c.signal });',
    '  const c = new AbortController(); const t = setTimeout(() => c.abort(), 1000); await refreshAnalytics({ signal: c.signal }); clearTimeout(t);',
    '  const c = new AbortController(); setTimeout(() => c.abort(), 1000); const s = createWriteStream(p, { signal: c.signal });',
    // A seam whose default is an in-process function, not a child.
    '  function m(read: (a: string, options: { signal: AbortSignal }) => Promise<string> = (a, options) => readFileText(a, options)) { const c = new AbortController(); setTimeout(() => c.abort(), 1000); return read("x", { signal: c.signal }); }',
    // A signal that is never aborted by a timer in the body.
    '  const c = new AbortController(); await execFileLoopBounded("git", [], { signal: c.signal });',
  ]) {
    assert.equal(wallClockChildArms({ name: "x", file: "x", body }, childNames), 0, body);
  }
});
