/**
 * W1-T11195 — the ONE bounded reader of a product target's runner configuration.
 *
 * A native `rmd plan` against a product target reads its mounts table (`mountsPath`) from that target before it logs
 * `plan.start`; a target that carries none can only fail. This reader answers, from the COMMITTED tree at the exact frozen
 * head (never the working tree, which a dirty file can fake), whether that table is there and valid, so the product plan
 * operation refuses with a named, recoverable state before it journals or hands anything off.
 *
 * Four answers, and a failure never becomes absence (W1-T10621's confirmed-absence discipline):
 * - `present`: a regular blob that parses and validates through `validateMounts`, Tier Invariant (G-17) included.
 * - `absent`: a successful tree read at a verified commit lacks the path.
 * - `invalid`: the path is a symlink, a non-blob, oversized, or a blob that fails parsing or validation.
 * - `unreadable`: any git or transport failure, including a head that is not a commit in the checkout.
 */
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { mountsPath, validateMounts } from "./mounts.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

const layout = resolveRepoLayout(sep, () => undefined);
const treePath = (path: string) => relative(layout.root, path).split(sep).join("/");
/** The table's path inside the target tree: exactly the file `mountsPath` joins under a target root. */
export const TARGET_RUNNER_CONFIG_PATH = treePath(mountsPath(layout.root));
/** The never-overridable per-target state directory the table lives in. */
const STATE_DIRECTORY = treePath(layout.stateDir);
/** BACKSTOP: this repository's own table is ~43 KB; a blob past this bound is refused as invalid, never buffered. */
export const TARGET_RUNNER_CONFIG_MAX_BYTES = 1024 * 1024;

export type TargetRunnerConfig =
  | { state: "present"; head: string; path: string; digest: string }
  | { state: "absent"; head: string; path: string }
  | { state: "invalid" | "unreadable"; head: string; path: string; reason: string };

/** One git read of the target checkout; the default is the pinned host-worktree reader. */
export type TargetGitRead = (checkout: string, args: string[], opts: { maxBuffer: number; encoding?: "utf8" | "latin1" }) => Promise<string>;
const hostRead: TargetGitRead = (checkout, args, opts) => hostWorktreeGitAsync(checkout, args, { timeout: 20_000, ...opts });

interface TreeEntry { mode: string; type: string; object: string; size: string; path: string }
const entries = (out: string): TreeEntry[] => out.split("\0").filter(Boolean).flatMap((line) => {
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\S+)\t(.*)$/s.exec(line);
  if (!match) throw new Error(`unparseable ls-tree row: ${JSON.stringify(line)}`);
  return [{ mode: match[1]!, type: match[2]!, object: match[3]!, size: match[4]!, path: match[5]! }];
});

/** Read the mounts table from `head`'s committed tree in `checkout`. Never throws: every failure is a state. */
export async function readTargetRunnerConfig(checkout: string, head: string, read: TargetGitRead = hostRead): Promise<TargetRunnerConfig> {
  const path = TARGET_RUNNER_CONFIG_PATH;
  const at = { head, path };
  if (!/^[a-f0-9]{40}$/.test(head)) return { state: "unreadable", ...at, reason: "the frozen head is not a commit id" };
  let blob: Buffer;
  try {
    const commit = (await read(checkout, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{commit}`], { maxBuffer: 4096 })).trim();
    if (commit !== head) return { state: "unreadable", ...at, reason: `the checkout resolves ${head} to ${commit || "nothing"}` };
    const [file] = entries(await read(checkout, ["ls-tree", "-z", "-l", "--full-tree", head, "--", path], { maxBuffer: 64 * 1024 }));
    if (file === undefined) {
      // The file is not listed. A symlinked or non-directory state directory hides it rather than proving it absent.
      const [parent] = entries(await read(checkout, ["ls-tree", "-z", "-l", "--full-tree", head, "--", STATE_DIRECTORY], { maxBuffer: 64 * 1024 }));
      if (parent !== undefined && parent.type !== "tree") {
        return { state: "invalid", ...at, reason: `${STATE_DIRECTORY} is a ${parent.mode === "120000" ? "symlink" : parent.type}, not a directory` };
      }
      return { state: "absent", ...at };
    }
    if (file.mode === "120000") return { state: "invalid", ...at, reason: `${path} is a symlink` };
    if (file.type !== "blob") return { state: "invalid", ...at, reason: `${path} is a ${file.type}, not a file` };
    if (!(Number(file.size) <= TARGET_RUNNER_CONFIG_MAX_BYTES)) return { state: "invalid", ...at, reason: `${path} is ${file.size} bytes, over the ${TARGET_RUNNER_CONFIG_MAX_BYTES}-byte bound` };
    blob = Buffer.from(await read(checkout, ["cat-file", "blob", file.object], { maxBuffer: TARGET_RUNNER_CONFIG_MAX_BYTES + 1, encoding: "latin1" }), "latin1");
  } catch (error) {
    return { state: "unreadable", ...at, reason: `git read failed: ${String((error as Error)?.message ?? error)}` };
  }
  try {
    validateMounts(parseYaml(new TextDecoder("utf-8", { fatal: true }).decode(blob)));
  } catch (error) {
    return { state: "invalid", ...at, reason: String((error as Error)?.message ?? error) };
  }
  return { state: "present", ...at, digest: createHash("sha256").update(blob).digest("hex") };
}
