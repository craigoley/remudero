import type { CorpusCommit } from "./ci-failure-corpus.js";
import type { RollupCheckEntry } from "./sweep.js";

/** One request carries up to twenty commits and their check/status contexts. */
export const CI_LEARNING_GRAPHQL_COMMITS_PER_PAGE = 20;
/** PRIMARY CONTROL: at most one hundred commits from a PR are read in one daily pass. */
export const CI_LEARNING_GRAPHQL_MAX_PAGES = 5;

const PR_COMMITS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      commits(first:20,after:$after){
        nodes{commit{oid statusCheckRollup{contexts(first:100){
          nodes{__typename
            ... on CheckRun{name status conclusion startedAt completedAt detailsUrl externalId}
            ... on StatusContext{context state createdAt updatedAt}}
          pageInfo{hasNextPage}}}}}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A context page we cannot see in full is unreadable, never an empty or green rollup. */
function contextsFromGraphql(value: unknown): RollupCheckEntry[] | undefined {
  if (value === null) return [];
  const rollup = object(value);
  const contexts = object(rollup?.contexts);
  const pageInfo = object(contexts?.pageInfo);
  if (contexts === undefined || pageInfo === undefined) return undefined;
  if (!Array.isArray(contexts.nodes) || pageInfo.hasNextPage !== false) return undefined;
  const entries: RollupCheckEntry[] = [];
  for (const raw of contexts.nodes) {
    const row = object(raw);
    if (row?.__typename === "CheckRun" && typeof row.name === "string" && typeof row.status === "string") {
      entries.push({
        name: row.name,
        status: row.status,
        ...(typeof row.conclusion === "string" ? { conclusion: row.conclusion } : {}),
        ...(optionalString(row.startedAt) ? { startedAt: row.startedAt as string } : {}),
        ...(optionalString(row.completedAt) ? { completedAt: row.completedAt as string } : {}),
        ...(optionalString(row.detailsUrl) ? { detailsUrl: row.detailsUrl as string } : {}),
        ...(optionalString(row.externalId) ? { externalId: row.externalId as string } : {}),
      });
    } else if (row?.__typename === "StatusContext" && typeof row.context === "string" && typeof row.state === "string") {
      entries.push({
        context: row.context,
        state: row.state,
        ...(optionalString(row.createdAt) ? { startedAt: row.createdAt as string } : {}),
      });
    } else {
      return undefined;
    }
  }
  return entries;
}

/** Read one PR's commits and both gate types in one GraphQL call per twenty commits.
 * A malformed/truncated PR throws; a truncated context page leaves that commit unreadable. */
export async function readCiPrGraphql(
  owner: string,
  repo: string,
  number: number,
  read: (args: string[]) => Promise<unknown>,
  yieldBetweenPages: () => Promise<void> = async () => {},
): Promise<CorpusCommit[]> {
  const commits: CorpusCommit[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < CI_LEARNING_GRAPHQL_MAX_PAGES; page++) {
    const args = ["api", "graphql", "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`,
      "-f", `query=${PR_COMMITS_QUERY}`, ...(after === undefined ? [] : ["-f", `after=${after}`])];
    const response = object(await read(args));
    if (Array.isArray(response?.errors) && response.errors.length > 0) throw new Error(`CI-learning PR #${number} GraphQL errors`);
    const connection = object(object(object(response?.data)?.repository)?.pullRequest)?.commits;
    const rows = object(connection);
    const pageInfo = object(rows?.pageInfo);
    if (rows === undefined || pageInfo === undefined) {
      throw new Error(`CI-learning PR #${number} GraphQL commit page unreadable`);
    }
    if (!Array.isArray(rows.nodes) || typeof pageInfo.hasNextPage !== "boolean") {
      throw new Error(`CI-learning PR #${number} GraphQL commit page unreadable`);
    }
    for (const raw of rows.nodes) {
      const commit = object(object(raw)?.commit);
      if (typeof commit?.oid !== "string" || commit.oid.length === 0) {
        throw new Error(`CI-learning PR #${number} GraphQL commit SHA unreadable`);
      }
      const rollup = contextsFromGraphql(commit.statusCheckRollup);
      commits.push({ sha: commit.oid, ...(rollup === undefined ? {} : { rollup }) });
    }
    if (!pageInfo.hasNextPage) return commits;
    if (typeof pageInfo.endCursor !== "string" || rows.nodes.length === 0 || seenCursors.has(pageInfo.endCursor)) {
      throw new Error(`CI-learning PR #${number} GraphQL cursor unreadable`);
    }
    seenCursors.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
    await yieldBetweenPages();
  }
  throw new Error(`CI-learning PR #${number} exceeds ${CI_LEARNING_GRAPHQL_COMMITS_PER_PAGE * CI_LEARNING_GRAPHQL_MAX_PAGES} commits`);
}
