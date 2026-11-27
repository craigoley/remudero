/**
 * The depends_on shortlist an inbox draft can carry instead of every open task (config `inboxDraftIndex: "topk"`).
 *
 * MEASURED 2026-11-27 at b446ded: after W1-T14296 the draft index still lists 1,027 open public tasks in 265,777
 * chars, 97.5% of a 272,446-char prompt. This module scores those rows against one proposal and keeps the top K.
 * A row the proposal names by id is ALWAYS kept, whatever its score, because naming it is the strongest evidence a
 * dependency can have. The worker keeps Grep, so a dependency the shortlist misses is one search away, and the
 * prompt says so; the default index stays "full" until the operator flips it.
 *
 * Score = BM25(proposal text, row title and rationale) + IDF-weighted shared `files:` paths (a shared parent
 * directory counts half) + IDF-weighted shared `plan_refs` (a row whose plan_refs name an id the proposal names
 * shares that ref too). IDF keeps a path every task touches, like src/run-task.ts, from outranking a rare one.
 */

/** One open plan row, reduced to what the score reads. */
export interface DependsOnCandidateRow {
  id: string;
  title: string;
  /** Free text beside the title (the row's rationale); scored with the title, at lower weight. */
  body?: string;
  files: readonly string[];
  planRefs: readonly string[];
}

/** What the score reads from one proposal. */
export interface DependsOnCandidateQuery {
  text: string;
  files: readonly string[];
  planRefs: readonly string[];
  /** Ids the proposal names; a row with one of these ids is always kept. */
  namedIds: ReadonlySet<string>;
}

export const DEFAULT_DEPENDS_ON_SHORTLIST_K = 80;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Title tokens count this many times over a rationale token: a title here IS the finding. */
const TITLE_WEIGHT = 3;
/** Only the start of a rationale is scored, so one long record cannot dominate the length norm or the run time. */
const BODY_CHARS = 1500;
const DIRECTORY_WEIGHT = 0.5;

const STOPWORDS = new Set(("the and for that this with from are was were not but its it's into onto than then when what which " +
  "who whom whose why how all any each every one two its has have had does did done can could should would will shall " +
  "may might must our your their them they there here these those such only also just more most less least very same " +
  "other another over under after before about above below between while where whether because since until upon task " +
  "tasks").split(" "));

/** Lower-case word tokens of at least three characters, stopwords and bare numbers dropped. */
export function candidateTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/** Every proper ancestor directory of a repo-relative path, nearest first; the root is never one. */
function parentDirectories(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const dirs: string[] = [];
  for (let end = parts.length - 1; end >= 1; end--) dirs.push(parts.slice(0, end).join("/"));
  return dirs;
}

function idf(documentFrequency: number, total: number): number {
  return Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function frequencies<T>(sets: readonly ReadonlySet<T>[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const set of sets) for (const item of set) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** Each row's score against the query, in row order. A named row scores like any other; retention is separate. */
export function scoreDependsOnCandidates(rows: readonly DependsOnCandidateRow[], query: DependsOnCandidateQuery): number[] {
  const total = rows.length;
  if (total === 0) return [];

  const docTerms = rows.map((row) => {
    const counts = new Map<string, number>();
    for (const token of candidateTokens(row.title)) counts.set(token, (counts.get(token) ?? 0) + TITLE_WEIGHT);
    for (const token of candidateTokens((row.body ?? "").slice(0, BODY_CHARS))) counts.set(token, (counts.get(token) ?? 0) + 1);
    let length = 0;
    for (const count of counts.values()) length += count;
    return { counts, length };
  });
  const averageLength = docTerms.reduce((sum, doc) => sum + doc.length, 0) / total || 1;
  const termFrequency = frequencies(docTerms.map((doc) => new Set(doc.counts.keys())));
  const queryTerms = new Set(candidateTokens(query.text));

  const rowFiles = rows.map((row) => new Set(row.files));
  const rowDirs = rows.map((row) => new Set(row.files.flatMap(parentDirectories)));
  const fileFrequency = frequencies(rowFiles);
  const dirFrequency = frequencies(rowDirs);
  const queryFiles = new Set(query.files);
  const queryDirs = new Set(query.files.flatMap(parentDirectories));

  const rowRefs = rows.map((row) => new Set(row.planRefs));
  const refFrequency = frequencies(rowRefs);
  const queryRefs = new Set([...query.planRefs, ...query.namedIds]);

  return rows.map((_row, i) => {
    const doc = docTerms[i]!;
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.counts.get(term);
      if (tf === undefined) continue;
      score += idf(termFrequency.get(term)!, total) * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / averageLength));
    }
    for (const file of rowFiles[i]!) if (queryFiles.has(file)) score += idf(fileFrequency.get(file)!, total);
    for (const dir of rowDirs[i]!) if (queryDirs.has(dir)) score += DIRECTORY_WEIGHT * idf(dirFrequency.get(dir)!, total);
    for (const ref of rowRefs[i]!) if (queryRefs.has(ref)) score += idf(refFrequency.get(ref)!, total);
    return score;
  });
}

/**
 * The shortlist's ids in PLAN ORDER: every row the query names, plus the `k` highest-scoring other rows with a
 * positive score (ties go to the earlier row). A row that shares nothing with the proposal is never padding.
 */
export function dependsOnShortlist(rows: readonly DependsOnCandidateRow[], query: DependsOnCandidateQuery,
  k: number = DEFAULT_DEPENDS_ON_SHORTLIST_K): string[] {
  const scores = scoreDependsOnCandidates(rows, query);
  const ranked = rows.map((row, i) => ({ row, i, score: scores[i]! }))
    .filter(({ row, score }) => !query.namedIds.has(row.id) && score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, Math.floor(k)));
  const kept = new Set(ranked.map(({ i }) => i));
  return rows.filter((row, i) => kept.has(i) || query.namedIds.has(row.id)).map((row) => row.id);
}

/** Repo-relative path tokens in free text: at least one slash, a file-ish last segment, no URL scheme. */
export function pathsInText(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/[\s`'"()[\]{},;<>]+/)) {
    if (raw.includes("://")) continue;
    const token = raw.replace(/^[./]+/, "").replace(/[.:]+$/, "");
    if (/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(token)) found.add(token);
  }
  return [...found];
}
