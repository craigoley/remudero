import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

interface Workflow {
  on?: {
    push?: { branches?: string[]; paths?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { default?: unknown }> };
  };
  jobs?: {
    build?: {
      env?: Record<string, string>;
      steps?: Array<{ name?: string; run?: string; with?: { inlineScript?: string } }>;
    };
  };
}

const workflowPath = new URL("../.github/workflows/acr-build.yml", import.meta.url);

function workflow(): Workflow {
  return parseYaml(readFileSync(workflowPath, "utf8")) as Workflow;
}

function executableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(executableText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(executableText).join("\n");
  return "";
}

test("a push to main that changes either authoritative baked path starts the ACR build workflow", () => {
  const push = workflow().on?.push;
  assert.deepEqual(push?.branches, ["main"]);
  assert.deepEqual(push?.paths, ["deploy/Dockerfile", "deploy/entrypoint.sh"]);
});

test("a push to main that changes only mounted source paths does not start the ACR build workflow", () => {
  const paths = workflow().on?.push?.paths ?? [];
  for (const mountedPath of ["src/**", "test/**", "plan/**", "scripts/**", "bin/**", "package.json", "package-lock.json"]) {
    assert.equal(paths.includes(mountedPath), false, `${mountedPath} must not trigger an image build`);
  }
  assert.equal(paths.some((path) => path.includes("**") || path === "."), false, "the push filter must stay exact");
});

test("manual dispatch remains available with its current registry image and latest-tag controls", () => {
  const inputs = workflow().on?.workflow_dispatch?.inputs;
  assert.equal(inputs?.registry?.default, "synthwatcholey0620");
  assert.equal(inputs?.image?.default, "remudero");
  assert.equal(inputs?.tag_latest?.default, true);
});

test("both trigger modes publish an immutable commit tag and latest with the built sha stamped as RMD_BUILD_SHA", () => {
  const parsed = workflow();
  const env = parsed.jobs?.build?.env;
  assert.equal(env?.REGISTRY, "${{ inputs.registry || 'synthwatcholey0620' }}");
  assert.equal(env?.IMAGE, "${{ inputs.image || 'remudero' }}");
  assert.equal(env?.TAG_LATEST, "${{ github.event_name == 'push' || inputs.tag_latest }}");

  const build = parsed.jobs?.build?.steps?.find((step) => step.name === "Build and push (ACR)");
  const script = build?.with?.inlineScript ?? "";
  assert.match(script, /TAGS=\(-t "\$\{IMAGE\}:\$\{GITHUB_SHA\}"\)/);
  assert.match(script, /TAG_LATEST.*true[\s\S]*TAGS\+=\(-t "\$\{IMAGE\}:latest"\)/);
  assert.match(script, /--build-arg "RMD_BUILD_SHA=\$\{GITHUB_SHA\}"/);
});

test("the workflow builds only and contains no container replacement or recycle action", () => {
  const text = executableText(workflow().jobs);
  assert.doesNotMatch(text, /\b(?:docker\s+(?:run|stop|rm)|recycle-container|host-update|az\s+containerapp|ssh)\b/i);
  assert.match(text, /\baz acr build\b/);
});
