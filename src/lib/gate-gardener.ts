import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { systemClock } from "./clock.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec, Outcome } from "./gardener.js";
import { gateFireRatesPath, type GateFireRate, type GateFireRateReport } from "./gate-fire-rate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { resolveRepoLayout } from "./repo-layout.js";

/**
 * lib/gate-gardener.ts (W1-T4116) — the gates tend themselves.
 *
 * W1-T4115 measures how often each gate fires; nothing acted on it. Each pass proposes ONE class of
 * change as ONE pull request, every value taken from the ratchet's OWN measurement, never a guess:
 *   - TIGHTEN: a one-way ceiling the code has fallen below — a per-file source-size or comment-load
 *     row the ratchet itself would now record lower (its `shrunk`), or the contract-coverage ceiling
 *     above today's uncovered-route count.
 *   - REFRESH: a stale row — a per-file row for a file that no longer exists (the ratchet's
 *     `removed`), or the learnings baseline's recorded measurement that no longer matches the corpus.
 *     Its `capChars` headroom is deliberate and never touched.
 *   - DEMOTE: a REQUIRED gate that never refused across at least as many pull requests as a typical
 *     gate, moved to ADVISORY with a GATE_RATIONALE — a `review` class, judged by whether its PR merges.
 * TIGHTEN and REFRESH are judged by refusals repaired against refusals overridden across all gates.
 */

export type GateGardenClass = "tighten" | "refresh" | "demote";
export const GATE_GARDEN_CLASSES: readonly GateGardenClass[] = ["tighten", "refresh", "demote"];

export type GateEdit =
  | { kind: "row"; key: string; to: number | null }
  | { kind: "demote"; gate: string; rationale: string };

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
  cc: { CLIENT_SOURCES: string[]; BASELINE_PATH: string; routesCalled: (s: string[], read: (t: string) => string[]) => string[]; routesDeclared: (t: string) => string[]; uncovered: (c: string[], d: string[]) => string[] };
  lb: { loadCorpus: (d: string) => unknown[]; computeActiveChars: (e: unknown[]) => { chars: number; activeCount: number } };
  gm: { readGateLists: (t: string) => { required: Set<string> }; evaluateGateMonotonic: (b: unknown, h: unknown) => { ok: boolean; detail: string } };
}

export async function loadGateProbes(root: string): Promise<GateProbes> {
  const load = async <T>(rel: string) => (await import(pathToFileURL(join(root, rel)).href)) as T;
  return {
    ss: await load("scripts/source-size-ratchet.mjs"),
    cl: await load("scripts/comment-load-ratchet.mjs"),
    cc: await load("scripts/contract-coverage-ratchet.mjs"),
    lb: await load("scripts/learnings-budget-ratchet.mjs"),
    gm: await load("scripts/gate-monotonic-check.mjs"),
  };
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

/** TIGHTEN for the contract-coverage ceiling, counted with the ratchet's own route functions. */
function contractCandidates(root: string, { cc }: GateProbes): GateGardenAction[] {
  const readTree = (target: string) =>
    execFileSync("git", ["-C", root, "ls-files", "--", target], { encoding: "utf8" })
      .split("\n")
      .filter((p) => /\.(ts|tsx|js|mjs)$/.test(p))
      .map((p) => readFileSync(join(root, p), "utf8"));
  const count = cc.uncovered(cc.routesCalled(cc.CLIENT_SOURCES, readTree), cc.routesDeclared(readFileSync(join(root, "openapi/daemon.yaml"), "utf8"))).length;
  const ceiling = readJson(join(root, cc.BASELINE_PATH)).uncoveredCeiling;
  return typeof ceiling === "number" && count < ceiling
    ? [{ class: "tighten", target: `${cc.BASELINE_PATH}#uncoveredCeiling`, file: cc.BASELINE_PATH, edit: { kind: "row", key: "uncoveredCeiling", to: count }, reason: `${count} routes are uncovered today, under the ceiling of ${ceiling}.` }]
    : [];
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
  const candidates = [...ledgerCandidates(repoRoot, probes), ...contractCandidates(repoRoot, probes), ...learningsCandidates(repoRoot, probes), ...(demote ? [demote] : [])];
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
    for (const a of list) text = a.edit.kind === "row" ? editBaselineRow(text, a.edit.key, a.edit.to) : demoteInCiGate(text, a.edit.gate, a.edit.rationale);
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
  const proofs = actions.flatMap((a) =>
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
export function gateGardenSpec(deps: GardenerDeps, probes: GateProbes): GardenSpec<GateGardenClass, GateInventory, GateGardenAction, GardenCheckout> {
  const clock = deps.clock ?? systemClock;
  return {
    name: "gate",
    classes: GATE_GARDEN_CLASSES,
    review: { demote: "demoting a required gate stops it blocking merges, which is a judgement call." },
    cheapFingerprint: () => {
      const head = execFileSync("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const report = gateFireRatesPath(deps.stateDir);
      return `${head}:${existsSync(report) ? readFileSync(report, "utf8").length : 0}`;
    },
    inventory: () => gateInventory(deps.repoRoot, deps.stateDir, probes),
    fingerprint: (inv) => inv.candidates.map((a) => a.target).join(","),
    metric: (inv) => inv.tally,
    candidates: (inv) => inv.candidates,
    scorecard: (inv, plan) => ({ candidates: inv.candidates.length, tally: inv.tally, proposed: plan.actions.length }),
    apply: (ws, plan) => {
      const heading = `## Pass ${clock.iso()}`;
      const paths = applyGateActions(ws.root, plan.actions, heading, probes);
      return { paths, title: `chore(gates): the gate gardener proposes to ${plan.acting[0]} ${plan.actions.length} gate row(s)`, body: prBody(plan.actions, heading) };
    },
  };
}
