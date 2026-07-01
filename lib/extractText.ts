import pdfParse from "pdf-parse";
import { pdf } from "pdf-to-img";
import { createWorker } from "tesseract.js";

// If the embedded text layer averages fewer characters per page than this,
// treat the PDF as scanned/image-based and fall back to OCR.
const MIN_CHARS_PER_PAGE = 20;

// Safety cap so a huge upload can't hang the process during a demo.
const MAX_PAGES = 40;

export type ExtractProgress = {
  ocrStage: "parsing" | "ocr";
  current: number;
  total: number;
};

export type OnExtractProgress = (progress: ExtractProgress) => void;

/**
 * Extracts text from a PDF buffer.
 * - Text-based PDFs: uses pdf-parse (fast, free, no external calls) - this
 *   is near-instant regardless of page count, so no per-page progress needed.
 * - Scanned/image PDFs: falls back to Tesseract.js OCR (also free, runs
 *   locally - no external API, no rate limits, just CPU time). This is the
 *   slow path, so we report progress page by page.
 */
export async function extractText(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<string> {
  const parsed = await pdfParse(buffer);
  const numPages = parsed.numpages || 1;
  const avgCharsPerPage = parsed.text.trim().length / numPages;

  if (avgCharsPerPage >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    return parsed.text.trim();
  }

  // Fallback: this PDF has little/no embedded text - OCR it page by page.
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  const document = await pdf(buffer, { scale: 2 });
  const worker = await createWorker("eng");

  const pageTexts: string[] = [];
  let pageIndex = 0;

  try {
    for await (const imageBuffer of document) {
      pageIndex++;
      if (pageIndex > MAX_PAGES) break;

      const {
        data: { text },
      } = await worker.recognize(imageBuffer);
      pageTexts.push(text.trim());

      onProgress?.({ ocrStage: "ocr", current: pageIndex, total });
    }
  } finally {
    await worker.terminate();
  }

  return pageTexts.join("\n\n---\n\n");
}
