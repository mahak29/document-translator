/**
 * Copies tesseract.js-core WASM files to public/tesseract/ so they are
 * always included in the Vercel deployment regardless of file tracing.
 * Runs automatically via the "postinstall" npm script.
 */
const fs   = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "tesseract.js-core");
const dst = path.join(__dirname, "..", "public", "tesseract");

if (!fs.existsSync(src)) {
  console.log("[copy-wasm] tesseract.js-core not found, skipping.");
  process.exit(0);
}

if (!fs.existsSync(dst)) {
  fs.mkdirSync(dst, { recursive: true });
}

const files = fs.readdirSync(src).filter(
  (f) => f.endsWith(".wasm") || (f.endsWith(".js") && f.includes("core"))
);

let count = 0;
for (const f of files) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  count++;
}

console.log(`[copy-wasm] Copied ${count} files to public/tesseract/`);
