const API_URL = process.env.TMT_API_URL;

//  Elements to NEVER translate 
const SKIP_TAGS = new Set([
  "SCRIPT","STYLE","NOSCRIPT","CODE","PRE","KBD","SAMP","VAR",
  "MATH","SVG","CANVAS","VIDEO","AUDIO","IFRAME","OBJECT","EMBED",
  "HEAD","META","LINK","TEMPLATE","SLOT","tmt-inline","TMT-INLINE"
]);

// Semantic regions to skip (nav, footer, sidebar, ads)
const SKIP_ROLES = new Set(["navigation","banner","contentinfo","search","complementary"]);
const SKIP_CLASSES = /\b(nav|navbar|sidebar|footer|header|breadcrumb|menu|ad|ads|cookie|captcha|code|hljs)\b/i;
const SKIP_IDS     = /\b(nav|sidebar|footer|header|menu|cookie|ad)\b/i;

//  Technical term patterns to protect 
// These are masked before sending to the API and restored after
const PROTECT_PATTERNS = [
  // URLs
  /https?:\/\/[^\s<>"']+/g,
  // Email addresses
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
  // Camel/PascalCase identifiers (APIs, class names, function names)
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  // ALL_CAPS constants
  /\b[A-Z][A-Z0-9_]{2,}\b/g,
  // Version numbers / semver
  /\bv?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi,
  // File extensions / filenames
  /\b[\w-]+\.(js|ts|jsx|tsx|py|go|rs|java|cpp|c|h|css|html|json|yaml|yml|md|txt|pdf|docx|xlsx|png|jpg|svg|env)\b/gi,
  // npm packages / kebab-case-identifiers
  /\b@?[a-z][\w-]*\/[\w-]+\b/g,
  // Hashtags
  /#[\w]+/g,
  // @mentions
  /@[\w]+/g,
];

// Common proper noun starters and tech brand names to protect
const PROTECT_WORDS = new Set([
  "Google","Facebook","Twitter","Instagram","YouTube","GitHub","Microsoft",
  "Apple","Amazon","Netflix","Spotify","Slack","Discord","OpenAI","Anthropic",
  "React","Angular","Vue","Next","Vite","Node","Python","JavaScript","TypeScript",
  "HTML","CSS","API","SDK","UI","UX","HTTP","HTTPS","REST","JSON","XML","SQL",
  "TMT","Nepali","Tamang","English","Nepal","Kathmandu","Dhulikhel",
]);

//  Masking 
function maskProtected(text) {
  const placeholders = [];

  let masked = text;

  // Mask regex patterns
  for (const pattern of PROTECT_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      const id = `⟦${placeholders.length}⟧`;
      placeholders.push(match);
      return id;
    });
  }

  // Mask protected words
  const wordRe = new RegExp(`\\b(${[...PROTECT_WORDS].join("|")})\\b`, "g");
  masked = masked.replace(wordRe, (match) => {
    const id = `⟦${placeholders.length}⟧`;
    placeholders.push(match);
    return id;
  });

  return { masked, placeholders };
}

function restorePlaceholders(translated, placeholders) {
  return translated.replace(/⟦(\d+)⟧/g, (_, i) => placeholders[Number(i)] ?? _);
}

//  DOM walking 
function shouldSkipNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute("translate") === "no") return true;
  if (el.getAttribute("contenteditable") === "true") return true;
  if (SKIP_ROLES.has(el.getAttribute("role"))) return true;
  if (el.className && SKIP_CLASSES.test(el.className)) return true;
  if (el.id && SKIP_IDS.test(el.id)) return true;
  return false;
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Must have meaningful content
      if (!node.textContent.trim() || node.textContent.trim().length < 3) {
        return NodeFilter.FILTER_REJECT;
      }
      // Walk up and check all ancestors
      let el = node.parentElement;
      while (el && el !== root) {
        if (shouldSkipNode(el)) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

//  Batching 
// Group text nodes into batches ≤ 500 chars to stay within API sentence limits
function batchNodes(nodes) {
  const batches = [];
  let current = [], currentLen = 0;

  for (const node of nodes) {
    const text = node.textContent.trim();
    if (currentLen + text.length > 500 && current.length > 0) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(node);
    currentLen += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

//  API call (single sentence) 
async function callTranslate(text, src_lang, tgt_lang, apiKey) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ text, src_lang, tgt_lang }),
  });
  const data = await res.json();
  if (data.message_type === "SUCCESS") return data.output;
  throw new Error(data.message || "API error");
}

//  Progress tracking 
let _progressCallback = null;
let _cancelRequested  = false;
const _pageTranslatedNodes = [];

export function onProgress(cb) { _progressCallback = cb; }
export function cancelPageTranslation() { _cancelRequested = true; }
export function getPageTranslatedNodes() { return _pageTranslatedNodes; }

//  Main entry 
export async function translatePage(tgt_lang, apiKey) {
  _cancelRequested = false;
  _pageTranslatedNodes.length = 0;

  const src_lang = "en"; // Default; could add detection per node in future
  const nodes = collectTextNodes(document.body);

  if (!nodes.length) {
    _progressCallback?.({ status: "error", message: "No translatable text found." });
    return;
  }

  const batches = batchNodes(nodes);
  let done = 0;
  const total = nodes.length;

  _progressCallback?.({ status: "start", total, done: 0 });

  for (const batch of batches) {
    if (_cancelRequested) {
      _progressCallback?.({ status: "cancelled", done, total });
      return;
    }

    // Translate each node in the batch sequentially (API is sentence-level)
    for (const node of batch) {
      if (_cancelRequested) break;

      const originalText = node.textContent;
      const { masked, placeholders } = maskProtected(originalText.trim());

      // Skip if nothing worth translating remains after masking
      if (!masked.replace(/⟦\d+⟧/g, "").trim()) {
        done++;
        continue;
      }

      try {
        const translated = await callTranslate(masked, src_lang, tgt_lang, apiKey);
        const restored = restorePlaceholders(translated, placeholders);

        // Replace in DOM
        const wrapper = document.createElement("tmt-inline");
        wrapper.setAttribute("data-original", originalText);
        wrapper.setAttribute("data-translated", restored);
        wrapper.setAttribute("data-src", src_lang);
        wrapper.setAttribute("data-tgt", tgt_lang);
        wrapper.setAttribute("data-page", "true");
        wrapper.className = "tmt-translated tmt-page-translated";
        wrapper.title = `Original: ${originalText.slice(0, 80)}… | Click "Restore page" to undo`;
        wrapper.textContent = restored;

        node.parentNode?.replaceChild(wrapper, node);
        _pageTranslatedNodes.push(wrapper);
      } catch (err) {
        // Skip failed nodes silently — don't block the rest
        console.warn("TMT page-engine: skip node:", err.message);
      }

      done++;
      _progressCallback?.({ status: "progress", done, total });

      // Rate-limit: small delay between requests
      await new Promise(r => setTimeout(r, 80));
    }
  }

  _progressCallback?.({ status: "done", done, total });
}

//  Restore page 
export function restorePage() {
  const all = document.querySelectorAll("tmt-inline[data-page]");
  all.forEach(w => w.replaceWith(document.createTextNode(w.getAttribute("data-original"))));
  _pageTranslatedNodes.length = 0;
  return all.length;
}
