import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attestLearningOrigin,
  buildExportBundle,
  computeArtifactHash,
  loadGlobalArtifact,
  loadLearnings,
  loadLearningsCorpus,
  PUBLIC_SOURCE_FREE_REASON,
  PUBLIC_EXPORT_SRC,
  renderExportBundle,
  resolveLearningsSchema,
  verifyBundlePin,
  type LocalLearningEntry,
  type PublicLearningEntry,
  type V1BundleLearningEntry,
} from "../src/lib/learnings.js";
import { buildBundle, type BundleProvenance } from "../src/lib/bundle.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}learnings-v2-`)), name);
}

function entry(over: Partial<LocalLearningEntry> = {}): LocalLearningEntry {
  return {
    id: "origin-fact",
    subsystem: "knowledge",
    lifecycle: "active",
    files: ["src/lib/learnings.ts"],
    fact: "A source-bound fact.",
    src: "internal/repo/path#42",
    ...over,
  };
}

const publicProvenance = {
  sourceRepo: "example/private-repo",
  sourceSha: "deadbeef",
  exportedAt: "2026-09-10T00:00:00.000Z",
};

const privateProvenance: BundleProvenance = publicProvenance;

function validSettings(): Record<string, unknown> {
  return {
    permissions: { deny: [], allow: [], ask: [] },
    hooks: {},
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ["github.com", "api.github.com"] },
    },
  };
}

const gitOrigin = {
  kind: "git" as const,
  path: "private/origin-source.ts",
  rev: "a".repeat(40),
  startLine: 2,
  endLine: 2,
  lineSha256: "b".repeat(64),
};

test("learnings-v2: only named schemas are structured; legacy versions stay V1", () => {
  assert.equal(resolveLearningsSchema("learnings-v1"), "v1");
  assert.equal(resolveLearningsSchema("learnings-v2"), "v2");
  for (const version of ["2026-07-20T00:00:00.000Z", "v1", "2026-07-20"]) {
    assert.equal(resolveLearningsSchema(version), "v1");
  }
  for (const version of ["learnings-v0", "learnings-v2.1", "learnings-v2-beta", "learnings-v3"]) {
    assert.throws(() => resolveLearningsSchema(version), /unsupported learnings artifact version/);
    assert.equal(verifyBundlePin(`version: ${version}\nhash: pin\nentries: []\n`, "pin").ok, false);
  }
});

test("learnings-v2: the live corpus retains its baseline V1 artifact hash", () => {
  const corpus = loadLearningsCorpus(fileURLToPath(new URL("../learnings/", import.meta.url)));
  assert.equal(corpus.length, 83);
  assert.equal(computeArtifactHash(corpus), "f13ba22db845dbb1e5cb21e737b69caa1a9fecd6e6cb5fc60a198a5c31437868");
});

test("learnings-v2: a V1 or legacy artifact carrying origin is refused before trust", () => {
  const local = entry({ origin: gitOrigin });
  const wireEntry = {
    ...local,
    origin: {
      kind: gitOrigin.kind,
      path: gitOrigin.path,
      rev: gitOrigin.rev,
      start_line: gitOrigin.startLine,
      end_line: gitOrigin.endLine,
      line_sha256: gitOrigin.lineSha256,
    },
  };
  for (const version of ["v1", "2026-09-10"]) {
    const path = tmpPath("artifact.yaml");
    writeFileSync(path, JSON.stringify({ version, hash: computeArtifactHash([local]), entries: [wireEntry] }));
    const loaded = loadGlobalArtifact(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.match(loaded.reason, /entry 'origin-fact'.*origin.*V1/i);
  }
});

test("learnings-v2: a public V2 artifact cannot carry a raw Git locator", () => {
  const local = entry({ origin: gitOrigin });
  const wireEntry = {
    ...local,
    origin: {
      kind: gitOrigin.kind,
      path: gitOrigin.path,
      rev: gitOrigin.rev,
      start_line: gitOrigin.startLine,
      end_line: gitOrigin.endLine,
      line_sha256: gitOrigin.lineSha256,
    },
  };
  const path = tmpPath("raw-git.yaml");
  writeFileSync(path, JSON.stringify({ version: "learnings-v2", hash: computeArtifactHash([local], "v2"), entries: [wireEntry] }));
  const loaded = loadGlobalArtifact(path);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.match(loaded.reason, /origin-fact.*raw Git origin/i);
});

test("learnings-v2: public export replaces author provenance and hashes the projection", () => {
  const local = entry({ share: "public", origin: gitOrigin, src: "https://internal.example/repo/src/lib/learnings.ts" });
  const result = buildExportBundle([local], publicProvenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.version, "learnings-v2");
  assert.equal(result.bundle.entries[0]?.src, PUBLIC_EXPORT_SRC);
  assert.deepEqual(result.bundle.entries[0]?.origin, {
    kind: "redacted",
    reason: "git origin withheld from public export",
  });
  assert.equal(result.bundle.hash, computeArtifactHash(result.bundle.entries, "v2"));
  assert.notEqual(result.bundle.hash, computeArtifactHash([local], "v2"));

  const text = renderExportBundle(result.bundle);
  assert.ok(!text.includes(local.src));
  assert.ok(!text.includes(gitOrigin.rev));
  assert.ok(!text.includes(gitOrigin.path));
  assert.ok(text.includes(PUBLIC_EXPORT_SRC));
  assert.equal(verifyBundlePin(text, result.bundle.hash).ok, true);
  const path = tmpPath("public.yaml");
  writeFileSync(path, text);
  assert.equal(loadGlobalArtifact(path).ok, true);

  const noSource = buildExportBundle(
    [entry({ share: "public", origin: { kind: "none", reason: "author-only explanation" } })],
    publicProvenance,
  );
  assert.equal(noSource.ok, true);
  if (noSource.ok) {
    assert.deepEqual(noSource.bundle.entries[0]?.origin, { kind: "none", reason: PUBLIC_SOURCE_FREE_REASON });
    assert.ok(!renderExportBundle(noSource.bundle).includes("author-only explanation"));
  }
});

test("learnings-v2: V2 binds origin while V1 remains byte-compatible", () => {
  const first = entry({ origin: gitOrigin });
  const second = entry({ origin: { ...gitOrigin, lineSha256: "c".repeat(64) } });
  assert.equal(computeArtifactHash([first], "v1"), computeArtifactHash([second], "v1"));
  assert.notEqual(computeArtifactHash([first], "v2"), computeArtifactHash([second], "v2"));
});

test("learnings-v2: local parsing rejects redacted origin while import parsing accepts it", () => {
  const redacted: PublicLearningEntry = {
    ...entry({ share: "public" }),
    src: PUBLIC_EXPORT_SRC,
    origin: { kind: "redacted", reason: "provenance withheld" },
  };
  const text = JSON.stringify([redacted]);
  const localPath = tmpPath("local.yaml");
  writeFileSync(localPath, text);
  assert.throws(() => loadLearnings(localPath), /redacted origin is import-only/);
  writeFileSync(localPath, JSON.stringify([{ ...entry(), origin: { ...gitOrigin, unbound: true } }]));
  assert.throws(() => loadLearnings(localPath), /unrecognized key/);

  const artifactPath = tmpPath("global.yaml");
  writeFileSync(
    artifactPath,
    JSON.stringify({ version: "learnings-v2", hash: computeArtifactHash([redacted], "v2"), entries: [redacted] }),
  );
  assert.equal(loadGlobalArtifact(artifactPath).ok, true);
});

test("learnings-v2: private V1 bundles strip origin without changing their version option", () => {
  const result = buildBundle([entry({ origin: gitOrigin })], validSettings(), privateProvenance);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.entries[0]?.origin, undefined);
  assert.equal(result.bundle.hash, computeArtifactHash(result.bundle.entries));
  const explicitVersion = buildBundle([entry({ origin: gitOrigin })], validSettings(), privateProvenance, { version: "learnings-v2" });
  assert.equal(explicitVersion.ok, true);
  if (explicitVersion.ok) {
    assert.equal(explicitVersion.bundle.version, "learnings-v2");
    assert.equal(explicitVersion.bundle.entries[0]?.origin, undefined);
    assert.equal(explicitVersion.bundle.hash, computeArtifactHash(explicitVersion.bundle.entries));
  }
  assert.equal(buildExportBundle([entry({ share: "public" })], publicProvenance, "2026-09-10").ok, false);
});

test("learnings-v2: blob attestation canonicalizes CRLF and distinguishes every non-match outcome", () => {
  const span = "second\n";
  const lineSha256 = createHash("sha256").update(Buffer.from(span, "utf8")).digest("hex");
  const source = entry({ origin: { ...gitOrigin, lineSha256 } });
  assert.equal(attestLearningOrigin(source, "/repo", { readGitBlob: () => Buffer.from("first\r\nsecond\r\n") }).status, "match");
  assert.equal(attestLearningOrigin(source, "/repo", { readGitBlob: () => Buffer.from("first\nsecond") }).status, "match");
  assert.equal(attestLearningOrigin(source, "/repo", { readGitBlob: () => Buffer.from([0xff]) }).status, "unresolvable");
  assert.equal(attestLearningOrigin(source, "/repo", { readGitBlob: () => Buffer.from("first\n") }).status, "mismatch");
  assert.equal(
    attestLearningOrigin(entry({ origin: { ...gitOrigin, lineSha256, startLine: 0 } }), "/repo", { readGitBlob: () => Buffer.from("first\nsecond\n") }).status,
    "mismatch",
  );
  assert.equal(attestLearningOrigin(source, "/repo", { readGitBlob: () => { throw new Error("missing object"); } }).status, "unresolvable");
  assert.equal(attestLearningOrigin(entry(), "/repo").status, "legacy-unattested");
  assert.equal(attestLearningOrigin(entry({ origin: { kind: "none", reason: "no source" } }), "/repo").status, "source-free");
});

test("learnings-v2: a local source-free reason is scrubbed before promotion or export", () => {
  const result = buildExportBundle(
    [entry({ share: "public", origin: { kind: "none", reason: "password: abracadabra-secret" } })],
    publicProvenance,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /generic-credential-assignment/);
});

test("learnings-v2: parseOrigin rejects every malformed 'git' origin shape one field at a time", () => {
  const write = (origin: unknown) => {
    const path = tmpPath("git-origin.yaml");
    writeFileSync(path, JSON.stringify([{ ...entry(), origin }]));
    return path;
  };
  const gitWire = (over: Record<string, unknown> = {}) => ({
    kind: "git",
    path: gitOrigin.path,
    rev: gitOrigin.rev,
    start_line: gitOrigin.startLine,
    end_line: gitOrigin.endLine,
    line_sha256: gitOrigin.lineSha256,
    ...over,
  });
  assert.throws(() => loadLearnings(write("not-a-mapping")), /'origin' must be a mapping/);
  assert.throws(() => loadLearnings(write({ kind: 7 })), /'origin\.kind' must be a string/);
  assert.throws(
    () => loadLearnings(write(gitWire({ path: "../escape" }))),
    /'origin\.path' must be a safe repo-relative path/,
  );
  assert.throws(() => loadLearnings(write(gitWire({ rev: "not-hex" }))), /'origin\.rev' must be a full lowercase 40-hex/);
  assert.throws(
    () => loadLearnings(write(gitWire({ end_line: 0 }))),
    /'origin\.start_line'\/'origin\.end_line' must be positive inclusive integers/,
  );
  assert.throws(
    () => loadLearnings(write(gitWire({ line_sha256: "not-a-digest" }))),
    /'origin\.line_sha256' must be a lowercase SHA-256 digest/,
  );
});

test("learnings-v2: a source-free ('none') origin validates its keys, reason, and import-mode pin", () => {
  const withNone = (origin: unknown) => {
    const path = tmpPath("none-origin.yaml");
    writeFileSync(path, JSON.stringify([{ ...entry(), origin }]));
    return path;
  };
  assert.throws(
    () => loadLearnings(withNone({ kind: "none", reason: "fine", extra: true })),
    /'origin' has unrecognized key\(s\) extra/,
  );
  assert.throws(() => loadLearnings(withNone({ kind: "none", reason: "" })), /'origin\.reason' must be a non-empty string/);

  const local = withNone({ kind: "none", reason: "an author-only explanation" });
  const [loaded] = loadLearnings(local);
  assert.deepEqual(loaded?.origin, { kind: "none", reason: "an author-only explanation" });

  const importPath = tmpPath("none-import.yaml");
  const wrongReasonEntry = { ...entry(), origin: { kind: "none", reason: "an author-only explanation" } };
  writeFileSync(
    importPath,
    JSON.stringify({ version: "learnings-v2", hash: computeArtifactHash([wrongReasonEntry as LocalLearningEntry], "v2"), entries: [wrongReasonEntry] }),
  );
  const badImport = loadGlobalArtifact(importPath);
  assert.equal(badImport.ok, false);
  if (!badImport.ok) assert.match(badImport.reason, /imported source-free origin must use/);
});

test("learnings-v2: an imported 'redacted' origin rejects a reason outside the public allowlist", () => {
  const wireEntry = { ...entry(), origin: { kind: "redacted", reason: "not-a-recognized-reason" } };
  const path = tmpPath("bad-redaction.yaml");
  writeFileSync(
    path,
    JSON.stringify({ version: "learnings-v2", hash: computeArtifactHash([wireEntry as LocalLearningEntry], "v2"), entries: [wireEntry] }),
  );
  const loaded = loadGlobalArtifact(path);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.match(loaded.reason, /'origin\.reason' is not a recognized public redaction reason/);
});

test("learnings-v2: loadGlobalArtifact turns an unsupported schema version into a refusal, not a crash", () => {
  const path = tmpPath("unsupported-version.yaml");
  writeFileSync(path, JSON.stringify({ version: "learnings-v3", hash: "irrelevant", entries: [] }));
  const loaded = loadGlobalArtifact(path);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) {
    assert.equal(loaded.kind, "refused");
    assert.match(loaded.reason, /unsupported learnings artifact version 'learnings-v3'/);
  }
});

test("learnings-v2: verifyBundlePin refuses a bundle with no 'version' field before ever hashing", () => {
  const result = verifyBundlePin(JSON.stringify({ hash: "pin", entries: [] }), "pin");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /bundle missing string 'version'/);
});

test("learnings-v2: attestLearningOrigin's default blob reader shells out to the real repo's Git object store", () => {
  const repoDir = process.cwd();
  const rev = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const blob = execFileSync("git", ["-C", repoDir, "cat-file", "blob", `${rev}:package.json`], { encoding: "buffer" });
  const firstLine = blob.toString("utf8").split("\n")[0];
  const span = `${firstLine}\n`;
  const lineSha256 = createHash("sha256").update(Buffer.from(span, "utf8")).digest("hex");
  const source = entry({ origin: { kind: "git", path: "package.json", rev, startLine: 1, endLine: 1, lineSha256 } });
  assert.equal(attestLearningOrigin(source, repoDir).status, "match");
});

if (false) {
  const local = entry({ origin: gitOrigin });
  const publicEntry: PublicLearningEntry = {
    ...entry(),
    src: PUBLIC_EXPORT_SRC,
    origin: { kind: "redacted", reason: "provenance withheld" },
  };
  // @ts-expect-error public redacted origins cannot enter a local writer.
  buildExportBundle([publicEntry], publicProvenance);
  // @ts-expect-error a local Git origin cannot be emitted by a V1 bundle type.
  const v1: V1BundleLearningEntry = local;
  void v1;
}
