"use client";

import { useState, useRef } from "react";
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

const FORMAT_LABELS: Record<string, string> = {
  pdf: "PDF",
  txt: "Text (TXT)",
};

const FORMAT_ICONS: Record<string, string> = {
  pdf: "📄",
  txt: "📃",
};

const FORMAT_COLORS: Record<string, string> = {
  pdf: "#f97316",
  txt: "#22c55e",
};

const ALLOWED_EXTENSIONS = ["pdf", "txt", "text"];
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function validateFile(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `"${f.name}" is not supported. Only PDF and TXT files are allowed.`;
  }
  if (f.size > MAX_FILE_SIZE_BYTES) {
    return `File is too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Maximum size is ${MAX_FILE_SIZE_MB} MB.`;
  }
  if (f.size === 0) {
    return "The file appears to be empty.";
  }
  return null;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [selectedLangs, setSelectedLangs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [translations, setTranslations] = useState<Record<string, string> | null>(null);
  const [translatedSegments, setTranslatedSegments] = useState<Record<string, string[]> | null>(null);
  const [fileType, setFileType] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function toggleLang(code: string) {
    setSelectedLangs((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]
    );
  }

  function langName(code: string) {
    return LANGUAGES.find((l) => l.code === code)?.name || code;
  }

  function getFileExtension(f: File): string {
    return f.name.split(".").pop()?.toLowerCase() || "";
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function progressPercent(p: ProgressEvent | null): number {
    if (!p) return 5;
    if (p.stage === "extracting") {
      if (p.ocrStage === "ocr" && p.total) return Math.round((p.current! / p.total) * 40);
      return 20;
    }
    if (p.stage === "translating" && p.total && p.current !== undefined) {
      const langFraction = p.totalLangs ? (p.langIndex! - 1) / p.totalLangs : 0;
      const langProgress = p.total ? p.current / p.total / (p.totalLangs || 1) : 0;
      return Math.round(40 + (langFraction + langProgress) * 60);
    }
    return 50;
  }

  function progressText(p: ProgressEvent | null): string {
    if (!p) return "Starting…";
    if (p.stage === "extracting") {
      if (p.ocrStage === "ocr") {
        if (!p.total) return "Scanning document…";
        return `OCR scanning page ${p.current} of ${p.total}`;
      }
      return "Reading document text…";
    }
    if (p.stage === "translating" && p.language) {
      const label = langName(p.language);
      const langCount =
        p.totalLangs && p.totalLangs > 1 ? ` · lang ${p.langIndex}/${p.totalLangs}` : "";
      if (p.total) return `Translating to ${label}: ${p.current}/${p.total}${langCount}`;
      return `Translating to ${label}${langCount}…`;
    }
    return "Working…";
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0] || null;
    if (f) applyFile(f);
  }

  function applyFile(f: File) {
    const validationError = validateFile(f);
    if (validationError) {
      setError(validationError);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(f);
    setTranslations(null);
    setTranslatedSegments(null);
    setFileType(null);
    setError(null);
  }

  function handleReset() {
    setFile(null);
    setSelectedLangs([]);
    setTranslations(null);
    setTranslatedSegments(null);
    setFileType(null);
    setError(null);
    setProgress(null);
    setActiveTab(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit() {
    if (!file || selectedLangs.length === 0) return;

    // Re-validate before submitting (covers any edge cases)
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);
    setTranslations(null);
    setTranslatedSegments(null);
    setFileType(null);
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
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "stage" || event.type === "progress") {
            setProgress(event);
          } else if (event.type === "done") {
            setTranslations(event.translations);
            setTranslatedSegments(event.translatedSegments || null);
            setFileType(event.fileType || null);
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

  async function downloadOriginalFormat(lang: string) {
    if (!file || !translatedSegments || !fileType) return;
    setDownloading(true);
    try {
      const formData = new FormData();
      formData.append("originalFile", file);
      formData.append("translatedSegments", JSON.stringify(translatedSegments[lang]));
      formData.append("fileType", fileType);
      formData.append("language", lang);

      const res = await fetch("/api/download", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `translated-${lang}.${fileType}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  }

  const acceptedFormats = ".pdf,.txt,.text";
  const ext = file ? getFileExtension(file) : "";
  const canTranslate = !!file && selectedLangs.length > 0 && !loading;
  const pct = progressPercent(progress);

  return (
    <>
      {/* Background gradient blobs */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 0 }}>
        <div style={{
          position: "absolute", top: "-20%", left: "-10%",
          width: 600, height: 600, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(124,106,247,0.12) 0%, transparent 70%)",
        }} />
        <div style={{
          position: "absolute", bottom: "-15%", right: "-5%",
          width: 500, height: 500, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(91,91,240,0.1) 0%, transparent 70%)",
        }} />
      </div>

      <main style={{ position: "relative", zIndex: 1, maxWidth: 760, margin: "0 auto", padding: "52px 24px 80px" }}>

        {/* Header */}
        <div style={{ marginBottom: 48 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 12,
              background: "linear-gradient(135deg, #7c6af7, #5b5bf0)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
            }}>📑</div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>
              Document Translator
            </h1>
          </div>
          <p style={{ margin: 0, color: "#6b6b88", fontSize: 14, maxWidth: 500 }}>
            Upload a PDF or TXT and get a translated document in the same format — layout preserved.
          </p>
        </div>

        {/* Upload Card */}
        <div className="glass" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#9090b0", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              01 — Upload Document
            </p>
            {(file || translations) && (
              <button className="reset-btn" onClick={handleReset}>
                ↺ Reset
              </button>
            )}
          </div>

          <div
            className={`drop-zone${dragOver ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptedFormats}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                if (f) applyFile(f);
              }}
              style={{ display: "none" }}
            />
            {file ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: `${FORMAT_COLORS[ext] || "#7c6af7"}22`,
                  border: `1px solid ${FORMAT_COLORS[ext] || "#7c6af7"}44`,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
                }}>
                  {FORMAT_ICONS[ext] || "📎"}
                </div>
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#eee" }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                    {FORMAT_LABELS[ext] || ext.toUpperCase()} · {formatFileSize(file.size)}
                  </div>
                </div>
                <div style={{
                  marginLeft: 8, padding: "3px 10px", borderRadius: 6,
                  background: `${FORMAT_COLORS[ext] || "#7c6af7"}22`,
                  color: FORMAT_COLORS[ext] || "#7c6af7",
                  fontSize: 11, fontWeight: 700,
                }}>
                  {(FORMAT_LABELS[ext] || ext).toUpperCase()}
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 32, marginBottom: 10 }}>⬆️</div>
                <div style={{ fontSize: 14, color: "#ccc", marginBottom: 4 }}>Drop your file here, or click to browse</div>
                <div style={{ fontSize: 12, color: "#555" }}>PDF · TXT</div>
              </div>
            )}
          </div>

          {/* Format pills */}
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            {Object.entries(FORMAT_LABELS).map(([fExt, label]) => (
              <span key={fExt} style={{
                padding: "3px 10px", borderRadius: 6, fontSize: 12,
                background: ext === fExt ? `${FORMAT_COLORS[fExt]}22` : "rgba(255,255,255,0.04)",
                border: `1px solid ${ext === fExt ? FORMAT_COLORS[fExt] : "rgba(255,255,255,0.08)"}`,
                color: ext === fExt ? FORMAT_COLORS[fExt] : "#555",
                fontWeight: ext === fExt ? 600 : 400,
                transition: "all 0.15s",
              }}>
                {FORMAT_ICONS[fExt]} {label}
              </span>
            ))}
          </div>
        </div>

        {/* Language Selection Card */}
        <div className="glass" style={{ padding: 28, marginBottom: 24 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600, color: "#9090b0", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            02 — Target Languages
            {selectedLangs.length > 0 && (
              <span style={{ marginLeft: 10, background: "#7c6af7", color: "#fff", borderRadius: 20, padding: "1px 8px", fontSize: 11 }}>
                {selectedLangs.length} selected
              </span>
            )}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                className={`lang-btn${selectedLangs.includes(lang.code) ? " active" : ""}`}
                onClick={() => toggleLang(lang.code)}
              >
                {lang.name}
              </button>
            ))}
          </div>
        </div>

        {/* Translate Card */}
        <div className="glass" style={{ padding: 28 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600, color: "#9090b0", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            03 — Translate
          </p>

          <button className="primary-btn" onClick={handleSubmit} disabled={!canTranslate}>
            {loading ? (
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="spinner" /> Translating…
              </span>
            ) : "Translate Document →"}
          </button>

          {loading && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="glow-dot" />
                <span style={{ fontSize: 13, color: "#9090b0" }}>{progressText(progress)}</span>
              </div>
              <div className="progress-bar-track">
                <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {error && (
            <div style={{
              marginTop: 16, padding: "12px 16px", borderRadius: 10,
              background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
              color: "#f87171", fontSize: 13,
            }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Results */}
        {translations && activeTab && (
          <div className="result-section" style={{ marginTop: 40 }}>

            {/* Divider */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
              <span style={{ fontSize: 12, color: "#555", textTransform: "uppercase", letterSpacing: "0.1em" }}>Translation Ready</span>
              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
            </div>

            {/* Language Tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
              {Object.keys(translations).map((lang) => (
                <button
                  key={lang}
                  className={`tab-btn${activeTab === lang ? " active" : ""}`}
                  onClick={() => setActiveTab(lang)}
                >
                  {langName(lang)}
                </button>
              ))}
            </div>

            {/* Download Bar */}
            <div style={{
              display: "flex", gap: 10, marginBottom: 28, flexWrap: "wrap",
              padding: "16px 20px", borderRadius: 12,
              background: "rgba(124,106,247,0.07)",
              border: "1px solid rgba(124,106,247,0.15)",
            }}>
              <button className="dl-btn-ghost" onClick={() => downloadTxt(activeTab, translations[activeTab])}>
                📃 Download .txt
              </button>
            </div>

            {/* Translation preview — single scrollable block, same as original */}
            <pre className="translation-preview">
              {translations[activeTab]}
            </pre>

          </div>
        )}
      </main>
    </>
  );
}
