// W1-T14823 — the agent SDK (/) and the image's Claude Code CLI (/deploy) bump in ONE Dependabot pull request.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

const SDK = "@anthropic-ai/claude-agent-sdk";
const CLI = "@anthropic-ai/claude-code";
const SHARED = "agent-sdk-and-image-cli";
const APP = "npm-minor-and-patch";

interface Group { patterns?: string[]; "exclude-patterns"?: string[]; "update-types"?: string[] }
interface Lane { "package-ecosystem": string; directory?: string; directories?: string[]; groups?: Record<string, Group> }

function npmLanes(): Lane[] {
  const cfg = parse(readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8")) as { updates: Lane[] };
  return cfg.updates.filter((u) => u["package-ecosystem"] === "npm");
}

function sharedLane(): Lane {
  const lane = npmLanes().find((u) => (u.directories ?? []).includes("/") && (u.directories ?? []).includes("/deploy"));
  assert.ok(lane, "one npm lane must list both / and /deploy under `directories`");
  return lane;
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
}

/** Dependabot's rule: a dependency joins the FIRST group whose patterns (default every name) match and whose exclude-patterns don't. */
function groupOf(lane: Lane, name: string): string | undefined {
  for (const [id, g] of Object.entries(lane.groups ?? {})) {
    const inPatterns = (g.patterns ?? ["*"]).some((p) => glob(p).test(name));
    const excluded = (g["exclude-patterns"] ?? []).some((p) => glob(p).test(name));
    if (inPatterns && !excluded) return id;
  }
  return undefined;
}

function deps(dir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

test("W1-T14823 the agent SDK and the image CLI share one npm group spanning / and /deploy", () => {
  const lane = sharedLane();
  assert.ok(deps(".").includes(SDK), `the root manifest must declare ${SDK}`);
  assert.ok(deps("deploy").includes(CLI), `deploy/package.json must declare ${CLI}`);
  assert.equal(groupOf(lane, SDK), SHARED, `${SDK} must join the ${SHARED} group`);
  assert.equal(groupOf(lane, CLI), SHARED, `${CLI} must join the ${SHARED} group`);
});

test("W1-T14823 no other npm lane covers / or /deploy", () => {
  const lanes = npmLanes();
  const shared = lanes.filter((u) => (u.directories ?? []).includes("/") && (u.directories ?? []).includes("/deploy"));
  assert.equal(shared.length, 1, "exactly one npm lane must list both / and /deploy");
  for (const u of lanes.filter((l) => l !== shared[0])) {
    const dirs = [...(u.directories ?? []), ...(u.directory === undefined ? [] : [u.directory])];
    assert.ok(!dirs.includes("/") && !dirs.includes("/deploy"), `a second npm lane covers ${dirs.join(", ")}`);
  }
});

test("W1-T14823 every image package is named by an image group and never joins the app group", () => {
  const lane = sharedLane();
  for (const name of deps("deploy")) {
    const id = groupOf(lane, name);
    assert.ok(id !== undefined && id !== APP, `${name} (deploy/package.json) must join an image group, got ${id ?? "none"}`);
    assert.ok(
      (lane.groups?.[id]?.patterns ?? []).includes(name),
      `${name} must be named in ${id}'s patterns, not caught by a wildcard`,
    );
  }
});

test("W1-T14823 the root app dependencies stay in the app group", () => {
  const lane = sharedLane();
  const app = deps(".").filter((n) => n !== SDK);
  assert.ok(app.length > 0, "the root manifest must declare app dependencies");
  for (const name of app) assert.equal(groupOf(lane, name), APP, `${name} must stay in ${APP}`);
});
