import { NextRequest, NextResponse } from "next/server";
import { extractText } from "@/lib/extractText";
import { translateText } from "@/lib/translateText";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds - raise on Vercel Pro for large/scanned PDFs

// Streams newline-delimited JSON progress events, then a final "done" event:
//   {"type":"stage","stage":"extracting"}
//   {"type":"progress","stage":"extracting","ocrStage":"ocr","current":3,"total":30}
//   {"type":"stage","stage":"translating","language":"hi","langIndex":1,"totalLangs":2}
//   {"type":"progress","stage":"translating","language":"hi","langIndex":1,"totalLangs":2,"current":2,"total":8}
//   {"type":"done","sourceText":"...","translations":{"hi":"...","es":"..."}}
//   {"type":"error","error":"..."}
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

        const sourceText = await extractText(buffer, (p) => {
          send({ type: "progress", stage: "extracting", ...p });
        });

        if (!sourceText.trim()) {
          send({ type: "error", error: "Could not extract any text from this PDF" });
          controller.close();
          return;
        }

        const translations: Record<string, string> = {};

        for (let i = 0; i < languages.length; i++) {
          const lang = languages[i];
          send({
            type: "stage",
            stage: "translating",
            language: lang,
            langIndex: i + 1,
            totalLangs: languages.length,
          });

          translations[lang] = await translateText(sourceText, lang, (current, total) => {
            send({
              type: "progress",
              stage: "translating",
              language: lang,
              langIndex: i + 1,
              totalLangs: languages.length,
              current,
              total,
            });
          });
        }

        send({ type: "done", sourceText, translations });
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
