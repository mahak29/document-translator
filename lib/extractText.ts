import pdfParse from "pdf-parse";
import { createWorker } from "tesseract.js";
import PizZip from "pizzip";
import path from "path";

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
// Render a single PDF page to a PNG buffer using pdfjs-dist + canvas.
// Both packages are already installed; this replaces pdf-to-img which had
// a broken require.resolve('pdfjs-dist/package.json') at module load time.
// ---------------------------------------------------------------------------

async function renderPdfPageToImage(
  pdfDoc: any,
  pageNum: number,
  scale = 2
): Promise<Buffer> {
  const { createCanvas } = await import("canvas");
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  );
  const ctx = canvas.getContext("2d") as any;

  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();

  return canvas.toBuffer("image/png");
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const parsed = await pdfParse(buffer);
  const numPages = parsed.numpages || 1;
  const avgCharsPerPage = parsed.text.trim().length / numPages;

  // If the PDF has a usable text layer, use it directly — no OCR needed.
  if (avgCharsPerPage >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    const text = parsed.text.trim();
    const segments = text
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { fullText: text, segments, fileType: "pdf" };
  }

  // Scanned/image PDF — fall back to OCR using pdfjs-dist + canvas + tesseract.
  // pdfjs-dist is already a declared dependency (needed by pdf-to-img as a peer).
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  // Dynamically import pdfjs-dist so the bundler never inlines it.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);

  // Point the worker at the file on disk. `process.cwd()` is the project root
  // on Vercel (/var/task), where node_modules is present at runtime.
  const workerPath = path.join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.mjs"
  );
  pdfjsLib.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;

  const pdfDoc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const worker = await createWorker("eng");
  const pageTexts: string[] = [];

  try {
    for (let i = 1; i <= Math.min(pdfDoc.numPages, MAX_PAGES); i++) {
      const imgBuffer = await renderPdfPageToImage(pdfDoc, i, 2);

      const {
        data: { text },
      } = await worker.recognize(imgBuffer);
      pageTexts.push(text.trim());

      onProgress?.({ ocrStage: "ocr", current: i, total });
    }
  } finally {
    await worker.terminate();
    await pdfDoc.destroy();
  }

  const fullText = pageTexts.join("\n\n---\n\n");
  const segments = pageTexts.filter(Boolean);
  return { fullText, segments, fileType: "pdf" };
}

// ---------------------------------------------------------------------------
// DOCX extraction
// ---------------------------------------------------------------------------

function extractDocx(buffer: Buffer): ExtractionResult {
  const zip = new PizZip(buffer);

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
    segments.push(...extractParagraphTexts(file.asText(), "w:t"));
  }

  return { fullText: segments.join("\n\n"), segments, fileType: "docx" };
}

// ---------------------------------------------------------------------------
// PPTX extraction
// ---------------------------------------------------------------------------

function extractPptx(buffer: Buffer): ExtractionResult {
  const zip = new PizZip(buffer);

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
    segments.push(...extractParagraphTexts(file.asText(), "a:t"));
  }

  return { fullText: segments.join("\n\n"), segments, fileType: "pptx" };
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
// Shared XML helper
// ---------------------------------------------------------------------------

function extractParagraphTexts(xml: string, tagName: string): string[] {
  const pTag = tagName === "w:t" ? "w:p" : "a:p";
  const segments: string[] = [];
  const paraRegex = new RegExp(`<${pTag}[\\s>][\\s\\S]*?<\\/${pTag}>`, "g");
  let paraMatch;

  while ((paraMatch = paraRegex.exec(xml)) !== null) {
    const textRegex = new RegExp(
      `<${tagName}(?:\\s[^>]*)?>([^<]*)<\\/${tagName}>`,
      "g"
    );
    let textMatch;
    let paraText = "";
    while ((textMatch = textRegex.exec(paraMatch[0])) !== null) {
      paraText += textMatch[1];
    }
    if (paraText.trim()) segments.push(paraText);
  }

  return segments;
}
