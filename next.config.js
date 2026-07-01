/** @type {import('next').NextConfig} */
const nextConfig = {
  // These packages must NEVER be bundled by webpack.
  // They either ship native .node binaries (@napi-rs/canvas, tesseract.js)
  // or use dynamic file resolution (pdfjs-dist, pdf-parse) that breaks inside
  // a webpack bundle. Listing them here makes Next.js emit plain Node require()
  // calls so the real node_modules are used at runtime.
  serverExternalPackages: [
    "@napi-rs/canvas",
    "pdfjs-dist",
    "tesseract.js",
    "pdf-parse",
    "pdf-lib",
    "@pdf-lib/fontkit",
    "pdfkit",
    "pizzip",
  ],
  // Fallback for Next.js < 14.1 where the top-level key wasn't available yet
  experimental: {
    serverComponentsExternalPackages: [
      "@napi-rs/canvas",
      "pdfjs-dist",
      "tesseract.js",
      "pdf-parse",
      "pdf-lib",
      "@pdf-lib/fontkit",
      "pdfkit",
      "pizzip",
    ],
  },
};

module.exports = nextConfig;
