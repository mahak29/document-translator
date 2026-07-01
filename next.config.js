/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent webpack from bundling packages that use native .node binaries,
  // dynamic file resolution, or large WASM blobs. They must be loaded by
  // Node's native require() at runtime — not inlined into the bundle.
  serverExternalPackages: [
    "@napi-rs/canvas",
    "pdfjs-dist",
    "tesseract.js",
    "tesseract.js-core",
    "pdf-parse",
    "pdf-lib",
    "@pdf-lib/fontkit",
    "pdfkit",
    "pizzip",
  ],
  // Fallback key for Next.js < 14.1
  experimental: {
    serverComponentsExternalPackages: [
      "@napi-rs/canvas",
      "pdfjs-dist",
      "tesseract.js",
      "tesseract.js-core",
      "pdf-parse",
      "pdf-lib",
      "@pdf-lib/fontkit",
      "pdfkit",
      "pizzip",
    ],
  },
  webpack(config, { isServer }) {
    if (isServer) {
      // Belt-and-suspenders: also mark these as webpack externals so the
      // bundler emits `require('pkg')` instead of inlining the source.
      const external = (
        _ctx,
        request,
        callback
      ) => {
        const externals = [
          "@napi-rs/canvas",
          "pdfjs-dist",
          "tesseract.js",
          "tesseract.js-core",
          "pdf-parse",
        ];
        if (externals.some((e) => request === e || request.startsWith(e + "/"))) {
          return callback(undefined, `commonjs ${request}`);
        }
        callback();
      };

      if (Array.isArray(config.externals)) {
        config.externals.push(external);
      } else {
        config.externals = [config.externals, external].filter(Boolean);
      }
    }
    return config;
  },
};

module.exports = nextConfig;
