/** @type {import('next').NextConfig} */
const nextConfig = {
  // These packages do their own internal file/worker resolution and
  // break when webpack tries to bundle them for the server.
  // Marking them external makes Next.js load them via plain Node require.
  serverExternalPackages: [
    "pdf-to-img",
    "pdfjs-dist",
    "tesseract.js",
    "pdf-parse",
    "pizzip",
    "pdf-lib",
    "@pdf-lib/fontkit",
    "pdfkit",
  ],
  experimental: {
    serverComponentsExternalPackages: [
      "pdf-to-img",
      "pdfjs-dist",
      "tesseract.js",
      "pdf-parse",
      "pizzip",
      "pdf-lib",
      "@pdf-lib/fontkit",
      "pdfkit",
    ],
  },
};

module.exports = nextConfig;
