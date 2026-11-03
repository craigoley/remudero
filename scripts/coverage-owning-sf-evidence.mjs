#!/usr/bin/env node
// Emit a bounded text receipt binding selected source-file LCOV records to the checked-out Git
// tree. This is evidence for log consumers; it does not enforce a coverage threshold.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const PREFIX = "RMD_COV_SF_V1_";
const MAX_LCOV_BYTES = 64 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_LCOV_LINE_CHARS = 1024 * 1024;
const MAX_LCOV_RECORDS = 100_000;
const MAX_SF_PATH_CHARS = 4096;
const MAX_OWNER_FILES = 64;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function markerLine(kind, value) {
  return `${PREFIX}${kind} ${canonicalJson(value)}\n`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function unavailable(reason, context = {}) {
  const body = {
    schema: 1,
    reason,
    repository: context.repository ?? null,
    run_id: context.run_id ?? null,
    run_attempt: context.run_attempt ?? null,
    integration_head: context.integration_head ?? null,
  };
  process.stdout.write(markerLine("UNAVAILABLE", body));
  return 0;
}

function gitText(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("git_metadata_unavailable");
  return result.stdout.trim();
}

function gitTree(cwd) {
  const result = spawnSync(
    "git",
    ["ls-tree", "-rz", "-r", "--full-tree", "HEAD", "--", "src", "scripts"],
    { cwd, timeout: 30_000, maxBuffer: MAX_TREE_BYTES, windowsHide: true },
  );
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("git_tree_unavailable");
  return result.stdout;
}

function parseTreeBlobOids(treeBytes, wanted) {
  const wantedSet = new Set(wanted);
  const blobs = new Map();
  let start = 0;
  while (start < treeBytes.length) {
    const end = treeBytes.indexOf(0, start);
    if (end < 0) throw new Error("git_tree_truncated");
    const row = new TextDecoder("utf-8", { fatal: true }).decode(treeBytes.subarray(start, end));
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("git_tree_malformed");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const repoPath = row.slice(tab + 1);
    if (type === "blob" && wantedSet.has(repoPath)) {
      if (!/^[a-f0-9]{40,64}$/.test(oid ?? "") || blobs.has(repoPath)) throw new Error("git_tree_duplicate_or_invalid_oid");
      blobs.set(repoPath, { oid, mode });
    }
    start = end + 1;
  }
  return blobs;
}

function validateOwnerFiles(values) {
  const files = (values ?? []).slice().sort();
  if (files.length === 0 || files.length > MAX_OWNER_FILES || new Set(files).size !== files.length) {
    throw new Error("owner_file_list_invalid");
  }
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || file.length > 256 || file.includes("\\") || isAbsolute(file)) {
      throw new Error("owner_file_path_invalid");
    }
    if (!file.startsWith("src/") || file.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("owner_file_path_invalid");
    }
  }
  return files;
}

function readBoundedLcov(root, inputPath) {
  const filePath = resolve(root, inputPath);
  const rel = relative(root, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("lcov_path_outside_repo");
  let fd;
  try {
    const before = lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LCOV_BYTES) throw new Error("lcov_not_regular_or_over_limit");
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const pinned = fstatSync(fd);
    if (!pinned.isFile() || pinned.size > MAX_LCOV_BYTES || pinned.size !== before.size) throw new Error("lcov_changed_or_over_limit");
    const chunks = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_LCOV_BYTES) throw new Error("lcov_over_limit");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(fd);
    if (after.size !== total || after.size !== pinned.size) throw new Error("lcov_changed_during_read");
    const bytes = Buffer.concat(chunks, total);
    return { bytes, sha256: sha256(bytes) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function splitSourcePath(root, sourceFile) {
  const absolute = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(root, sourceFile);
  const rel = relative(root, absolute);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const repoPath = inside ? rel.split(sep).join("/") : null;
  const escapedParent = rel === ".." || rel.startsWith(`..${sep}`);
  return { repoPath, outside: !inside, relativeParentChild: !inside && !isAbsolute(sourceFile) && escapedParent };
}

function parseLcov(root, text, ownerFiles) {
  const owners = new Map(ownerFiles.map((file) => [file, { path: file, sf_record_count: 0, lf_sum: 0, lh_sum: 0, counters_complete: true, incomplete: false }]));
  const allPaths = new Set();
  const repoSourcePaths = new Set();
  let sfRecordCount = 0;
  let repoSrcRecordCount = 0;
  let outOfRepoRecordCount = 0;
  let relativeParentChildRecordCount = 0;
  let incompleteSfRecordCount = 0;
  let current = null;

  const finish = (closed) => {
    if (!current) return;
    current.closed = closed;
    const complete = closed && current.lf !== null && current.lh !== null;
    if (!complete) incompleteSfRecordCount += 1;
    if (current.repoPath?.startsWith("src/")) {
      repoSrcRecordCount += 1;
      repoSourcePaths.add(current.repoPath);
    }
    // Owner evidence is exact: an absolute path or a normalized `src/../` alias is not
    // interchangeable with the literal repo-relative SF record expected by the consumer.
    const owner = owners.get(current.sourceFile);
    if (owner) {
      owner.sf_record_count += 1;
      if (current.lf === null || current.lh === null) owner.counters_complete = false;
      else {
        owner.lf_sum += current.lf;
        owner.lh_sum += current.lh;
      }
      if (!closed) owner.incomplete = true;
    }
    current = null;
  };

  let offset = 0;
  while (offset < text.length) {
    const next = text.indexOf("\n", offset);
    const end = next < 0 ? text.length : next;
    let line = text.slice(offset, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    offset = next < 0 ? text.length : next + 1;
    if (line.length > MAX_LCOV_LINE_CHARS) throw new Error("lcov_line_over_limit");
    if (line.startsWith("SF:")) {
      if (current) finish(false);
      const sourceFile = line.slice(3);
      if (sourceFile.trim().length === 0 || sourceFile.length > MAX_SF_PATH_CHARS) throw new Error("lcov_sf_path_invalid");
      if (++sfRecordCount > MAX_LCOV_RECORDS) throw new Error("lcov_record_count_over_limit");
      allPaths.add(sourceFile);
      const classified = splitSourcePath(root, sourceFile);
      if (classified.outside) {
        outOfRepoRecordCount += 1;
        if (classified.relativeParentChild) relativeParentChildRecordCount += 1;
      }
      current = { sourceFile, repoPath: classified.repoPath, lf: null, lh: null };
    } else if (line === "end_of_record") {
      if (current) finish(true);
    } else if (current && (line.startsWith("LF:") || line.startsWith("LH:"))) {
      const key = line.startsWith("LF:") ? "lf" : "lh";
      const value = line.slice(3);
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("lcov_line_count_invalid");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error("lcov_line_count_invalid");
      current[key] = parsed;
    }
  }
  if (current) finish(false);

  const ownerRows = [...owners.values()].map((owner) => {
    const state = owner.incomplete || !owner.counters_complete ? "incomplete" : owner.sf_record_count === 0 ? "missing-sf" : "observed";
    return {
      path: owner.path,
      blob_oid: null,
      sf_record_count: owner.sf_record_count,
      lf_sum: owner.counters_complete && owner.sf_record_count > 0 ? owner.lf_sum : null,
      lh_sum: owner.counters_complete && owner.sf_record_count > 0 ? owner.lh_sum : null,
      state,
    };
  });
  return {
    ownerRows,
    sfRecordCount,
    uniqueSfPathCount: allPaths.size,
    repoSrcRecordCount,
    repoSrcUniquePathCount: repoSourcePaths.size,
    outOfRepoRecordCount,
    relativeParentChildRecordCount,
    incompleteSfRecordCount,
  };
}

function emitFrame(header, rows) {
  const begin = markerLine("BEGIN", header);
  const fileLines = rows.map((row) => markerLine("FILE", row));
  const end = {
    schema: 1,
    owner_record_count: rows.length,
    begin_sha256: sha256(Buffer.from(begin, "utf8")),
    records_sha256: sha256(Buffer.from(fileLines.join(""), "utf8")),
  };
  process.stdout.write(begin);
  process.stdout.write(fileLines.join(""));
  process.stdout.write(markerLine("END", end));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let ownerFiles;
  let context = {};
  try {
    const parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        lcov: { type: "string", default: "coverage/lcov.info" },
        file: { type: "string", multiple: true },
      },
    });
    ownerFiles = validateOwnerFiles(parsed.values.file ?? []);
    context.repository = env.GITHUB_REPOSITORY;
    context.run_id = env.GITHUB_RUN_ID;
    context.run_attempt = env.GITHUB_RUN_ATTEMPT;
    if (typeof context.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository)) throw new Error("repository_identity_unavailable");
    if (typeof context.run_id !== "string" || !/^\d+$/.test(context.run_id)) throw new Error("run_identity_unavailable");
    if (typeof context.run_attempt !== "string" || !/^\d+$/.test(context.run_attempt)) throw new Error("run_identity_unavailable");

    const cwd = process.cwd();
    const root = gitText(cwd, ["rev-parse", "--show-toplevel"]);
    context.integration_head = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40,64}$/.test(context.integration_head)) throw new Error("integration_head_unavailable");
    const blobs = parseTreeBlobOids(gitTree(root), ownerFiles);
    const lcov = readBoundedLcov(root, parsed.values.lcov);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(lcov.bytes);
    const population = parseLcov(root, text, ownerFiles);
    const rows = population.ownerRows.map((row) => {
      const blob = blobs.get(row.path);
      return { ...row, blob_oid: blob?.oid ?? null, state: blob ? row.state : "missing-from-tree" };
    });
    const header = {
      schema: 1,
      state: population.incompleteSfRecordCount === 0 ? "complete" : "partial",
      repository: context.repository,
      run_id: context.run_id,
      run_attempt: context.run_attempt,
      integration_head: context.integration_head,
      lcov_state: "present",
      lcov_bytes: lcov.bytes.length,
      lcov_sha256: lcov.sha256,
      sf_record_count: population.sfRecordCount,
      unique_sf_path_count: population.uniqueSfPathCount,
      repo_src_sf_record_count: population.repoSrcRecordCount,
      repo_src_unique_path_count: population.repoSrcUniquePathCount,
      out_of_repo_sf_record_count: population.outOfRepoRecordCount,
      relative_parent_child_sf_record_count: population.relativeParentChildRecordCount,
      incomplete_sf_record_count: population.incompleteSfRecordCount,
      owner_record_count: rows.length,
    };
    emitFrame(header, rows);
    return 0;
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "receipt_unavailable";
    return unavailable(reason, context);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
