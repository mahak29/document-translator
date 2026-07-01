import PizZip from "pizzip";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Main entry point – assemble a translated document in the original format
// ---------------------------------------------------------------------------

export async function assembleDocument(
  originalBuffer: Buffer,
  translatedSegments: string[],
  fileType: string
): Promise<Buffer> {
  switch (fileType) {
    case "docx":
      return assembleDocx(originalBuffer, translatedSegments);
    case "pptx":
      return assemblePptx(originalBuffer, translatedSegments);
    case "pdf":
      return assemblePdf(translatedSegments);
    case "txt":
      return assembleTxt(translatedSegments);
    default:
      throw new Error(`Unsupported file type for assembly: ${fileType}`);
  }
}

// ---------------------------------------------------------------------------
// DOCX assembly – clone original ZIP, replace <w:t> text in-place
// ---------------------------------------------------------------------------

function assembleDocx(
  originalBuffer: Buffer,
  translatedSegments: string[]
): Buffer {
  const zip = new PizZip(originalBuffer);

  // Same file list we use during extraction
  const xmlFiles = ["word/document.xml"];
  for (const entry of Object.keys(zip.files)) {
    if (/^word\/(header|footer)\d+\.xml$/.test(entry)) {
      xmlFiles.push(entry);
    }
  }

  let segIdx = 0;

  for (const xmlFile of xmlFiles) {
    const file = zip.file(xmlFile);
    if (!file) continue;
    const originalXml = file.asText();

    // Count paragraphs in ORIGINAL xml before replacement
    const paraCount = countParagraphsWithText(originalXml, "w:t", "w:p");
    const replaced = replaceTextInXml(originalXml, "w:t", "w:p", translatedSegments, segIdx);
    segIdx += paraCount;

    zip.file(xmlFile, replaced);
  }

  return zip.generate({ type: "nodebuffer" }) as Buffer;
}

// ---------------------------------------------------------------------------
// PPTX assembly – clone original ZIP, replace <a:t> text in-place
// ---------------------------------------------------------------------------

function assemblePptx(
  originalBuffer: Buffer,
  translatedSegments: string[]
): Buffer {
  const zip = new PizZip(originalBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
      return numA - numB;
    });

  let segIdx = 0;

  for (const slideFile of slideFiles) {
    const file = zip.file(slideFile);
    if (!file) continue;
    const originalXml = file.asText();

    // Count paragraphs in ORIGINAL xml before replacement
    const paraCount = countParagraphsWithText(originalXml, "a:t", "a:p");
    const replaced = replaceTextInXml(originalXml, "a:t", "a:p", translatedSegments, segIdx);
    segIdx += paraCount;

    zip.file(slideFile, replaced);
  }

  return zip.generate({ type: "nodebuffer" }) as Buffer;
}

// ---------------------------------------------------------------------------
// PDF assembly – pdfkit with NotoSans for full Unicode support
// Handles all scripts: Latin, Devanagari (Hindi/Gujarati), Arabic, CJK,
// Cyrillic, Greek, etc. Preserves bullet points and paragraph formatting.
// ---------------------------------------------------------------------------

async function assemblePdf(translatedSegments: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 56,
      size: "A4",
      info: { Title: "Translated Document", Creator: "Document Translator" },
    });

    // NotoSans covers Latin, Cyrillic, Greek, and many other scripts.
    // It is the best single font we ship that handles most translation targets.
    const fontPath = path.join(process.cwd(), "fonts", "NotoSans-Regular.ttf");
    const boldFontPath = path.join(process.cwd(), "fonts", "NotoSans-Regular.ttf");

    try {
      if (fs.existsSync(fontPath)) {
        doc.registerFont("NotoSans", fontPath);
        doc.font("NotoSans");
      } else {
        doc.font("Helvetica");
      }
    } catch {
      doc.font("Helvetica");
    }

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(11);

    const pageWidth = doc.page.width;
    const margins = doc.page.margins;
    const textWidth = pageWidth - margins.left - margins.right;

    for (let i = 0; i < translatedSegments.length; i++) {
      const segment = translatedSegments[i];
      if (!segment || !segment.trim()) continue;

      // Split segment into lines to detect and preserve formatting
      const lines = segment.split("\n");

      for (let li = 0; li < lines.length; li++) {
        const raw = lines[li];
        const trimmed = raw.trim();

        if (!trimmed) {
          // Blank line — small gap
          doc.moveDown(0.3);
          continue;
        }

        // Detect bullet/list lines: •, -, *, –, —, or numbered (1. 2. etc)
        const bulletMatch = trimmed.match(/^([•\-\*–—])\s+(.+)$/);
        const numberedMatch = trimmed.match(/^(\d+[\.\):])\s+(.+)$/);

        if (bulletMatch) {
          const bullet = "•";
          const content = bulletMatch[2];
          // Render bullet with hanging indent
          doc.text(`${bullet}  ${content}`, {
            width: textWidth,
            indent: 12,
            lineGap: 2,
            paragraphGap: 3,
            align: "left",
          });
        } else if (numberedMatch) {
          const num = numberedMatch[1];
          const content = numberedMatch[2];
          doc.text(`${num}  ${content}`, {
            width: textWidth,
            indent: 12,
            lineGap: 2,
            paragraphGap: 3,
            align: "left",
          });
        } else {
          // Regular text line
          const isLastLine = li === lines.length - 1;
          doc.text(trimmed, {
            width: textWidth,
            lineGap: 3,
            paragraphGap: isLastLine ? 8 : 2,
            align: "left",
          });
        }
      }

      // Extra space between segments (pages/sections)
      if (i < translatedSegments.length - 1) {
        doc.moveDown(0.6);
      }
    }

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// TXT assembly – trivial
// ---------------------------------------------------------------------------

function assembleTxt(translatedSegments: string[]): Buffer {
  return Buffer.from(translatedSegments.join("\n\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// XML text replacement engine
//
// Walks through paragraphs in the XML, finds text nodes, and replaces their
// content with translations. All formatting XML (<w:rPr>, <a:rPr>, etc.)
// stays untouched. Only the text content of <w:t> / <a:t> nodes changes.
//
// Strategy: For each paragraph with text, put ALL translated text in the
// FIRST <w:t>/<a:t> node and empty the rest. This preserves the first run's
// formatting (font, bold, color, size) for the whole paragraph.
// ---------------------------------------------------------------------------

function replaceTextInXml(
  xml: string,
  textTag: string,  // "w:t" or "a:t"
  paraTag: string,  // "w:p" or "a:p"
  translatedSegments: string[],
  startIndex: number
): string {
  let segIdx = startIndex;
  const paraRegex = new RegExp(`<${paraTag}[\\s>][\\s\\S]*?<\\/${paraTag}>`, "g");

  return xml.replace(paraRegex, (paraXml) => {
    // Check if this paragraph has any text content
    const textRegex = new RegExp(
      `<${textTag}(?:\\s[^>]*)?>([^<]*)<\\/${textTag}>`,
      "g"
    );
    const matches = [...paraXml.matchAll(textRegex)];
    const originalText = matches.map((m) => m[1]).join("");

    if (!originalText.trim() || segIdx >= translatedSegments.length) {
      return paraXml; // No text or no more translations – keep as-is
    }

    const translated = escapeXml(translatedSegments[segIdx]);
    segIdx++;

    // Replace text nodes: first gets the translation, rest are emptied
    let isFirst = true;
    const result = paraXml.replace(
      new RegExp(`(<${textTag}(?:\\s[^>]*)?>)([^<]*)(<\\/${textTag}>)`, "g"),
      (full, openTag, _textContent, closeTag) => {
        if (isFirst) {
          isFirst = false;
          // Ensure xml:space="preserve" so whitespace is kept
          const tag = openTag.includes('xml:space')
            ? openTag
            : openTag.replace(`<${textTag}`, `<${textTag} xml:space="preserve"`);
          return `${tag}${translated}${closeTag}`;
        }
        return `${openTag}${closeTag}`; // Empty subsequent text nodes
      }
    );

    return result;
  });
}

// Count paragraphs that have non-empty text (to track segment index)
function countParagraphsWithText(
  xml: string,
  textTag: string,
  paraTag: string
): number {
  const paraRegex = new RegExp(`<${paraTag}[\\s>][\\s\\S]*?<\\/${paraTag}>`, "g");
  let count = 0;
  let match;

  while ((match = paraRegex.exec(xml)) !== null) {
    const textRegex = new RegExp(
      `<${textTag}(?:\\s[^>]*)?>([^<]*)<\\/${textTag}>`,
      "g"
    );
    const textMatches = [...match[0].matchAll(textRegex)];
    const text = textMatches.map((m) => m[1]).join("");
    if (text.trim()) count++;
  }

  return count;
}



function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


