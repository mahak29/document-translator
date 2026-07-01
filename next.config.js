/** @type {import('next').NextConfig} */
const nextConfig = {
  // These packages do their own internal file/worker resolution (pdfjs-dist's
  // worker file, tesseract.js's worker-script, pdf-parse's file reads) and
  // break when webpack tries to bundle them for the server. Marking them
  // external makes Next.js load them via plain Node `require` instead.
  experimental: {
    serverComponentsExternalPackages: [
      "pdf-to-img",
      "pdfjs-dist",
      "tesseract.js",
      "pdf-parse",
      "pizzip",
      "pdf-lib",
      "@pdf-lib/fontkit",
    ],
  },
};

module.exports = nextConfig;
