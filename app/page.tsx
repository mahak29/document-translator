"use client";

import { useState } from "react";
import { LANGUAGES } from "@/lib/languages";

type ProgressEvent = {
  type: "stage" | "progress";
  stage: "extracting" | "translating";
  ocrStage?: "parsing" | "ocr";
  language?: string;
  langIndex?: number;
  totalLangs?: number;
  current?: number;
  total?: number;
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [selectedLangs, setSelectedLangs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [translations, setTranslations] = useState<Record<string, string> | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  function toggleLang(code: string) {
    setSelectedLangs((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]
    );
  }

  function langName(code: string) {
    return LANGUAGES.find((l) => l.code === code)?.name || code;
  }

  function progressText(p: ProgressEvent | null): string {
    if (!p) return "Starting…";

    if (p.stage === "extracting") {
      if (p.ocrStage === "ocr") {
        if (!p.total) return "Scanning document…";
        return `Reading scanned page ${p.current} of ${p.total}…`;
      }
      return "Reading PDF text…";
    }

    if (p.stage === "translating" && p.language) {
      const label = langName(p.language);
      const langCount =
        p.totalLangs && p.totalLangs > 1 ? ` (language ${p.langIndex} of ${p.totalLangs})` : "";
      if (p.total) {
        return `Translating to ${label}: part ${p.current} of ${p.total}${langCount}`;
      }
      return `Translating to ${label}${langCount}…`;
    }

    return "Working…";
  }

  async function handleSubmit() {
    if (!file || selectedLangs.length === 0) return;
    setLoading(true);
    setError(null);
    setTranslations(null);
    setProgress(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("languages", JSON.stringify(selectedLangs));

      const res = await fetch("/api/translate", { method: "POST", body: formData });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Something went wrong");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.type === "stage" || event.type === "progress") {
            setProgress(event);
          } else if (event.type === "done") {
            setTranslations(event.translations);
            setActiveTab(selectedLangs[0]);
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  function downloadTxt(lang: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `translation-${lang}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>PDF Translator</h1>
      <p style={{ color: "#9a9a9a", marginBottom: 32 }}>
        Upload a PDF (text or scanned) and translate it into one or more languages.
      </p>

      <div
        style={{
          border: "1px dashed #444",
          borderRadius: 12,
          padding: 24,
          marginBottom: 24,
        }}
      >
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        {file && <p style={{ marginTop: 8, fontSize: 14, color: "#9a9a9a" }}>{file.name}</p>}
      </div>

      <p style={{ marginBottom: 8, fontWeight: 600 }}>Translate into:</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => toggleLang(lang.code)}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: "1px solid #444",
              background: selectedLangs.includes(lang.code) ? "#5b5bf0" : "transparent",
              color: "#f2f2f2",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {lang.name}
          </button>
        ))}
      </div>

      <button
        onClick={handleSubmit}
        disabled={!file || selectedLangs.length === 0 || loading}
        style={{
          padding: "10px 24px",
          borderRadius: 8,
          border: "none",
          background: !file || selectedLangs.length === 0 || loading ? "#333" : "#5b5bf0",
          color: "#fff",
          cursor: "pointer",
          fontSize: 15,
        }}
      >
        {loading ? "Translating…" : "Translate PDF"}
      </button>

      {loading && (
        <p style={{ marginTop: 12, fontSize: 14, color: "#9a9a9a" }}>{progressText(progress)}</p>
      )}

      {error && <p style={{ color: "#ff6b6b", marginTop: 16 }}>{error}</p>}

      {translations && (
        <div style={{ marginTop: 40 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {Object.keys(translations).map((lang) => (
              <button
                key={lang}
                onClick={() => setActiveTab(lang)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "1px solid #444",
                  background: activeTab === lang ? "#5b5bf0" : "transparent",
                  color: "#f2f2f2",
                  cursor: "pointer",
                }}
              >
                {langName(lang)}
              </button>
            ))}
          </div>

          {activeTab && (
            <div>
              <button
                onClick={() => downloadTxt(activeTab, translations[activeTab])}
                style={{
                  marginBottom: 12,
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "1px solid #444",
                  background: "transparent",
                  color: "#f2f2f2",
                  cursor: "pointer",
                }}
              >
                Download .txt
              </button>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  background: "#1a1a1d",
                  padding: 20,
                  borderRadius: 8,
                  maxHeight: 500,
                  overflowY: "auto",
                  fontSize: 14,
                  lineHeight: 1.6,
                }}
              >
                {translations[activeTab]}
              </pre>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
