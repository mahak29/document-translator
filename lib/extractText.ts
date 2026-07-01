import pdfParse from "pdf-parse";
import path from "path";
import { Module } from "module";

// Use Node's native require so webpack never bundles these heavy packages.
// Dynamic import() inside Next.js server routes goes through webpack's module
// system, which strips native .node binaries and breaks CJS interop.
const _require = (Module as any).createRequire
  ? (Module as any).createRequire(path.join(process.cwd(), "package.json"))
  : require;

const MIN_CHARS_PER_PAGE = 20;
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
  if (ext === "pdf")  return "pdf";
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
    case "pdf": return extractPdf(buffer, onProgress);
    case "txt": return extractTxt(buffer);
    default:
      throw new Error(
        `Unsupported file type: "${fileName}". Only PDF and TXT files are supported.`
      );
  }
}

// ---------------------------------------------------------------------------
// Custom CanvasFactory for pdfjs-dist that uses @napi-rs/canvas.
// pdfjs-dist needs a canvas to render page pixels. In Node there is no DOM
// canvas, so we supply our own factory backed by @napi-rs/canvas which ships
// prebuilt binaries for every platform including Vercel's Amazon Linux.
// ---------------------------------------------------------------------------

function makeCanvasFactory() {
  const napiCanvas = _require("@napi-rs/canvas");
  // Handle both CJS export shapes
  const createCanvas: (w: number, h: number) => any =
    napiCanvas.createCanvas ?? napiCanvas.default?.createCanvas;

  if (typeof createCanvas !== "function") {
    throw new Error(
      "Failed to load @napi-rs/canvas. " +
      "Run `npm install @napi-rs/canvas` and restart the server."
    );
  }

  return {
    create(width: number, height: number) {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    reset(canvasAndCtx: any, width: number, height: number) {
      canvasAndCtx.canvas.width  = width;
      canvasAndCtx.canvas.height = height;
      canvasAndCtx.context = canvasAndCtx.canvas.getContext("2d");
    },
    destroy(_canvasAndCtx: any) {
      // nothing to free
    },
  };
}

// ---------------------------------------------------------------------------
// Render one PDF page → PNG Buffer using pdfjs + @napi-rs/canvas
// ---------------------------------------------------------------------------

async function renderPageToPng(
  pdfjsLib: any,
  buffer: Buffer,
  pageNum: number,
  scale = 2
): Promise<Buffer> {
  // Set up the pdfjs worker path (absolute file:// URL required in Node)
  const workerSrc = `file://${path
    .join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs")
    .replace(/\\/g, "/")}`;

  const pdfjs = pdfjsLib.default ?? pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const canvasFactory = makeCanvasFactory();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    canvasFactory,         // ← tell pdfjs to use our canvas factory
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;

  try {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const width    = Math.ceil(viewport.width);
    const height   = Math.ceil(viewport.height);

    const canvasAndCtx = canvasFactory.create(width, height);
    const ctx          = canvasAndCtx.context as any;

    // White background → clean contrast for Tesseract
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvasFactory,
    }).promise;

    page.cleanup();

    return canvasAndCtx.canvas.toBuffer("image/png");
  } finally {
    await pdfDoc.destroy();
  }
}

// ---------------------------------------------------------------------------
// PDF extraction
// Pass 1: pdf-parse   → fast, text-layer PDFs (covers ~95% of real-world PDFs)
// Pass 2: pdfjs-dist + @napi-rs/canvas + tesseract.js
//          → OCR for scanned / image-only PDFs
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const parsed    = await pdfParse(buffer);
  const numPages  = parsed.numpages || 1;
  const avgChars  = parsed.text.trim().length / numPages;

  // ── Pass 1: use the embedded text layer ──────────────────────────────────
  if (avgChars >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    const text     = parsed.text.trim();
    const segments = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    return { fullText: text, segments, fileType: "pdf" };
  }

  // ── Pass 2: OCR ───────────────────────────────────────────────────────────
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  // Load pdfjs-dist via require — the ESM .mjs file is require()-able in
  // Node 22+; for older versions it falls back to a dynamic import().
  let pdfjsLib: any;
  try {
    pdfjsLib = _require("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);
  }

  // Load tesseract.js via require
  const tesseractMod   = _require("tesseract.js");
  const createWorker   = tesseractMod.createWorker ?? tesseractMod.default?.createWorker;
  const ocrWorker      = await createWorker("eng", 1, { logger: () => {} });

  const pageTexts: string[] = [];

  try {
    for (let i = 1; i <= total; i++) {
      const png = await renderPageToPng(pdfjsLib, buffer, i, 2);

      const { data: { text } } = await ocrWorker.recognize(png);
      pageTexts.push(text.trim());

      onProgress?.({ ocrStage: "ocr", current: i, total });
    }
  } finally {
    await ocrWorker.terminate();
  }

  const fullText = pageTexts.join("\n\n---\n\n");
  const segments = pageTexts.filter(Boolean);

  if (!fullText.trim()) {
    throw new Error(
      "No text found in this PDF. The file may be a scanned image " +
      "with poor quality or unrecognisable characters."
    );
  }

  return { fullText, segments, fileType: "pdf" };
}

// ---------------------------------------------------------------------------
// TXT extraction
// ---------------------------------------------------------------------------

function extractTxt(buffer: Buffer): ExtractionResult {
  const text     = buffer.toString("utf-8").trim();
  const segments = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return { fullText: text, segments, fileType: "txt" };
}
