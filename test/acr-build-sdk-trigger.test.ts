/**
 * test/acr-build-sdk-trigger.test.ts — W1-T5018.
 *
 * The image's `/app` `npm ci` installs the worker SDK (`@anthropic-ai/claude-agent-sdk`) from the
 * ROOT `package-lock.json`. W1-T4061 made that lockfile a trigger path but gated the actual build on
 * the playwright-core pin alone, so an SDK-only bump skipped the build and left the running fleet
 * behind the tested code.
 *
 * These tests do not grep the guard — they EXECUTE it: the "Decide whether this push needs a new
 * image" step's own `run:` script, lifted out of acr-build.yml, runs under bash in a throwaway git
 * repo whose two commits are the `before` and `after` of a push, and the test reads the
 * `build=` line it writes to `$GITHUB_OUTPUT`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { gitRepo } from "./helpers/git-repo.js";
import { imageDependenciesCommitsBehind, imageDependencyInputFingerprint, newestImageDependencyInputSha, realDeployDeps } from "../src/lib/deployer.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const SDK_KEY = "node_modules/@anthropic-ai/claude-agent-sdk";

interface GuardStep {
  name?: string;
  run?: string;
}

function guardScript(): string {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "acr-build.yml"), "utf8")) as {
    jobs?: { build?: { steps?: GuardStep[] } };
  };
  const step = doc.jobs?.build?.steps?.find((s) => s.name === "Decide whether this push needs a new image");
  assert.ok(step?.run, "the image guard step must exist and carry a run script");
  return step.run;
}

interface SdkEntry {
  version: string;
  integrity: string;
}

function lockfile(sdk: SdkEntry | undefined, opts: { leftPad?: string; playwright?: string } = {}): string {
  return JSON.stringify(
    {
      name: "remudero",
      lockfileVersion: 3,
      packages: {
        "": { name: "remudero" },
        "node_modules/left-pad": { version: opts.leftPad ?? "1.0.0", integrity: `sha512-leftpad-${opts.leftPad ?? "1.0.0"}` },
        "node_modules/playwright-core": { version: opts.playwright ?? "1.40.0" },
        ...(sdk === undefined ? {} : { [SDK_KEY]: { version: sdk.version, integrity: sdk.integrity } }),
      },
    },
    null,
    2,
  );
}

const SDK_OLD: SdkEntry = { version: "0.3.284", integrity: "sha512-old" };
const SDK_NEW: SdkEntry = { version: "0.3.285", integrity: "sha512-new" };

/** Commit `before` then `after` as the root package-lock.json and run the real guard step. */
function guardSays(before: string, after: string, extraChangedFile?: string): string {
  const repo = gitRepo({ seedCommit: false, kind: "acr-sdk-trigger" });
  const dir = repo.dir;
  const git = (...args: string[]): string => repo.git("-c", "commit.gpgsign=false", ...args);
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "package-lock.json"), before);
  git("add", "-A");
  git("commit", "-q", "-m", "before");
  const beforeSha = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "package-lock.json"), after);
  if (extraChangedFile) {
    mkdirSync(dirname(join(dir, extraChangedFile)), { recursive: true });
    writeFileSync(join(dir, extraChangedFile), "changed\n");
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "after");
  const afterSha = git("rev-parse", "HEAD");

  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "");
  execFileSync("bash", ["-c", guardScript()], {
    cwd: dir,
    env: { ...process.env, BEFORE_SHA: beforeSha, AFTER_SHA: afterSha, GITHUB_OUTPUT: outputFile },
    encoding: "utf8",
  });
  const line = readFileSync(outputFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("build="));
  assert.ok(line, "the guard must write a build= line to GITHUB_OUTPUT");
  return line.slice("build=".length);
}

test("W1-T5018: image build detects a worker SDK lockfile bump", () => {
  // An SDK-only bump (version and integrity move, nothing else in the image's inputs does).
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_NEW)), "true", "an SDK-only lockfile bump must build an image");
  // The full-install fallback can install left-pad too; use a genuine formatting-only no-op.
  assert.equal(
    guardSays(lockfile(SDK_OLD), JSON.stringify(JSON.parse(lockfile(SDK_OLD)))),
    "false",
    "formatting-only lockfile churn must not build an image",
  );
});

test("W1-T5018: an SDK integrity-only change still builds", () => {
  // Same version string, different tarball — a republish or registry swap is still a different SDK.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile({ ...SDK_OLD, integrity: "sha512-republished" })), "true");
});

test("W1-T5018: the SDK appearing in or disappearing from the lockfile builds", () => {
  assert.equal(guardSays(lockfile(undefined), lockfile(SDK_NEW)), "true", "SDK added");
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(undefined)), "true", "SDK removed");
});

test("W1-T5018: the playwright-core and other-baked-path triggers still build", () => {
  // W1-T4061's pin keeps working beside the SDK check.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD, { playwright: "1.41.0" })), "true");
  // Any other watched path builds unconditionally, whatever the lockfile did.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), ".dockerignore"), "true");
  // An unparseable lockfile on either side reads as "build": unknown never silently skips.
  assert.equal(guardSays(lockfile(SDK_OLD), "not json"), "true");
});

test("W1-T5018: the guard reads the SDK from the same lockfile key the image installs", () => {
  // The package the worker imports is the one the guard watches — a rename on either side breaks here.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"], "the worker SDK is a runtime dependency");
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  assert.ok(lock.packages?.[SDK_KEY]?.version, `the root lockfile resolves ${SDK_KEY}`);
  assert.match(guardScript(), /Object\.entries\(lock\.packages\)/, "every resolved package includes the SDK");
});

test("the real image guard builds for a baked supervisor change and skips mounted source", () => {
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), "src/lib/serve-supervisor.ts"), "true");
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), "src/run-task.ts"), "false");
});


test("the image guard detects the supervisor loader and its Linux compiler pins", () => {
  for (const name of ["tsx", "esbuild", "@esbuild/linux-x64"]) {
    const before = JSON.parse(lockfile(SDK_OLD));
    const after = JSON.parse(lockfile(SDK_OLD));
    before.packages[`node_modules/${name}`] = { version: "1.0.0", integrity: "sha512-old" };
    after.packages[`node_modules/${name}`] = { version: "1.0.0", integrity: "sha512-new" };
    assert.equal(guardSays(JSON.stringify(before), JSON.stringify(after)), "true", name);
  }
});

interface DependencyTree { lock: string | undefined; manifest?: string | undefined; workspace?: string | undefined; manifests?: Record<string, string> }

/** Both real consumers see exactly the same committed trees, not a reimplementation of either. */
function dependencyDecisions(before: DependencyTree, after: DependencyTree) {
  const repo = gitRepo({ seedCommit: false, kind: "image-dependency-contract" });
  const save = (tree: DependencyTree) => {
    for (const [path, text] of [["package-lock.json", tree.lock], ["package.json", tree.manifest], ["packages/fixture/package.json", tree.workspace], ...Object.entries(tree.manifests ?? {})] as const) {
      if (text === undefined) rmSync(join(repo.dir, path), { force: true });
      else { mkdirSync(dirname(join(repo.dir, path)), { recursive: true }); writeFileSync(join(repo.dir, path), text); }
    }
    repo.git("add", "-A"); repo.git("commit", "-q", "--allow-empty", "-m", "dependency input");
    return repo.git("rev-parse", "HEAD");
  };
  const base = save(before), head = save(after);
  repo.git("update-ref", "refs/remotes/origin/main", head);
  const output = join(repo.dir, "github-output"); writeFileSync(output, "");
  execFileSync("bash", ["-c", guardScript()], { cwd: repo.dir, encoding: "utf8",
    env: { ...process.env, BEFORE_SHA: base, AFTER_SHA: head, GITHUB_OUTPUT: output } });
  const git = (args: readonly string[]) => repo.git(...args);
  const deps = realDeployDeps({ installPath: repo.dir, stateRoot: join(repo.dir, "state"),
    daemonLabel: "fixture", serveLabel: "fixture", servePort: 4317, uid: 1000,
    ledgerPath: join(repo.dir, "state/ledger.ndjson"), log: () => {}, sleep: () => {},
    execFile: (cmd, argv) => {
      if (cmd === "docker" && argv[0] === "exec") return base;
      assert.equal(cmd, "git", "only fixture Git reads are permitted");
      return argv[0] === "-C" ? repo.git(...argv.slice(2)) : repo.git(...argv);
    } });
  try {
    return { build: readFileSync(output, "utf8").trim() === "build=true", drift: deps.imageBakedCommitsBehind!(),
      newest: deps.newestBakedSha!(), direct: imageDependenciesCommitsBehind(base, git),
      fingerprint: imageDependencyInputFingerprint("origin/main", git), newestDirect: newestImageDependencyInputSha(git), base, head };
  } finally { repo.cleanup(); }
}

const dependencyTree = (): DependencyTree => ({ lock: lockfile(SDK_OLD), manifest: "{}" });
const mutateDependency = (change: (lock: { packages: Record<string, Record<string, unknown>> }) => void): DependencyTree => {
  const tree=dependencyTree(), lock=JSON.parse(tree.lock!); change(lock); return { ...tree, lock: JSON.stringify(lock) };
};

test("image build and runtime drift agree on installed dependency changes", () => {
  const cases = [
    mutateDependency(l => l.packages["node_modules/left-pad"]!.version="1.0.1"),
    mutateDependency(l => l.packages["node_modules/left-pad"]!.integrity="sha512-republished"),
    mutateDependency(l => l.packages["node_modules/left-pad"]!.resolved="https://registry.invalid/other.tgz"),
    mutateDependency(l => l.packages[SDK_KEY]!.dependencies={"left-pad":"1.0.0"}),
    mutateDependency(l => l.packages["node_modules/child"]={version:"2.0.0",dev:true}),
    mutateDependency(l => { delete l.packages["node_modules/left-pad"]; }),
    mutateDependency(l => { l.packages["node_modules/left-pad"]!.optional=true; l.packages["node_modules/left-pad"]!.os=["linux"]; l.packages["node_modules/left-pad"]!.cpu=["x64"]; }),
    { ...dependencyTree(), manifest: JSON.stringify({ scripts: { install: "node install.js" } }) },
  ];
  for (const after of cases) {
    const got=dependencyDecisions(dependencyTree(),after);
    assert.equal(got.build,true); assert.equal(got.drift,1); assert.equal(got.direct,1);
    assert.equal(got.newest,got.head); assert.equal(got.newestDirect,got.head);
  }
  // The actual committed Hono security patch, not a made-up version-only approximation.
  const ref="64b0ccba26c00c28423a0c95da26578376fc1548";
  const actual=(sha:string):DependencyTree=>{
    const read=(path:string)=>execFileSync("git",["show",`${sha}:${path}`],{cwd:REPO_ROOT,encoding:"utf8"});
    const lock=read("package-lock.json"), entries=JSON.parse(lock).packages as Record<string,{link?:boolean;resolved?:string}>;
    const manifests=Object.fromEntries(Object.values(entries).filter(e=>e.link).map(e=>[`${e.resolved}/package.json`,read(`${e.resolved}/package.json`)]));
    return {lock,manifest:read("package.json"),manifests};
  };
  const old=actual(ref+"^"), next=actual(ref);
  const oldLock=JSON.parse(old.lock!), nextLock=JSON.parse(next.lock!);
  assert.equal(oldLock.packages["node_modules/hono"].version,"4.13.7");
  assert.equal(nextLock.packages["node_modules/hono"].version,"4.13.11");
  const committed=dependencyDecisions(old,next);
  assert.equal(committed.build,true); assert.equal(committed.drift,1); assert.equal(committed.newest,committed.head);
  // Full real-tree comparison is tested directly, including all required workspace manifests.
  const git=(args:readonly string[])=>execFileSync("git",args as string[],{cwd:REPO_ROOT,encoding:"utf8"});
  assert.notEqual(imageDependencyInputFingerprint(ref+"^",git),undefined);
  assert.notEqual(imageDependencyInputFingerprint(ref,git),undefined);
  assert.notEqual(imageDependencyInputFingerprint(ref+"^",git),imageDependencyInputFingerprint(ref,git));
});

test("image dependency inputs cover the full-install fallback without formatting rebuilds", () => {
  const before=mutateDependency(l=>{l.packages["node_modules/left-pad"]!.dev=true;});
  const after=JSON.parse(before.lock!); after.packages["node_modules/left-pad"].integrity="sha512-dev-change";
  assert.equal(dependencyDecisions(before,{...before,lock:JSON.stringify(after)}).build,true);
  const reordered=JSON.parse(before.lock!);
  reordered.packages=Object.fromEntries(Object.entries(reordered.packages).reverse());
  const got=dependencyDecisions(before,{...before,lock:JSON.stringify(reordered,null,4),manifest:"{  }\n"});
  assert.equal(got.build,false); assert.equal(got.drift,0); assert.equal(got.direct,0); assert.equal(got.newest,got.base);
  assert.match(readFileSync(join(REPO_ROOT,"deploy/Dockerfile"),"utf8"),/npm ci --omit=dev \|\| npm ci/);
});

test("image dependency uncertainty and newest input identity remain explicit", () => {
  for (const after of [ { ...dependencyTree(),lock:"{" }, { ...dependencyTree(),lock:undefined },
    { ...dependencyTree(),lock:JSON.stringify({lockfileVersion:3}) }, { ...dependencyTree(),manifest:undefined },
    { ...dependencyTree(),manifest:"null" }, { ...dependencyTree(),lock:JSON.stringify({lockfileVersion:1,dependencies:{}}) } ]) {
    const got=dependencyDecisions(dependencyTree(),after);
    assert.equal(got.build,true); assert.equal(got.drift,undefined); assert.equal(got.direct,undefined);
    assert.equal(got.newest,undefined); assert.equal(got.newestDirect,undefined);
  }
  const linked=mutateDependency(l=>{
    l.packages["packages/fixture"]={version:"1.0.0"};
    l.packages["node_modules/fixture"]={link:true,resolved:"packages/fixture"};
  });
  const before={...linked,workspace:JSON.stringify({name:"fixture",version:"1.0.0"})};
  const after={...before,workspace:JSON.stringify({name:"fixture",version:"1.0.1"})};
  const got=dependencyDecisions(before,after);
  assert.equal(got.build,true); assert.equal(got.drift,1); assert.equal(got.newest,got.head);
  assert.equal(dependencyDecisions(before,{...after,workspace:undefined}).drift,undefined);
});
