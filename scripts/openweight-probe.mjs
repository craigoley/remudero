#!/usr/bin/env node
// scripts/openweight-probe.mjs — a replayable, operator-invoked openweight probe that keeps its raw
// evidence (W1-T3576).
//
// WHY: the first openweight authoring recon retained only aggregate outcomes, so a purported 0/5
// YAML failure could not be attributed to the model, the parser, the field validator, the prompt or
// the transport. This harness makes a lane-shaped probe repeatable: the SAME request shape the
// adapter sends (its output contract as the system message, temperature 0, a completion budget of
// at least 5,000), and one schema-valid record PER RUN carrying the prompt, the raw model output,
// the parsed fields, the validation verdict, the endpoint identity, the model id and timestamps.
//
// CASH: every run is a paid Azure request. The harness does not reserve against the daemon's
// `dailyCapUsd`; it is bounded instead by MAX_PROBE_RUNS per invocation, and an operator runs it.
//
// CREDENTIALS: the key is read ONLY from RMD_OPENWEIGHT_API_KEY in this process's environment, or
// from the named Azure key-retrieval command (`--key-source azure-cli`). A command-line key flag is
// refused before anything else is parsed, and a resolved key that also appears anywhere in argv is
// refused before transport. Every byte written to disk or printed passes through redactSecrets, and
// the recorded request headers carry `[REDACTED]` in place of the key.

// OUTPUT: `--out-dir` is required and is refused inside this repository or inside ANY git work
// tree, so generated evidence cannot land where it could be committed. Each invocation creates one
// NEW named session directory (never overwritten) holding a `*` .gitignore, session.json, one
// run-NNN.json per run and summary.json. This script never runs git add/commit.
//
// Usage (the adapter module is TypeScript, so run through tsx):
//   node --import tsx scripts/openweight-probe.mjs --mode authoring|classification \
//     --prompt-file <path> --out-dir <dir outside any git work tree> --endpoint https://<resource>/ \
//     [--model gpt-oss-120b] [--runs N] [--labels a,b,c] [--name <session>] \
//     [--key-source env|azure-cli --azure-account <name> --azure-resource-group <name>]
//
// Exit 0 when the session completed (pass/fail counts are evidence, not an exit status), 1 when a
// transport error stopped it, 2 on a refusal (always before any transport call).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  OPENWEIGHT_API_KEY_ENV,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_OUTPUT_CONTRACT,
  OPENWEIGHT_REQUEST_TIMEOUT_MS,
  openWeightPriceFor,
  openWeightReplyIsTruncated,
  openWeightTemperatureField,
  openWeightUnfence,
  openWeightUsageUsd,
} from "../src/lib/worker-provider.ts";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export const PROBE_MODES = ["authoring", "classification"];
export const KEY_SOURCES = ["env", "azure-cli"];
export const DEFAULT_MODEL = "gpt-oss-120b";
export const PROBE_TEMPERATURE = 0;
/** The measured floor below which gpt-oss-120b truncates its reasoning (W1-T3546: 1,500 did). */
export const COMPLETION_TOKEN_FLOOR = 5000;
/** The adapter's own `api-version`, so a probe URL is byte-identical to the production route. */
export const PROBE_API_VERSION = "2024-10-21";
export const RUN_RECORD_SCHEMA = "rmd.openweight-probe.run/v1";
export const SESSION_SCHEMA = "rmd.openweight-probe.session/v1";
export const SUMMARY_SCHEMA = "rmd.openweight-probe.summary/v1";
export const REDACTED = "[REDACTED]";
export const VERDICTS = ["pass", "fail", "error"];

/**
 * PRIMARY CONTROL: the per-invocation bound on paid requests. Nothing else bounds this script's
 * spend -- it deliberately does not touch the daemon's allowance file -- so this IS the cash guard.
 * Ten covers one arm of the measured five-per-arm A/B twice over.
 */
export const MAX_PROBE_RUNS = 10;

/** A flag that could carry a credential. Matched on the flag NAME, so the value is never read. */
export const CLI_CREDENTIAL_FLAG_RE = /^--?(?:api[-_]?key|apikey|key|token|secret|password|credential|auth)(?:=|$)/i;
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const AZURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/;

/** A refusal: raised only before any transport call. Its message never interpolates an argv value
 *  or a key, because a mistyped flag value may BE a pasted key. */
export class ProbeRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeRefusal";
    this.code = code;
  }
}

const HELP = `openweight-probe: a replayable openweight probe that retains raw evidence (W1-T3576)

  node --import tsx scripts/openweight-probe.mjs --mode authoring|classification \\
    --prompt-file <path> --out-dir <dir> --endpoint https://<resource>/ [options]

  --model <deployment>        default ${DEFAULT_MODEL}; must accept temperature ${PROBE_TEMPERATURE}
  --runs <n>                  1..${MAX_PROBE_RUNS} paid requests (default 1)
  --labels <a,b,c>            classification only: the closed label set
  --name <session>            session directory name (default derived from mode, model, time)
  --key-source env|azure-cli  env reads ${OPENWEIGHT_API_KEY_ENV}; azure-cli runs
                              'az cognitiveservices account keys list' with
  --azure-account <name> --azure-resource-group <name>

  A key is never accepted on the command line. --out-dir must sit outside every git work tree.`;

/** The name of the first credential-shaped flag in argv, or null. The value is never returned. */
export function findCliCredential(argv) {
  for (const token of argv) {
    if (CLI_CREDENTIAL_FLAG_RE.test(token)) return token.split("=")[0];
  }
  return null;
}

/** Replace every occurrence of each secret (raw and JSON-escaped) with {@link REDACTED}. */
export function redactSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

/** The named Azure key-retrieval command. Argument array, never a shell string. */
export function azureKeyCommand(account, resourceGroup) {
  return {
    command: "az",
    args: ["cognitiveservices", "account", "keys", "list", "--name", account, "--resource-group", resourceGroup, "--query", "key1", "--output", "tsv"],
  };
}

function parseProbeArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        mode: { type: "string" },
        "prompt-file": { type: "string" },
        "out-dir": { type: "string" },
        endpoint: { type: "string" },
        model: { type: "string", default: DEFAULT_MODEL },
        runs: { type: "string", default: "1" },
        labels: { type: "string" },
        name: { type: "string" },
        "key-source": { type: "string", default: "env" },
        "azure-account": { type: "string" },
        "azure-resource-group": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    // parseArgs echoes the offending token, and a stray token may be a pasted key: never repeat it.
    const reason = "unparseable-argv";
    throw new ProbeRefusal("bad-argument", `${reason}: ${error?.code ?? "invalid argument"} (argv not echoed: it may carry a credential)`);
  }
  return parsed.values;
}

/** The completion budget a probe sends: the adapter's own, refused before transport if it ever
 *  drops below {@link COMPLETION_TOKEN_FLOOR} (a truncated reasoning reply is not evidence). */
export function probeCompletionTokens(adapterBudget = OPENWEIGHT_MAX_COMPLETION_TOKENS) {
  if (adapterBudget < COMPLETION_TOKEN_FLOOR) {
    throw new ProbeRefusal("completion-budget", `the adapter completion budget is below ${COMPLETION_TOKEN_FLOOR}`);
  }
  return adapterBudget;
}

function requireProbeShape(values) {
  const mode = values.mode;
  if (!PROBE_MODES.includes(mode)) throw new ProbeRefusal("bad-mode", `--mode must be one of ${PROBE_MODES.join(", ")}`);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_PROBE_RUNS) {
    throw new ProbeRefusal("bad-runs", `--runs must be an integer from 1 to MAX_PROBE_RUNS=${MAX_PROBE_RUNS}`);
  }
  let labels = null;
  if (mode === "classification") {
    labels = String(values.labels ?? "").split(",").map((label) => label.trim()).filter(Boolean);
    if (labels.length < 2 || !labels.every((label) => LABEL_RE.test(label)) || new Set(labels).size !== labels.length) {
      throw new ProbeRefusal("bad-labels", "classification needs --labels naming at least two distinct closed labels");
    }
  } else if (values.labels !== undefined) {
    throw new ProbeRefusal("bad-labels", "--labels applies only to --mode classification");
  }
  const model = values.model;
  if (!MODEL_ID_RE.test(model)) throw new ProbeRefusal("bad-model", "--model is not a safe deployment id");
  try {
    openWeightPriceFor(model);
  } catch {
    const reason = "unpriced-model";
    throw new ProbeRefusal(reason, "--model has no openweight price row; refusing a paid request at an unknown rate");
  }
  let temperatureField;
  try {
    temperatureField = openWeightTemperatureField(model);
  } catch {
    const reason = "unshaped-model";
    throw new ProbeRefusal(reason, "--model has no openweight request-shape row");
  }
  if (temperatureField.temperature !== PROBE_TEMPERATURE) {
    throw new ProbeRefusal("temperature-unsupported", `--model does not accept temperature ${PROBE_TEMPERATURE}, so its probe is not replayable`);
  }
  probeCompletionTokens();
  if (values.name !== undefined && !SESSION_NAME_RE.test(values.name)) {
    throw new ProbeRefusal("bad-name", "--name must be a plain directory name");
  }
  return { mode, runs, labels, model, endpoint: requireEndpoint(values.endpoint) };
}

function requireEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    const reason = "bad-endpoint";
    throw new ProbeRefusal(reason, "--endpoint must be an https URL");
  }
  if (url.protocol !== "https:") throw new ProbeRefusal("bad-endpoint", "--endpoint must use https");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ProbeRefusal("bad-endpoint", "--endpoint must carry no userinfo, query or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

/** The nearest existing ancestor of `path` (itself included), realpath-resolved, plus the rest. */
function realpathOfNearest(path) {
  let current = path;
  const rest = [];
  for (;;) {
    try {
      return { real: join(realpathSync(current), ...rest), existing: realpathSync(current) };
    } catch {
      const reason = "not-yet-created";
      const parent = dirname(current);
      if (parent === current) throw new ProbeRefusal("bad-output", `${reason}: no existing ancestor for --out-dir`);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether `dir` sits in a git work tree. Fails CLOSED: git not answering is not git saying no. */
export function defaultInsideGitWorkTree(dir) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return true;
  return result.status === 0 && result.stdout.trim() === "true";
}

function resolveOutputTarget(values, deps) {
  if (typeof values["out-dir"] !== "string" || values["out-dir"].trim() === "") {
    throw new ProbeRefusal("no-output-path", "--out-dir is required: evidence goes to a caller-selected directory, never a default");
  }
  const outDir = resolve(deps.cwd, values["out-dir"]);
  const { real, existing } = realpathOfNearest(outDir);
  if (isWithin(real, realpathSync(deps.repoRoot))) {
    throw new ProbeRefusal("output-in-repository", "--out-dir resolves inside this repository; evidence must never be committable");
  }
  if (deps.insideGitWorkTree(existing)) {
    throw new ProbeRefusal("output-in-git-work-tree", "--out-dir resolves inside a git work tree; evidence must never be committable");
  }
  if (existing === real && !statSync(real).isDirectory()) {
    throw new ProbeRefusal("output-not-directory", "--out-dir names an existing non-directory");
  }
  return real;
}

/** Run the key-retrieval command. stderr is counted, never kept, so it cannot reach a log. */
export function defaultRunKeyCommand(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderrBytes: (result.stderr ?? "").length, failed: Boolean(result.error) };
}

function resolveApiKey(values, deps) {
  const source = values["key-source"];
  if (!KEY_SOURCES.includes(source)) throw new ProbeRefusal("bad-key-source", `--key-source must be one of ${KEY_SOURCES.join(", ")}`);
  if (source === "env") {
    const fromEnv = String(deps.env[OPENWEIGHT_API_KEY_ENV] ?? "").trim();
    if (fromEnv === "") throw new ProbeRefusal("no-credential", `${OPENWEIGHT_API_KEY_ENV} is absent from the process environment`);
    return { source, apiKey: fromEnv };
  }
  const account = values["azure-account"];
  const group = values["azure-resource-group"];
  if (!AZURE_NAME_RE.test(account ?? "") || !AZURE_NAME_RE.test(group ?? "")) {
    throw new ProbeRefusal("bad-argument", "--key-source azure-cli needs --azure-account and --azure-resource-group");
  }
  const { command, args } = azureKeyCommand(account, group);
  const result = deps.runKeyCommand(command, args);
  const fromCommand = String(result.stdout ?? "").trim();
  if (result.failed || result.status !== 0 || fromCommand === "") {
    // stderr is withheld, not echoed: an operator re-runs the named command to read it.
    throw new ProbeRefusal("no-credential", `the Azure key-retrieval command returned no key (status ${result.status}); its output is withheld`);
  }
  return { source, apiKey: fromCommand };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Authoring: the unfenced reply must parse as YAML and meet the task-shard field contract. */
export function validateAuthoring(content) {
  const unfenced = openWeightUnfence(content);
  const fenced = unfenced !== content;
  let document;
  try {
    document = parseYaml(unfenced);
  } catch (error) {
    const reason = "yaml-parse-failed";
    return { parsed: { fenced, document: null }, verdict: "fail", reasons: [`${reason}: ${String(error?.message ?? error).split("\n")[0]}`] };
  }
  const reasons = [];
  const shard = Array.isArray(document) ? document[0] : document;
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.trim() !== "";
  if (!isMap(shard)) {
    reasons.push("document is not a task-shard mapping");
  } else {
    if (!text(shard.id)) reasons.push("missing string id");
    if (!text(shard.title)) reasons.push("missing string title");
    if (!Array.isArray(shard.acceptance) || shard.acceptance.length === 0) {
      reasons.push("missing non-empty acceptance list");
    } else {
      shard.acceptance.forEach((item, index) => {
        if (!isMap(item) || !text(item.claim) || !text(item.proof)) reasons.push(`acceptance[${index}] lacks a string claim and proof`);
      });
    }
  }
  return { parsed: { fenced, document: document ?? null }, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** Classification: the trimmed reply must be exactly one listed label. */
export function validateClassification(content, labels) {
  const label = openWeightUnfence(content).trim();
  const listed = labels.includes(label);
  return { parsed: { label }, verdict: listed ? "pass" : "fail", reasons: listed ? [] : [`reply is not one of the closed labels: ${labels.join(", ")}`] };
}

/** Problems with a per-run record; an empty list means schema-valid. */
export function validateRunRecord(record) {
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(what); };
  const str = (value) => typeof value === "string" && value !== "";
  need(record?.schema === RUN_RECORD_SCHEMA, "schema");
  need(Number.isInteger(record?.run?.index) && record.run.index >= 1 && record.run.index <= record.run.of, "run.index/run.of");
  need(PROBE_MODES.includes(record?.mode), "mode");
  need(str(record?.model), "model");
  need(str(record?.endpoint?.host) && str(record?.endpoint?.url) && str(record?.endpoint?.deployment) && str(record?.endpoint?.apiVersion), "endpoint identity");
  need(record?.request?.headers?.["api-key"] === REDACTED, "request.headers api-key redacted");
  need(record?.request?.body?.temperature === PROBE_TEMPERATURE, "request.body.temperature");
  need(Number(record?.request?.body?.max_completion_tokens) >= COMPLETION_TOKEN_FLOOR, "request.body.max_completion_tokens");
  need(str(record?.prompt?.user) && str(record?.prompt?.system) && str(record?.prompt?.sha256), "prompt text");
  need(VERDICTS.includes(record?.validation?.verdict) && Array.isArray(record?.validation?.reasons), "validation verdict");
  need(record !== null && typeof record === "object" && "parsed" in record, "parsed fields");
  need(str(record?.timestamps?.startedAt) && str(record?.timestamps?.completedAt), "timestamps");
  if (record?.validation?.verdict !== "error") {
    need(typeof record?.response?.raw === "string", "response.raw");
    need(typeof record?.response?.content === "string", "response.content");
  } else {
    need(str(record?.error), "error");
  }
  return problems;
}

function interpretResponse(status, raw, shape) {
  const response = { status, raw, content: null, finishReason: null, usage: null, usd: null };
  if (status < 200 || status > 299) return { response, parsed: null, verdict: "error", reasons: [`HTTP ${status}`], error: `HTTP ${status}`, stop: true };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const reason = "response body is not JSON";
    return { response, parsed: null, verdict: "error", reasons: [reason], error: reason, stop: true };
  }
  const choice = payload?.choices?.[0];
  response.finishReason = choice?.finish_reason ?? null;
  if (payload?.usage && typeof payload.usage === "object") {
    response.usage = payload.usage;
    const prompt = Number(payload.usage.prompt_tokens) || 0;
    const completion = Number(payload.usage.completion_tokens) || 0;
    response.usd = openWeightUsageUsd(shape.model, prompt, completion);
  }
  if (typeof choice?.message?.content !== "string") {
    const reason = "response has no assistant content";
    return { response, parsed: null, verdict: "error", reasons: [reason], error: reason, stop: false };
  }
  response.content = choice.message.content;
  const judged = shape.mode === "authoring" ? validateAuthoring(response.content) : validateClassification(response.content, shape.labels);
  if (openWeightReplyIsTruncated(response.finishReason)) {
    return { response, parsed: judged.parsed, verdict: "fail", reasons: ["truncated (finish_reason=length)", ...judged.reasons], error: null, stop: false };
  }
  return { response, parsed: judged.parsed, verdict: judged.verdict, reasons: judged.reasons, error: null, stop: false };
}

/** Evidence goes to disk only through here: redacted, exclusive-create, owner-only. */
function writeEvidence(path, value, secrets) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, redactSecrets(text, secrets), { flag: "wx", mode: 0o600 });
}

function compactStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Run one probe session. Every refusal is raised before the first transport call.
 * @returns {Promise<{ exitCode: number, refusal?: { code: string, message: string }, sessionDir?: string, summary?: object }>}
 */
export async function runProbe(argv, overrides = {}) {
  const deps = {
    env: process.env,
    cwd: process.cwd(),
    repoRoot: REPO_ROOT,
    transport: fetchTransport,
    runKeyCommand: defaultRunKeyCommand,
    insideGitWorkTree: defaultInsideGitWorkTree,
    readFile: (path) => readFileSync(path, "utf8"),
    now: () => new Date(),
    log: (line) => console.log(line),
    ...overrides,
  };
  let secrets = [];
  try {
    const credentialFlag = findCliCredential(argv);
    if (credentialFlag !== null) {
      throw new ProbeRefusal("cli-credential", `${credentialFlag} refused: a key is read only from ${OPENWEIGHT_API_KEY_ENV} or the Azure key-retrieval command`);
    }
    const values = parseProbeArgs(argv);
    if (values.help) {
      deps.log(HELP);
      return { exitCode: 0 };
    }
    const shape = requireProbeShape(values);
    if (typeof values["prompt-file"] !== "string") throw new ProbeRefusal("prompt-unreadable", "--prompt-file is required");
    let prompt;
    try {
      prompt = deps.readFile(resolve(deps.cwd, values["prompt-file"]));
    } catch {
      const reason = "prompt-unreadable";
      throw new ProbeRefusal(reason, "--prompt-file could not be read");
    }
    if (prompt.trim() === "") throw new ProbeRefusal("prompt-unreadable", "--prompt-file is empty");
    const outDir = resolveOutputTarget(values, deps);
    const { source, apiKey } = resolveApiKey(values, deps);
    secrets = [apiKey];
    if (argv.some((token) => token.includes(apiKey))) {
      throw new ProbeRefusal("credential-in-argv", "the resolved key also appears on the command line; refusing before transport");
    }
    const createdAt = deps.now();
    const sessionName = values.name ?? `openweight-${shape.mode}-${shape.model}-${compactStamp(createdAt)}`;
    const sessionDir = join(outDir, sessionName);
    mkdirSync(outDir, { recursive: true });
    try {
      mkdirSync(sessionDir);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const reason = "session-exists";
      throw new ProbeRefusal(reason, `session ${sessionName} already exists under --out-dir; evidence is never overwritten`);
    }
    return await runSession({ shape, prompt, sessionDir, sessionName, source, createdAt, apiKey, deps });
  } catch (error) {
    if (!(error instanceof ProbeRefusal)) throw new Error(redactSecrets(error?.message ?? String(error), secrets));
    return { exitCode: 2, refusal: { code: error.code, message: error.message } };
  }
}

async function runSession({ shape, prompt, sessionDir, sessionName, source, createdAt, apiKey, deps }) {
  const secrets = [apiKey];
  const url = new URL(`openai/deployments/${encodeURIComponent(shape.model)}/chat/completions?api-version=${PROBE_API_VERSION}`, shape.endpoint).toString();
  const endpoint = { host: shape.endpoint.host, url, deployment: shape.model, apiVersion: PROBE_API_VERSION };
  const messages = [{ role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT }, { role: "user", content: prompt }];
  const body = { model: shape.model, messages, temperature: PROBE_TEMPERATURE, max_completion_tokens: probeCompletionTokens() };
  const promptRecord = { system: OPENWEIGHT_OUTPUT_CONTRACT, user: prompt, sha256: sha256(prompt) };
  writeEvidence(join(sessionDir, ".gitignore"), "*\n", secrets);
  writeEvidence(join(sessionDir, "session.json"), {
    schema: SESSION_SCHEMA, session: sessionName, mode: shape.mode, model: shape.model, endpoint, runs: shape.runs,
    labels: shape.labels, keySource: source, prompt: promptRecord, createdAt: createdAt.toISOString(),
  }, secrets);
  const counts = { pass: 0, fail: 0, error: 0 };
  let exitCode = 0;
  for (let index = 1; index <= shape.runs; index += 1) {
    const startedAt = deps.now().toISOString();
    let judged;
    try {
      const reply = await deps.transport({
        url, method: "POST", body: JSON.stringify(body), timeoutMs: OPENWEIGHT_REQUEST_TIMEOUT_MS,
        headers: { "content-type": "application/json", "api-key": apiKey },
      });
      judged = interpretResponse(reply.status, String(reply.text), shape);
    } catch (error) {
      const reason = redactSecrets(String(error?.message ?? error), secrets);
      judged = { response: null, parsed: null, verdict: "error", reasons: ["transport error"], error: reason, stop: true };
    }
    const record = {
      schema: RUN_RECORD_SCHEMA, session: sessionName, run: { index, of: shape.runs }, mode: shape.mode, model: shape.model, endpoint,
      request: { method: "POST", headers: { "content-type": "application/json", "api-key": REDACTED }, body },
      prompt: promptRecord, labels: shape.labels, response: judged.response, parsed: judged.parsed,
      validation: { verdict: judged.verdict, reasons: judged.reasons }, error: judged.error,
      timestamps: { startedAt, completedAt: deps.now().toISOString() },
    };
    const problems = validateRunRecord(record);
    if (problems.length > 0) throw new Error(`openweight-probe: run record failed its own schema: ${problems.join(", ")}`);
    const recordPath = join(sessionDir, `run-${String(index).padStart(3, "0")}.json`);
    writeEvidence(recordPath, record, secrets);
    counts[judged.verdict] += 1;
    deps.log(redactSecrets(`openweight-probe: run ${index}/${shape.runs} ${judged.verdict} -> ${recordPath}`, secrets));
    if (judged.stop) {
      exitCode = 1;
      break;
    }
  }
  const summary = { schema: SUMMARY_SCHEMA, session: sessionName, requested: shape.runs, ...counts, completedAt: deps.now().toISOString() };
  writeEvidence(join(sessionDir, "summary.json"), summary, secrets);
  deps.log(`openweight-probe: session ${sessionDir}: pass ${counts.pass}, fail ${counts.fail}, error ${counts.error}`);
  return { exitCode, sessionDir, summary };
}

/** The real transport: one POST with the adapter's own deadline. Tests pass a recorder as
 *  `fetchImpl`; nothing in the suite reaches the network. */
export async function fetchTransport({ url, method, headers, body, timeoutMs }, fetchImpl = fetch) {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: abort.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(deadline);
  }
}

export async function main(argv, overrides = {}) {
  const errorLog = overrides.errorLog ?? ((line) => console.error(line));
  const result = await runProbe(argv, overrides);
  if (result.refusal) errorLog(`openweight-probe: REFUSED (${result.refusal.code}): ${result.refusal.message}`);
  return result.exitCode;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
