import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Real embeddings from a real model (Voyage — Anthropic's recommended
 * embedding provider; there is no embeddings endpoint on the Messages API).
 *
 * Results are cached to .cache/embeddings.json so the on-stage run is fast
 * and does not depend on conference wifi. Delete the file to re-embed.
 */

const MODEL = process.env.EMBED_MODEL ?? 'voyage-3-lite';
const CACHE = new URL('../../.cache/embeddings.json', import.meta.url).pathname;

export type InputType = 'document' | 'query';
type EmbeddingCache = Record<string, number[]>;

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

let cache: EmbeddingCache | null = null;

async function loadCache(): Promise<EmbeddingCache> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8')) as EmbeddingCache;
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache(): Promise<void> {
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache));
}

const key = (text: string, type: InputType) => createHash('sha1').update(`${MODEL}:${type}:${text}`).digest('hex');

export async function embed(texts: string, inputType?: InputType): Promise<number[]>;
export async function embed(texts: string[], inputType?: InputType): Promise<number[][]>;
export async function embed(
  texts: string | string[],
  inputType: InputType = 'document',
): Promise<number[] | number[][]> {
  const list = Array.isArray(texts) ? texts : [texts];
  const c = await loadCache();

  const missing = list.filter((t) => !c[key(t, inputType)]);
  if (missing.length) {
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error(
        'VOYAGE_API_KEY is not set. Layer 4 needs a real embedding model.\n'
          + 'Get a free key at https://voyageai.com and put it in .env',
      );
    }
    // Voyage accepts up to 128 inputs per request.
    for (let i = 0; i < missing.length; i += 128) {
      const batch = missing.slice(i, i + 128);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, input: batch, input_type: inputType }),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-await-in-loop
        throw new Error(`voyage ${res.status}: ${await res.text()}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const json = (await res.json()) as VoyageEmbeddingResponse;
      json.data.forEach((d, j) => {
        c[key(batch[j] as string, inputType)] = d.embedding;
      });
    }
    await saveCache();
  }

  const out = list.map((t) => c[key(t, inputType)] as number[]);
  return Array.isArray(texts) ? out : (out[0] as number[]);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
