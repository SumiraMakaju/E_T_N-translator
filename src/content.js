// ═══════════════════════════════════════════════════════════════════════════
// TMT Translator — content.js
// Includes: page-engine, inline translation, tooltip, lang picker, page panel
// ═══════════════════════════════════════════════════════════════════════════

const TMT_API_URL = process.env.TMT_API_URL;

// ── SHARED STATE ─────────────────────────────────────────────────────────────
let tooltip          = null;
let langPicker       = null;
let pagePanel        = null;
let selectionTimeout = null;
let isPageTranslating = false;
const translatedNodes = []; // inline undo stack

//  HELPERS 
function detectLanguage(text) {
  return /[\u0900-\u097F]/.test(text) ? "ne" : "en";
}
function langName(code) {
  return { en: "English", ne: "Nepali", tmg: "Tamang" }[code] || code;
}
function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

//  TOAST 
let _toastEl = null, _toastTimer = null;
function showToast(msg, duration = 2500) {
  if (!_toastEl) {
    _toastEl = document.createElement("div");
    _toastEl.id = "tmt-toast";
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = msg;
  _toastEl.classList.add("tmt-toast-visible");
  clearTimeout(_toastTimer);
  if (duration > 0) _toastTimer = setTimeout(() => _toastEl?.classList.remove("tmt-toast-visible"), duration);
}
function hideToast() { _toastEl?.classList.remove("tmt-toast-visible"); }

// PAGE ENGINE — smart full-page translation

const SKIP_TAGS = new Set([
  "SCRIPT","STYLE","NOSCRIPT","CODE","PRE","KBD","SAMP","VAR",
  "MATH","SVG","CANVAS","VIDEO","AUDIO","IFRAME","OBJECT","EMBED",
  "HEAD","META","LINK","TEMPLATE","SLOT","TMT-INLINE",
]);
const SKIP_ROLES    = new Set(["navigation","banner","contentinfo","search","complementary"]);
const SKIP_CLASSES  = /\b(nav|navbar|sidebar|footer|header|breadcrumb|menu|ad|ads|cookie|captcha|code|hljs)\b/i;
const SKIP_IDS      = /\b(nav|sidebar|footer|header|menu|cookie|ad)\b/i;

function shouldSkipNode(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

  const tag = el.tagName;

  if ([
    "SCRIPT","STYLE","NOSCRIPT","CODE","PRE",
    "INPUT","TEXTAREA","A","BUTTON","SELECT"
  ].includes(tag)) return true;

  if (el.closest("[contenteditable='true']")) return true;

  // Skip Gmail / dynamic UI areas
  if (el.closest("[role='navigation'], [role='toolbar'], [aria-label]")) return true;

  return false;
}
function collectTextNodes(root) {
  const nodes = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent.trim();

      if (!text || text.length < 3) return NodeFilter.FILTER_REJECT;

      // ❌ Skip emails / URLs inside text
      if (
        /\bhttps?:\/\//i.test(text) ||
        /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(text)
      ) return NodeFilter.FILTER_REJECT;

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

function batchNodes(nodes) {
  const batches = [];
  let current = [], len = 0;
  for (const node of nodes) {
    const t = node.textContent.trim();
    if (len + t.length > 400 && current.length) { batches.push(current); current = []; len = 0; }
    current.push(node);
    len += t.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Route ALL fetch calls through the background service worker.
// Content scripts are blocked by page CSP on sites like Gmail, Outlook, etc.
// The background service worker is NOT subject to page CSP.
async function callTranslateAPI(text, src_lang, tgt_lang, _apiKey) {
  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "TRANSLATE", text, src_lang, tgt_lang },
      (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      }
    );
  });
  if (response?.success) return response.output;
  if (response?.error === "NO_API_KEY") throw new Error("NO_API_KEY");
  throw new Error(response?.error || "API error");
}

// Page engine state
let _progressCb       = null;
let _cancelRequested  = false;
const _pageNodes      = [];

function setProgressCallback(cb) { _progressCb = cb; }
function cancelPageTranslation()  { _cancelRequested = true; }

async function translatePage(tgt_lang, apiKey) {
  _cancelRequested = false;
  _pageNodes.length = 0;

  // Auto-detect page source language from visible text sample
  const sample = document.body.innerText.slice(0, 200);
  const src_lang = detectLanguage(sample);

  if (src_lang === tgt_lang) {
    _progressCb?.({ status: "error", message: `Page already appears to be in ${langName(tgt_lang)}.` });
    return;
  }

  const nodes = collectTextNodes(document.body);
  if (!nodes.length) {
    _progressCb?.({ status: "error", message: "No translatable text found on this page." });
    return;
  }

  const batches = batchNodes(nodes);
  let done = 0;
  const total = nodes.length;

  _progressCb?.({ status: "start", total, done: 0 });

  for (const batch of batches) {
    if (_cancelRequested) { _progressCb?.({ status: "cancelled", done, total }); return; }

    for (const node of batch) {
      if (_cancelRequested) break;
      if (!document.contains(node)) { done++; continue; } // node may have been removed

      const originalText = node.textContent;

      try {
        // masking & protection handled inside background.js for all paths
        const translated = await callTranslateAPI(originalText.trim(), src_lang, tgt_lang, apiKey);
        // If background skipped it (all protected), translated === originalText — still wrap so restore works
        if (!translated || translated === originalText.trim()) { done++; _progressCb?.({ status: "progress", done, total }); continue; }

        const wrapper = document.createElement("tmt-inline");
        wrapper.setAttribute("data-original",   originalText);
        wrapper.setAttribute("data-translated", translated);
        wrapper.setAttribute("data-src",        src_lang);
        wrapper.setAttribute("data-tgt",        tgt_lang);
        wrapper.setAttribute("data-page",       "true");
        wrapper.className = "tmt-translated tmt-page-translated";
        wrapper.title = `Original: ${originalText.slice(0, 80)}`;
        wrapper.textContent = translated;   // ← fixed: was using undefined `restored`

        node.parentNode?.replaceChild(wrapper, node);
        _pageNodes.push(wrapper);
      } catch (err) {
        // If API key is missing, abort the whole run immediately
        if (err.message === "NO_API_KEY") {
          _cancelRequested = true;
          _progressCb?.({ status: "error", message: "No API key — open Settings to configure." });
          return;
        }
        console.warn("TMT page-engine skip:", err.message);
      }

      done++;
      _progressCb?.({ status: "progress", done, total });
      await new Promise(r => setTimeout(r, 80)); // rate-limit
    }
  }

  _progressCb?.({ status: "done", done, total });
}

function restorePageTranslation() {
  const all = document.querySelectorAll("tmt-inline[data-page]");
  all.forEach(w => w.replaceWith(document.createTextNode(w.getAttribute("data-original"))));
  _pageNodes.length = 0;
  return all.length;
}


// INLINE TRANSLATION (text selection)


async function translateInline(selection, tgt_lang) {
  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length < 2) return;

  const src_lang = detectLanguage(selectedText);
  if (src_lang === tgt_lang) { showToast(`Already in ${langName(tgt_lang)}!`); return; }

  let savedRange;
  try { savedRange = selection.getRangeAt(0).cloneRange(); } catch { return; }

  showToast("Translating…", 0);

  const response = await new Promise(r =>
    chrome.runtime.sendMessage({ type: "TRANSLATE", text: selectedText, src_lang, tgt_lang }, r)
  );

  hideToast();

  if (!response?.success) {
    showToast("⚠ " + (response?.error === "NO_API_KEY"
      ? "No API key — open Settings to configure."
      : (response?.error || "Translation failed")), 3500);
    return;
  }

  try {
    const scrollY = window.scrollY;
    const sel2 = window.getSelection();
    sel2.removeAllRanges();
    sel2.addRange(savedRange);
    const range = sel2.getRangeAt(0);

    const wrapper = document.createElement("tmt-inline");
    wrapper.setAttribute("data-original",   selectedText);
    wrapper.setAttribute("data-translated", response.output);
    wrapper.setAttribute("data-src",        src_lang);
    wrapper.setAttribute("data-tgt",        tgt_lang);
    wrapper.className = "tmt-translated";
    wrapper.title = `Original: ${selectedText} | Alt+Z to restore`;
    wrapper.textContent = response.output;

    range.deleteContents();
    range.insertNode(wrapper);
    sel2.removeAllRanges();
    window.scrollTo(0, scrollY);

    translatedNodes.push(wrapper);
    showToast(`✓ Translated to ${langName(tgt_lang)} — Alt+Z to undo`);
  } catch {
    showToast("⚠ Could not replace text here.", 3000);
  }
}

function deTranslateLast() {
  while (translatedNodes.length && !document.contains(translatedNodes.at(-1))) translatedNodes.pop();
  if (!translatedNodes.length) { showToast("Nothing to restore."); return; }
  const w = translatedNodes.pop();
  w.replaceWith(document.createTextNode(w.getAttribute("data-original")));
  showToast("↩ Restored original text");
}

function deTranslateAll() {
  const all = document.querySelectorAll("tmt-inline:not([data-page])");
  if (!all.length) { showToast("No inline translations to restore."); return; }
  all.forEach(w => w.replaceWith(document.createTextNode(w.getAttribute("data-original"))));
  translatedNodes.length = 0;
  showToast(`↩ Restored ${all.length} translation${all.length !== 1 ? "s" : ""}`);
}


// PAGE TRANSLATE PANEL UI


function createPagePanel() {
  const el = document.createElement("div");
  el.id = "tmt-page-panel";
  el.innerHTML = `
    <div class="tmt-pp-header">
      <div class="tmt-pp-brand">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Smart Page Translate
      </div>
      <button class="tmt-pp-close" id="tmt-pp-close">✕</button>
    </div>
    <div class="tmt-pp-body">

      <div id="tmt-pp-setup" style="display:flex;flex-direction:column;gap:14px">
        <div class="tmt-pp-lang-group">
          <span class="tmt-pp-lang-label">Translate page to</span>
          <div class="tmt-pp-lang-btns">
            <button class="tmt-pp-lang-btn active" data-lang="ne">🇳🇵 Nepali</button>
            <button class="tmt-pp-lang-btn" data-lang="en">🇬🇧 English</button>
            <button class="tmt-pp-lang-btn" data-lang="tmg">🏔 Tamang</button>
          </div>
        </div>
        <div class="tmt-pp-features">
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-skip"></span>Skips code blocks, &lt;pre&gt;, scripts</div>
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-keep"></span>Preserves URLs, names, tech terms</div>
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-smart"></span>Skips nav, footer, sidebar</div>
        </div>
        <button class="tmt-pp-go" id="tmt-pp-go">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 9-14 9V3z" fill="currentColor"/></svg>
          Translate Page
        </button>
      </div>

      <div id="tmt-pp-progress" style="display:none">
        <div class="tmt-pp-status-row">
          <span id="tmt-pp-status-text">Starting…</span>
          <span id="tmt-pp-count" style="font-family:monospace;font-size:11px;color:#475569">0 / 0</span>
        </div>
        <div class="tmt-pp-bar-track"><div class="tmt-pp-bar-fill" id="tmt-pp-bar"></div></div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="tmt-pp-cancel" id="tmt-pp-cancel">Cancel</button>
        </div>
      </div>

      <div id="tmt-pp-done" style="display:none">
        <div class="tmt-pp-done-row">
          <div class="tmt-pp-done-icon">✓</div>
          <div>
            <div class="tmt-pp-done-title" id="tmt-pp-done-title">Page translated</div>
            <div class="tmt-pp-done-sub" id="tmt-pp-done-sub"></div>
          </div>
        </div>
        <div class="tmt-pp-done-actions">
          <button class="tmt-pp-restore" id="tmt-pp-restore">↩ Restore original</button>
          <button class="tmt-pp-again" id="tmt-pp-again">Translate again</button>
        </div>
      </div>

    </div>
    <button class="tmt-pp-collapse" id="tmt-pp-collapse" title="Collapse">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M19 9l-7 7-7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  `;
  document.body.appendChild(el);

  let selectedLang = "ne";
  let collapsed    = false;

  el.querySelectorAll(".tmt-pp-lang-btn").forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-pp-lang-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLang = btn.dataset.lang;
    };
  });

  document.getElementById("tmt-pp-collapse").onclick = () => {
    collapsed = !collapsed;
    el.classList.toggle("tmt-pp-collapsed", collapsed);
    const path = el.querySelector("#tmt-pp-collapse svg path");
    if (path) path.setAttribute("d", collapsed ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7");
  };

  document.getElementById("tmt-pp-close").onclick = () => {
    if (isPageTranslating) { cancelPageTranslation(); isPageTranslating = false; }
    el.classList.remove("tmt-pp-visible");
    setTimeout(() => { el.style.display = "none"; }, 220);
  };

  document.getElementById("tmt-pp-go").onclick = () => startPageTranslate(selectedLang);

  document.getElementById("tmt-pp-cancel").onclick = () => {
    cancelPageTranslation();
    isPageTranslating = false;
    switchView("setup");
    showToast("Translation cancelled.");
  };

  document.getElementById("tmt-pp-restore").onclick = () => {
    const n = restorePageTranslation();
    switchView("setup");
    showToast(`↩ Restored ${n} element${n !== 1 ? "s" : ""} to original`);
  };

  document.getElementById("tmt-pp-again").onclick = () => {
    restorePageTranslation();
    switchView("setup");
  };

  return el;
}

function switchView(view) {
  ["setup","progress","done"].forEach(v => {
    const el = document.getElementById(`tmt-pp-${v}`);
    if (el) el.style.display = v === view ? (v === "setup" ? "flex" : "block") : "none";
  });
}

function showPagePanel() {
  if (!pagePanel) pagePanel = createPagePanel();
  pagePanel.style.display = "block";
  pagePanel.classList.remove("tmt-pp-collapsed");
  switchView("setup");
  requestAnimationFrame(() => pagePanel.classList.add("tmt-pp-visible"));
}

async function startPageTranslate(tgt_lang) {
  if (isPageTranslating) return;

  const result = await new Promise(r => chrome.storage.sync.get("apiKey", r));
  const apiKey = result.apiKey;
  if (!apiKey) {
    showToast("⚠ No API key — click the TMT icon → Settings to configure.", 4000);
    return;
  }

  isPageTranslating = true;
  switchView("progress");

  const statusEl = document.getElementById("tmt-pp-status-text");
  const countEl  = document.getElementById("tmt-pp-count");
  const barEl    = document.getElementById("tmt-pp-bar");

  setProgressCallback(({ status, done, total, message }) => {
    if (status === "start") {
      statusEl.textContent = `Translating to ${langName(tgt_lang)}…`;
      countEl.textContent  = `0 / ${total}`;
      barEl.style.width    = "0%";
    } else if (status === "progress") {
      const pct = Math.round((done / total) * 100);
      barEl.style.width   = pct + "%";
      countEl.textContent = `${done} / ${total}`;
      statusEl.textContent = `Translating… ${pct}%`;
    } else if (status === "done") {
      isPageTranslating = false;
      switchView("done");
      document.getElementById("tmt-pp-done-title").textContent =
        `✓ Page translated to ${langName(tgt_lang)}`;
      document.getElementById("tmt-pp-done-sub").textContent =
        `${done} text blocks translated · code & names preserved`;
    } else if (status === "cancelled") {
      isPageTranslating = false;
    } else if (status === "error") {
      isPageTranslating = false;
      switchView("setup");
      showToast("⚠ " + (message || "Page translation failed"), 4000);
    }
  });

  try {
    await translatePage(tgt_lang, apiKey);
  } catch (err) {
    isPageTranslating = false;
    switchView("setup");
    showToast("⚠ " + err.message, 4000);
  }
}

// LANGUAGE PICKER (Alt+T)

function createLangPicker() {
  const el = document.createElement("div");
  el.id = "tmt-lang-picker";
  el.innerHTML = `
    <div class="tmt-picker-header">
      <div class="tmt-picker-logo">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Translate selection to…
      </div>
      <span class="tmt-picker-hint">Alt+Z to undo</span>
    </div>
    <div class="tmt-picker-options">
      <button class="tmt-pick-btn" data-lang="en">
        <span class="tmt-pick-flag">🇬🇧</span>
        <div class="tmt-pick-text"><span class="tmt-pick-name">English</span><span class="tmt-pick-code">en</span></div>
      </button>
      <button class="tmt-pick-btn" data-lang="ne">
        <span class="tmt-pick-flag">🇳🇵</span>
        <div class="tmt-pick-text"><span class="tmt-pick-name">Nepali</span><span class="tmt-pick-code">ne</span></div>
      </button>
      <button class="tmt-pick-btn" data-lang="tmg">
        <span class="tmt-pick-flag">🏔</span>
        <div class="tmt-pick-text"><span class="tmt-pick-name">Tamang</span><span class="tmt-pick-code">tmg</span></div>
      </button>
    </div>
    <div class="tmt-picker-footer">
      <button class="tmt-restore-btn" id="tmt-restore-all">↩ Restore all selections</button>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function showLangPicker(x, y, savedRange) {
  if (!langPicker) langPicker = createLangPicker();
  langPicker.style.display = "block";
  langPicker.classList.remove("tmt-picker-visible");

  const vw = window.innerWidth;
  let left = x, top = y + 14;
  if (left + 250 > vw) left = vw - 258;
  if (left < 8) left = 8;
  if (top + 220 > window.innerHeight + window.scrollY) top = y - 220;

  langPicker.style.left = left + "px";
  langPicker.style.top  = top + "px";

  requestAnimationFrame(() => langPicker.classList.add("tmt-picker-visible"));

  langPicker.querySelectorAll(".tmt-pick-btn").forEach(btn => {
    btn.onclick = async () => {
      const tgt = btn.dataset.lang;
      hideLangPicker(); hideTooltipEl();
      if (savedRange) {
        const sel = window.getSelection(); sel.removeAllRanges();
        try { sel.addRange(savedRange); } catch {}
      }
      await translateInline(window.getSelection(), tgt);
    };
  });

  document.getElementById("tmt-restore-all").onclick = () => { hideLangPicker(); deTranslateAll(); };
}

function hideLangPicker() {
  if (langPicker) {
    langPicker.classList.remove("tmt-picker-visible");
    setTimeout(() => { langPicker && (langPicker.style.display = "none"); }, 180);
  }
}


// TOOLTIP (hover preview card)

function createTooltip() {
  const el = document.createElement("div");
  el.id = "tmt-tooltip";
  el.innerHTML = `
    <div class="tmt-header">
      <div class="tmt-logo">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        TMT
      </div>
      <div class="tmt-lang-row">
        <select id="tmt-src">
          <option value="en">English</option>
          <option value="ne">Nepali</option>
          <option value="tmg">Tamang</option>
        </select>
        <button id="tmt-swap">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <select id="tmt-tgt">
          <option value="ne">Nepali</option>
          <option value="en">English</option>
          <option value="tmg">Tamang</option>
        </select>
      </div>
    </div>
    <div id="tmt-source-text" class="tmt-source"></div>
    <div id="tmt-output" class="tmt-output"><div class="tmt-spinner"></div></div>
    <div class="tmt-actions">
      <div class="tmt-action-left">
        <button id="tmt-replace" class="tmt-btn-replace" style="display:none">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          Replace on page
        </button>
        <button id="tmt-copy" class="tmt-btn-secondary" style="display:none">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
          </svg>
          Copy
        </button>
      </div>
      <button id="tmt-close" class="tmt-btn-ghost">✕</button>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

let _savedRangeForTooltip = null;
let _tgtLangForReplace    = "ne";

function showTooltipEl(x, y, text, savedRange) {
  if (!tooltip) tooltip = createTooltip();
  _savedRangeForTooltip = savedRange || null;

  const srcSel  = tooltip.querySelector("#tmt-src");
  const tgtSel  = tooltip.querySelector("#tmt-tgt");
  const srcEl   = tooltip.querySelector("#tmt-source-text");
  const outEl   = tooltip.querySelector("#tmt-output");
  const copyBtn = tooltip.querySelector("#tmt-copy");
  const repBtn  = tooltip.querySelector("#tmt-replace");
  const closeBtn= tooltip.querySelector("#tmt-close");
  const swapBtn = tooltip.querySelector("#tmt-swap");

  const detected = detectLanguage(text);
  srcSel.value = detected;
  tgtSel.value = detected === "en" ? "ne" : "en";
  _tgtLangForReplace = tgtSel.value;

  srcEl.textContent = text.length > 120 ? text.slice(0, 120) + "…" : text;
  outEl.innerHTML   = '<div class="tmt-spinner"></div>';
  copyBtn.style.display = "none";
  repBtn.style.display  = "none";

  tooltip.style.display = "block";
  tooltip.classList.remove("tmt-visible");

  const vw = window.innerWidth;
  let left = x, top = y + 16;
  if (left + 300 > vw) left = vw - 310;
  if (left < 8) left = 8;
  if (top + 240 > window.innerHeight + window.scrollY) top = y - 250;

  tooltip.style.left = left + "px";
  tooltip.style.top  = top + "px";

  requestAnimationFrame(() => tooltip.classList.add("tmt-visible"));
  runTooltipTranslate(text, srcSel.value, tgtSel.value);

  const retranslate = () => {
    if (srcSel.value === tgtSel.value) tgtSel.value = srcSel.value === "en" ? "ne" : "en";
    _tgtLangForReplace = tgtSel.value;
    outEl.innerHTML = '<div class="tmt-spinner"></div>';
    copyBtn.style.display = "none"; repBtn.style.display = "none";
    runTooltipTranslate(text, srcSel.value, tgtSel.value);
  };

  srcSel.onchange = retranslate;
  tgtSel.onchange = () => { _tgtLangForReplace = tgtSel.value; retranslate(); };
  swapBtn.onclick = () => { [srcSel.value, tgtSel.value] = [tgtSel.value, srcSel.value]; _tgtLangForReplace = tgtSel.value; retranslate(); };
  closeBtn.onclick = hideTooltipEl;

  copyBtn.onclick = () => {
    const r = outEl.querySelector(".tmt-result");
    if (!r) return;
    navigator.clipboard.writeText(r.textContent).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`; }, 1500);
    });
  };

  repBtn.onclick = async () => {
    hideTooltipEl();
    if (_savedRangeForTooltip) {
      const sel = window.getSelection(); sel.removeAllRanges();
      try { sel.addRange(_savedRangeForTooltip); } catch {}
    }
    await translateInline(window.getSelection(), _tgtLangForReplace);
  };
}

function runTooltipTranslate(text, src_lang, tgt_lang) {
  const outEl   = tooltip?.querySelector("#tmt-output");
  const copyBtn = tooltip?.querySelector("#tmt-copy");
  const repBtn  = tooltip?.querySelector("#tmt-replace");

  chrome.runtime.sendMessage({ type: "TRANSLATE", text, src_lang, tgt_lang }, (res) => {
    if (!outEl) return;
    if (res?.success) {
      outEl.innerHTML = `<div class="tmt-result">${escapeHtml(res.output)}</div>`;
      copyBtn && (copyBtn.style.display = "flex");
      repBtn  && (repBtn.style.display  = "flex");
    } else if (res?.error === "NO_API_KEY") {
      outEl.innerHTML = `<div class="tmt-error">⚠ No API key. <a href="#" id="tmt-open-opts">Configure →</a></div>`;
      document.getElementById("tmt-open-opts")?.addEventListener("click", e => {
        e.preventDefault(); chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      });
    } else {
      outEl.innerHTML = `<div class="tmt-error">⚠ ${escapeHtml(res?.error || "Translation failed")}</div>`;
    }
  });
}

function hideTooltipEl() {
  if (tooltip) {
    tooltip.classList.remove("tmt-visible");
    setTimeout(() => { tooltip && (tooltip.style.display = "none"); }, 200);
  }
}

// KEYBOARD SHORTCUTS


document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideTooltipEl(); hideLangPicker(); return; }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    const sel = window.getSelection(), text = sel?.toString().trim();
    if (!text || text.length < 2) { showToast("✋ Select text first, then press Alt+T"); return; }
    let sr = null; try { sr = sel.getRangeAt(0).cloneRange(); } catch {}
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    hideTooltipEl();
    showLangPicker(rect.left + window.scrollX, rect.bottom + window.scrollY, sr);
    return;
  }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault(); hideLangPicker(); hideTooltipEl(); deTranslateLast(); return;
  }

  if (e.altKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault(); hideLangPicker(); hideTooltipEl(); deTranslateAll(); return;
  }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault(); showPagePanel(); return;
  }
});

// MOUSE SELECTION → TOOLTIP

document.addEventListener("mouseup", (e) => {
  if (tooltip?.contains(e.target) || langPicker?.contains(e.target) || pagePanel?.contains(e.target)) return;
  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const sel = window.getSelection(), text = sel?.toString().trim();
    if (text && text.length > 1 && text.length < 1000) {
      if (langPicker?.classList.contains("tmt-picker-visible")) return;
      const range = sel.getRangeAt(0), rect = range.getBoundingClientRect();
      let sr = null; try { sr = range.cloneRange(); } catch {}
      showTooltipEl(rect.left + window.scrollX, rect.bottom + window.scrollY, text, sr);
    } else if (!text) { hideTooltipEl(); hideLangPicker(); }
  }, 350);
});

document.addEventListener("mousedown", (e) => {
  if (langPicker?.classList.contains("tmt-picker-visible") && !langPicker.contains(e.target)) hideLangPicker();
});

// MESSAGES FROM BACKGROUND

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSLATE_SELECTION" || msg.type === "KEYBOARD_TRANSLATE") {
    const sel = window.getSelection(), text = msg.text || sel?.toString().trim();
    if (text) {
      const range = sel?.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect  = range ? range.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 100 };
      let sr = null; try { if (range) sr = range.cloneRange(); } catch {}
      showTooltipEl(rect.left + window.scrollX, rect.bottom + window.scrollY, text, sr);
    }
  }
  if (msg.type === "OPEN_PAGE_PANEL")  showPagePanel();
  if (msg.type === "DETRANSLATE_LAST") deTranslateLast();
  if (msg.type === "DETRANSLATE_ALL")  deTranslateAll();
});


const observer = new MutationObserver(() => {
  if (isPageTranslating) return;
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});