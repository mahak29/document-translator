export const metadata = {
  title: "Document Translator",
  description: "Upload a PDF, DOCX, PPTX, or TXT document and translate it into any language with layout preserved",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0f0f11", color: "#f2f2f2" }}>
        {children}
      </body>
    </html>
  );
}
