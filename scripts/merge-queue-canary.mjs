/**
 * W1-T7736 — THE MERGE QUEUE IS REHEARSED ON A SCRATCH BRANCH BEFORE MAIN RE-ENABLES IT.
 *
 * Ruleset 24525891 (main's merge_queue rule) has been disabled since 2026-10-05, when its merge groups
 * timed out and the board went red. This harness gives the operator go/no-go evidence without touching
 * main's rules: it creates a scratch branch `mq-canary/<utc-date>` at main's head and a NEW ruleset whose
 * include list names ONLY that branch, carrying 24525891's merge_queue and required-check parameters (read,
 * never written). It then replays recent green PR heads as `mq-canary-replay/<pr>` PRs against the scratch
 * branch, enqueues each one, measures every merge group, and tears everything down in a `finally`.
 *
 * DRY RUN BY DEFAULT. Without `--live` the harness makes only reads. It builds and guards the ruleset
 * payload, sizes and picks the sample, and writes the report. Every GitHub call goes through one injected
 * seam ({@link createGhSeam}), so each step is testable with no network. Reads use the paced transport
 * (src/lib/github-transport.ts, the W1-T3275 read floor). Writes go through the same call pacer.
 * RMD_GH_COOLDOWN_S is never set here.
 *
 * Usage: node --import tsx scripts/merge-queue-canary.mjs [--live] [--report <path>] [--runner-slots N]
 */
import { writeFileSync } from "node:fs";
import { isMainModule, parseArgv } from "./lib/argv.mjs";
import { createGhCallPacer, ghExec, ghJson } from "../src/lib/github-transport.ts";

export const SOURCE_RULESET_ID = 24525891;
export const SCRATCH_PREFIX = "mq-canary/";
/** The head-ref prefix of every replay PR. src/lib/sweep.ts excludes PRs carrying it. */
export const REPLAY_PREFIX = "mq-canary-replay/";
const SCRATCH_RE = /^mq-canary\/\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/;
const MINUTE_MS = 60_000;
/** MEASURED 2026-10-27 over 24h of this repo's Actions jobs: 114 GitHub-hosted jobs ran at once with
 *  queue time p99 4 s, so the account's concurrency cap is at least that. The old default, 20, is the
 *  Free plan's documented cap and sized every dry run to zero groups. A floor, not a ceiling. */
export const DEFAULT_RUNNER_SLOTS = 114;
/** How many recent green pull_request CI runs price one group; the costliest of them is the price. */
export const GROUP_COST_SAMPLE_RUNS = 10;
/** Job statuses that hold or wait for a runner. */
const BUSY_JOB_STATUSES = new Set(["in_progress", "queued", "waiting", "pending"]);

export class RehearsalRefusal extends Error {
  constructor(reason) {
    super(`merge-queue canary refused: ${reason}`);
    this.name = "RehearsalRefusal";
  }
}

export class RehearsalInterrupted extends Error {
  constructor() {
    super("merge-queue canary interrupted before every group finished");
    this.name = "RehearsalInterrupted";
  }
}

export function scratchBranchName(nowMs) {
  return `${SCRATCH_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}`;
}

export function replayBranchName(prNumber) {
  return `${REPLAY_PREFIX}${prNumber}`;
}

/** Refuses, before any write, a ruleset payload that could reach any ref other than the scratch branch. */
export function assertRulesetTargetsOnlyScratch(payload, scratch) {
  if (!SCRATCH_RE.test(scratch)) throw new RehearsalRefusal(`"${scratch}" is not a mq-canary/<date> scratch branch`);
  if (payload?.target !== "branch") throw new RehearsalRefusal(`the ruleset targets "${payload?.target}", not a branch`);
  const include = payload?.conditions?.ref_name?.include;
  if (!Array.isArray(include) || include.length !== 1) {
    throw new RehearsalRefusal(`the include list must name exactly the scratch branch, got ${JSON.stringify(include)}`);
  }
  const ref = String(include[0]);
  if (ref.startsWith("~")) throw new RehearsalRefusal(`the include list names ${ref}, a pattern GitHub expands beyond the scratch branch`);
  if (/[*?[\]]/.test(ref)) throw new RehearsalRefusal(`the include list names the wildcard ${ref}`);
  if (/(^|\/)main$/.test(ref)) throw new RehearsalRefusal(`the include list names main (${ref})`);
  if (ref !== `refs/heads/${scratch}`) throw new RehearsalRefusal(`the include list names ${ref}, not refs/heads/${scratch}`);
  return payload;
}

/** The rehearsal ruleset: the source ruleset's merge_queue and required-check rules, scoped to the scratch branch. */
export function buildRehearsalRuleset(source, scratch) {
  const rule = (type) => source?.rules?.find((r) => r.type === type);
  const queue = rule("merge_queue");
  if (!queue) throw new RehearsalRefusal(`ruleset ${source?.id} carries no merge_queue rule to copy`);
  const checks = rule("required_status_checks");
  const rules = [{ type: "merge_queue", parameters: structuredClone(queue.parameters) }];
  if (checks) rules.push({ type: "required_status_checks", parameters: structuredClone(checks.parameters) });
  return assertRulesetTargetsOnlyScratch({
    name: `mq-canary rehearsal ${scratch} (W1-T7736)`,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${scratch}`], exclude: [] } },
    rules,
  }, scratch);
}

export function requiredContextsOf(payload) {
  const checks = payload.rules.find((r) => r.type === "required_status_checks");
  return (checks?.parameters?.required_status_checks ?? []).map((c) => c.context);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? undefined : s[Math.floor(s.length / 2)];
};

/**
 * The sample size comes from what was read first, never from a fixed count. The window offers
 * `freeJobSlots x windowMinutes` slot-minutes. One group costs the measured job-minutes of a CI run,
 * `budget.jobMinutesPerRun`; jobs x wall-clock counted skipped jobs and idle shards as runner time.
 * The queue builds at most `maxEntriesToBuild` of the groups at once.
 */
export function sizeSample({ candidates, budget, maxEntriesToBuild, windowMinutes }) {
  const slotMinutes = budget.freeJobSlots * windowMinutes;
  const groupCost = Number.isFinite(budget.jobMinutesPerRun) ? budget.jobMinutesPerRun : 0;
  const size = groupCost > 0 ? Math.min(candidates, Math.floor(slotMinutes / groupCost)) : 0;
  return { size, concurrent: Math.min(maxEntriesToBuild, size), slotMinutes, groupCost: groupCost > 0 ? groupCost : undefined };
}

/** Most recent first, led by the first pair whose changed files overlap, so the queue's reason to exist runs. */
export function pickSample(candidates, size) {
  let pair = null;
  for (let i = 0; i < candidates.length && !pair; i++) {
    for (let j = i + 1; j < candidates.length && !pair; j++) {
      const shared = candidates[i].files.filter((f) => candidates[j].files.includes(f));
      if (shared.length > 0) pair = { prs: [candidates[i].number, candidates[j].number], files: shared };
    }
  }
  if (size < 2) pair = null;
  const lead = pair ? candidates.filter((c) => pair.prs.includes(c.number)) : [];
  const rest = candidates.filter((c) => !lead.includes(c));
  return { sample: [...lead, ...rest].slice(0, size), conflictPair: pair };
}

/** The W1-T5940 selection a group ran, from the line writeMergeGroupSelection prints in its job log. */
export function parseGroupSelection(lines) {
  for (const line of lines) {
    const full = /W1-T5940: merge group selection -> FULL: (.*)$/.exec(line);
    if (full) return { mode: "full", suites: 0, why: full[1].trim() };
    const narrow = /W1-T5940: merge group selection -> ((\d+) suite\(s\) over \d+ member\(s\))/.exec(line);
    if (narrow) return { mode: "affected", suites: Number(narrow[2]), why: narrow[1] };
  }
  return { mode: "unknown", suites: 0, why: "no W1-T5940 selection line in the group's job log" };
}

export function classifyRemoval(reason) {
  if (/time/i.test(reason)) return "timeout";
  if (/conflict/i.test(reason)) return "ejected";
  if (/fail|check|ci/i.test(reason)) return "fail";
  return "ejected";
}

const minutesBetween = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 6_000) / 10 : undefined);

export function measureJob(job) {
  return { name: job.name, conclusion: job.conclusion ?? "none",
    queueWaitMin: minutesBetween(job.createdAt, job.startedAt), runMin: minutesBetween(job.startedAt, job.completedAt) };
}

/** Poll every enqueued entry until it merges, leaves the queue, or the harness deadline passes. */
async function awaitGroups(seam, entries, { deadlineMs, pollMs, aborted }) {
  const pending = () => entries.filter((e) => e.outcome === undefined);
  while (pending().length > 0) {
    if (aborted()) throw new RehearsalInterrupted();
    for (const entry of pending()) {
      const state = await seam.readPrQueueState(entry.pr);
      if (state.groupSha) entry.groupSha = state.groupSha;
      if (state.merged) Object.assign(entry, { outcome: "pass", completedAt: state.mergedAt });
      else if (state.removal) {
        Object.assign(entry, { outcome: classifyRemoval(state.removal.reason), ejectionReason: state.removal.reason,
          completedAt: state.removal.at });
      }
    }
    if (pending().length === 0) break;
    if (seam.now() >= deadlineMs) {
      for (const entry of pending()) Object.assign(entry, { outcome: "timeout", ejectionReason: "harness deadline passed" });
      break;
    }
    await seam.sleep(pollMs);
  }
}

/** Wait for a replay PR's required checks, then enqueue it. A red or refused PR is recorded, never retried. */
async function enqueueReplay(seam, entry, contexts, { deadlineMs, pollMs, aborted }) {
  for (;;) {
    if (aborted()) throw new RehearsalInterrupted();
    const checks = await seam.readPrChecks(entry.pr, contexts);
    if (checks === "red") return Object.assign(entry, { outcome: "ejected", ejectionReason: "the replay PR's own required checks were red" });
    if (checks === "green") break;
    if (seam.now() >= deadlineMs) return Object.assign(entry, { outcome: "timeout", ejectionReason: "the replay PR's checks never finished" });
    await seam.sleep(pollMs);
  }
  try {
    entry.enqueuedAt = (await seam.enqueue(entry.nodeId)).enqueuedAt;
  } catch (error) {
    Object.assign(entry, { outcome: "ejected", ejectionReason: `enqueuePullRequest refused: ${error.message}` });
  }
  return entry;
}

/** Every step is attempted and recorded on its own; one failed delete never skips the next. */
export async function tearDown(seam, created) {
  const steps = [];
  const attempt = async (step, fn) => {
    try {
      await fn();
      steps.push({ step, ok: true });
    } catch (error) {
      steps.push({ step, ok: false, error: error.message });
    }
  };
  if (created.ruleset !== undefined) await attempt(`delete ruleset ${created.ruleset}`, () => seam.deleteRuleset(created.ruleset));
  for (const pr of created.prs) await attempt(`close replay PR #${pr}`, () => seam.closePr(pr));
  for (const branch of [...created.branches].reverse()) await attempt(`delete branch ${branch}`, () => seam.deleteBranch(branch));
  return steps;
}

/**
 * The rehearsal. With `live: false` it stops after the reads and the plan, and writes nothing. With
 * `live: true` every created resource is torn down in the `finally`, even when a group fails or the run
 * is interrupted.
 */
export async function runRehearsal(seam, opts = {}) {
  const { live = false, runnerSlots = DEFAULT_RUNNER_SLOTS, windowMinutes = 120, pollMs = 3 * MINUTE_MS, aborted = () => false } = opts;
  const result = { live, startedAt: new Date(seam.now()).toISOString(), groups: [], teardown: [] };
  result.identity = await seam.readIdentity();
  const source = await seam.readRuleset(SOURCE_RULESET_ID);
  result.scratch = scratchBranchName(seam.now());
  const payload = buildRehearsalRuleset(source, result.scratch);
  result.include = payload.conditions.ref_name.include;
  result.queue = payload.rules[0].parameters;
  const contexts = requiredContextsOf(payload);
  result.requiredChecks = contexts;
  const candidates = await seam.listGreenMergedPrs();
  const budget = { ...(await seam.readRunnerBudget()), runnerSlots };
  budget.freeJobSlots = Math.max(0, runnerSlots - budget.busyJobs);
  const ciMinutes = median(candidates.map((c) => c.ciMinutes).filter((m) => m > 0));
  result.groupCiMinutes = ciMinutes === undefined ? undefined : Math.round(ciMinutes * 10) / 10;
  result.budget = budget;
  result.sizing = sizeSample({ candidates: candidates.length, budget,
    maxEntriesToBuild: result.queue.max_entries_to_build ?? 1, windowMinutes });
  const { sample, conflictPair } = pickSample(candidates, result.sizing.size);
  Object.assign(result, { sample: sample.map((c) => c.number), conflictPair });
  if (!live) return result;
  if (sample.length === 0) {
    result.refusal = "the runner budget or the observed CI duration leaves room for no group";
    return result;
  }
  const created = { ruleset: undefined, prs: [], branches: [] };
  const timing = { pollMs, aborted,
    deadlineMs: seam.now() + windowMinutes * MINUTE_MS + (result.queue.check_response_timeout_minutes ?? 60) * MINUTE_MS };
  const entries = [];
  try {
    await seam.createBranch(result.scratch, await seam.readBranchHead("main"));
    created.branches.push(result.scratch);
    created.ruleset = (await seam.createRuleset(payload)).id;
    for (const candidate of sample) {
      const head = replayBranchName(candidate.number);
      await seam.createBranch(head, candidate.headSha);
      created.branches.push(head);
      const opened = await seam.openPr({ head, base: result.scratch, title: `mq-canary replay of #${candidate.number} (W1-T7736)`,
        body: `Merge-queue rehearsal replay of #${candidate.number} against ${result.scratch}. Torn down by the harness.` });
      if (opened.base !== result.scratch) throw new RehearsalRefusal(`replay PR #${opened.number} opened against ${opened.base}`);
      created.prs.push(opened.number);
      entries.push({ replayOf: candidate.number, pr: opened.number, nodeId: opened.nodeId });
    }
    for (const entry of entries) await enqueueReplay(seam, entry, contexts, timing);
    await awaitGroups(seam, entries.filter((e) => e.outcome === undefined), timing);
    for (const entry of entries) {
      const jobs = entry.groupSha ? await seam.readGroupJobs(entry.groupSha) : [];
      const logged = jobs.find((j) => /test-slow|ci-shard/.test(j.name));
      entry.selection = logged ? parseGroupSelection(await seam.readJobLog(logged.id)) : parseGroupSelection([]);
      entry.jobs = jobs.map(measureJob);
      entry.durationMin = minutesBetween(entry.enqueuedAt, entry.completedAt);
    }
  } catch (error) {
    result.failure = error.message;
  } finally {
    result.groups = entries.map(({ nodeId: _nodeId, ...entry }) => entry);
    result.teardown = await tearDown(seam, created);
  }
  return result;
}

/** go only when groups ran, every one passed or was ejected for a real conflict, and teardown completed. */
export function verdictOf(result) {
  if (!result.live) return { go: false, reason: "dry run only — no merge group has run on GitHub yet" };
  if (result.refusal) return { go: false, reason: result.refusal };
  if (result.failure) return { go: false, reason: `the rehearsal failed: ${result.failure}` };
  const torn = result.teardown.filter((s) => !s.ok);
  if (torn.length > 0) return { go: false, reason: `teardown incomplete: ${torn.map((s) => s.step).join(", ")}` };
  if (result.groups.length === 0) return { go: false, reason: "no group ran" };
  const conflict = (g) => g.outcome === "ejected" && /conflict/i.test(g.ejectionReason ?? "");
  const bad = result.groups.filter((g) => g.outcome !== "pass" && !conflict(g));
  if (bad.length > 0) return { go: false, reason: bad.map((g) => `#${g.pr} ${g.outcome} (${g.ejectionReason ?? "no reason"})`).join("; ") };
  const slowest = Math.max(...result.groups.map((g) => g.durationMin ?? 0));
  return { go: true, reason: `${result.groups.length} group(s) finished, the slowest in ${slowest} min; teardown complete` };
}

const BASELINE = [
  "On 2026-10-05 ruleset 24525891 was enabled on main at ~19:16Z and disabled at ~21:36Z. Group jobs waited",
  "~15 min for runners during that day's Actions incident and were cancelled. Groups timed out and ejected",
  "#9391, #9392, #9388 and #9390 (W1-T5909, W1-T5956, W1-T5939), and the operator re-enqueued them by hand",
  "(W1-T5941). Every group ran the full suite then; W1-T5940 (#10400) has since narrowed a group to its",
  "affected suites.",
];

export function renderReport(result, notes = []) {
  const v = verdictOf(result);
  const cell = (x) => (x === undefined || x === null ? "—" : String(x));
  const out = ["# Merge-queue canary rehearsal (W1-T7736)", "",
    `Generated by \`scripts/merge-queue-canary.mjs\` at ${result.startedAt}, mode **${result.live ? "live" : "dry run"}**.`, "",
    "## Identity", "", `- ran as \`${result.identity?.login ?? "unknown"}\` (${result.identity?.kind ?? "unknown"})`,
    ...(result.identity?.note ? [`- ${result.identity.note}`] : []), "",
    "## Scratch target", "", `- scratch branch: \`${result.scratch}\``, `- rehearsal ruleset include: \`${JSON.stringify(result.include)}\``,
    `- merge_queue parameters copied from ruleset ${SOURCE_RULESET_ID} (read only): \`${JSON.stringify(result.queue)}\``,
    `- required checks: ${(result.requiredChecks ?? []).map((c) => `\`${c}\``).join(", ") || "none"}`, "",
    "## Sample", "", `- observed CI duration per run (median): ${cell(result.groupCiMinutes)} min`,
    `- runner budget: ${result.budget?.runnerSlots} slots, ${result.budget?.busyJobs} jobs busy (running or queued), ${cell(result.budget?.jobMinutesPerRun)} job-min per CI run (the costliest of the last ${GROUP_COST_SAMPLE_RUNS} green pull_request runs)`,
    `- sizing: ${result.sizing?.slotMinutes} free slot-min in the window / ${cell(result.sizing?.groupCost)} job-min per group = ${result.sizing?.size} group(s), up to ${result.sizing?.concurrent} building at once`,
    `- sample: ${(result.sample ?? []).map((n) => `#${n}`).join(", ") || "none"}`,
    `- conflicting pair: ${result.conflictPair ? `${result.conflictPair.prs.map((n) => `#${n}`).join(" x ")} (${result.conflictPair.files.join(", ")})` : "none in the sample"}`, "",
    "## Groups", ""];
  if (result.groups.length === 0) out.push("No merge group ran.");
  else {
    out.push("| replay PR | of | group sha | enqueue to completion (min) | outcome | ejection reason | selection | jobs: queue wait / run (min) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const g of result.groups) {
      const selection = g.selection ? `${g.selection.mode}${g.selection.mode === "affected" ? ` (${g.selection.suites} suites)` : ""}: ${g.selection.why}` : "—";
      const jobs = (g.jobs ?? []).map((j) => `${j.name} ${cell(j.queueWaitMin)}/${cell(j.runMin)}`).join("; ") || "—";
      out.push(`| #${g.pr} | #${g.replayOf} | ${cell(g.groupSha?.slice(0, 12))} | ${cell(g.durationMin)} | ${g.outcome} | ${cell(g.ejectionReason)} | ${selection} | ${jobs} |`);
    }
  }
  out.push("", "## Teardown", "", ...(result.teardown.length === 0 ? ["Nothing was created, so nothing was torn down."]
    : result.teardown.map((s) => `- ${s.ok ? "done" : "FAILED"}: ${s.step}${s.ok ? "" : ` — ${s.error}`}`)),
  "", "## Baseline: 2026-10-05", "", ...BASELINE, "");
  if (notes.length > 0) out.push("## Notes", "", ...notes, "");
  out.push("## Verdict", "", `merge-queue canary verdict: ${v.go ? "go" : "no-go"} — ${v.reason}`, "");
  return out.join("\n");
}

/** Runner minutes a job held: zero for a skipped job or one that never started. */
export function jobRunnerMinutes(job) {
  if (job.conclusion === "skipped") return 0;
  const start = Date.parse(job.started_at);
  const end = Date.parse(job.completed_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / MINUTE_MS : 0;
}

/**
 * The real seam, built only on src/lib/github-transport.ts. Reads go through `ghJson`, which applies the
 * read cadence floor and the broker. Writes and the job-log read go through `ghExec`, with the JSON body
 * on stdin. Every call first waits on the call pacer. `readExec` and `exec` are injectable for tests.
 */
export function createGhSeam({ owner = "craigoley", repo = "remudero", pacer = createGhCallPacer(), readExec, exec = ghExec,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const read = async (args) => {
    await pacer.waitAsync();
    return ghJson(args, (reading) => pacer.recordResult(false, reading), readExec);
  };
  const write = async (method, path, body) => {
    await pacer.waitAsync();
    const args = ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])];
    const out = exec(args, { encoding: "utf8", input: body === undefined ? "" : JSON.stringify(body) });
    return out.trim() === "" ? {} : JSON.parse(out);
  };
  const graphql = (query, vars = {}) => read(["api", "graphql", "-f", `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])]).then((res) => res.data);
  const r = `repos/${owner}/${repo}`;
  return {
    now, sleep,
    readIdentity: async () => ({ login: (await graphql("{ viewer { login } }")).viewer.login,
      kind: "GitHub App installation token (the fleet's service identity)" }),
    readRuleset: (id) => read(["api", `${r}/rulesets/${id}`]),
    readBranchHead: async (branch) => (await read(["api", `${r}/git/ref/heads/${branch}`])).object.sha,
    listGreenMergedPrs: async () => {
      const data = await graphql(`{ search(query: "repo:${owner}/${repo} is:pr is:merged base:main", type: ISSUE, first: 20) { nodes { ... on PullRequest {
        number headRefOid files(first: 100) { nodes { path } } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        nodes { ... on CheckRun { name conclusion startedAt completedAt } } } } } } } } } } }`);
      return data.search.nodes.map((pr) => {
        const runs = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes.filter((c) => c.name) ?? [];
        const green = (name) => runs.some((c) => c.name === name && c.conclusion === "SUCCESS");
        const starts = runs.map((c) => Date.parse(c.startedAt)).filter(Number.isFinite);
        const ends = runs.map((c) => Date.parse(c.completedAt)).filter(Number.isFinite);
        return { number: pr.number, headSha: pr.headRefOid, files: pr.files.nodes.map((f) => f.path), green: green("ci") && green("ci-gate"),
          ciMinutes: starts.length && ends.length ? (Math.max(...ends) - Math.min(...starts)) / MINUTE_MS : 0 };
      }).filter((pr) => pr.green);
    },
    // A run is not a job: one CI run holds up to ~40 runners, a policy run one for seconds. Count jobs.
    readRunnerBudget: async () => {
      const jobsOf = async (runId) => (await read(["api", `${r}/actions/runs/${runId}/jobs?filter=latest&per_page=100`])).jobs ?? [];
      let busyJobs = 0;
      for (const status of ["in_progress", "queued"]) {
        for (const run of (await read(["api", `${r}/actions/runs?status=${status}&per_page=100`])).workflow_runs ?? []) {
          busyJobs += (await jobsOf(run.id)).filter((j) => BUSY_JOB_STATUSES.has(j.status)).length;
        }
      }
      const recent = await read(["api",
        `${r}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=${GROUP_COST_SAMPLE_RUNS}`]);
      const costs = [];
      for (const run of recent.workflow_runs ?? []) {
        const minutes = (await jobsOf(run.id)).reduce((n, j) => n + jobRunnerMinutes(j), 0);
        if (minutes > 0) costs.push(minutes);
      }
      // The costliest, not the median: a plan-only run costs ~65 job-min and a source run ~259.
      return { busyJobs, jobMinutesPerRun: costs.length === 0 ? undefined : Math.round(Math.max(...costs) * 10) / 10 };
    },
    createBranch: (name, sha) => write("POST", `${r}/git/refs`, { ref: `refs/heads/${name}`, sha }),
    deleteBranch: (name) => write("DELETE", `${r}/git/refs/heads/${name}`),
    createRuleset: (payload) => write("POST", `${r}/rulesets`, payload),
    deleteRuleset: (id) => write("DELETE", `${r}/rulesets/${id}`),
    openPr: async (pr) => {
      const made = await write("POST", `${r}/pulls`, pr);
      return { number: made.number, nodeId: made.node_id, base: made.base.ref };
    },
    closePr: (number) => write("PATCH", `${r}/pulls/${number}`, { state: "closed" }),
    readPrChecks: async (number, contexts) => {
      const pr = await read(["api", `${r}/pulls/${number}`]);
      const runs = (await read(["api", `${r}/commits/${pr.head.sha}/check-runs?per_page=100`])).check_runs;
      const named = contexts.map((c) => runs.find((run) => run.name === c));
      if (named.some((run) => run && run.status === "completed" && run.conclusion !== "success")) return "red";
      return named.every((run) => run?.conclusion === "success") ? "green" : "pending";
    },
    enqueue: async (nodeId) => {
      const data = await graphql("mutation($id: ID!) { enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { enqueuedAt } } }", { id: nodeId });
      return { enqueuedAt: data.enqueuePullRequest.mergeQueueEntry.enqueuedAt };
    },
    readPrQueueState: async (number) => {
      const data = await graphql(`{ repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { merged mergedAt
        mergeQueueEntry { headCommit { oid } } timelineItems(last: 5, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } } } } }`);
      const pr = data.repository.pullRequest;
      const removed = pr.timelineItems.nodes.at(-1);
      return { merged: pr.merged, mergedAt: pr.mergedAt, groupSha: pr.mergeQueueEntry?.headCommit.oid,
        removal: removed ? { reason: removed.reason, at: removed.createdAt } : undefined };
    },
    readGroupJobs: async (sha) => {
      const runs = (await read(["api", `${r}/actions/runs?head_sha=${sha}&event=merge_group&per_page=20`])).workflow_runs;
      const jobs = [];
      for (const run of runs) {
        for (const j of (await read(["api", `${r}/actions/runs/${run.id}/jobs?per_page=100`])).jobs) {
          jobs.push({ id: j.id, name: j.name, conclusion: j.conclusion, createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at });
        }
      }
      return jobs;
    },
    readJobLog: async (id) => {
      await pacer.waitAsync();
      return exec(["api", `${r}/actions/jobs/${id}/logs`], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n");
    },
  };
}

const HELP = `merge-queue-canary (W1-T7736): rehearse the merge queue on a scratch branch.
  --live             create the scratch branch, ruleset and replay PRs (default: dry run, reads only)
  --report <path>    write the markdown report there
  --runner-slots N   concurrent job slots the account's runners allow (default ${DEFAULT_RUNNER_SLOTS}, the 2026-10-27 observed floor)
  --window-min N     the rehearsal window in minutes (default 120)
  --note <text>      a line for the report's Notes section (repeatable)`;

export async function main(argv, { seam = createGhSeam(), write = writeFileSync, log = console.log, onSignal = process.once.bind(process) } = {}) {
  const { values, helpRequested } = parseArgv(argv, { live: { type: "boolean" }, report: { type: "string" }, note: { type: "string", multiple: true },
    "runner-slots": { type: "string", default: String(DEFAULT_RUNNER_SLOTS) }, "window-min": { type: "string", default: "120" } }, { helpText: HELP });
  if (helpRequested) return 0;
  let stop = false;
  for (const signal of ["SIGINT", "SIGTERM"]) onSignal(signal, () => { stop = true; });
  const result = await runRehearsal(seam, { live: values.live === true, runnerSlots: Number(values["runner-slots"]),
    windowMinutes: Number(values["window-min"]), aborted: () => stop });
  const report = renderReport(result, (values.note ?? []).map((n) => `- ${n}`));
  if (values.report) write(values.report, report);
  log(report.split("\n").find((l) => l.startsWith("merge-queue canary verdict:")));
  return verdictOf(result).go ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
