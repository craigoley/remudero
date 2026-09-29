/** Fresh, private case-file sample for the nightly fleet snapshot. No publication or routing. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFieldTrialsLedger } from "../src/lib/field-trials-flow.ts";
import { systemClock } from "../src/lib/clock.ts";
import { caseFileCommand, parseCasePrSnapshot } from "../src/lib/report-commands.ts";
import { ghTextAsync } from "../src/lib/github-transport.ts";
import { refreshInstallationToken } from "../src/lib/github-app.ts";
import { loadPlan } from "../src/lib/plan.ts";
import { resolveRepoLayout } from "../src/lib/repo-layout.ts";

const repoRoot = process.env.RMD_FIELD_TRIALS_REPO_ROOT ?? "/app";
const stateDir = process.env.RMD_FIELD_TRIALS_CORE_LEDGER ?? "/home/node/Remudero/state";
const out = process.env.RMD_FIELD_TRIALS_CASE_OUT ?? join(stateDir, "field-trials", "case-files-latest.json");
const maxCases = Number(process.env.RMD_FIELD_TRIALS_MAX_CASES ?? "200");
if (!Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 200) throw new Error("field-trials case-file bound must be 1..200");
const maxPrSearches = Number(process.env.RMD_FIELD_TRIALS_PR_SEARCH_MAX ?? "25");
if (!Number.isSafeInteger(maxPrSearches) || maxPrSearches < 0 || maxPrSearches > 25)
  throw new Error("field-trials exact PR search bound must be 0..25");

const read = await readFieldTrialsLedger(stateDir);
if (read.state === "unavailable") throw new Error(`field-trials case-file ledger unavailable: ${read.reason}`);
const plan = loadPlan(resolveRepoLayout(repoRoot).planMonolith);
const cutoff = systemClock.now() - 14 * 86_400_000;
const recent = read.rows.filter((row) => row.step === "worker.assignment" && row.taskId
  && /^W\d+-T\d+$/.test(row.taskId) && row.ts && Date.parse(row.ts) >= cutoff)
  .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
const seen = new Set();
const taskIds = [];
let outsidePlan = 0;
for (const row of recent) {
  if (seen.has(row.taskId)) continue;
  seen.add(row.taskId);
  if (!plan.byId.has(row.taskId)) { outsidePlan++; continue; }
  taskIds.push(row.taskId);
}
const latestPr = new Map();
for (const row of read.rows) {
  if (row.step !== "pr.opened" || !row.taskId || row.prRepo !== "craigoley/remudero" || !row.prNumber) continue;
  const prior = latestPr.get(row.taskId);
  if (!prior || (row.ts ?? "") > prior.ts) latestPr.set(row.taskId, { number: row.prNumber, ts: row.ts ?? "" });
}
const withoutLedgerPr = taskIds.filter((id) => !latestPr.has(id));
if (process.env.GH_APP_ID && process.env.GH_APP_INSTALLATION_ID && process.env.GH_APP_PRIVATE_KEY_PATH) {
  const token = await refreshInstallationToken({ env: process.env });
  if (!token.ok) console.error(`field-trials case-files: GitHub App token unavailable (${token.reason}); exact PR reads may be unavailable`);
}
const creditsTask = (pr, taskId) => String(pr.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${taskId}`)
  || new RegExp(`^run-${taskId}-\\d+$`).test(String(pr.headRefName ?? ""));
let searches = 0;
let searchMatched = 0;
let searchAmbiguous = 0;
let searchUnreadable = 0;
for (const taskId of withoutLedgerPr.slice(0, maxPrSearches)) {
  searches += 1;
  try {
    const candidates = JSON.parse(await ghTextAsync(["pr", "list", "--repo", "craigoley/remudero",
      "--state", "all", "--search", taskId, "--limit", "20", "--json", "number,body,headRefName,updatedAt"]));
    if (!Array.isArray(candidates)) throw new Error("PR search returned no list");
    const credited = candidates.filter((pr) => creditsTask(pr, taskId));
    if (credited.length > 1) { searchAmbiguous += 1; continue; }
    if (credited.length === 1 && Number.isSafeInteger(credited[0].number)) {
      latestPr.set(taskId, { number: credited[0].number, ts: credited[0].updatedAt ?? "" });
      searchMatched += 1;
    }
  } catch {
    searchUnreadable += 1;
  }
}
const withPr = taskIds.filter((id) => latestPr.has(id));
const selected = withPr.slice(0, maxCases);
let files = [];
if (selected.length > 0) {
  const projection = new Map();
  const prRead = new Map();
  for (const taskId of selected) {
    const number = latestPr.get(taskId).number;
    let raw;
    try {
      raw = JSON.parse(await ghTextAsync(["pr", "view", String(number), "--repo", "craigoley/remudero", "--json",
        "number,url,state,headRefOid,headRefName,body,mergedAt,statusCheckRollup"]));
      prRead.set(number, parseCasePrSnapshot(raw, systemClock.iso()));
    } catch {
      prRead.set(number, { state: "unavailable", reason: "github-exact-pr-read-failed" });
    }
    const credited = raw && creditsTask(raw, taskId);
    const source = credited ? String(raw.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${taskId}`)
      ? "trailer" : "head-branch" : "none";
    projection.set(taskId, { taskId, status: raw?.state === "MERGED" && credited ? "merged"
      : raw?.state === "OPEN" ? "review" : "blocked", merged: raw?.state === "MERGED" && credited,
    source, prNumber: number, prUrl: raw?.url });
  }
  let result = "";
  const code = await caseFileCommand(["--tasks", selected.join(","), "--json"], {
    repoRoot, stateDir, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readProjection: (task) => projection.get(task.id), readPr: (number) => prRead.get(number),
    out: (line) => { result = line; },
  });
  if (code !== 0) throw new Error(`field-trials case-file command refused (${code})`);
  files = JSON.parse(result);
}
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
const temporary = `${out}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(files), { mode: 0o600 });
renameSync(temporary, out);
console.log(JSON.stringify({ event: "field_trials.case_files", asOf: files[0]?.asOf ?? null,
  selected: selected.length, candidates: taskIds.length, withoutLedgerPr: withoutLedgerPr.length,
  withoutPrAfterSearch: taskIds.length - withPr.length,
  prSearches: searches, prSearchMatched: searchMatched, prSearchAmbiguous: searchAmbiguous,
  prSearchUnreadable: searchUnreadable, prSearchDeferred: Math.max(0, withoutLedgerPr.length - searches),
  overBound: Math.max(0, withPr.length - selected.length),
  outsidePlan, ledger: read.state, path: out }));
