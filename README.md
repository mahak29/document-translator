# PDF Translator (MVP)

Upload a PDF (text-based or scanned/image), pick one or more target languages,
get translated text back — downloadable as `.txt`.

**100% free, no API keys, no rate-limited AI service.**

## How it works
1. `pdf-parse` tries to extract the embedded text layer directly (fast path
   for normal, text-based PDFs).
2. If a PDF has little or no embedded text (i.e. it's a scan / image-based),
   it falls back to **Tesseract.js** — a real OCR engine that runs locally,
   free and unlimited, no external API calls.
3. The extracted text is translated into each selected language using
   `google-translate-api-x` — a free, no-API-key wrapper around Google
   Translate's web endpoint, chunked to respect its ~5000-character
   per-request limit.
4. The whole process streams live progress back to the browser (e.g. "Reading
   scanned page 12 of 30…", "Translating to Hindi: part 3 of 8 (language 1 of
   2)") so you're never left staring at a frozen button during a demo.
5. Results are shown in tabs on the frontend with a download button per
   language.

## Setup

```bash
npm install
npm run dev
```

No `.env` file needed — nothing here requires an API key.

Open http://localhost:3000

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

No environment variables to configure.

## Important: read this before your demo

- **OCR is CPU-bound, not network-bound.** For text-based PDFs (most PDFs),
  this is fast — seconds, regardless of page count. But if a PDF is scanned
  (no embedded text layer), Tesseract has to OCR every page image, and that
  can take real time on a 20-30 page scanned document — potentially a few
  minutes depending on server CPU.
- **Serverless function timeouts.** Vercel's free/Hobby tier caps serverless
  functions around 10-60 seconds depending on plan and config. A large
  scanned PDF could exceed that and the request will fail mid-demo. Two
  options:
  - **Safest for today:** run the demo with `npm run dev` locally (or on a
    normal always-on server/VPS), which has no such timeout. If your client
    demo is a live walkthrough, this is the lower-risk choice.
  - If you must deploy to Vercel: `maxDuration` is set to 60s in
    `app/api/translate/route.ts`; this needs a paid Vercel plan to actually
    take effect beyond the Hobby tier's default cap. Test with your actual
    demo PDF ahead of time, not for the first time in front of the client.
- **`MAX_PAGES` safety cap** is set to 40 in `lib/extractText.ts` for OCR
  fallback, so a huge scanned upload can't hang the server indefinitely.
  Text-based PDFs aren't capped — pdf-parse handles those in one pass
  regardless of page count.
- **Translation package is unofficial.** `google-translate-api-x` scrapes
  Google Translate's web interface — it's free and generally reliable for
  demo-scale usage, but it isn't an officially supported API, so don't rely
  on it for a production launch. Fine for tonight.

## Fast-follow ideas (post-MVP)
- Export translated output as a formatted PDF or DOCX instead of `.txt`.
- Show a progress indicator during OCR (page N of M) — useful once you're
  processing large scanned PDFs.
- Cache extracted source text so re-translating into a new language doesn't
  re-run OCR.
- If translation reliability becomes an issue at higher volume, consider a
  self-hosted LibreTranslate instance (also free, open source, no rate
  limits, but needs a small server to run).
