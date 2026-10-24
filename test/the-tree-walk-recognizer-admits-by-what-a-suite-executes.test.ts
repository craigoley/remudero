import assert from "node:assert/strict";
import { test } from "node:test";
import { censusCandidateWalks, discoverCensusCandidates } from "#src/lib/ci-parity.js";

function candidates(text: string) {
  return discoverCensusCandidates("/repo", () => ({
    status: 0, stdout: "test/example.test.ts\n", stderr: "",
  }), () => text);
}

test("W1-T9050: a suite that names ls-files only in a comment or fixture string is not a census candidate", () => {
  for (const text of [
    '// git ls-files src/\nimport { thing } from "#src/lib/thing.js";',
    '/* readdirSync("src/"); git ls-files */\nimport "#src/lib/thing.js";',
    'const fixture = \'execFileSync("git", ["ls-files", "src/"])\';',
    'const fixture = `execFileSync("git", ["ls-files", "src/"])`;',
    'const fixture = `head ${"value"} readdirSync("src/"); git ls-files`;',
    'const fixture = /readdirSync\\("src\/"\\)/; // ls-files',
    'import { readdirSync } from "node:fs"; import "#src/lib/thing.js";',
    'const command = ["ls-files", "src/"];',
    'execFileSync("git", ["grep", "ls-files", "--", "src/"]);',
    'execFileSync("node", ["ls-files", "src/"]);',
    'execFileSync("git", ["ls-files", "--", "deploy/"]); import "#src/lib/x.js";',
    'readdirSync(join(REPO_ROOT, "deploy")); import "#src/lib/x.js";',
  ]) {
    assert.deepEqual(censusCandidateWalks(text), [], text);
    assert.deepEqual(candidates(text), [], text);
  }
});

test("W1-T9050: a suite that shells git ls-files is still a candidate", () => {
  const text = 'execFileSync("git", ["ls-files", "--", "src/"])';
  assert.deepEqual(censusCandidateWalks(text), ["src/"]);
  assert.deepEqual(candidates(text), [{ testFile: "test/example.test.ts", idiom: "ls-files", walks: ["src/"] }]);
  const unfiltered = 'execFileSync("git", ["ls-files"], { cwd: REPO_ROOT })';
  assert.deepEqual(candidates(unfiltered), [{ testFile: "test/example.test.ts", idiom: "ls-files",
    walks: ["plan/tasks.d/", "scripts/", "src/", "test/"] }]);
});

test("W1-T9050: executable walks use their own repository scope across lines", () => {
  for (const text of [
    'execFileSync(\n "git",\n ["ls-files", "--", "test/"],\n { cwd: REPO_ROOT }\n); import "#src/lib/x.js";',
    'readdirSync(\n join(REPO_ROOT, "test")\n); import "#src/lib/x.js";',
    'const area = join(REPO_ROOT, "test"); readdirSync(area, { recursive: true }); import "#src/lib/x.js";',
    'const argv = ["ls-files", "--", "test/"]; execFileSync("git", argv);',
  ]) assert.deepEqual(censusCandidateWalks(text), ["test/"], text);
  assert.deepEqual(censusCandidateWalks('globSync("test/**/*.ts", { cwd: REPO_ROOT })'), ["test/**/*.ts"]);
  assert.deepEqual(censusCandidateWalks('execSync("git ls-files -- scripts/")'), ["scripts/"]);
  assert.deepEqual(censusCandidateWalks('`${readdirSync("src/").length}`'), ["src/"]);
});

test("W1-T9050: an enumeration rooted in a temporary fixture is not a repository walk", () => {
  for (const text of [
    'const root = mkdtempSync(join(tmpdir(), "r-")); readdirSync(join(root, "src"));',
    'const root = mkdtempSync(join(tmpdir(), "r-")); execFileSync("git", ["ls-files", "src/"], { cwd: root });',
    'const root = mkdtempSync(join(tmpdir(), "r-")); globSync("src/**/*.ts", { cwd: root });',
    'execFileSync("git", ["-C", "/tmp/fixture", "ls-files", "src/"]);',
  ]) {
    assert.deepEqual(censusCandidateWalks(text), [], text);
    assert.deepEqual(candidates(text), [], text);
  }
});

test("W1-T9050: an unfiltered repository listing covers each tracked corpus", () => {
  assert.deepEqual(censusCandidateWalks('execFileSync("git", ["ls-files"], { cwd: REPO_ROOT })'),
    ["plan/tasks.d/", "scripts/", "src/", "test/"]);
  assert.deepEqual(censusCandidateWalks('execFileSync("git", ["ls-files", "--", "*.ts"], { cwd: REPO_ROOT })'),
    ["plan/tasks.d/", "scripts/", "src/", "test/"]);
});

test("W1-T9050: fixture mentions do not change the executable enumeration idiom", () => {
  assert.deepEqual(candidates('const note = "ls-files"; readdirSync("test/"); import "#src/lib/x.js";'),
    [{ testFile: "test/example.test.ts", idiom: "dir-walk", walks: ["test/"] }]);
});

test("W1-T9050: a helper directory walk retains its repository caller scope", () => {
  assert.deepEqual(censusCandidateWalks('function walk(dir) { return readdirSync(dir); } walk(join(REPO_ROOT, "src"));'),
    ["src/"]);
  assert.deepEqual(censusCandidateWalks('function walk(dir) { return readdirSync(dir); } walk(join(REPO_ROOT, "src"));\n' +
    'test("fixture", () => { const dir = mkdtempSync(join(tmpdir(), "r-")); });'), ["src/"]);
  assert.deepEqual(censusCandidateWalks(
    'const files = (dir: string): string[] => readdirSync(dir); files(join(REPO_ROOT, "src"));'),
  ["src/"]);
});
