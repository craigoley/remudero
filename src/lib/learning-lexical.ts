/** Deterministic, dependency-free BM25 over learning facts. Only text that is already in the
 * reviewed corpus is ranked; the score never grants an entry authority or changes its lifecycle. */

const STOPWORDS = new Set([
  "and", "are", "but", "for", "from", "has", "have", "into", "not", "our", "the", "their",
  "this", "that", "these", "those", "with", "will", "you", "your", "task", "tasks",
]);

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export function lexicalTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export interface LexicalDocument { id: string; text: string }
export interface LexicalHit { id: string; score: number; matchedTerms: number }

/** Classic positive-IDF BM25. Query terms are deduplicated, and equal scores sort by id. */
export function bm25Rank(
  query: string,
  docs: readonly LexicalDocument[],
  opts: { k1?: number; b?: number } = {},
): LexicalHit[] {
  const terms = [...new Set(lexicalTokens(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const k1 = opts.k1 ?? BM25_K1;
  const b = opts.b ?? BM25_B;
  const tokenized = docs.map((doc) => ({ id: doc.id, tokens: lexicalTokens(doc.text) }));
  const avgLength = tokenized.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length;
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    frequencies.set(term, tokenized.filter((doc) => doc.tokens.includes(term)).length);
  }
  return tokenized.map((doc) => {
    const counts = new Map<string, number>();
    for (const token of doc.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      matchedTerms++;
      const df = frequencies.get(term)!;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const lengthNorm = avgLength === 0 ? 1 : 1 - b + b * doc.tokens.length / avgLength;
      score += idf * tf * (k1 + 1) / (tf + k1 * lengthNorm);
    }
    return { id: doc.id, score, matchedTerms };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
