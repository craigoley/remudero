// W1-T6063 — a Node major in the image is a coordinated plan change, never a dependency bump.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", ".github", "dependabot.yml");

interface Lane {
  "package-ecosystem": string;
  directory: string;
  ignore?: { "dependency-name"?: string; "update-types"?: string[] }[];
}

test("W1-T6063: the deploy docker lane ignores node majors", () => {
  const cfg = parse(readFileSync(CONFIG, "utf8")) as { updates: Lane[] };
  const lane = cfg.updates.find((u) => u["package-ecosystem"] === "docker" && u.directory === "/deploy");
  assert.ok(lane, "the /deploy docker lane must exist");
  const ignored = (lane.ignore ?? []).some(
    (i) => i["dependency-name"] === "node" && (i["update-types"] ?? []).includes("version-update:semver-major"),
  );
  assert.ok(ignored, "the /deploy docker lane must ignore node version-update:semver-major");
});
