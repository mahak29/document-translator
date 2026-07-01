import { NextRequest, NextResponse } from "next/server";
import { extractText } from "@/lib/extractText";
import { translateSegments } from "@/lib/translateText";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds - raise on Vercel Pro for large/scanned PDFs

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

        const extraction = await extractText(buffer, file.name, (p) => {
          send({ type: "progress", stage: "extracting", ...p });
        });

        if (!extraction.fullText.trim()) {
          send({ type: "error", error: "Could not extract any text from this document" });
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

          const segments = await translateSegments(
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
