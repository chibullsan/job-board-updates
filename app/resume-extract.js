// Pulls plain text out of uploaded files when it can. Pictures and unknown types are saved, not rejected.
const path = require("path");

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);

async function extractText(filename, buf) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".docx") {
    const mammoth = require("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return clean(r.value);
  }
  if (ext === ".pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: true });
    return clean(Array.isArray(text) ? text.join("\n") : text);
  }
  if (ext === ".txt" || ext === ".md" || ext === ".text" || ext === ".csv") return clean(buf.toString("utf8"));
  if (ext === ".rtf") {
    return clean(
      buf
        .toString("latin1")
        .replace(/\\par[d]?/g, "\n")
        .replace(/\{\\\*[^}]*\}/g, "")
        .replace(/\\'[0-9a-f]{2}/gi, "")
        .replace(/\\[a-z]+-?\d* ?/gi, "")
        .replace(/[{}]/g, "")
    );
  }
  if (ext === ".doc") {
    const err = new Error("Old .doc files can't be read as text. I saved the file. If you can, also upload a Word (.docx) or PDF copy.");
    err.code = "DOC";
    throw err;
  }
  if (IMAGE.has(ext)) {
    const err = new Error("Saved as a picture. I cannot read the words in the image automatically — please tell me what it is, or upload a Word/PDF if it has text I should use.");
    err.code = "IMAGE";
    throw err;
  }
  const err = new Error("Saved. I could not pull text from this file type. Tell me what it is, or upload a Word/PDF copy if you want me to read it.");
  err.code = "UNKNOWN";
  throw err;
}

async function extractUpload(filename, buf) {
  try {
    const text = await extractText(filename, buf);
    return { text, note: text ? "" : "Little or no text found (it may be a scan or a picture)." };
  } catch (e) {
    return { text: "", note: String((e && e.message) || e), savedOnly: true };
  }
}

function clean(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { extractText, extractUpload };
