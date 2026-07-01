/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tell Vercel's output file tracer to explicitly include these modules
  // in the deployment package. Without this, modules loaded via dynamic
  // require() or eval("require") are invisible to the tracer and get omitted.
  outputFileTracingIncludes: {
    "/api/translate": [
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-musl/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/wasm-feature-detect/**/*",
    ],
    "/api/download": [
      "./node_modules/pdfkit/**/*",
    ],
  },

  // Prevent webpack from bundling these packages — they must be loaded
  // by Node's native require() at runtime.
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
      const EXTERNALS = [
        "@napi-rs/canvas",
        "pdfjs-dist",
        "tesseract.js",
        "tesseract.js-core",
        "pdf-parse",
      ];

      const externalFn = (_ctx, request, callback) => {
        if (EXTERNALS.some((e) => request === e || request.startsWith(e + "/"))) {
          return callback(undefined, "commonjs " + request);
        }
        callback();
      };

      if (Array.isArray(config.externals)) {
        config.externals.push(externalFn);
      } else {
        config.externals = [config.externals, externalFn].filter(Boolean);
      }
    }
    return config;
  },
};

module.exports = nextConfig;
