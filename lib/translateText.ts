import translate from "google-translate-api-x";

// The underlying (unofficial) Google Translate endpoint caps requests at
// ~5000 characters - we chunk conservatively below that.
const CHUNK_SIZE = 4500;

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n\s*\n/)) {
    if ((current + "\n\n" + paragraph).length > size) {
      if (current) chunks.push(current);
      // A single paragraph longer than the chunk size on its own - hard split it.
      if (paragraph.length > size) {
        for (let i = 0; i < paragraph.length; i += size) {
          chunks.push(paragraph.slice(i, i + size));
        }
        current = "";
      } else {
        current = paragraph;
      }
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export type OnTranslateProgress = (current: number, total: number) => void;

/**
 * Translates text into targetLangCode (ISO 639-1, e.g. "hi", "es").
 * Free, no API key - uses the unofficial Google Translate web endpoint under
 * the hood, chunked to respect its per-request character limit.
 */
export async function translateText(
  sourceText: string,
  targetLangCode: string,
  onProgress?: OnTranslateProgress
): Promise<string> {
  const chunks = chunkText(sourceText, CHUNK_SIZE);
  const translatedChunks: string[] = [];

  onProgress?.(0, chunks.length);

  for (let i = 0; i < chunks.length; i++) {
    const result: any = await translate(chunks[i], { to: targetLangCode });
    const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
    translatedChunks.push(text);

    onProgress?.(i + 1, chunks.length);

    // Small delay between chunk requests to be gentle on the free endpoint.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return translatedChunks.join("\n\n");
}
