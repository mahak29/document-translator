import pdfParse from "pdf-parse";
import path from "path";
import fs from "fs";

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
  if (ext === "pdf") return "pdf";
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
// CanvasFactory backed by @napi-rs/canvas
// ---------------------------------------------------------------------------

function makeCanvasFactory() {
  // Listed in serverExternalPackages + outputFileTracingIncludes so:
  // 1. webpack emits `require("@napi-rs/canvas")` verbatim (no bundling)
  // 2. Vercel file tracer copies the module into the deployment package
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const napiCanvas = require("@napi-rs/canvas");
  const createCanvas: (w: number, h: number) => any =
    napiCanvas.createCanvas ?? napiCanvas.default?.createCanvas;

  if (typeof createCanvas !== "function") {
    throw new Error("@napi-rs/canvas: createCanvas not found.");
  }

  return {
    create(width: number, height: number) {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    reset(canvasAndCtx: any, width: number, height: number) {
      canvasAndCtx.canvas.width = width;
      canvasAndCtx.canvas.height = height;
      canvasAndCtx.context = canvasAndCtx.canvas.getContext("2d");
    },
    destroy(_canvasAndCtx: any) {},
  };
}

// ---------------------------------------------------------------------------
// Render one PDF page → PNG Buffer
// ---------------------------------------------------------------------------

async function renderPageToPng(
  buffer: Buffer,
  pageNum: number,
  scale = 2
): Promise<Buffer> {
  // Dynamic import keeps pdfjs out of the initial bundle parse
  // while still being visible to the output file tracer via
  // outputFileTracingIncludes.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);
  const pdfjs = pdfjsLib.default ?? pdfjsLib;

  const workerPath = path.join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.mjs"
  );
  pdfjs.GlobalWorkerOptions.workerSrc = `file://${workerPath.replace(/\\/g, "/")}`;

  const canvasFactory = makeCanvasFactory();

  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    canvasFactory,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  try {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const width    = Math.ceil(viewport.width);
    const height   = Math.ceil(viewport.height);

    const cc  = canvasFactory.create(width, height);
    const ctx = cc.context as any;

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);

    await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
    page.cleanup();

    return cc.canvas.toBuffer("image/png");
  } finally {
    await pdfDoc.destroy();
  }
}

// ---------------------------------------------------------------------------
// PDF extraction
// Pass 1 — pdf-parse        (text-layer PDFs)
// Pass 2 — pdfjs + tesseract (scanned PDFs)
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const parsed   = await pdfParse(buffer);
  const numPages = parsed.numpages || 1;
  const avgChars = parsed.text.trim().length / numPages;

  // Pass 1: embedded text layer
  if (avgChars >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    const text = parsed.text.trim();
    const segments = text.split(/\n{2,}/).map((s: string) => s.trim()).filter(Boolean);
    return { fullText: text, segments, fileType: "pdf" };
  }

  // Pass 2: OCR
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  // tesseract.js is listed in serverExternalPackages + outputFileTracingIncludes
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tesseractMod = require("tesseract.js");
  const createWorker: any =
    tesseractMod.createWorker ?? tesseractMod.default?.createWorker;

  const tessWorkerPath = path.join(
    process.cwd(),
    "node_modules",
    "tesseract.js",
    "src",
    "worker-script",
    "node",
    "index.js"
  );
  const tessLangPath = path.join(
    process.cwd(),
    "node_modules",
    "tesseract.js-core"
  );
  // corePath tells tesseract where the .wasm + .js core files are.
  // We point to node_modules directly — Vercel includes it via
  // outputFileTracingIncludes. public/tesseract/ is the fallback.
  const tessCorePath = fs.existsSync(
    path.join(process.cwd(), "node_modules", "tesseract.js-core", "tesseract-core-simd.wasm")
  )
    ? path.join(process.cwd(), "node_modules", "tesseract.js-core")
    : path.join(process.cwd(), "public", "tesseract");

  const ocrWorker = await createWorker("eng", 1, {
    workerPath: tessWorkerPath,
    langPath:   tessLangPath,
    corePath:   tessCorePath,
    logger:     () => {},
  });

  const pageTexts: string[] = [];

  try {
    for (let i = 1; i <= total; i++) {
      const png = await renderPageToPng(buffer, i, 2);
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
      "No text could be extracted from this PDF. " +
      "The scanned image may be too low quality or contain unrecognisable text."
    );
  }

  return { fullText, segments, fileType: "pdf" };
}

// ---------------------------------------------------------------------------
// TXT extraction
// ---------------------------------------------------------------------------

function extractTxt(buffer: Buffer): ExtractionResult {
  const text = buffer.toString("utf-8").trim();
  const segments = text.split(/\n\s*\n/).map((s: string) => s.trim()).filter(Boolean);
  return { fullText: text, segments, fileType: "txt" };
}
