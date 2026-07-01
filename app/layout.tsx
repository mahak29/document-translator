export const metadata = {
  title: "PDF Translator",
  description: "Upload a PDF, translate it into any language",
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
