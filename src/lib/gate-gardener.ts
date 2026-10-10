import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { fixedClock, systemClock } from "./clock.js";
import { checkoutHeadStamp } from "./checkout-head.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec, Outcome } from "./gardener.js";
import { gateFireRatesPath, type GateFireRate, type GateFireRateReport } from "./gate-fire-rate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { defaultTestSlots, lowPriorityCommand, readHostLoad, testRunArgv, testRunConcurrency } from "./test-slot.js";
import { machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { loadPlan, loadPlanFromYaml, machineFilingAdmissionViolations } from "./plan.js";
import { loadPolicy } from "./policy.js";

/**
 * lib/gate-gardener.ts (W1-T4116) — the gates tend themselves.
 *
 * W1-T4115 measures how often each gate fires; nothing acted on it. Each pass proposes ONE class of
 * change as ONE pull request, every value taken from the ratchet's OWN measurement, never a guess:
 *   - TIGHTEN: a one-way ceiling the code has fallen below — a per-file source-size or comment-load
 *     row the ratchet itself would now record lower (its `shrunk`). (W1-T4583 retired the
 *     contract-coverage ceiling this also tightened.)
 *   - REFRESH: a stale row — a per-file row for a file that no longer exists (the ratchet's
 *     `removed`), or the learnings baseline's recorded measurement that no longer matches the corpus.
 *     Its `capChars` headroom is deliberate and never touched.
 *   - DEMOTE: a REQUIRED gate that never refused across at least as many pull requests as a typical
 *     gate, moved to ADVISORY with a GATE_RATIONALE — a `review` class, judged by whether its PR merges.
 * TIGHTEN and REFRESH are judged by refusals repaired against refusals overridden across all gates.
 * DEFUSE files a remedy for a fixture about to expire; that tally never measures it, so it is judged
 * by its PR's decision (W1-T5825).
 */

export type GateGardenClass = "tighten" | "refresh" | "demote" | "defuse";
export const GATE_GARDEN_CLASSES: readonly GateGardenClass[] = ["tighten", "refresh", "demote", "defuse"];
export const DEFUSE_LEAD_DAYS = 21;

interface ExpiringFixture {
  file: string; line: number; stamp: string; field: string; threshold: string;
  expiresAt: number; daysLeft: number;
}

export interface GateDefuseSources {
  thresholdDays?: number;
  leadDays?: number;
  openOrigins?: () => string[];
  mintTaskId?: (branch: string) => string;
  admissionViolations?: typeof machineFilingAdmissionViolations;
  execFile?: (command: string, args: string[], options: { cwd: string; encoding: "utf8" }) => string;
  /** Runs one test file with the clock shifted `shiftDays` ahead: true when it passes. Throws when
   *  the run reaches no verdict. Default {@link runSuiteShifted} in the repo checkout. */
  runSuite?: (file: string, shiftDays: number) => boolean;
}

/** W1-T6036: the control shift, nonzero so the control loads the same clock preload as the shifted run. */
export const DEFUSE_CONTROL_SHIFT_DAYS = 0.001;
export const DEFUSE_VERDICTS_FILE = "gate-gardener-defuse-verdicts.json";
const DEFUSE_RUN_TIMEOUT_MS = 15 * 60_000;
type DefuseVerdict = "confirmed" | "shifted_passed" | "control_failed";

/** Run `file` under the repo's own test invocation plus scripts/clock-shift.mjs. A nonzero exit is
 *  a red suite; a run killed or never started has no exit status and is rethrown, never read as red. */
export function runSuiteShifted(repoRoot: string, file: string, shiftDays: number): boolean {
  const env: NodeJS.ProcessEnv = { ...process.env, FK_SHIFT_DAYS: String(shiftDays) };
  delete env.RMD_SELF_SYNC_DONE; // the test setup refuses to load under it (W1-T3069)
  delete env.NODE_TEST_CONTEXT; // inherited from a parent `node --test`, it makes this run report nothing and exit 0
  const args = ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "--import", "./scripts/clock-shift.mjs", file];
  // Niced and bounded (test-slot.ts), but no host-wide slot: one file, and a gardener pass must not queue behind coverage.
  const load = readHostLoad();
  const child = lowPriorityCommand(process.execPath, testRunArgv(args, testRunConcurrency(load, defaultTestSlots(load.cores))));
  try {
    execFileSync(child.file, child.args, { cwd: repoRoot, env, stdio: "ignore", timeout: DEFUSE_RUN_TIMEOUT_MS });
    return true;
  } catch (e) {
    if (typeof (e as { status?: unknown }).status === "number") return false;
    throw e;
  }
}

export type GateEdit =
  | { kind: "row"; key: string; to: number | null }
  | { kind: "demote"; gate: string; rationale: string }
  | { kind: "defuse"; finding: ExpiringFixture; leadDays: number; urgent: boolean };

export interface GateGardenAction extends GardenAction<GateGardenClass> {
  /** Repo-relative file the edit lands in. */
  file: string;
  edit: GateEdit;
}

export interface GateInventory {
  candidates: GateGardenAction[];
  /** Repaired and overridden refusals, summed over every fire-rate measurement seen so far. */
  tally: Outcome;
}

export const CI_GATE_YML = ".github/workflows/ci-gate.yml";
export const GATE_GARDEN_LOG = "docs/gate-garden-log.md";

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;

interface LedgerVerdict {
  shrunk: Array<{ path: string; to: number }>;
  removed: string[];
}

/** The ratchets' own measurement and evaluation functions. They are ES modules under scripts/, so
 *  they load once, asynchronously, before the (synchronous) gardener runs. */
export interface GateProbes {
  ss: { listSourceFiles: (r: string) => string[]; countLines: (t: string) => number; evaluateSourceSizeRatchet: (c: Json, b: Json) => LedgerVerdict };
  cl: { listMeasuredFiles: (r: string) => string[]; countCommentLines: (t: string, p: string) => { comments: number }; evaluateCommentLoadRatchet: (c: Json, b: Json) => LedgerVerdict };
  lb: { loadCorpus: (d: string) => unknown[]; computeActiveChars: (e: unknown[]) => { chars: number; activeCount: number } };
  gm: { readGateLists: (t: string) => { required: Set<string> }; evaluateGateMonotonic: (b: unknown, h: unknown) => { ok: boolean; detail: string } };
  ef?: { MARGIN_DAYS: number; censusExpiringFixtures: (opts: { files: string[]; readFile: (path: string) => string; now: number; thresholdDays: number; marginDays: number }) => { reported: ExpiringFixture[] } };
}

export async function loadGateProbes(root: string): Promise<GateProbes> {
  const load = async <T>(rel: string) => (await import(pathToFileURL(join(root, rel)).href)) as T;
  return {
    ss: await load("scripts/source-size-ratchet.mjs"),
    cl: await load("scripts/comment-load-ratchet.mjs"),
    lb: await load("scripts/learnings-budget-ratchet.mjs"),
    gm: await load("scripts/gate-monotonic-check.mjs"),
    ef: await load("scripts/expiring-fixture-census.mjs"),
  };
}

function defuseCandidates(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources): GateGardenAction[] {
  if (!probes.ef) throw new Error("gate gardener: expiring-fixture census probe is missing");
  const run = (cmd: string, args: string[]): string => sources.execFile
    ? sources.execFile(cmd, args, { cwd: deps.repoRoot, encoding: "utf8" })
    : execFileSync(cmd, args, { cwd: deps.repoRoot, encoding: "utf8" });
  const leadDays = sources.leadDays ?? DEFUSE_LEAD_DAYS;
  const files = run("git", ["ls-files", "test/*.test.ts"]).trim().split("\n").filter(Boolean);
  if (files.length === 0) return [];
  const layout = resolveRepoLayout(deps.repoRoot);
  const { reported } = probes.ef.censusExpiringFixtures({
    files, readFile: (path) => readFileSync(join(deps.repoRoot, path), "utf8"),
    now: (deps.clock ?? systemClock).now(), thresholdDays: sources.thresholdDays ?? loadPolicy(join(layout.planDir, "policy.yaml")).values.sweep.staleDays,
    marginDays: leadDays,
  });
  const byFile = new Map<string, ExpiringFixture>();
  for (const f of reported) {
    const prior = byFile.get(f.file);
    if (!prior || f.expiresAt < prior.expiresAt) byFile.set(f.file, f);
  }
  if (byFile.size === 0) return [];
  const queued = existsSync(layout.planMonolith) ? loadPlan(layout.planMonolith).tasks.filter((t) => t.status === "queued" && !t.retirement).map((t) => t.origin) : [];
  const open = sources.openOrigins ? sources.openOrigins() : (JSON.parse(run("gh", ["pr", "list", "--state", "open", "--limit", "1000", "--json", "body"])) as Array<{ body: string }>).flatMap((pr) => [...pr.body.matchAll(/expiring-fixture:test\/[^\s"'`]+\.test\.ts/g)].map((m) => m[0]));
  const covered = new Set([...queued, ...open]);
  const runSuite = sources.runSuite ?? ((file: string, days: number) => runSuiteShifted(deps.repoRoot, file, days));
  return [...byFile.values()].flatMap((finding): GateGardenAction[] => {
    const target = `expiring-fixture:${finding.file}`;
    if (covered.has(target)) {
      deps.log("gate_garden.defuse_deferred", defuseEvidence(finding, leadDays));
      return [];
    }
    if (!confirmDefuse(deps, finding, run, runSuite)) return [];
    return [{ class: "defuse", target, file: finding.file,
      edit: { kind: "defuse", finding, leadDays, urgent: finding.daysLeft <= probes.ef!.MARGIN_DAYS },
      reason: `${finding.file}:${finding.line} crosses ${finding.threshold} on ${fixedClock(finding.expiresAt).iso()} (${leadDays}-day lead).` }];
  });
}

/**
 * W1-T6036: a field-name census is a CANDIDATE generator. Measured 2026-10-06, the widened census
 * named 22 `updated_at`/`updatedAt` rows that no threshold ages, so a finding is filed only when its
 * file passes at the control shift and fails shifted one day past the crossing. Anything else is
 * ledgered `gate_garden.defuse_unconfirmed`. A verdict is remembered per blob and crossing day; a
 * run with no verdict is ledgered `run_error` and retried next pass, never read as red.
 */
function confirmDefuse(deps: GardenerDeps, f: ExpiringFixture, run: (cmd: string, args: string[]) => string, runSuite: (file: string, days: number) => boolean): boolean {
  const crossingDate = fixedClock(f.expiresAt).iso();
  const evidence = { file: f.file, line: f.line, crossingDate };
  const path = join(deps.stateDir, DEFUSE_VERDICTS_FILE);
  const memo = (existsSync(path) ? readJson(path) : {}) as Record<string, DefuseVerdict>;
  const key = `${run("git", ["hash-object", "--", f.file]).trim()}:${crossingDate.slice(0, 10)}`;
  let verdict = memo[key];
  if (!verdict) {
    try {
      verdict = !runSuite(f.file, DEFUSE_CONTROL_SHIFT_DAYS) ? "control_failed"
        : runSuite(f.file, Math.ceil(f.daysLeft) + 1) ? "shifted_passed" : "confirmed";
    } catch (e) {
      deps.log("gate_garden.defuse_unconfirmed", { ...evidence, outcome: "run_error", error: String(e) });
      return false;
    }
    writeAtomic(path, JSON.stringify({ ...memo, [key]: verdict }, null, 2) + "\n");
    if (verdict !== "confirmed") deps.log("gate_garden.defuse_unconfirmed", { ...evidence, outcome: verdict });
  }
  return verdict === "confirmed";
}

function defuseEvidence(f: ExpiringFixture, leadDays: number): Record<string, unknown> {
  return { file: f.file, line: f.line, crossingDate: fixedClock(f.expiresAt).iso(), leadDays };
}

/** `s` as a BRE matching itself under the executor's `grep -arn`: one pass over a class holding the
 *  backslash, so an escape this adds is never itself re-escaped and a `\` in a path stays literal. */
function breLiteral(s: string): string {
  return s.replace(/[\\.*[^$]/g, "\\$&");
}

export function renderDefuseShard(action: GateGardenAction, taskId: string) {
  if (action.edit.kind !== "defuse") throw new Error("gate gardener: mixed defuse plan");
  const { finding: f, leadDays, urgent } = action.edit;
  const crossing = fixedClock(f.expiresAt).iso();
  const title = `${taskId}: ${f.file} stays defused across ${crossing}`;
  return renderMachineShard({
    taskId, title: `Defuse the expiring fixture in ${f.file} before ${crossing}`, origin: action.target,
    files: [f.file], cost: 1, costPopulation: urgent ? [0, 1] : [1],
    acceptance: [{ claim: `The census reports no crossing for ${f.file} with now past ${crossing}, and the test remains green across the crossing.`,
      proof: `grep: test("${breLiteral(title)}" in ${f.file}` }],
    rationale: [
      `${f.file}:${f.line}: ${f.field} is stamped ${f.stamp}; ${f.threshold} crosses on ${crossing}.`,
      `Found ${f.daysLeft} days before crossing using a ${leadDays}-day lead horizon.`,
      "Use an exemption only when this case is judged against an injected clock; prove it by ageing the fixture across the threshold and rerunning the test, as #8673 did.",
      "Otherwise make the stamp relative to the test's clock. Moving a fixed date only re-arms the fixture.",
      "Add the task's regression to this fixture file: run the census immediately before and after crossing, and run the affected case at both clocks.",
    ],
  });
}

function applyDefuseActions(ws: GardenCheckout, actions: GateGardenAction[], deps: GardenerDeps, sources: GateDefuseSources) {
  if (!ws.branch) throw new Error("gate gardener: filing workspace has no branch for task-id reservation");
  const paths: string[] = [];
  for (const action of actions) {
    const draft = renderDefuseShard(action, "NEW-1");
    if (draft.refused) throw new Error(`gate gardener: defuse shard refused (${draft.refused})`);
    const plan = loadPlanFromYaml(draft.text, "defuse-admission");
    const reasons = (sources.admissionViolations ?? machineFilingAdmissionViolations)(plan.tasks[0]!, {
      plan, releasedIds: new Set(), pathExists: (path) => existsSync(join(deps.repoRoot, path)),
    });
    if (reasons.length) throw new Error(`gate gardener: defuse shard refused (machine-filing-admission: ${reasons.join("; ")})`);
    const args = ["--import", "tsx", join(deps.repoRoot, "src/run-task.ts"), "next-task-id", "--reserve", "--branch", ws.branch];
    const output = sources.mintTaskId ? undefined : sources.execFile
      ? sources.execFile(process.execPath, args, { cwd: deps.repoRoot, encoding: "utf8" })
      : execFileSync(process.execPath, args, { cwd: deps.repoRoot, encoding: "utf8" });
    const taskId = sources.mintTaskId ? sources.mintTaskId(ws.branch) : /^RESERVED (W1-T\d+) on origin/m.exec(output!)?.[1];
    if (!taskId) throw new Error("gate gardener: task-id reservation returned no held id");
    const rendered = renderDefuseShard(action, taskId);
    if (rendered.refused) throw new Error(`gate gardener: defuse shard refused (${rendered.refused})`);
    const stem = action.file.replace(/^test\//, "").replace(/\.test\.ts$/, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const path = join(resolveRepoLayout(ws.root).planDir, "tasks.d", `${taskId}-defuse-${stem}.yaml`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, rendered.text);
    paths.push(relative(ws.root, path));
  }
  const land = ws.land.bind(ws);
  ws.land = (opts) => {
    const url = land(opts);
    if (url) for (const a of actions) {
      if (a.edit.kind === "defuse") deps.log("gate_garden.defuse_filed", defuseEvidence(a.edit.finding, a.edit.leadDays));
    }
    return url;
  };
  return { paths, title: `chore(plan): file ${actions.length} expiring fixture remedy task(s)`, body: [
    "The gate gardener files expiring fixture remedies before the CI margin.", "", "## Acceptance",
    ...actions.flatMap((a, i) => [`- claim: ${a.target} has a machine-filed remedy`, `  proof: grep: ${a.target} in ${paths[i]}`]),
  ].join("\n") };
}

/** TIGHTEN and REFRESH rows for the two per-file ledgers, from each ratchet's own evaluation. */
function ledgerCandidates(root: string, { ss, cl }: GateProbes): GateGardenAction[] {
  const measured: Array<{ file: string; verdict: LedgerVerdict }> = [];
  const lines: Json = {};
  for (const p of ss.listSourceFiles(root)) lines[p] = ss.countLines(readFileSync(join(root, p), "utf8"));
  measured.push({ file: "scripts/source-size-baseline.json", verdict: ss.evaluateSourceSizeRatchet(lines, readJson(join(root, "scripts/source-size-baseline.json"))) });
  const comments: Json = {};
  for (const p of cl.listMeasuredFiles(root)) comments[p] = cl.countCommentLines(readFileSync(join(root, p), "utf8"), p).comments;
  measured.push({ file: "scripts/comment-load-baseline.json", verdict: cl.evaluateCommentLoadRatchet(comments, readJson(join(root, "scripts/comment-load-baseline.json"))) });
  return measured.flatMap(({ file, verdict }) => [
    ...verdict.shrunk.map((s): GateGardenAction => ({ class: "tighten", target: `${file}#${s.path}`, file, edit: { kind: "row", key: s.path, to: s.to }, reason: `The file shrank a whole bucket; the ratchet now records ${s.to}.` })),
    ...verdict.removed.map((path): GateGardenAction => ({ class: "refresh", target: `${file}#${path}`, file, edit: { kind: "row", key: path, to: null }, reason: "The file no longer exists." })),
  ]);
}

/** REFRESH for the learnings baseline's recorded measurement; the cap is left alone. */
function learningsCandidates(root: string, { lb }: GateProbes): GateGardenAction[] {
  const file = "scripts/learnings-budget-baseline.json";
  const now = lb.computeActiveChars(lb.loadCorpus(resolveRepoLayout(root).learningsDir));
  const recorded = readJson(join(root, file));
  const rows: Array<[string, number]> = [["measuredChars", now.chars], ["measuredActiveEntries", now.activeCount]];
  return rows
    .filter(([key, value]) => typeof recorded[key] === "number" && recorded[key] !== value)
    .map(([key, value]) => ({ class: "refresh", target: `${file}#${key}`, file, edit: { kind: "row", key, to: value }, reason: `The recorded ${key} is ${String(recorded[key])}; the corpus measures ${value}.` }));
}

/** DEMOTE: the REQUIRED gate that never refused over at least the median number of pull requests a
 *  gate is seen on, costing the most minutes — one per pass, since each is a person's decision. */
export function demotionCandidate(report: GateFireRateReport & { measuredAt?: string }, required: Set<string>): GateGardenAction | undefined {
  if (report.status !== "measured") return undefined;
  const prs = report.gates.map((g) => g.prs).sort((a, b) => a - b);
  const typical = prs[Math.floor(prs.length / 2)] ?? 0;
  const quiet = report.gates
    .filter((g) => report.neverFired.includes(g.gate) && required.has(g.gate) && g.prs >= typical)
    .sort((a, b) => b.minutes - a.minutes || b.prs - a.prs);
  const g: GateFireRate | undefined = quiet[0];
  if (!g) return undefined;
  const rationale = `W1-T4116 gate gardener: ${g.gate} refused 0 of ${g.runs} runs on ${g.prs} pull requests (measured ${report.measuredAt ?? "unknown"}, ${g.minutes} min).`;
  return { class: "demote", target: g.gate, file: CI_GATE_YML, edit: { kind: "demote", gate: g.gate, rationale }, reason: `It never refused on ${g.prs} pull requests and cost ${g.minutes} CI minutes.` };
}

/** Fold each NEW fire-rate measurement into a running tally once, so the metric only grows. */
export function updateTally(stateDir: string, report: (GateFireRateReport & { measuredAt?: string }) | undefined): Outcome {
  const path = join(stateDir, "gate-gardener-tally.json");
  const tally = existsSync(path) ? (readJson(path) as { seen: string[]; trials: number; successes: number }) : { seen: [], trials: 0, successes: 0 };
  if (report?.status === "measured" && report.measuredAt && !tally.seen.includes(report.measuredAt)) {
    for (const g of report.gates) {
      tally.trials += g.repaired + g.overridden;
      tally.successes += g.repaired;
    }
    tally.seen.push(report.measuredAt);
    writeAtomic(path, JSON.stringify(tally, null, 2) + "\n");
  }
  return { trials: tally.trials, successes: tally.successes };
}

export function gateInventory(repoRoot: string, stateDir: string, probes: GateProbes): GateInventory {
  const reportPath = gateFireRatesPath(stateDir);
  const report = existsSync(reportPath) ? (readJson(reportPath) as unknown as GateFireRateReport & { measuredAt?: string }) : undefined;
  // The REQUIRED list, read by the gate-monotonic check itself.
  const required = probes.gm.readGateLists(readFileSync(join(repoRoot, CI_GATE_YML), "utf8")).required;
  const demote = report ? demotionCandidate(report, required) : undefined;
  const candidates = [...ledgerCandidates(repoRoot, probes), ...learningsCandidates(repoRoot, probes), ...(demote ? [demote] : [])];
  return { candidates, tally: updateTally(stateDir, report) };
}

/** Move one gate from REQUIRED to ADVISORY in ci-gate.yml and set a fresh GATE_RATIONALE. */
export function demoteInCiGate(text: string, gate: string, rationale: string): string {
  const listRe = (name: string) => new RegExp(`(^ {6}${name}: >-\\n {8}\\[\\n)([\\s\\S]*?)(\\n {8}\\])`, "m");
  const items = (body: string) => body.split("\n").map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
  const render = (list: string[]) => list.map((q, i) => `        ${q}${i < list.length - 1 ? "," : ""}`).join("\n");
  const quoted = JSON.stringify(gate);
  const req = listRe("REQUIRED").exec(text);
  const adv = listRe("ADVISORY").exec(text);
  if (!req || !adv || !items(req[2]!).includes(quoted)) throw new Error(`ci-gate.yml: ${gate} is not in a readable REQUIRED list`);
  let out = text.replace(listRe("REQUIRED"), (_m, a: string, b: string, c: string) => a + render(items(b).filter((q) => q !== quoted)) + c);
  out = out.replace(listRe("ADVISORY"), (_m, a: string, b: string, c: string) => a + render([...items(b), quoted]) + c);
  const line = `      GATE_RATIONALE: ${JSON.stringify(rationale)}`;
  return /^ {6}GATE_RATIONALE: .*$/m.test(out) ? out.replace(/^ {6}GATE_RATIONALE: .*$/m, line) : out.replace(/^( {6}ADVISORY: >-)$/m, `${line}\n$1`);
}

/** Set (or, for `null`, remove) one numeric row, editing only that line when the file does not
 *  round-trip through JSON.stringify unchanged. */
export function editBaselineRow(text: string, key: string, to: number | null): string {
  const parsed = JSON.parse(text) as Json;
  if (JSON.stringify(parsed, null, 2) + "\n" === text) {
    if (to === null) delete parsed[key];
    else parsed[key] = to;
    return JSON.stringify(parsed, null, 2) + "\n";
  }
  if (to === null) throw new Error(`cannot remove ${key} from a baseline that does not round-trip`);
  const re = new RegExp(`("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*)-?\\d+(?:\\.\\d+)?`);
  if (!re.test(text)) throw new Error(`no numeric row ${key}`);
  return text.replace(re, `$1${to}`);
}

function logSection(heading: string, actions: GateGardenAction[]): string {
  return ["", heading, "", ...actions.map((a) => `- ${a.class} ${a.target}: ${a.reason}`), ""].join("\n");
}

export function applyGateActions(root: string, actions: GateGardenAction[], heading: string, { gm }: GateProbes): string[] {
  const byFile = new Map<string, GateGardenAction[]>();
  for (const a of actions) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  for (const [file, list] of byFile) {
    let text = readFileSync(join(root, file), "utf8");
    for (const a of list) {
      if (a.edit.kind === "defuse") throw new Error("defuse actions require machine filing");
      text = a.edit.kind === "row" ? editBaselineRow(text, a.edit.key, a.edit.to) : demoteInCiGate(text, a.edit.gate, a.edit.rationale);
    }
    if (file === CI_GATE_YML) {
      // The gate-monotonic check itself must read the result as a REVIEWED demotion.
      const verdict = gm.evaluateGateMonotonic(gm.readGateLists(readFileSync(join(root, file), "utf8")), gm.readGateLists(text));
      if (!verdict.ok) throw new Error(`gate-monotonic would refuse: ${verdict.detail}`);
    }
    writeFileSync(join(root, file), text);
  }
  const logPath = join(root, GATE_GARDEN_LOG);
  const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "# Gate garden log\n\nEach section is one pass of the gate gardener (W1-T4116).\n";
  writeAtomic(logPath, prior.replace(/\n*$/, "\n") + logSection(heading, actions));
  return [...byFile.keys(), GATE_GARDEN_LOG].sort();
}

function prBody(actions: GateGardenAction[], heading: string): string {
  const proofs = actions.flatMap((a) => a.edit.kind === "defuse" ? [] :
    a.edit.kind === "demote"
      ? [`- claim: ${a.edit.gate} is moved to ADVISORY with a reviewed rationale`, `  proof: grep: GATE_RATIONALE: "W1-T4116 gate gardener: ${a.edit.gate} refused 0 in ${CI_GATE_YML}`]
      : a.edit.to === null
        ? []
        : [`- claim: ${a.target} records ${a.edit.to}`, `  proof: grep: "${a.edit.key}": ${a.edit.to} in ${a.file}`],
  );
  return [
    "The gate gardener (W1-T4116) tends the repo's gates from their own measurements.",
    "",
    ...actions.map((a) => `- **${a.class}** \`${a.target}\`: ${a.reason}`),
    "",
    "## Acceptance",
    "- claim: this pass is recorded in the gate garden log",
    `  proof: grep: ^${heading}$ in ${GATE_GARDEN_LOG}`,
    ...proofs,
  ].join("\n");
}

/** The repo's gates as a gardener spec, over probes loaded by {@link loadGateProbes}. */
export function gateGardenSpec(deps: GardenerDeps, probes: GateProbes, sources: GateDefuseSources = {}): GardenSpec<GateGardenClass, GateInventory, GateGardenAction, GardenCheckout> {
  const clock = deps.clock ?? systemClock;
  return {
    name: "gate",
    landingRefusal: machineShardLandingGuard({ ...deps, admissionViolations: sources.admissionViolations }),
    classes: GATE_GARDEN_CLASSES,
    review: { demote: "demoting a required gate stops it blocking merges, which is a judgement call." },
    decision: ["defuse"],
    cheapFingerprint: () => {
      const head = checkoutHeadStamp(deps.repoRoot, clock);
      const report = gateFireRatesPath(deps.stateDir);
      return `${head}:${existsSync(report) ? readFileSync(report, "utf8").length : 0}:${clock.iso().slice(0, 10)}`;
    },
    inventory: () => {
      const inv = gateInventory(deps.repoRoot, deps.stateDir, probes);
      if (!existsSync(join(deps.stateDir, "GATE_OFF-defuse"))) inv.candidates.push(...defuseCandidates(deps, probes, sources));
      return inv;
    },
    fingerprint: (inv) => inv.candidates.map((a) => a.target).join(","),
    metric: (inv) => inv.tally,
    candidates: (inv) => inv.candidates,
    scorecard: (inv, plan) => ({ candidates: inv.candidates.length, tally: inv.tally, proposed: plan.actions.length }),
    apply: (ws, plan) => {
      if (plan.acting[0] === "defuse") return applyDefuseActions(ws, plan.actions, deps, sources);
      const heading = `## Pass ${clock.iso()}`;
      const paths = applyGateActions(ws.root, plan.actions, heading, probes);
      return { paths, title: `chore(gates): the gate gardener proposes to ${plan.acting[0]} ${plan.actions.length} gate row(s)`, body: prBody(plan.actions, heading) };
    },
  };
}
