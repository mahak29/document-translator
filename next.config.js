/** @type {import('next').NextConfig} */
const nextConfig = {
  // These packages do their own internal file/worker resolution and
  // break when webpack tries to bundle them for the server.
  // Marking them external makes Next.js load them via plain Node require.
  serverExternalPackages: [
    "pdfjs-dist",
    "tesseract.js",
    "pdf-parse",
    "canvas",
    "pizzip",
    "pdf-lib",
    "@pdf-lib/fontkit",
    "pdfkit",
  ],
  experimental: {
    serverComponentsExternalPackages: [
      "pdfjs-dist",
      "tesseract.js",
      "pdf-parse",
      "canvas",
      "pizzip",
      "pdf-lib",
      "@pdf-lib/fontkit",
      "pdfkit",
    ],
  },
};

module.exports = nextConfig;
