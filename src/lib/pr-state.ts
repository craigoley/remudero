import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { systemClock } from "./clock.js";
import { ledgerPathFor } from "./ledger-path.js";
import { openLedgerUnion, type OpenLedgerUnionOptions } from "./ledger-union.js";
import { ghCommand, parseGhBrokerDuration } from "./gh-read-broker.js";
import { ghOptionsWithDefaultTimeout } from "./github-transport.js";
import { resolveOwnerRepoAt } from "./owner-repo.js";
import { installPolicyPath, loadPolicy } from "./policy.js";
import { summarizePrChecks } from "./pr-checks.js";
import { REVIEW_CONTEXT } from "./review.js";
import { execFileRouted } from "./spawn-helper.js";

type Row = Record<string, unknown>;
type Field = { value: unknown; asOf: string; source: string };
const FIELD_NAMES = ["head_sha", "checks", "mergeability", "review_state", "auto_merge", "terminal_state"] as const;
type FieldName = typeof FIELD_NAMES[number];
type Answer = { number: number; newestMs?: number; fields: Partial<Record<FieldName, Field>>; error?: string };
const USAGE = "usage: rmd pr-state <n...> [--max-age <dur>] (dur: <n>s|m|h|d)";

const PR_STATE_RUNTIME = {
  stateDir: () => dirname(ledgerPathFor(loadConfig())),
  repository: () => resolveOwnerRepoAt(process.cwd()),
  readLedger: (dir: string, options: OpenLedgerUnionOptions): AsyncIterable<Row> => openLedgerUnion(dir, options),
  readBroker: brokerRead,
  policyPollIntervalMs: (path: string) => loadPolicy(path).values.pollIntervalMs,
  policyPath: installPolicyPath,
  clock: systemClock,
  write: (text: string) => console.log(text),
  error: (text: string) => console.error(text),
  env: process.env,
};

function parseArgs(args: string[]): { numbers: number[]; maxAge?: number } | undefined {
  const numbers = new Set<number>();
  let maxAge: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-age") {
      if (maxAge !== undefined) return undefined;
      maxAge = parseGhBrokerDuration(args[++i]);
      if (maxAge === undefined || !Number.isFinite(maxAge)) return undefined;
    } else if (/^[1-9][0-9]*$/.test(args[i]) && Number.isSafeInteger(Number(args[i]))) {
      numbers.add(Number(args[i]));
    } else return undefined;
  }
  return numbers.size > 0 ? { numbers: [...numbers], maxAge } : undefined;
}

function put(answer: Answer, key: FieldName, value: unknown, row: Row): void {
  if (value === undefined) return;
  const ts = row.ts as string;
  const previous = answer.fields[key];
  if (!previous || Date.parse(ts) >= Date.parse(previous.asOf)) {
    answer.fields[key] = { value, asOf: ts, source: row.step as string };
  }
}

function fold(answer: Answer, row: Row, ms: number): void {
  answer.newestMs = Math.max(answer.newestMs ?? -Infinity, ms);
  const head = answer.fields.head_sha;
  const rowHead = typeof row.head_sha === "string" && row.head_sha !== "" ? row.head_sha : undefined;
  if (rowHead !== undefined && (!head || ms >= Date.parse(head.asOf))) {
    if (head && head.value !== rowHead) {
      for (const key of ["checks", "mergeability", "review_state", "auto_merge"] as const) delete answer.fields[key];
    }
    put(answer, "head_sha", rowHead, row);
  }
  const current = answer.fields.head_sha;
  const matchesHead = rowHead !== undefined ? rowHead === current?.value : current === undefined || ms >= Date.parse(current.asOf);
  if (matchesHead) {
    put(answer, "mergeability", row.merge_state, row);
    if (row.step === "sweep.merge_probe" && (row.verdict === "clean" || row.verdict === "conflict")) {
      put(answer, "mergeability", row.verdict === "conflict" ? "dirty" : "clean", row);
    }
    const checks = row.checks_state;
    if (checks === "green" || checks === "pending" || checks === "red") {
      const names = row.failing_checks;
      if ((Array.isArray(names) && names.every(name => typeof name === "string")) || checks !== "red") {
        put(answer, "checks", { state: checks, failing: Array.isArray(names) ? names : [] }, row);
      }
    }
    put(answer, "review_state", typeof row.review_state === "string" ? row.review_state :
      row.step === "review.posted" && typeof row.state === "string" ? row.state : undefined, row);
    put(answer, "auto_merge", typeof row.auto_merge_armed === "boolean" ? row.auto_merge_armed :
      (row.step === "automerge.armed" && row.outcome === "armed") || row.arm_outcome === "armed" ? true : undefined, row);
  }
  if (row.step === "pr.terminal" && (row.state === "merged" || row.state === "closed")) {
    put(answer, "terminal_state", row.state, row);
  } else if (row.step === "sweep.disposed") {
    put(answer, "terminal_state", "open", row);
  }
  if (row.arm_outcome === "direct-merged" || row.step === "automerge.armed" && row.outcome === "direct-merged") {
    put(answer, "terminal_state", "merged", row);
  }
}

function rowNumber(row: Row): number | undefined {
  if (typeof row.pr_number === "number" && Number.isSafeInteger(row.pr_number) && row.pr_number > 0) return row.pr_number;
  const match = typeof row.pr_url === "string" ? /\/pull\/([0-9]+)(?:[/?#].*)?$/.exec(row.pr_url) : null;
  return match ? Number(match[1]) : undefined;
}

function queryArgs(numbers: number[], repository: { owner: string; repo: string }): string[] {
  const fields = `headRefOid mergeable mergeStateStatus autoMergeRequest{enabledAt} state
    commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){pageInfo{hasNextPage} nodes{
      __typename ... on CheckRun{name status conclusion startedAt completedAt databaseId externalId detailsUrl
        checkSuite{workflowRun{databaseId workflow{databaseId name}}}}
      ... on StatusContext{context state createdAt}
    }}}}}}`;
  const query = `query{repository(owner:${JSON.stringify(repository.owner)},name:${JSON.stringify(repository.repo)}){
    ${numbers.map(n => `pr${n}:pullRequest(number:${n}){${fields}}`).join("\n")}
  }}`;
  return ["api", "graphql", "-f", `query=${query}`];
}

async function brokerRead(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  let stdout = "", stderr = "";
  const code = await ghCommand(["--class", "agent", "--fresh", "--", ...args], env, async directArgs => {
    const result = await execFileRouted("gh", directArgs, ghOptionsWithDefaultTimeout({ encoding: "utf8" as const, env }));
    stdout += result.stdout;
    stderr += result.stderr;
    return 0;
  }, undefined, (stream, text) => { if (stream === "stdout") stdout += text; else stderr += text; });
  if (code !== 0) throw new Error(stderr.trim() || `broker exited ${code}`);
  return JSON.parse(stdout);
}

function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("incomplete GitHub answer");
  return value as Row;
}

function githubFields(value: unknown, asOf: string): Answer["fields"] {
  const row = object(value);
  if (typeof row.headRefOid !== "string" || !row.headRefOid || typeof row.mergeable !== "string" ||
      typeof row.mergeStateStatus !== "string" ||
      !("autoMergeRequest" in row) || !["OPEN", "MERGED", "CLOSED"].includes(String(row.state))) {
    throw new Error("incomplete GitHub PR fields");
  }
  const commits = object(row.commits).nodes;
  if (!Array.isArray(commits) || commits.length !== 1) throw new Error("incomplete GitHub head commit");
  const rollup = object(commits[0]).commit;
  const raw = object(rollup).statusCheckRollup;
  let checks: { state: string; failing: string[] };
  let reviewState = "none";
  if (raw === null) checks = { state: "pending", failing: [] };
  else {
    const summary = object(raw);
    const contexts = object(summary.contexts);
    if (object(contexts.pageInfo).hasNextPage !== false || !Array.isArray(contexts.nodes)) {
      throw new Error("truncated or incomplete GitHub check contexts");
    }
    const report = summarizePrChecks(contexts.nodes.map(value => {
      const check = object(value);
      if (check.__typename === "StatusContext") {
        return { context: String(check.context), state: String(check.state), startedAt: String(check.createdAt) };
      }
      if (check.__typename !== "CheckRun") throw new Error("unknown GitHub check context");
      const run = object(object(check.checkSuite ?? {}).workflowRun ?? {});
      const workflow = object(run.workflow ?? {});
      return { name: String(check.name), status: String(check.status), conclusion: typeof check.conclusion === "string" ? check.conclusion : undefined,
        startedAt: typeof check.startedAt === "string" ? check.startedAt : undefined,
        completedAt: typeof check.completedAt === "string" ? check.completedAt : undefined,
        checkRunId: typeof check.databaseId === "number" ? check.databaseId : undefined,
        detailsUrl: typeof check.detailsUrl === "string" ? check.detailsUrl : undefined,
        externalId: typeof check.externalId === "string" ? check.externalId : undefined,
        workflowRunId: typeof run.databaseId === "number" ? run.databaseId : undefined,
        workflowId: typeof workflow.databaseId === "number" ? workflow.databaseId : undefined,
        workflowName: typeof workflow.name === "string" ? workflow.name : undefined };
    }));
    const review = report.rows.find(check => check.name === REVIEW_CONTEXT);
    if (review) reviewState = review.state === "SUCCESS" ? "success" :
      review.state === "FAILURE" || review.state === "ERROR" ? "failure" : "pending";
    const state = report.red.length > 0 ? "red" : report.pending.length > 0 ? "pending" :
      summary.state === "SUCCESS" ? "green" : summary.state === "FAILURE" || summary.state === "ERROR" ? "red" : "pending";
    checks = { state, failing: report.red };
  }
  const values: Record<FieldName, unknown> = {
    head_sha: row.headRefOid, checks,
    mergeability: { mergeable: row.mergeable, merge_state: row.mergeStateStatus },
    review_state: reviewState, auto_merge: row.autoMergeRequest !== null,
    terminal_state: String(row.state).toLowerCase(),
  };
  return Object.fromEntries(FIELD_NAMES.map(key => [key, { value: values[key], asOf, source: "github.graphql" }]));
}

function render(answer: Answer): string {
  const lines = [`PR #${answer.number}${answer.error ? ` STALE: ${answer.error}` : ""}`];
  for (const key of FIELD_NAMES) {
    const field = answer.fields[key];
    lines.push(`  ${key}: ${field ? JSON.stringify(field.value) : "unknown"} as_of=${field?.asOf ?? "unknown"} source=${field?.source ?? "unknown"}`);
  }
  return lines.join("\n");
}

/** One ledger-union pass and, only for stale or incomplete PRs, one broker read. W1-T10370. */
export async function prStateCommand(rest: string[], deps: Partial<typeof PR_STATE_RUNTIME> = {}): Promise<number> {
  const parsed = parseArgs(rest);
  if (!parsed) { (deps.error ?? PR_STATE_RUNTIME.error)(USAGE); return 2; }
  const answers = new Map(parsed.numbers.map(number => [number, { number, fields: {} } as Answer]));
  const ledgerErrors = new Set<string>();
  const passes: number[] = [];
  const clock = deps.clock ?? PR_STATE_RUNTIME.clock;
  try {
    const dir = (deps.stateDir ?? PR_STATE_RUNTIME.stateDir)();
    const unread = (path: string) => { ledgerErrors.add(`ledger unread: ${path}`); };
    for await (const row of (deps.readLedger ?? PR_STATE_RUNTIME.readLedger)(dir, {
      onUnreadArchive: unread, onUnreadLive: unread, onUnreadDirectory: unread,
      onMalformedRow: finding => { ledgerErrors.add(`ledger malformed: ${finding.path}`); },
    })) {
      const ms = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      const n = rowNumber(row);
      const answer = n === undefined ? undefined : answers.get(n);
      if (!Number.isFinite(ms) || ms > clock.now()) {
        if (answer) ledgerErrors.add(`ledger invalid timestamp for PR #${answer.number}`);
        continue;
      }
      if (row.step === "sweep.pass" && row.dry_run !== true && typeof row.enumerated === "number" && !passes.includes(ms)) {
        passes.push(ms); passes.sort((a, b) => b - a); passes.length = Math.min(passes.length, 2);
      }
      if (answer && typeof row.step === "string" && row.dry_run !== true) fold(answer, row, ms);
    }
  } catch (error) {
    const reason = `ledger read failed: ${String(error)}`;
    ledgerErrors.add(reason);
  }
  let maxAge = parsed.maxAge;
  if (maxAge === undefined) {
    try {
      maxAge = 2 * (passes.length === 2 ? passes[0] - passes[1] :
        (deps.policyPollIntervalMs ?? PR_STATE_RUNTIME.policyPollIntervalMs)((deps.policyPath ?? PR_STATE_RUNTIME.policyPath)()));
      if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error("no positive sweep cadence");
    } catch (error) {
      const reason = `ledger freshness unavailable: ${String(error)}`;
      ledgerErrors.add(reason);
      maxAge = 0;
    }
  }
  const stale = [...answers.values()].filter(answer => ledgerErrors.size > 0 || answer.newestMs === undefined ||
    clock.now() - answer.newestMs > maxAge || FIELD_NAMES.some(key => answer.fields[key] === undefined));
  if (stale.length > 0) {
    try {
      const args = queryArgs(stale.map(answer => answer.number), (deps.repository ?? PR_STATE_RUNTIME.repository)());
      const response = object(await (deps.readBroker ?? PR_STATE_RUNTIME.readBroker)(args, deps.env ?? PR_STATE_RUNTIME.env));
      if (Array.isArray(response.errors) && response.errors.length > 0) throw new Error(JSON.stringify(response.errors));
      const repository = object(object(response.data).repository);
      const asOf = clock.iso();
      for (const answer of stale) {
        try { answer.fields = githubFields(repository[`pr${answer.number}`], asOf); }
        catch (error) { Object.assign(answer, { error: String(error) }); }
      }
    } catch (error) { for (const answer of stale) Object.assign(answer, { error: String(error) }); }
    for (const answer of stale) {
      if (answer.error && ledgerErrors.size > 0) answer.error = `${[...ledgerErrors].join("; ")}; ${answer.error}`;
    }
  }
  for (const answer of answers.values()) (deps.write ?? PR_STATE_RUNTIME.write)(render(answer));
  return [...answers.values()].some(answer => answer.error !== undefined) ? 1 : 0;
}
