import pdfParse from "pdf-parse";
import { createWorker } from "tesseract.js";
import PizZip from "pizzip";

// pdf-to-img is loaded dynamically to prevent Next.js bundler from inlining it.
// It calls require.resolve('pdfjs-dist/package.json') at module load time, which
// fails inside a webpack bundle. Dynamic import defers that until runtime.

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
 * Result of extraction – segments preserve the document's paragraph structure
 * so we can map translations back to exact positions during re-assembly.
 */
export type ExtractionResult = {
  fullText: string;
  segments: string[];
  fileType: string;
};

// ---------------------------------------------------------------------------
// File-type detection
// ---------------------------------------------------------------------------

export function getFileType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "txt" || ext === "text") return "txt";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function extractText(
  buffer: Buffer,
  fileName: string,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const fileType = getFileType(fileName);

  switch (fileType) {
    case "pdf":
      return extractPdf(buffer, onProgress);
    case "docx":
      return extractDocx(buffer);
    case "pptx":
      return extractPptx(buffer);
    case "txt":
      return extractTxt(buffer);
    default:
      throw new Error(`Unsupported file type: ${fileName}`);
  }
}

// ---------------------------------------------------------------------------
// PDF extraction (unchanged logic, wrapped in ExtractionResult)
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const parsed = await pdfParse(buffer);
  const numPages = parsed.numpages || 1;
  const avgCharsPerPage = parsed.text.trim().length / numPages;

  if (avgCharsPerPage >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    const text = parsed.text.trim();
    // Split into paragraph segments by double-newlines
    const segments = text
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { fullText: text, segments, fileType: "pdf" };
  }

  // Fallback: OCR page by page
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  // Dynamic import keeps pdf-to-img out of the webpack bundle entirely.
  // pdfjs-dist is its peer dep and must be resolved at runtime, not bundle time.
  const { pdf } = await import("pdf-to-img");
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

  const fullText = pageTexts.join("\n\n---\n\n");
  // Each page is a segment for PDF
  const segments = pageTexts.filter(Boolean);
  return { fullText, segments, fileType: "pdf" };
}

// ---------------------------------------------------------------------------
// DOCX extraction – walk <w:t> nodes, collect text per paragraph
// ---------------------------------------------------------------------------

function extractDocx(buffer: Buffer): ExtractionResult {
  const zip = new PizZip(buffer);

  // Collect XML files to process (document + headers + footers)
  const xmlFiles = ["word/document.xml"];
  for (const entry of Object.keys(zip.files)) {
    if (/^word\/(header|footer)\d+\.xml$/.test(entry)) {
      xmlFiles.push(entry);
    }
  }

  const segments: string[] = [];

  for (const xmlFile of xmlFiles) {
    const file = zip.file(xmlFile);
    if (!file) continue;
    const xml = file.asText();
    const paraSegments = extractParagraphTexts(xml, "w:t");
    segments.push(...paraSegments);
  }

  const fullText = segments.join("\n\n");
  return { fullText, segments, fileType: "docx" };
}

// ---------------------------------------------------------------------------
// PPTX extraction – walk <a:t> nodes per slide, collect text per paragraph
// ---------------------------------------------------------------------------

function extractPptx(buffer: Buffer): ExtractionResult {
  const zip = new PizZip(buffer);

  // Find all slide XML files and sort them
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
      return numA - numB;
    });

  const segments: string[] = [];

  for (const slideFile of slideFiles) {
    const file = zip.file(slideFile);
    if (!file) continue;
    const xml = file.asText();
    const paraSegments = extractParagraphTexts(xml, "a:t");
    segments.push(...paraSegments);
  }

  const fullText = segments.join("\n\n");
  return { fullText, segments, fileType: "pptx" };
}

// ---------------------------------------------------------------------------
// TXT extraction
// ---------------------------------------------------------------------------

function extractTxt(buffer: Buffer): ExtractionResult {
  const text = buffer.toString("utf-8").trim();
  const segments = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { fullText: text, segments, fileType: "txt" };
}

// ---------------------------------------------------------------------------
// Shared XML helper – extracts paragraph-level text from XML
// tagName is "w:t" for DOCX or "a:t" for PPTX
// ---------------------------------------------------------------------------

function extractParagraphTexts(xml: string, tagName: string): string[] {
  // Determine paragraph tag name
  const pTag = tagName === "w:t" ? "w:p" : "a:p";

  const segments: string[] = [];
  // Match paragraphs – use a regex that handles nested content
  const paraRegex = new RegExp(`<${pTag}[\\s>][\\s\\S]*?<\\/${pTag}>`, "g");
  let paraMatch;

  while ((paraMatch = paraRegex.exec(xml)) !== null) {
    const paraXml = paraMatch[0];
    // Find all text nodes within this paragraph
    const textRegex = new RegExp(
      `<${tagName}(?:\\s[^>]*)?>([^<]*)<\\/${tagName}>`,
      "g"
    );
    let textMatch;
    let paraText = "";

    while ((textMatch = textRegex.exec(paraXml)) !== null) {
      paraText += textMatch[1];
    }

    if (paraText.trim()) {
      segments.push(paraText);
    }
  }

  return segments;
}
