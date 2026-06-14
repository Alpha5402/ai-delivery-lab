import { getLlmRuntimeSettings } from "./llmSettingsService.js";

type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
};

const EMBEDDING_TIMEOUT_MS = 30_000;

export async function getEmbedding(text: string): Promise<{ embedding: number[]; model: string } | null> {
  const settings = getLlmRuntimeSettings();
  const model = settings.embeddingModelName;
  if (!settings.apiKey || !model || !text.trim()) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(`${settings.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const payload = await response.json() as EmbeddingResponse;
    const embedding = payload.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.length > 0 ? { embedding, model } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function cosineSimilarity(left: number[] | undefined, right: number[] | undefined) {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
