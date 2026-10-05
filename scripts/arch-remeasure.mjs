#!/usr/bin/env node
// scripts/arch-remeasure.mjs — W1-T5059: the plan-complete re-measure instrument (Phase 4 design §9, P4-T20).
//
// TWO MODES, BOTH GENTLE AND READ-ONLY:
//   probe    sequential GETs, a 3 s gap, aborting (exit 3) after two consecutive `runtime.loop_lag` windows
//            over 10 s. The read token is read in-process from `<stateDir>/service-tokens.json` and is NEVER
//            printed; response bodies are hashed, never stored.
//   recount  independent recounts over the LEDGER UNION in all three rotation forms, compared with the `now`
//            view: (a) today's merges distinct by PR vs `recent.mergedToday.count`; (b) in-flight runs vs
//            `board.counts.running`; (c) open grill entries vs `decisions[kind=grill]` (corpus: the FEEDBACK
//            STORE, not the ledger). One JSON line per recount, then a summary line.
//
// THE CONTROL (doctrine: "the rotations come in two forms" / "the control must prove each form was read"):
// file DISCOVERY is one directory listing classified by form, kept separate from the READER, which counts the
// files it actually read per form. A form PRESENT on disk that contributed ZERO files to the read is glob
// blindness: the recount refuses with `oracle_blind` and exits 2. A form with no files on disk is reported
// `absent (0 on disk)` and is NOT refused — the production host measured 398 .gz, 0 plain, 1 live, so
// "any form has zero files" would refuse every real run.
//
// DEPENDENCY-FREE ON PURPOSE: node builtins only, so the file can be copied to a host without a checkout.
// `yaml` is used for the feedback store when importable, else a top-level-key scanner (labelled in output).
//
// USAGE:
//   node scripts/arch-remeasure.mjs recount [--state-dir D] [--now-file F | --host H] [--plan-root R] [--feedback-root R]
//   --plan-root and --feedback-root default to this file's checkout. They must name the checkout the VIEW reads: on the
//   production host that is the managed checkout (`<config.root>/repos/remudero`), not serve's own repo mount —
//   measured 2026-10-05, the serve mount's plan was two days behind (17 vs 74 merges) and its feedback store one
//   grill entry short.
//   node scripts/arch-remeasure.mjs probe   [--state-dir D] [--host H] [--routes a,b] [--sweeps N] [--out F]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";

export const FORMS = ["gz", "plain", "live"];
export const ORACLE_BLIND = "oracle_blind";
export const ABSENT = "absent (0 on disk)";
export const LAG_WINDOW_LIMIT_MS = 10_000;
export const LAG_ABORT_STREAK = 2;
export const PROBE_GAP_MS = 3_000;
/** status.ts DEFAULT_LIVENESS_BOUND_MS: a ledger-only in-flight trace is "running" only within this of its last activity. */
export const LIVENESS_BOUND_MS = 30 * 60_000;
/** status.ts LANE_START_STEPS: any of these opens a fresh in-flight run for its task. */
export const START_STEPS = new Set(["run.start", "daemon.start", "drain.start", "plan.start", "retro.start", "serve.start", "triage.start"]);
/** status.ts LANE_TERMINAL_STEPS, plus `verdict.merged` (deriveStatus's merged-is-terminal precedence, read from the ledger). */
export const TERMINAL_STEPS = new Set(["verdict", "verdict.merged", "run.error", "daemon.stop", "daemon.summary", "drain.stop", "drain.summary",
  "plan.verdict", "plan.error", "retro.error", "serve.stop", "triage.error"]);

// ── discovery (the census of what is ON DISK) ──────────────────────────────────────────────────────────────

/** The rotation form a ledger file name belongs to, or null for anything else (e.g. `ledger.ndjson.carried.json`). */
export function classifyLedgerName(name) {
  if (name === "ledger.ndjson") return "live";
  if (/^ledger\..+\.ndjson\.gz$/.test(name)) return "gz";
  if (/^ledger\..+\.ndjson$/.test(name)) return "plain";
  return null;
}

/** One directory listing, classified by form: the PRESENT side of the control. */
export function discoverForms(names) {
  const present = { gz: [], plain: [], live: [] };
  for (const name of names) {
    const form = classifyLedgerName(name);
    if (form) present[form].push(name);
  }
  for (const form of FORMS) present[form].sort();
  return present;
}

/** The reader's selection: the three union globs `ledger.*.ndjson.gz ledger.*.ndjson ledger.ndjson`, oldest first, live last. */
export function selectUnionFiles(names) {
  const gz = names.filter((n) => /^ledger\..+\.ndjson\.gz$/.test(n));
  const plain = names.filter((n) => /^ledger\..+\.ndjson$/.test(n));
  return [...[...gz, ...plain].sort(), ...names.filter((n) => n === "ledger.ndjson")];
}

/** Files read per form vs files present per form. A present form that contributed zero files is blind. */
export function formControl(present, readCounts) {
  const forms = {};
  const blind = [];
  for (const form of FORMS) {
    const p = present[form]?.length ?? 0;
    const r = readCounts[form] ?? 0;
    forms[form] = { present: p, read: r, ...(p === 0 ? { state: ABSENT } : r === 0 ? { state: ORACLE_BLIND } : r < p ? { state: `partial (${p - r} unread)` } : {}) };
    if (p > 0 && r === 0) blind.push(form);
  }
  return { forms, blind };
}

// ── the reader ────────────────────────────────────────────────────────────────────────────────────────────

/** Lines of one ledger file, gunzipped when `.gz`. */
export async function* openLines(path) {
  const raw = createReadStream(path);
  const input = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  yield* createInterface({ input, crlfDelay: Infinity });
}

/** Keeps only lines a recount can use, so a 400-rotation union does not have to live in memory: rows naming a
 *  step the recounts read, plus every row stamped at or after `sinceIso` (liveness evidence for the running recount). */
export function relevantLine(sinceIso) {
  const tokens = ['"verdict', '"pr.opened"', ...[...START_STEPS, ...TERMINAL_STEPS].map((s) => `"${s}"`)];
  return (line) => {
    if (tokens.some((t) => line.includes(t))) return true;
    const at = line.indexOf('"ts":"');
    return at >= 0 && line.slice(at + 6, at + 30) >= sinceIso;
  };
}

/** Reads `files` (names in `dir`), deduping rows by EXACT line — rotations duplicate heavily. Counts a file as read
 *  per form only once its stream completes. Never throws on one bad file: it is listed in `unreadable`. */
export async function readUnion(dir, files, { keep = () => true, open = openLines } = {}) {
  const seen = new Set();
  const rows = [];
  const read = { gz: 0, plain: 0, live: 0 };
  const unreadable = [];
  let rawLines = 0;
  for (const name of files) {
    const form = classifyLedgerName(name);
    try {
      for await (const line of open(join(dir, name))) {
        rawLines += 1;
        if (!line || seen.has(line) || !keep(line)) continue;
        seen.add(line);
        try { rows.push(JSON.parse(line)); } catch { /* a torn line is not a row */ }
      }
      if (form) read[form] += 1;
    } catch (error) {
      unreadable.push(`${name}: ${error?.message ?? error}`);
    }
  }
  rows.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  return { rows, read, unreadable, rawLines, distinctLines: seen.size };
}

// ── the recounts (pure) ─────────────────────────────────────────────────────────────────────────────────

/** now-view.ts mergedTodayCount, recounted: merges today (UTC) keyed task_id|pr_url, pr_url from the row or the
 *  run's `pr.opened`. `planIds` null means the plan could not be loaded: compared WITHOUT the plan filter. */
export function recountMergedToday(rows, { nowMs, planIds }) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const prByRun = new Map();
  const merges = new Set();
  for (const row of rows) {
    if (row.step === "pr.opened" && typeof row.run_id === "string" && typeof row.pr_url === "string") prByRun.set(row.run_id, row.pr_url);
    const merged = (row.step === "verdict" && row.verdict === "merged") || row.step === "verdict.merged";
    if (!merged || typeof row.ts !== "string" || !row.ts.startsWith(day) || typeof row.task_id !== "string") continue;
    if (planIds && !planIds.has(row.task_id)) continue;
    const prUrl = typeof row.pr_url === "string" ? row.pr_url : typeof row.run_id === "string" ? prByRun.get(row.run_id) : undefined;
    merges.add(`${row.task_id}|${prUrl ?? ""}`);
  }
  return { count: merges.size, day };
}

/** board.ts isRunningRow (a live run `phase`), recounted from rows: per task, the LATEST start step with no later
 *  terminal step, and own-run activity within the liveness bound of `nowMs`. The board's other two liveness
 *  disjuncts (an open PR, a live inflight lock) and its blocked precedence are NOT in the ledger — named in `caveats`. */
export function recountRunning(rows, { nowMs, planIds, livenessBoundMs = LIVENESS_BOUND_MS }) {
  const runs = new Map();
  for (const row of rows) {
    const taskId = row.task_id;
    if (typeof taskId !== "string" || typeof row.step !== "string") continue;
    if (START_STEPS.has(row.step)) {
      runs.set(taskId, { inFlight: true, runId: row.run_id, lastTs: row.ts });
      continue;
    }
    const run = runs.get(taskId);
    if (!run) continue;
    if (run.inFlight && row.run_id === run.runId && typeof row.ts === "string") run.lastTs = row.ts;
    if (TERMINAL_STEPS.has(row.step)) run.inFlight = false;
  }
  const running = [];
  for (const [taskId, run] of runs) {
    if (!run.inFlight || (planIds && !planIds.has(taskId))) continue;
    const last = Date.parse(run.lastTs ?? "");
    if (Number.isFinite(last) && nowMs - last <= livenessBoundMs) running.push(taskId);
  }
  return { count: running.length, tasks: running.sort() };
}

/** now-decisions.ts grillDecisions, recounted: `grilling` entries with a string id and no answer (human-gate.ts
 *  feedbackHasAnswer: `answered_by`, or a reply naming it with non-empty `raw`). */
export function recountOpenGrill(entries) {
  const open = entries.filter((e) => e?.status === "grilling" && typeof e.id === "string" &&
    !(e.answered_by || entries.some((r) => r?.reply_to === e.id && typeof r.raw === "string" && r.raw.trim().length > 0)));
  return { count: open.length, ids: open.map((e) => e.id) };
}

/** The `now` view's own numbers, from the served envelope `{generatedAt, data}` or a bare body. */
export function expectedFromNow(body) {
  const data = body?.data ?? body;
  const decisions = Array.isArray(data?.decisions) ? data.decisions : null;
  return {
    asOfMs: Date.parse(body?.generatedAt ?? "") || null,
    mergedToday: data?.recent?.mergedToday?.count ?? null,
    mergedTodayDay: data?.recent?.mergedToday?.day ?? null,
    running: data?.board?.counts?.running ?? null,
    grill: decisions ? decisions.filter((d) => d?.kind === "grill").length : null,
    grillIds: decisions ? decisions.filter((d) => d?.kind === "grill").map((d) => String(d.id ?? "").replace(/^grill:/, "")).sort() : [],
    runningTasks: Array.isArray(data?.board?.tasks) ? data.board.tasks.filter((t) => t?.phase != null).map((t) => t.taskId).sort() : [],
    grillUnavailable: data?.decisionsReasons?.grill ?? null,
    decisionsMore: data?.decisionsMore ?? 0,
  };
}

/** Plan task ids from `plan/tasks.yaml` and `plan/tasks.d/*.yaml` by their `- id:` lines, or a reason. */
export function loadPlanIds(planRoot, { list = readdirSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    const dir = join(planRoot, "plan");
    const files = [join(dir, "tasks.yaml"), ...list(join(dir, "tasks.d")).filter((f) => f.endsWith(".yaml")).map((f) => join(dir, "tasks.d", f))];
    const ids = new Set();
    for (const file of files) for (const m of read(file).matchAll(/^\s*-\s+id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) ids.add(m[1]);
    if (ids.size === 0) return { reason: `no task ids under ${dir}` };
    return { ids };
  } catch (error) {
    return { reason: `the plan is unreadable: ${error?.message ?? error}` };
  }
}

/** A minimal reader for the feedback entry fields the grill recount needs, used only when `yaml` is not importable. */
export function scanFeedbackFields(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) body.push(lines[++i].trim());
      value = body.join("\n").trim();
    } else value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (value === "null" || value === "~") value = null;
    out[m[1]] = value;
  }
  return out;
}

/** Every `<root>/plan/feedback/*.yaml` entry, with the per-file control the ledger recounts get. */
export async function readFeedbackStore(root, { list = readdirSync, read = (p) => readFileSync(p, "utf8"), parse } = {}) {
  const dir = join(root, "plan", "feedback");
  let parser = parse;
  let parserName = "injected";
  if (!parser) {
    try { const yaml = await import("yaml"); parser = (t) => yaml.parse(t); parserName = "yaml"; }
    catch { parser = scanFeedbackFields; parserName = "top-level-key scanner"; }
  }
  let names;
  try { names = list(dir).filter((f) => f.endsWith(".yaml")).sort(); } catch (error) { return { reason: `the feedback store is unreadable: ${error?.message ?? error}`, dir }; }
  const entries = [];
  const unreadable = [];
  for (const name of names) {
    try { entries.push(parser(read(join(dir, name)))); } catch (error) { unreadable.push(`${name}: ${error?.message ?? error}`); }
  }
  return { dir, entries, parser: parserName, present: names.length, read: entries.length, unreadable };
}

// ── the recount run ─────────────────────────────────────────────────────────────────────────────────────

function verdict(expected, observed) {
  return expected === null || expected === undefined ? null : expected === observed;
}

/** Runs all three recounts. Returns the JSON lines and the exit code; never prints. */
export async function runRecounts({ stateDir, nowBody, planIds, planReason, feedbackRoot, nowMs,
  listDir = readdirSync, select = selectUnionFiles, open = openLines, feedback = readFeedbackStore }) {
  const expected = expectedFromNow(nowBody);
  const asOfMs = expected.asOfMs ?? nowMs;
  const names = listDir(stateDir);
  const present = discoverForms(names);
  const sinceIso = new Date(asOfMs - LIVENESS_BOUND_MS).toISOString();
  const union = await readUnion(stateDir, select(names), { keep: relevantLine(sinceIso), open });
  const control = formControl(present, union.read);
  const blindNote = control.blind.length ? { refused: ORACLE_BLIND, blindForms: control.blind } : {};
  const planNote = planIds ? { planFilter: "applied" } : { planFilter: `unavailable — compared without the plan filter (${planReason ?? "no plan"})` };
  const corpus = { corpus: "ledger union", rawLines: union.rawLines, distinctRelevantLines: union.distinctLines, ...(union.unreadable.length ? { unreadable: union.unreadable } : {}) };
  const lines = [];

  const merged = recountMergedToday(union.rows, { nowMs: asOfMs, planIds });
  lines.push({ recount: "merged_today", expected: expected.mergedToday, observed: merged.count, day: merged.day,
    match: control.blind.length ? null : verdict(expected.mergedToday, merged.count), forms: control.forms, ...corpus, ...planNote, ...blindNote });

  const running = recountRunning(union.rows, { nowMs: asOfMs, planIds });
  lines.push({ recount: "running", expected: expected.running, observed: running.count, tasks: running.tasks, expectedTasks: expected.runningTasks,
    match: control.blind.length ? null : verdict(expected.running, running.count), forms: control.forms, ...corpus, ...planNote, ...blindNote,
    terminalSteps: [...TERMINAL_STEPS], startSteps: [...START_STEPS], livenessBoundMs: LIVENESS_BOUND_MS,
    caveats: ["the board also counts a run backed only by an open PR or a live inflight lock (not in the ledger)",
      "a GitHub-blocked or GitHub-merged task is not running on the board; only ledger verdicts are seen here",
      "fix-lane rows extend the board's liveness; this recount reads only the run's own run_id"] });

  if (!feedbackRoot) {
    lines.push({ recount: "open_grill", expected: expected.grill, observed: null, match: null, corpus: "feedback store", reason: "no --feedback-root" });
  } else {
    const store = await feedback(feedbackRoot);
    if ("reason" in store) {
      lines.push({ recount: "open_grill", expected: expected.grill, observed: null, match: null, corpus: "feedback store", reason: store.reason });
    } else {
      const grill = recountOpenGrill(store.entries);
      const storeBlind = store.present > 0 && store.read === 0;
      if (storeBlind) control.blind.push("feedback-store");
      const capped = expected.decisionsMore > 0;
      lines.push({ recount: "open_grill", expected: expected.grill, observed: grill.count, ids: grill.ids, expectedIds: expected.grillIds,
        match: storeBlind ? null : capped && expected.grill !== grill.count ? null : verdict(expected.grill, grill.count),
        corpus: "feedback store (NOT the ledger)", dir: store.dir, parser: store.parser,
        forms: { yaml: { present: store.present, read: store.read, ...(store.present === 0 ? { state: ABSENT } : storeBlind ? { state: ORACLE_BLIND } : {}) } },
        ...(storeBlind ? { refused: ORACLE_BLIND, blindForms: ["feedback-store"] } : {}),
        ...(store.unreadable.length ? { unreadable: store.unreadable } : {}),
        ...(capped ? { note: `decisions is display-capped (decisionsMore=${expected.decisionsMore}); a mismatch is indeterminate` } : {}),
        ...(expected.grillUnavailable ? { expectedUnavailable: expected.grillUnavailable } : {}),
        caveats: ["the view reconciles entries against GitHub (projectReconciledFeedback); this recount reads the store as-is"] });
    }
  }
  const summary = { summary: true, asOf: new Date(asOfMs).toISOString(), stateDir,
    matched: lines.filter((l) => l.match === true).length, mismatched: lines.filter((l) => l.match === false).length,
    indeterminate: lines.filter((l) => l.match === null).length, oracle_blind: control.blind };
  lines.push(summary);
  return { lines, exitCode: control.blind.length ? 2 : 0 };
}

// ── the gentle probe ────────────────────────────────────────────────────────────────────────────────────

/** Folds new `runtime.loop_lag` rows into the consecutive-over-limit streak; rows before `sinceMs` or already seen are skipped. */
export function foldLagStreak(state, rows, sinceMs) {
  let { streak, seen } = state;
  for (const row of rows) {
    if (row?.step !== "runtime.loop_lag" || typeof row.ts !== "string" || seen.has(row.ts) || !(Date.parse(row.ts) > sinceMs)) continue;
    seen = new Set(seen).add(row.ts);
    streak = row.maxMs > LAG_WINDOW_LIMIT_MS ? streak + 1 : 0;
  }
  return { streak, seen };
}

/** The tail of the live ledger's `runtime.loop_lag` rows (last `bytes`), parsed. */
export function readLagTail(stateDir, bytes = 300_000) {
  const path = join(stateDir, "ledger.ndjson");
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split("\n").filter((l) => l.includes('"runtime.loop_lag"')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } finally { closeSync(fd); }
}

const TIMEISH = /(^|_)(ts|at|At|generated|generatedAt|generated_at|asOf|ageMs|age_ms|sampledAt|updatedAt|observedAt|fetchedAt|lastSeen)$/;
const stripTimes = (v) => Array.isArray(v) ? v.map(stripTimes) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIMEISH.test(k) && k !== "staleness").map(([k, x]) => [k, stripTimes(x)])) : v;
const sha = (x) => createHash("sha1").update(x).digest("hex").slice(0, 12);

/** Sequential probe: one GET at a time, `gapMs` apart; checks the lag streak before every request and aborts at
 *  {@link LAG_ABORT_STREAK}. Returns the hashed samples and whether it aborted; `emit` receives each sample. */
export async function runProbe({ routes, sweeps = 1, gapMs = PROBE_GAP_MS, cycleMs = 0, baseUrl, token, fetchImpl = fetch,
  readLagRows, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), emit = () => {} }) {
  const startedMs = now();
  let lag = foldLagStreak({ streak: 0, seen: new Set() }, readLagRows(), startedMs);
  const samples = [];
  for (let s = 1; s <= sweeps; s += 1) {
    const sweepStart = now();
    for (const route of routes) {
      lag = foldLagStreak(lag, readLagRows(), startedMs);
      if (lag.streak >= LAG_ABORT_STREAK) return { aborted: true, reason: `runtime.loop_lag over ${LAG_WINDOW_LIMIT_MS} ms for ${lag.streak} consecutive windows`, samples };
      const rec = { ts: new Date(now()).toISOString(), sweep: s, route };
      const t0 = now();
      try {
        const res = await fetchImpl(`${baseUrl}${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        Object.assign(rec, { ms: now() - t0, status: res.status, bytes: buf.length, hashAll: sha(buf), cache: res.headers.get("x-rmd-cache-state"), staleSrc: res.headers.get("x-rmd-stale-source") });
        try { const body = JSON.parse(buf.toString("utf8")); rec.hashData = sha(JSON.stringify(stripTimes(body))); if (typeof body?.stale === "boolean") rec.stale = body.stale; if (body?.error) rec.err = body.error; }
        catch { rec.nonjson = true; }
      } catch (error) {
        Object.assign(rec, { ms: now() - t0, error: String(error?.cause?.code ?? error?.name ?? error) });
      }
      samples.push(rec);
      emit(rec);
      await sleep(gapMs);
    }
    if (s < sweeps) await sleep(Math.max(0, cycleMs - (now() - sweepStart)));
  }
  return { aborted: false, samples };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The serve container's address — a DEFAULT only; `--host` overrides it. */
function discoverHost() {
  const ip = execFileSync("docker", ["inspect", "remudero-serve", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]).toString().trim();
  return `http://${ip}:4317`;
}

/** The read token, in-process only. Never logged, never returned to output. */
function readToken(stateDir) {
  const path = join(stateDir, "service-tokens.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).read : undefined;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    "state-dir": { type: "string", default: process.env.RMD_REMEASURE_STATE_DIR ?? join(homedir(), "Remudero", "state") },
    host: { type: "string" }, "now-file": { type: "string" }, "plan-root": { type: "string" }, "feedback-root": { type: "string" },
    routes: { type: "string", default: "/v1/views/now?instance=core" }, sweeps: { type: "string", default: "1" },
    "gap-ms": { type: "string", default: String(PROBE_GAP_MS) }, "cycle-ms": { type: "string", default: "150000" }, out: { type: "string" },
  } });
  const mode = positionals[0];
  const stateDir = values["state-dir"];
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  if (mode === "recount") {
    let nowBody;
    if (values["now-file"]) nowBody = JSON.parse(readFileSync(values["now-file"], "utf8"));
    else {
      const res = await fetch(`${values.host ?? discoverHost()}/v1/views/now?instance=core`, { headers: { authorization: `Bearer ${readToken(stateDir) ?? ""}` }, signal: AbortSignal.timeout(30_000) });
      nowBody = await res.json();
    }
    const plan = loadPlanIds(values["plan-root"] ?? repoRoot);
    const { lines, exitCode } = await runRecounts({ stateDir, nowBody, planIds: plan.ids ?? null, planReason: plan.reason,
      feedbackRoot: values["feedback-root"] ?? repoRoot, nowMs: Date.now() });
    for (const line of lines) out(JSON.stringify(line));
    if (exitCode !== 0) err(`${ORACLE_BLIND}: a rotation form present on disk contributed zero files: ${lines.at(-1).oracle_blind.join(", ")}`);
    return exitCode;
  }
  if (mode === "probe") {
    const result = await runProbe({ routes: values.routes.split(",").filter(Boolean), sweeps: Number(values.sweeps), gapMs: Number(values["gap-ms"]),
      cycleMs: Number(values["cycle-ms"]), baseUrl: values.host ?? discoverHost(), token: readToken(stateDir), readLagRows: () => readLagTail(stateDir),
      emit: (rec) => (values.out ? appendFileSync(values.out, `${JSON.stringify(rec)}\n`) : out(JSON.stringify(rec))) });
    out(JSON.stringify({ summary: true, aborted: result.aborted, ...(result.reason ? { reason: result.reason } : {}), samples: result.samples.length }));
    return result.aborted ? 3 : 0;
  }
  err("usage: arch-remeasure.mjs recount|probe [--state-dir D] [--host URL] [--now-file F] [--plan-root R] [--feedback-root R] [--routes a,b] [--sweeps N] [--out F]");
  return 64;
}

// Self-contained main guard (not scripts/lib/argv.mjs): this file must run when copied alone to a host.
const isMain = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ""); } catch { return false; } })();
if (isMain) process.exitCode = await main(process.argv.slice(2));
