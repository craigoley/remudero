/** Fresh, private case-file snapshot for the nightly fleet refresh: every called task. No publication or routing. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFieldTrialsLedger } from "../src/lib/field-trials-flow.ts";
import { systemClock } from "../src/lib/clock.ts";
import { caseFileCommand, parseCasePrSnapshot } from "../src/lib/report-commands.ts";
import { ghTextAsync } from "../src/lib/github-transport.ts";
import { refreshInstallationToken } from "../src/lib/github-app.ts";
import { loadPlan } from "../src/lib/plan.ts";
import { resolveRepoLayout } from "../src/lib/repo-layout.ts";
import { readTaskCaseLedgers } from "../src/lib/task-case-file.ts";
import { buildFieldTrialsCaseFiles, caseLedgerWindowDays, creditsTask, ghPrListingPage, parseCarry, readCaseFileCatalog,
  readCaseFileOpsCatalog } from "../src/lib/field-trials-case-files.ts";

const repoRoot = process.env.RMD_FIELD_TRIALS_REPO_ROOT ?? "/app";
const stateDir = process.env.RMD_FIELD_TRIALS_CORE_LEDGER ?? "/home/node/Remudero/state";
const out = process.env.RMD_FIELD_TRIALS_CASE_OUT ?? join(stateDir, "field-trials", "case-files-latest.json");
// W1-T14602: what the last build learned (PR links, finished PR reads), so tonight reads only what changed.
const carryPath = join(dirname(out), "case-files-carry.json");

const read = await readFieldTrialsLedger(stateDir);
if (read.state === "unavailable") throw new Error(`field-trials case-file ledger unavailable: ${read.reason}`);
const plan = loadPlan(resolveRepoLayout(repoRoot).planMonolith);
if (process.env.GH_APP_ID && process.env.GH_APP_INSTALLATION_ID && process.env.GH_APP_PRIVATE_KEY_PATH) {
  const token = await refreshInstallationToken({ env: process.env });
  if (!token.ok) console.error(`field-trials case-files: GitHub App token unavailable (${token.reason}); exact PR reads may be unavailable`);
}
// W1-T14717: new core tasks are filed in the ops catalog, so select from both; a refused read falls back to the
// daemon's last good snapshot (W1-T14564) and is named in the summary either way.
const catalog = await readCaseFileCatalog(plan, () => readCaseFileOpsCatalog(stateDir));
let carry;
try { carry = parseCarry(JSON.parse(readFileSync(carryPath, "utf8"))); } catch { carry = undefined; }

const result = await buildFieldTrialsCaseFiles(
  { rows: read.rows, planIds: catalog.planIds, carry, opsCatalog: catalog.opsCatalog },
  // W1-T14728: one REST listing of every PR, newest update first, in place of a search per task.
  ghPrListingPage(ghTextAsync, "craigoley/remudero"),
  async (number) => JSON.parse(await ghTextAsync(["pr", "view", String(number), "--repo", "craigoley/remudero",
    "--json", "number,url,state,headRefOid,headRefName,body,mergedAt,statusCheckRollup"])),
  { nowIso: () => systemClock.iso(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  async ({ selected, prNumbers, prReads, oldestCallTs }) => {
    const projection = new Map();
    const parsed = new Map();
    for (const taskId of selected) {
      const number = prNumbers.get(taskId);
      const pr = prReads.get(number);
      parsed.set(number, pr ? parseCasePrSnapshot(pr.raw, pr.readAt) : { state: "unavailable", reason: "github-exact-pr-read-failed" });
      const raw = pr?.raw;
      const credited = raw && creditsTask(raw, taskId);
      const source = credited ? String(raw.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${taskId}`)
        ? "trailer" : "head-branch" : "none";
      projection.set(taskId, { taskId, status: raw?.state === "MERGED" && credited ? "merged"
        : raw?.state === "OPEN" ? "review" : "blocked", merged: raw?.state === "MERGED" && credited,
      source, prNumber: number, prUrl: raw?.url });
    }
    let printed = "";
    const code = await caseFileCommand(["--tasks", selected.join(","), "--json"], {
      repoRoot, stateDir, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }), readTask: catalog.readTask,
      // The ledger read reaches back to the oldest selected call, so no called run falls outside its case file.
      readLedgers: (dir, taskIds, asOf) => readTaskCaseLedgers(dir, taskIds, asOf,
        { windowDays: caseLedgerWindowDays(asOf, oldestCallTs) }),
      readProjection: (task) => projection.get(task.id), readPr: (number) => parsed.get(number),
      out: (line) => { printed = line; },
    });
    if (code !== 0) throw new Error(`field-trials case-file command refused (${code})`);
    return JSON.parse(printed);
  },
);

mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
for (const [path, body] of [[carryPath, result.carry], [out, result.files]]) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
  renameSync(temporary, path);
}
console.log(JSON.stringify({ event: "field_trials.case_files", asOf: result.files[0]?.asOf ?? null, ...result.summary,
  ledger: read.state, path: out, readFailures: result.readFailures }));
