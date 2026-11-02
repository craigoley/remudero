// toolStepSignature: the bounded signature a worker.activity row records for one tool call (operator ruling, 2026-10-13).
// One case per branch. The redaction cases are the point: a signature names what ran, never with what.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSIGNMENT_RE,
  PACKAGE_RE,
  PROGRAM_RE,
  SCRIPT_RE,
  SUBCOMMAND_RE,
  toolStepSignature,
  UNSAFE_PATH_RE,
} from "#src/lib/tool-step-signature.js";

const WT = "/work/wt-run";
const bash = (command: unknown): string | undefined => toolStepSignature("Bash", { command }, WT);

test("toolStepSignature reduces a curl call carrying an Authorization header to Bash:curl", () => {
  assert.equal(bash('curl -H "Authorization: Bearer s3cret" https://example.com'), "Bash:curl");
});

test("toolStepSignature strips leading env assignments, including an export of assignments only", () => {
  assert.equal(bash("FOO=bar TOKEN='a b' npm test"), "Bash:npm test");
  assert.equal(bash("FOO=a\\ b npm test"), "Bash:npm test", "an escaped space stays inside the assignment");
  assert.equal(bash("STAMP=$(date +%s) git status"), "Bash:git status");
  assert.equal(bash("FOO=1; npm ci"), "Bash:npm ci");
  assert.equal(bash("export PATH=/opt/bin:$PATH && npm ci"), "Bash:npm ci");
  assert.equal(bash("export -p && npm ci"), "Bash:export", "an export that is not only assignments is the command");
  assert.equal(bash("FOO=bar"), undefined, "assignments with no command name no program");
});

test("toolStepSignature skips leading cd segments: cd x && npm run lint is Bash:npm run lint", () => {
  assert.equal(bash("cd x && npm run lint"), "Bash:npm run lint");
  assert.equal(bash("cd x; npm run lint -- --fix"), "Bash:npm run lint");
  assert.equal(bash("cd x\nnpm run -s agents-md"), "Bash:npm run agents-md");
  assert.equal(bash("(cd sub && npm ci)"), "Bash:npm ci");
  assert.equal(bash("cd /tmp"), "Bash:cd", "a cd that ends the command is the command");
  assert.equal(bash("cd x | cat"), "Bash:cd", "only && and ; chain a cd onto the next command");
  assert.equal(bash("cd x &&"), undefined);
});

test("toolStepSignature names an unknown program by its basename only", () => {
  assert.equal(bash("/usr/bin/python3 -c 'print(1)' --token abc"), "Bash:python3");
  assert.equal(bash("# set up\nls -la /secret"), "Bash:ls", "a leading comment line is skipped");
  assert.equal(bash("cat > out.txt <<'EOF'\nit's here\nEOF"), "Bash:cat");
});

test("toolStepSignature keeps a known program's subcommand and never a flag value", () => {
  assert.equal(bash("git -C /home/user/repo -c user.name=x --no-pager log --oneline"), "Bash:git log");
  assert.equal(bash('git commit -m "$(cat <<\'EOF\'\nfeat: it\'s (done)\nEOF\n)"'), "Bash:git commit");
  assert.equal(bash("gh -R owner/repo pr create --title secret"), "Bash:gh pr");
  assert.equal(bash("rmd check-acceptance body.md"), "Bash:rmd check-acceptance");
  assert.equal(bash("rmd --root /x drain"), "Bash:rmd", "an unknown flag ends the walk, so its value never passes for a subcommand");
  assert.equal(bash("npm --loglevel silent run test"), "Bash:npm");
  assert.equal(bash("npm --prefix=/x run Bad/Script"), "Bash:npm run");
  assert.equal(bash("git -- status"), "Bash:git status");
  assert.equal(bash("git $SUB"), "Bash:git", "an expansion is never read as a subcommand");
  assert.equal(bash("git Status"), "Bash:git");
  assert.equal(bash("gh"), "Bash:gh");
  assert.equal(bash('git commit -m "never read'), "Bash:git commit", "words after the signature are never lexed");
});

test("toolStepSignature names the tool npx runs, without its version, and nothing for a URL", () => {
  assert.equal(bash("npx -y prettier@3.0.0 --check ."), "Bash:npx prettier");
  assert.equal(bash("npx @biomejs/biome check"), "Bash:npx @biomejs/biome");
  assert.equal(bash("npx https://example.com/pkg.tgz"), "Bash:npx");
  assert.equal(bash("npx"), "Bash:npx");
});

test("toolStepSignature records node's script path only when it is inside the worktree", () => {
  assert.equal(
    bash("node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/a.test.ts test/b.test.ts 2>&1 | tail -5"),
    "Bash:node --test test/a.test.ts",
  );
  assert.equal(bash(`node --import tsx ${WT}/src/run-task.ts check-acceptance body.md`), "Bash:node src/run-task.ts");
  assert.equal(bash("node --test-name-pattern=x --test"), "Bash:node --test");
  assert.equal(bash("node /etc/evil.js"), "Bash:node");
  assert.equal(bash("node -e 'process.exit(1)'"), "Bash:node", "inline code is a flag value");
  assert.equal(bash("node https://example.com/x.js"), "Bash:node", "a URL is never a path");
  assert.equal(bash("node -- $SCRIPT"), "Bash:node");
  assert.equal(bash("tsx scripts/build.ts --out x"), "Bash:tsx scripts/build.ts");
  assert.equal(bash("> out.txt 2>&1 node scripts/x.mjs"), "Bash:node scripts/x.mjs", "a leading redirection is skipped");
  assert.equal(bash("node >> log.txt 2>&- < in.txt scripts/x.mjs"), "Bash:node scripts/x.mjs");
  assert.equal(bash("cd x >/dev/null 2>&1 && npm ci"), "Bash:npm ci");
});

test("toolStepSignature shows a file tool's path relative to the worktree, inside vs outside", () => {
  assert.equal(toolStepSignature("Read", { file_path: `${WT}/src/lib/worker.ts` }, WT), "Read:src/lib/worker.ts");
  assert.equal(toolStepSignature("Edit", { file_path: "/etc/hosts" }, WT), "Edit:<outside>");
  assert.equal(toolStepSignature("Write", { file_path: "/work/wt-run-2/x.ts" }, WT), "Write:<outside>", "a sibling prefix is outside");
  assert.equal(toolStepSignature("MultiEdit", { file_path: "../escape.ts" }, WT), "MultiEdit:<outside>");
  assert.equal(toolStepSignature("NotebookEdit", { notebook_path: "nb/a.ipynb" }, WT), "NotebookEdit:nb/a.ipynb");
  assert.equal(toolStepSignature("Read", { file_path: "https://example.com/a" }, WT), "Read:<outside>");
  assert.equal(toolStepSignature("Read", { file_path: `${WT}/src/a.ts` }, ""), "Read:<outside>", "no known worktree shows no path");
});

test("toolStepSignature uses Grep's and Glob's path input, never the pattern", () => {
  assert.equal(toolStepSignature("Grep", { pattern: "s3cret", path: "src" }, WT), "Grep:src");
  assert.equal(toolStepSignature("Glob", { pattern: "**/*.ts", path: WT }, WT), "Glob:.");
  assert.equal(toolStepSignature("Grep", { pattern: "s3cret" }, WT), "Grep");
});

test("toolStepSignature records any other tool by its name alone", () => {
  assert.equal(toolStepSignature("WebFetch", { url: "https://example.com/?token=x" }, WT), "WebFetch");
  assert.equal(toolStepSignature("TodoWrite", null, WT), "TodoWrite");
});

test("toolStepSignature caps a 500-character command at 120 characters", () => {
  const command = `npm run ${"a".repeat(492)}`;
  assert.equal(command.length, 500);
  const signature = bash(command);
  assert.equal(signature?.length, 120);
  assert.ok(signature?.startsWith("Bash:npm run aaa"));
});

test("toolStepSignature returns undefined for unparseable input rather than guessing", () => {
  assert.equal(bash(42), undefined, "a non-string command");
  assert.equal(bash('"npm test'), undefined, "an unterminated quote in the program");
  assert.equal(bash("cd 'x && npm test"), undefined, "an unterminated quote in a skipped segment");
  assert.equal(bash("git \"$(echo hi"), undefined, "an unterminated substitution");
  assert.equal(bash("FOO=`date npm test"), undefined, "an unterminated backtick");
  assert.equal(bash("FOO=${BAR npm test"), undefined, "an unterminated parameter expansion");
  assert.equal(bash("cd x 2> 'log && npm test"), undefined, "an unterminated redirection target");
  assert.equal(bash("git \"unterminated"), undefined, "an unterminated double quote");
  assert.equal(bash("$CMD --flag"), undefined, "a program known only at run time");
  assert.equal(bash("[ -f x ] && npm test"), undefined, "a program name that is not a name");
  assert.equal(bash("   "), undefined);
  assert.equal(toolStepSignature("Read", {}, WT), undefined, "a file tool with no path");
  assert.equal(toolStepSignature("Grep", "not-an-object", WT), undefined);
  assert.equal(toolStepSignature("", {}, WT), undefined, "no tool name");
});

test("each signature validator regex accepts its healthy input and refuses an unhealthy one", () => {
  assert.equal(ASSIGNMENT_RE.test("FOO_1=bar"), true);
  assert.equal(ASSIGNMENT_RE.test("--foo=bar"), false);
  assert.equal(PROGRAM_RE.test("python3"), true);
  assert.equal(PROGRAM_RE.test("["), false);
  assert.equal(SUBCOMMAND_RE.test("rev-parse"), true);
  assert.equal(SUBCOMMAND_RE.test("owner/repo"), false);
  assert.equal(SCRIPT_RE.test("test:unit"), true);
  assert.equal(SCRIPT_RE.test("Bad/Script"), false);
  assert.equal(PACKAGE_RE.exec("@biomejs/biome@1.9.0")?.[1], "@biomejs/biome");
  assert.equal(PACKAGE_RE.exec("https://example.com/x.tgz"), null);
  assert.equal(UNSAFE_PATH_RE.test("https://example.com/a"), true, "a URL is unsafe as a path");
  assert.equal(UNSAFE_PATH_RE.test("src/lib/a.ts"), false);
});
