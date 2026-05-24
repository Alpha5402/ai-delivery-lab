export type ReadingStats = {
  wordCount: number;
  readingMinutes: number;
};

const WORDS_PER_MINUTE = 300;

export function calculateReadingStats(body: string): ReadingStats {
  const normalized = body.trim();

  if (!normalized) {
    return { wordCount: 0, readingMinutes: 1 };
  }

  const cjkChars = normalized.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const withoutCjk = normalized.replace(/[\u4e00-\u9fff]/g, " ");
  const latinWords = withoutCjk.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
  const wordCount = cjkChars + latinWords;

  return {
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE)),
  };
}
