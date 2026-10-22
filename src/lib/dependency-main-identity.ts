/** Immutable, whole-path evidence for dependency changes that already landed on main. */
import { isDependabotAuthor, isManifestPath } from "./dep-review.js";
import { PLAN_FILING_FILE_CACHE_MAX_ENTRIES, PLAN_FILING_FILE_RESPONSE_CAP, type GhApiFetcher, type GhReadSteps, type OpenPrRest, type PlanFilingFileObservation } from "./open-prs-rest.js";

export type DependencyMainIdentity =
  | { state: "identical"; headSha: string; mainSha: string; files: readonly { path: string; mode: string; blob: string }[] }
  | { state: "different" | "unavailable"; reason: string };

const caches = new WeakMap<object, Map<string, DependencyMainIdentity>>();
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function* read(fetch: GhApiFetcher, endpoint: string): GhReadSteps<unknown> { return yield () => fetch(["api", endpoint]); }

/** Existing complete-file admission bounds this reader too. No observed bot candidate means no reads.
 * Only immutable identity results are retained; failed or partial reads are retried normally. */
export function* hydrateDependencyMainIdentitiesSteps(
  owner: string, repo: string, candidates: readonly OpenPrRest[],
  observations: ReadonlyMap<number, PlanFilingFileObservation>, fetch: GhApiFetcher, cacheOwner: object,
): GhReadSteps<Map<number, DependencyMainIdentity>> {
  const out = new Map<number, DependencyMainIdentity>();
  const eligible = candidates.filter(pr => {
    const paths = observations.get(pr.number);
    return pr.isDraft !== true && pr.contributionOrigin?.actor?.login !== undefined && isDependabotAuthor({ login: pr.contributionOrigin.actor.login }) &&
      sha(pr.headRefOid) && paths?.state === "complete" && paths.paths.length > 0 &&
      new Set(paths.paths).size === paths.paths.length && paths.paths.every(path => isManifestPath(path));
  });
  if (eligible.length === 0) return out;
  const cache = caches.get(cacheOwner) ?? new Map<string, DependencyMainIdentity>();
  caches.set(cacheOwner, cache);
  const prefix = `repos/${owner}/${repo}`;
  let mainSha: string;
  try {
    const main = record(yield* read(fetch, `${prefix}/commits/main`));
    if (main === undefined) throw new Error("main response unavailable");
    if (!sha(main.sha)) throw new Error("main SHA unavailable");
    mainSha = main.sha;
  } catch (error) {
    const reason = String(error);
    for (const pr of eligible) out.set(pr.number, { state: "unavailable", reason });
    return out;
  }
  for (const pr of eligible) {
    const observation = observations.get(pr.number)!;
    if (observation.state !== "complete") continue;
    const paths = [...observation.paths].sort();
    const key = JSON.stringify([owner, repo, pr.number, pr.headRefOid, mainSha, paths]);
    const prior = cache.get(key);
    if (prior !== undefined) { out.set(pr.number, prior); continue; }
    let result: DependencyMainIdentity;
    try {
      const bound = (raw: unknown): boolean => {
        const row = record(raw);
        const head = record(row?.head), base = record(row?.base), user = record(row?.user);
        return row?.state === "open" && row.merged === false && head?.sha === pr.headRefOid && base?.ref === "main" && base.sha === mainSha &&
          typeof user?.login === "string" && isDependabotAuthor({ login: user.login }) && row.changed_files === paths.length;
      };
      if (!bound(yield* read(fetch, `${prefix}/pulls/${pr.number}`))) throw new Error("PR identity or file count unbound");
      const files = yield* read(fetch, `${prefix}/pulls/${pr.number}/files?per_page=100`);
      if (!Array.isArray(files) || files.length !== paths.length || files.length >= PLAN_FILING_FILE_RESPONSE_CAP)
        throw new Error("changed path population incomplete");
      const actual = files.map(file => record(file));
      if (actual.some(file => !file || typeof file.status !== "string" || !["modified", "added"].includes(file.status) || !sha(file.sha) || file.previous_filename !== undefined) ||
          JSON.stringify(actual.map(file => file!.filename).sort()) !== JSON.stringify(paths))
        throw new Error("changed path population unsupported or mismatched");
      const trees = new Map<string, Map<string, { mode: string; type: string; sha: string }>>();
      function* tree(treeSha: string): GhReadSteps<Map<string, { mode: string; type: string; sha: string }>> {
        const cached = trees.get(treeSha);
        if (cached) return cached;
        const body = record(yield* read(fetch, `${prefix}/git/trees/${treeSha}`));
        if (body?.sha !== treeSha || body.truncated !== false || !Array.isArray(body.tree)) throw new Error("tree incomplete or unbound");
        const entries = new Map<string, { mode: string; type: string; sha: string }>();
        for (const value of body.tree) {
          const entry = record(value);
          if (!entry || typeof entry.path !== "string" || entry.path.includes("/") || entries.has(entry.path) || !sha(entry.sha) ||
              typeof entry.mode !== "string" || typeof entry.type !== "string") throw new Error("tree entry malformed");
          entries.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
        }
        trees.set(treeSha, entries);
        return entries;
      }
      function* root(commitSha: string): GhReadSteps<string> {
        const commit = record(yield* read(fetch, `${prefix}/git/commits/${commitSha}`));
        const commitTree = record(commit?.tree);
        if (commitTree === undefined) throw new Error("commit tree unavailable");
        if (commit?.sha !== commitSha || !sha(commitTree.sha)) throw new Error("commit tree unbound");
        return commitTree.sha;
      }
      function* leaf(rootSha: string, path: string): GhReadSteps<{ mode: string; type: string; sha: string } | undefined> {
        let current = rootSha;
        const parts = path.split("/");
        if (parts.some(part => part === "" || part === "." || part === ".." || /[\0\r\n]/.test(part))) throw new Error("unsafe path");
        for (let i = 0; i < parts.length; i++) {
          const entry = (yield* tree(current)).get(parts[i]);
          if (!entry) return undefined;
          if (i === parts.length - 1) return entry;
          if (entry.type !== "tree" || entry.mode !== "040000") throw new Error("non-directory parent");
          current = entry.sha;
        }
        return undefined;
      }
      const headRoot = yield* root(pr.headRefOid);
      const mainRoot = yield* root(mainSha);
      const identities: Array<{ path: string; mode: string; blob: string }> = [];
      let different = false;
      for (const path of paths) {
        const head = yield* leaf(headRoot, path);
        const main = yield* leaf(mainRoot, path);
        if (!head || head.type !== "blob" || !["100644", "100755"].includes(head.mode) || !main || main.type !== "blob" ||
            !["100644", "100755"].includes(main.mode)) throw new Error("missing or non-regular leaf");
        if (head.sha !== actual.find(file => file!.filename === path)!.sha) throw new Error("file blob unbound to head tree");
        if (head.mode !== main.mode || head.sha !== main.sha) different = true;
        identities.push({ path, mode: head.mode, blob: head.sha });
      }
      if (!bound(yield* read(fetch, `${prefix}/pulls/${pr.number}`))) throw new Error("PR moved during observation");
      result = different ? { state: "different", reason: "main differs in content or mode" } : { state: "identical", headSha: pr.headRefOid, mainSha, files: identities };
      cache.set(key, result);
      while (cache.size > PLAN_FILING_FILE_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    } catch (error) { result = { state: "unavailable", reason: String(error) }; }
    out.set(pr.number, result);
  }
  return out;
}
