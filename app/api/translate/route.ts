import { NextRequest, NextResponse } from "next/server";
import { extractText } from "@/lib/extractText";
import { translateSegments } from "@/lib/translateText";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_EXTENSIONS = ["pdf", "txt", "text"];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Streams newline-delimited JSON progress events, then a final "done" event.
// The "done" event now includes translated segments per language (for layout-
// preserving download) alongside the concatenated full text (for UI display).
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const languagesRaw = formData.get("languages") as string | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (!languagesRaw) {
    return NextResponse.json({ error: "No target languages selected" }, { status: 400 });
  }

  // File type validation
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return NextResponse.json(
      { error: `File type ".${ext}" is not supported. Only PDF and TXT files are allowed.` },
      { status: 400 }
    );
  }

  // File size validation
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 20 MB.` },
      { status: 400 }
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
  }

  const languages: string[] = JSON.parse(languagesRaw);
  if (!languages.length) {
    return NextResponse.json({ error: "Select at least one language" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        send({ type: "stage", stage: "extracting" });

        let extraction;
        try {
          extraction = await extractText(buffer, file.name, (p) => {
            send({ type: "progress", stage: "extracting", ...p });
          });
        } catch (extractErr: any) {
          const msg = extractErr?.message || "Failed to read the document";
          // Provide friendly messages for known failure modes
          const friendly = msg.includes("WASM") || msg.includes("wasm") || msg.includes("Aborted")
            ? "OCR engine failed to load. Please try a PDF with selectable text instead of a scanned image."
            : msg.includes("scanned") || msg.includes("No text")
            ? msg
            : `Could not read the document: ${msg}`;
          send({ type: "error", error: friendly });
          controller.close();
          return;
        }

        if (!extraction.fullText.trim()) {
          send({ type: "error", error: "Could not extract any text from this document. If this is a scanned PDF, make sure it contains legible text." });
          controller.close();
          return;
        }

        // Translate segments for each language (preserves paragraph order)
        const translations: Record<string, string> = {};
        const translatedSegmentsMap: Record<string, string[]> = {};

        for (let i = 0; i < languages.length; i++) {
          const lang = languages[i];
          send({
            type: "stage",
            stage: "translating",
            language: lang,
            langIndex: i + 1,
            totalLangs: languages.length,
          });

          let segments;
          try {
            segments = await translateSegments(
              extraction.segments,
              lang,
              (current, total) => {
                send({
                  type: "progress",
                  stage: "translating",
                  language: lang,
                  langIndex: i + 1,
                  totalLangs: languages.length,
                  current,
                  total,
                });
              }
            );
          } catch (translateErr: any) {
            send({
              type: "error",
              error: `Translation to ${lang} failed: ${translateErr?.message || "Unknown error"}. Check your internet connection and try again.`,
            });
            controller.close();
            return;
          }

          translatedSegmentsMap[lang] = segments;
          translations[lang] = segments.join("\n\n");
        }

        send({
          type: "done",
          sourceText: extraction.fullText,
          translations,
          translatedSegments: translatedSegmentsMap,
          fileType: extraction.fileType,
        });
      } catch (err: any) {
        send({ type: "error", error: err?.message || "Something went wrong" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
