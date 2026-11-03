import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { ProjectInitError, type ProjectInitPayload } from "./project-init.js";
import { resolveRepoLayout, type RepoLayout } from "./repo-layout.js";

/**
 * `rmd project init --write <dir>`: puts the generated gate stack on disk in a target checkout.
 *
 * project-init.ts stays a pure generator. Without this step its output stopped at a printed file
 * list, so every onboarding retyped the stack by hand. This writer only creates files: it refuses
 * any path that already exists, so an existing repository's own workflows are never overwritten.
 * Pushing, opening the PR and arming branch protection stay separate operator steps.
 */
export interface ProjectInitWriteFs {
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  writeFile: (path: string, content: string) => void;
}

export const realProjectInitWriteFs: ProjectInitWriteFs = {
  exists: existsSync,
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, content) => writeFileSync(path, content, { flag: "wx" }),
};

/** Configs GitHub reads only from `.github/`: a repo-root dependabot.yml is ignored, so it would land inert. */
const GITHUB_DIR_CONFIGS = new Set(["dependabot.yml"]);

/** Repository-relative path to content, in the order the files are written. The principles file and
 *  the protection payload go where the target's layout puts them, never at a re-spelled literal. */
export function projectInitFiles(payload: ProjectInitPayload, layout: RepoLayout): Array<[string, string]> {
  const rel = (path: string) => relative(layout.root, path).split(sep).join("/");
  return [
    ...Object.entries(payload.workflows).map(([name, content]): [string, string] => [`.github/workflows/${name}`, content]),
    ...Object.entries(payload.configs).map(([name, content]): [string, string] => [GITHUB_DIR_CONFIGS.has(name) ? `.github/${name}` : name, content]),
    [rel(layout.principlesFile), payload.principlesYaml],
    [rel(join(layout.stateDir, "branch-protection.json")), JSON.stringify(payload.branchProtection, null, 2) + "\n"],
  ];
}

/** Write every generated file under `dir`. Checks all targets before writing any, so a refusal writes nothing. */
export function writeProjectInit(payload: ProjectInitPayload, dir: string, fs: ProjectInitWriteFs = realProjectInitWriteFs): string[] {
  if (!isAbsolute(dir)) throw new ProjectInitError(`rmd project init: --write needs an absolute directory, got "${dir}"`);
  const files = projectInitFiles(payload, resolveRepoLayout(dir));
  for (const [rel] of files) {
    if (isAbsolute(rel) || normalize(rel).split(sep).includes("..")) throw new ProjectInitError(`rmd project init: generated path escapes the target: ${rel}`);
  }
  const existing = files.map(([rel]) => rel).filter((rel) => fs.exists(join(dir, rel)));
  if (existing.length > 0) {
    throw new ProjectInitError(`rmd project init: refusing to overwrite existing file(s) in ${dir}: ${existing.join(", ")}`);
  }
  for (const [rel, content] of files) {
    const target = join(dir, rel);
    fs.mkdirp(dirname(target));
    fs.writeFile(target, content);
  }
  return files.map(([rel]) => rel);
}
