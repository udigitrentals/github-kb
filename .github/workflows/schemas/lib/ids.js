// lib/ingest/ids.js
// Provides stable IDs and slugs for KB ingestion, plus a collision-safe unique slug generator.
// Deps: crypto (built-in), uuid (npm: uuid)

const crypto = require("crypto");
const { v5: uuidv5, v4: uuidv4 } = require("uuid");

// IMPORTANT: do not change; changing namespace will change every ID.
const NAMESPACE_KB = "b4b80c28-0e9c-5c53-9e31-8478a29799c1";

/** SHA-256 hex digest */
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Normalize to NFC */
function nfc(str) {
  return (str && typeof str.normalize === "function") ? str.normalize("NFC") : str;
}

/**
 * Stable ID for a raw Markdown block.
 * Primary: uuidv5(sha256(NFC(raw)), NAMESPACE_KB)
 * Fallbacks: sha256Hex(raw) → uuidv4()
 */
function stableId(rawMarkdown) {
  try {
    const nfcText = nfc(rawMarkdown);
    const hash = sha256Hex(Buffer.from(nfcText, "utf8"));
    return uuidv5(hash, NAMESPACE_KB);
  } catch (e) {
    try { return sha256Hex(Buffer.from(rawMarkdown || "", "utf8")); }
    catch { return uuidv4(); }
  }
}

/**
 * Basic slugify: lowercase, remove diacritics/punct, collapse dashes.
 */
function slugifyTitle(s) {
  return String(s || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s\-–—]/g, "")
    .replace(/[\s–—]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Ensure a slug is unique by appending -2, -3, ... if needed.
 *
 * @param {string} baseSlug - the starting slug (already slugified)
 * @param {Set<string>|Function} taken - a Set of used slugs OR a function (slug)=>boolean that returns true if taken
 * @param {Object} [opts]
 * @param {boolean} [opts.mutate=false] - if taken is a Set, add the chosen slug into it when true
 * @param {number}  [opts.max=10000]    - safety cap on attempts
 * @returns {string} unique slug
 *
 * Usage with Set:
 *   const taken = new Set(["block-1", "block-1-2"]);
 *   const unique = ensureUniqueSlug("block-1", taken, { mutate: true });
 *
 * Usage with callback:
 *   const unique = ensureUniqueSlug("block-1", (s)=>db.hasSlug(s));
 */
function ensureUniqueSlug(baseSlug, taken, opts = {}) {
  const { mutate = false, max = 10000 } = opts;
  const isTaken = (slug) =>
    typeof taken === "function" ? !!taken(slug)
      : (taken && typeof taken.has === "function" ? taken.has(slug) : false);

  // If base is free, use it
  if (!isTaken(baseSlug)) {
    if (mutate && taken && typeof taken.add === "function") taken.add(baseSlug);
    return baseSlug;
  }

  // If base ends with -N already, start from the next integer; else start at 2
  const m = baseSlug.match(/-(\d+)$/);
  let i = m ? (parseInt(m[1], 10) + 1) : 2;
  const root = m ? baseSlug.replace(/-(\d+)$/, "") : baseSlug;

  for (let tries = 0; tries < max; tries++, i++) {
    const candidate = `${root}-${i}`;
    if (!isTaken(candidate)) {
      if (mutate && taken && typeof taken.add === "function") taken.add(candidate);
      return candidate;
    }
  }
  // Extremely unlikely, but guarantees a result
  const fallback = `${root}-${Date.now()}`;
  if (mutate && taken && typeof taken.add === "function") taken.add(fallback);
  return fallback;
}

/**
 * Convenience: slugify a title and ensure uniqueness in one call.
 *
 * @param {string} title
 * @param {Set<string>|Function} taken
 * @param {Object} [opts] - same options as ensureUniqueSlug
 * @returns {string} unique slug
 */
function slugifyUnique(title, taken, opts = {}) {
  const base = slugifyTitle(title);
  return ensureUniqueSlug(base, taken, opts);
}

module.exports = {
  stableId,
  sha256Hex,
  slugifyTitle,
  ensureUniqueSlug,
  slugifyUnique,
  NAMESPACE_KB
};
