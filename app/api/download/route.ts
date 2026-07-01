import { NextRequest, NextResponse } from "next/server";
import { assembleDocument } from "@/lib/assembleDocument";

export const runtime = "nodejs";
export const maxDuration = 30;

const MIME_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
};

const EXTENSIONS: Record<string, string> = {
  docx: ".docx",
  pptx: ".pptx",
  pdf: ".pdf",
  txt: ".txt",
};

/**
 * POST /api/download
 *
 * Accepts the original file + translated segments + file type + language,
 * assembles a layout-preserving translated document, and returns it as a
 * binary download.
 *
 * Body: FormData {
 *   originalFile: File,
 *   translatedSegments: string (JSON array of translated text segments),
 *   fileType: string ("docx" | "pptx" | "pdf" | "txt"),
 *   language: string (language code, used in filename)
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const originalFile = formData.get("originalFile") as File | null;
    const segmentsJson = formData.get("translatedSegments") as string | null;
    const fileType = formData.get("fileType") as string | null;
    const language = formData.get("language") as string | null;

    if (!segmentsJson || !fileType || !language) {
      return NextResponse.json(
        { error: "Missing required fields: translatedSegments, fileType, language" },
        { status: 400 }
      );
    }

    const translatedSegments: string[] = JSON.parse(segmentsJson);

    let originalBuffer: Buffer;
    if (originalFile) {
      const ab = await originalFile.arrayBuffer();
      originalBuffer = Buffer.from(ab);
    } else {
      // For TXT/PDF we may not need the original file
      originalBuffer = Buffer.alloc(0);
    }

    const outputBuffer = await assembleDocument(
      originalBuffer,
      translatedSegments,
      fileType
    );

    const mimeType = MIME_TYPES[fileType] || "application/octet-stream";
    const ext = EXTENSIONS[fileType] || ".bin";
    const filename = `translated-${language}${ext}`;

    return new Response(outputBuffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(outputBuffer.length),
      },
    });
  } catch (err: any) {
    console.error("Download assembly error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to generate document" },
      { status: 500 }
    );
  }
}
