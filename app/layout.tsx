import "./globals.css";

export const metadata = {
  title: "Document Translator",
  description: "Upload a PDF or TXT document and translate it into any language with layout preserved",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', system-ui, sans-serif",
          background: "#0a0a0f",
          color: "#e8e8f0",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
