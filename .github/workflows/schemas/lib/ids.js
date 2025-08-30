const crypto = require("crypto");
const { v5: uuidv5, v4: uuidv4 } = require("uuid");
const NAMESPACE_KB = "b4b80c28-0e9c-5c53-9e31-8478a29799c1"; // constant

function sha256Bytes(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function nfc(str) { return str.normalize ? str.normalize("NFC") : str; }

function stableId(rawMarkdown) {
  try {
    const hashOfNFC = sha256Bytes(Buffer.from(nfc(rawMarkdown), "utf8"));
    return uuidv5(hashOfNFC, NAMESPACE_KB);
  } catch { // fallback chain
    try { return sha256Bytes(Buffer.from(rawMarkdown)); }
    catch { return uuidv4(); }
  }
}

function slugifyTitle(s) {
  return String(s)
    .normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9\s\-–—]/g, "")
    .replace(/[\s–—]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = { stableId, sha256Bytes, slugifyTitle, NAMESPACE_KB };
