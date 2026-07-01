import pdfParse from "pdf-parse";
import path from "path";

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
// CanvasFactory backed by @napi-rs/canvas.
// Loaded via eval('require') so webpack's static analysis never sees the
// import and cannot attempt to bundle or trace the native .node binary.
// ---------------------------------------------------------------------------

function nativeRequire(id: string): any {
  // eval prevents webpack from statically analyzing the require call.
  // At runtime this is a plain Node.js require() - no bundling involved.
  // eslint-disable-next-line no-eval
  return eval("require")(id);
}

function makeCanvasFactory() {
  const napiCanvas = nativeRequire("@napi-rs/canvas");
  const createCanvas: (w: number, h: number) => any =
    napiCanvas.createCanvas ?? napiCanvas.default?.createCanvas;

  if (typeof createCanvas !== "function") {
    throw new Error("@napi-rs/canvas could not be loaded — createCanvas is not a function.");
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
  // Load pdfjs-dist via eval-require — keeps it out of webpack bundle
  let pdfjsLib: any;
  try {
    pdfjsLib = nativeRequire("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    // Node 20 and below can't require() .mjs — use dynamic import instead
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);
  }

  const pdfjs = pdfjsLib.default ?? pdfjsLib;

  // Point the worker at the real file on disk.
  // On Vercel node_modules lives at /var/task/node_modules.
  const workerPath = path.join(
    process.cwd(),
    "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"
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

    // White background → clean OCR contrast
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
// Pass 1 — pdf-parse  (text-layer PDFs, ~95 % of real-world files)
// Pass 2 — pdfjs-dist + @napi-rs/canvas + tesseract.js  (scanned PDFs)
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: Buffer,
  onProgress?: OnExtractProgress
): Promise<ExtractionResult> {
  const parsed   = await pdfParse(buffer);
  const numPages = parsed.numpages || 1;
  const avgChars = parsed.text.trim().length / numPages;

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  if (avgChars >= MIN_CHARS_PER_PAGE) {
    onProgress?.({ ocrStage: "parsing", current: numPages, total: numPages });
    const text     = parsed.text.trim();
    const segments = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    return { fullText: text, segments, fileType: "pdf" };
  }

  // ── Pass 2: OCR ───────────────────────────────────────────────────────────
  const total = Math.min(numPages, MAX_PAGES);
  onProgress?.({ ocrStage: "ocr", current: 0, total });

  // Load tesseract.js via eval-require
  const tesseractMod = nativeRequire("tesseract.js");
  const createWorker: any =
    tesseractMod.createWorker ?? tesseractMod.default?.createWorker;

  if (typeof createWorker !== "function") {
    throw new Error("tesseract.js could not be loaded.");
  }

  // Tell tesseract where to find its worker script and language data.
  // On Vercel everything lives under process.cwd() = /var/task at runtime.
  const tessWorkerPath = path.join(
    process.cwd(),
    "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js"
  );
  const tessLangPath = path.join(
    process.cwd(),
    "node_modules", "tesseract.js-core"
  );

  const ocrWorker = await createWorker("eng", 1, {
    workerPath: tessWorkerPath,
    langPath:   tessLangPath,
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
      "No text found in this PDF. The scanned image may have poor quality " +
      "or contain unrecognisable characters."
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
