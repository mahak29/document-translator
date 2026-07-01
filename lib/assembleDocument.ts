import PizZip from "pizzip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
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
// PDF assembly – generate a clean, well-formatted PDF with translated text
// ---------------------------------------------------------------------------

async function assemblePdf(translatedSegments: string[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  // Register fontkit so we can embed custom Unicode fonts
  pdfDoc.registerFontkit(fontkit);

  // Load Noto Sans – supports Latin, Devanagari (Hindi), Cyrillic, Arabic, CJK basics
  let font;
  try {
    const fontPath = path.join(process.cwd(), "fonts", "NotoSans-Regular.ttf");
    const fontBytes = fs.readFileSync(fontPath);
    font = await pdfDoc.embedFont(fontBytes, { subset: true });
  } catch {
    // Fallback to Helvetica if custom font not found (Latin-only)
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 50;
  const fontSize = 11;
  const lineHeight = fontSize * 1.5;
  const maxLineWidth = pageWidth - 2 * margin;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  for (const segment of translatedSegments) {
    // Word-wrap each segment
    const lines = wrapText(segment, font, fontSize, maxLineWidth);

    for (const line of lines) {
      if (y < margin + lineHeight) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }

      page.drawText(line, {
        x: margin,
        y,
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });

      y -= lineHeight;
    }

    // Paragraph spacing
    y -= lineHeight * 0.5;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
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



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(
  text: string,
  font: any,
  fontSize: number,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    try {
      const width = font.widthOfTextAtSize(testLine, fontSize);
      if (width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    } catch {
      // If font can't measure (non-Latin chars), just use character count estimate
      if (testLine.length * fontSize * 0.5 > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [""];
}
