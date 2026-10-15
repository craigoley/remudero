import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const READ_MAP_CORPUS_FORMAT = "rmd-read-map-corpus-observation-v1";
export const READ_MAP_MANIFEST_FORMAT = "rmd-read-map-run-manifest-v1";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const SUITE = /^test\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.ts$/;
const INPUTS = ["package-lock.json", "test/setup/read-map.ts", "test/setup/tmp-hygiene.ts", "scripts/lib/read-map-summary-reporter.mjs", "scripts/lib/read-map-corpus.mjs", "scripts/read-map-corpus.mjs"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const corpusDigest = value => digest(JSON.stringify(value));
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 8 << 20 }).trim();
const safeSuite = name => typeof name === "string" && SUITE.test(name) && !name.split("/").some(x => x === "." || x === "..");

export function readCorpusBytes(path, maximumBytes = 4 * 1024 ** 2) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) throw Error("read-map corpus needs a bounded regular file");
  const bytes = readFileSync(path), after = lstatSync(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("read-map corpus file changed during capture");
  return { bytes, sha256: digest(bytes), modifiedMs: after.mtimeMs };
}

export function validateCorpusManifest(m) {
  if (m?.format !== READ_MAP_MANIFEST_FORMAT || !SHA.test(m.head ?? "") || !SHA.test(m.tree ?? "") ||
      !/^[a-f0-9-]{36}$/.test(m.runId ?? "") || !Number.isFinite(m.preparedAtMs) || !Array.isArray(m.suites) || !m.suites.length) throw Error("invalid read-map run identity");
  const names = m.suites.map(x => x.path);
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...names].sort()) ||
      m.suites.some(x => !safeSuite(x.path) || !SHA.test(x.blob ?? "") || !HASH.test(x.sha256 ?? "") || !Number.isSafeInteger(x.bytes) || x.bytes < 1 || x.bytes > 4 * 1024 ** 2) ||
      m.suitesSha256 !== corpusDigest(m.suites)) throw Error("invalid physical read-map suite inventory");
  if (!Array.isArray(m.inputs) || JSON.stringify(m.inputs.map(x => x.path)) !== JSON.stringify(INPUTS) ||
      m.inputs.some(x => !HASH.test(x.sha256 ?? "")) || !HASH.test(m.nodeSha256 ?? "") || m.nodeVersion !== process.version ||
      typeof m.root !== "string" || !isAbsolute(m.root) || m.mode !== "shadow" || m.skipsNothing !== true) throw Error("invalid read-map producer/runtime inputs");
  return m;
}

/** Prepare only: this never starts tests, narrows execution or changes a workflow. */
export function prepareReadMapCorpus(root, directory) {
  root = realpathSync(root);
  directory = join(realpathSync(dirname(resolve(directory))), basename(directory));
  const within = relative(root, directory);
  if (within === "" || (!within.startsWith("../") && !isAbsolute(within))) throw Error("read-map run artifacts must be outside the source checkout");
  if (git(root, ["status", "--porcelain"])) throw Error("read-map corpus requires a clean committed tree");
  if (existsSync(directory)) throw Error("read-map run directory must be fresh, never reused");
  const head = git(root, ["rev-parse", "HEAD"]), tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const suites = git(root, ["ls-tree", "-r", "-z", "HEAD", "--", "test"]).split("\0").filter(Boolean)
    .map(line => { const [meta, path] = line.split("\t"), [mode, type, blob] = meta.split(" "); return { mode, type, blob, path }; })
    .filter(x => x.path.endsWith(".test.ts")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(x => {
      if (!safeSuite(x.path) || x.type !== "blob" || !["100644", "100755"].includes(x.mode)) throw Error("unmodelled physical read-map suite");
      const file = readCorpusBytes(join(root, x.path)); return { path: x.path, blob: x.blob, sha256: file.sha256, bytes: file.bytes.length };
    });
  const inputs = INPUTS
    .map(path => ({ path, sha256: readCorpusBytes(join(root, path)).sha256 }));
  const manifest = validateCorpusManifest({ format: READ_MAP_MANIFEST_FORMAT, head, tree, runId: randomUUID(), preparedAtMs: Date.now(), root,
    nodeVersion: process.version, nodeSha256: readCorpusBytes(process.execPath, 256 * 1024 ** 2).sha256,
    inputs, suites, suitesSha256: corpusDigest(suites), mode: "shadow", skipsNothing: true });
  if (git(root, ["rev-parse", "HEAD"]) !== head || git(root, ["status", "--porcelain"])) throw Error("source moved during read-map preparation");
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, "records"), { mode: 0o700 });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
  return { manifest, directory: realpathSync(directory), env: { RMD_READ_MAP_ROOT: root, RMD_READ_MAP_DIR: join(realpathSync(directory), "records"),
    RMD_READ_MAP_MANIFEST: join(realpathSync(directory), "manifest.json") },
    reporter: join(root, "scripts/lib/read-map-summary-reporter.mjs"), reporterDestination: join(realpathSync(directory), "summaries.ndjson") };
}

/** The public reporter's summary only; captures no test body or stdout. */
export function readMapSummary(event, manifest, manifestSha256 = corpusDigest(manifest)) {
  if (event.type !== "test:summary") return undefined;
  const data = event.data, file = data.file === undefined ? null : relative(manifest.root, resolve(data.file)).split("\\").join("/");
  return { format: "rmd-read-map-test-summary-v1", runId: manifest.runId, head: manifest.head,
    manifestSha256, suite: file, success: data.success, counts: data.counts };
}

export function assessReadMapCorpus(manifest, summaries, records, sourceMatches) {
  validateCorpusManifest(manifest);
  const manifestSha256 = corpusDigest(manifest);
  const problems = [], expected = new Set(manifest.suites.map(x => x.path)), seen = new Set(), observed = [];
  const completeCounts = c => c && ["tests", "passed", "failed", "cancelled", "skipped", "todo"].every(k => Number.isSafeInteger(c[k]) && c[k] >= 0) &&
    c.tests > 0 && c.passed === c.tests && c.failed === 0 && c.cancelled === 0 && c.skipped === 0 && c.todo === 0;
  if (!sourceMatches) problems.push("read-map source or runtime drifted");
  let final;
  for (const [i, s] of summaries.entries()) {
    if (s.format !== "rmd-read-map-test-summary-v1" || s.runId !== manifest.runId || s.head !== manifest.head || s.manifestSha256 !== manifestSha256) {
      problems.push("read-map summary belongs to another run or source"); continue;
    }
    if (s.suite === null) { if (final || i !== summaries.length - 1) problems.push("read-map final summary is repeated or not final"); final = s; continue; }
    if (!expected.has(s.suite) || seen.has(s.suite)) { problems.push("read-map summary has a foreign or repeated suite"); continue; }
    seen.add(s.suite);
    const r = records.get(s.suite);
    if (s.success !== true || !completeCounts(s.counts)) problems.push("read-map suite has failed skipped cancelled or empty output: " + s.suite);
    if (!r || r.value.format !== "rmd-read-record-v2" || r.value.suite !== s.suite || !Array.isArray(r.value.reads) || !Array.isArray(r.value.listed) ||
        typeof r.value.unknownDescriptors !== "boolean" || [...r.value.reads, ...r.value.listed].some(x => typeof x !== "string" || x.includes("\0") || x.startsWith("/") || x.split("/").includes("..")) ||
        !HASH.test(r.sha256 ?? "") || r.modifiedMs < manifest.preparedAtMs) problems.push("read-map suite record is absent malformed or stale: " + s.suite);
    else {
      if (r.value.unknownDescriptors) problems.push("read-map descriptor coverage is incomplete: " + s.suite);
      observed.push({ suite: s.suite, recordSha256: r.sha256, counts: s.counts, record: r.value });
    }
  }
  for (const suite of expected) if (!seen.has(suite)) problems.push("read-map suite outcome is missing: " + suite);
  for (const suite of records.keys()) if (!seen.has(suite)) problems.push("read-map record has no closed suite outcome: " + suite);
  if (!final || final.success !== true || !completeCounts(final.counts)) problems.push("read-map closed positive final summary is missing");
  else for (const k of ["tests", "passed", "failed", "cancelled", "skipped", "todo"]) {
    const sum = summaries.filter(s => s.suite !== null && expected.has(s.suite)).reduce((n, s) => n + (s.counts?.[k] ?? NaN), 0);
    if (sum !== final.counts[k]) problems.push("read-map final count does not reconcile: " + k);
  }
  return { format: READ_MAP_CORPUS_FORMAT, head: manifest.head, tree: manifest.tree, runId: manifest.runId, manifestSha256,
    state: problems.length ? "INCOMPLETE" : "OBSERVED_NOT_QUALIFIED", expectedSuites: expected.size, observedSuites: seen.size, observations: observed, problems,
    qualification: { fullInputCoverage: "NOT_ESTABLISHED", heldOutFalseNegatives: "NOT_ESTABLISHED", descendantAttribution: "NOT_ESTABLISHED" },
    mode: "shadow", skipsNothing: true, dispatchAllowed: false, liveNarrowingAllowed: false };
}

export function collectReadMapCorpus(directory) {
  directory = realpathSync(directory);
  const manifest = validateCorpusManifest(JSON.parse(readCorpusBytes(join(directory, "manifest.json"), 16 * 1024 ** 2).bytes));
  const raw = readCorpusBytes(join(directory, "summaries.ndjson"), 8 * 1024 ** 2), text = raw.bytes.toString("utf8");
  if (!text.endsWith("\n")) throw Error("read-map summary stream is unclosed");
  const summaries = text.trimEnd().split("\n").map(line => JSON.parse(line));
  const records = new Map();
  for (const name of readdirSync(join(directory, "records")).sort()) {
    if (!name.endsWith(".json")) throw Error("foreign file in read-map records");
    const record = readCorpusBytes(join(directory, "records", name)), value = JSON.parse(record.bytes);
    if (!safeSuite(value.suite) || name !== value.suite.split("/").join("__") + ".json" || records.has(value.suite)) throw Error("foreign or duplicate read-map record identity");
    records.set(value.suite, { ...record, value });
  }
  const matches = git(manifest.root, ["rev-parse", "HEAD"]) === manifest.head && !git(manifest.root, ["status", "--porcelain"]) &&
    manifest.inputs.every(x => readCorpusBytes(join(manifest.root, x.path)).sha256 === x.sha256) &&
    readCorpusBytes(process.execPath, 256 * 1024 ** 2).sha256 === manifest.nodeSha256;
  return { ...assessReadMapCorpus(manifest, summaries, records, matches), summarySha256: raw.sha256 };
}
