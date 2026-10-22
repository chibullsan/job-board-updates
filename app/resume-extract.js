// Pulls plain text out of an uploaded resume (.docx, .pdf, .txt, .md, .rtf).
// Used by the upload button on the board page. Nothing leaves this PC.
const path = require("path");

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
  if (ext === ".txt" || ext === ".md" || ext === ".text") return clean(buf.toString("utf8"));
  if (ext === ".rtf") {
    // Very rough: strip RTF control words. Good enough for a plain resume.
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
  if (ext === ".doc") throw new Error("Old .doc files can't be read. Open it in Word, choose Save As, and pick Word Document (.docx) or PDF, then upload that.");
  throw new Error("That file type isn't supported. Please upload a Word (.docx) or PDF file.");
}

function clean(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { extractText };
