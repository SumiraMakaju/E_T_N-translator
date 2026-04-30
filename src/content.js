import {
  translatePage,
  restorePage,
  cancelPageTranslation,
  onProgress,
  getPageTranslatedNodes,
} from "./page-engine.js";

const API_URL = process.env.TMT_API_URL;

// ── State ─────────────────────────────────────────────────────────────────────
let tooltip       = null;
let langPicker    = null;
let pagePanel     = null;
let selectionTimeout = null;
let isPageTranslating = false;

const translatedNodes = []; // inline (selection) undo stack

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectLanguage(text) {
  return /[\u0900-\u097F]/.test(text) ? "ne" : "en";
}
function langName(code) {
  return { en: "English", ne: "Nepali", tmg: "Tamang" }[code] || code;
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastEl = null, toastTimer = null;
function showToast(msg, duration = 2500) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "tmt-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("tmt-toast-visible");
  clearTimeout(toastTimer);
  if (duration > 0) toastTimer = setTimeout(() => toastEl?.classList.remove("tmt-toast-visible"), duration);
}

// ── Inline translation (selection) ────────────────────────────────────────────
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

  toastEl?.classList.remove("tmt-toast-visible");

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
    wrapper.setAttribute("data-original", selectedText);
    wrapper.setAttribute("data-translated", response.output);
    wrapper.setAttribute("data-src", src_lang);
    wrapper.setAttribute("data-tgt", tgt_lang);
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

// ── PAGE TRANSLATE PANEL ──────────────────────────────────────────────────────
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
      <!-- Language selector -->
      <div class="tmt-pp-lang-row" id="tmt-pp-setup">
        <div class="tmt-pp-lang-group">
          <span class="tmt-pp-lang-label">Translate page to</span>
          <div class="tmt-pp-lang-btns">
            <button class="tmt-pp-lang-btn active" data-lang="ne">🇳🇵 Nepali</button>
            <button class="tmt-pp-lang-btn" data-lang="en">🇬🇧 English</button>
            <button class="tmt-pp-lang-btn" data-lang="tmg">🏔 Tamang</button>
          </div>
        </div>
        <div class="tmt-pp-features">
          <div class="tmt-pp-feature">
            <span class="tmt-pp-feature-dot tmt-dot-skip"></span>
            Skips code blocks &amp; pre tags
          </div>
          <div class="tmt-pp-feature">
            <span class="tmt-pp-feature-dot tmt-dot-keep"></span>
            Keeps names, URLs &amp; tech terms
          </div>
          <div class="tmt-pp-feature">
            <span class="tmt-pp-feature-dot tmt-dot-smart"></span>
            Skips nav, footer, sidebar
          </div>
        </div>
        <button class="tmt-pp-go" id="tmt-pp-go">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
          </svg>
          Translate Page
        </button>
      </div>

      <!-- Progress view (hidden by default) -->
      <div class="tmt-pp-progress" id="tmt-pp-progress" style="display:none">
        <div class="tmt-pp-status-row">
          <span id="tmt-pp-status-text">Starting…</span>
          <span id="tmt-pp-count">0 / 0</span>
        </div>
        <div class="tmt-pp-bar-track">
          <div class="tmt-pp-bar-fill" id="tmt-pp-bar"></div>
        </div>
        <div class="tmt-pp-progress-actions">
          <button class="tmt-pp-cancel" id="tmt-pp-cancel">Cancel</button>
        </div>
      </div>

      <!-- Done view (hidden by default) -->
      <div class="tmt-pp-done" id="tmt-pp-done" style="display:none">
        <div class="tmt-pp-done-row">
          <div class="tmt-pp-done-icon">✓</div>
          <div class="tmt-pp-done-info">
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

    <!-- Collapse toggle -->
    <button class="tmt-pp-collapse" id="tmt-pp-collapse" title="Minimise">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M19 9l-7 7-7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  `;
  document.body.appendChild(el);

  let selectedLang = "ne";
  let collapsed = false;

  // Lang buttons
  el.querySelectorAll(".tmt-pp-lang-btn").forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-pp-lang-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLang = btn.dataset.lang;
    };
  });

  // Collapse
  document.getElementById("tmt-pp-collapse").onclick = () => {
    collapsed = !collapsed;
    el.classList.toggle("tmt-pp-collapsed", collapsed);
    const icon = document.querySelector("#tmt-pp-collapse svg path");
    if (icon) icon.setAttribute("d", collapsed
      ? "M5 15l7-7 7 7"
      : "M19 9l-7 7-7-7");
  };

  // Close
  document.getElementById("tmt-pp-close").onclick = () => {
    if (isPageTranslating) { cancelPageTranslation(); isPageTranslating = false; }
    el.classList.remove("tmt-pp-visible");
    setTimeout(() => { el.style.display = "none"; }, 200);
  };

  // Go button
  document.getElementById("tmt-pp-go").onclick = () => startPageTranslate(selectedLang);

  // Cancel
  document.getElementById("tmt-pp-cancel").onclick = () => {
    cancelPageTranslation();
    isPageTranslating = false;
    switchPanelView("setup");
    showToast("Translation cancelled.");
  };

  // Restore
  document.getElementById("tmt-pp-restore").onclick = () => {
    const count = restorePage();
    deTranslateAll(); // also clear inline ones
    switchPanelView("setup");
    showToast(`↩ Restored ${count} element${count !== 1 ? "s" : ""}`);
  };

  // Again
  document.getElementById("tmt-pp-again").onclick = () => {
    restorePage();
    switchPanelView("setup");
  };

  return el;
}

function switchPanelView(view) {
  document.getElementById("tmt-pp-setup")   .style.display = view === "setup"    ? "flex"  : "none";
  document.getElementById("tmt-pp-progress").style.display = view === "progress"  ? "block" : "none";
  document.getElementById("tmt-pp-done")    .style.display = view === "done"      ? "block" : "none";
}

function showPagePanel() {
  if (!pagePanel) pagePanel = createPagePanel();
  pagePanel.style.display = "block";
  pagePanel.classList.remove("tmt-pp-collapsed");
  requestAnimationFrame(() => pagePanel.classList.add("tmt-pp-visible"));
}

async function startPageTranslate(tgt_lang) {
  if (isPageTranslating) return;

  const { apiKey } = await new Promise(r => chrome.storage.sync.get("apiKey", r));
  if (!apiKey) {
    showToast("⚠ No API key — open Settings first.", 3500);
    return;
  }

  isPageTranslating = true;
  switchPanelView("progress");

  const statusText = document.getElementById("tmt-pp-status-text");
  const countEl    = document.getElementById("tmt-pp-count");
  const bar        = document.getElementById("tmt-pp-bar");

  onProgress(({ status, done, total, message }) => {
    if (status === "start") {
      statusText.textContent = `Translating to ${langName(tgt_lang)}…`;
      countEl.textContent = `0 / ${total}`;
      bar.style.width = "0%";
    } else if (status === "progress") {
      const pct = Math.round((done / total) * 100);
      bar.style.width = pct + "%";
      countEl.textContent = `${done} / ${total}`;
      statusText.textContent = `Translating… ${pct}%`;
    } else if (status === "done") {
      isPageTranslating = false;
      switchPanelView("done");
      document.getElementById("tmt-pp-done-title").textContent =
        `Page translated to ${langName(tgt_lang)}`;
      document.getElementById("tmt-pp-done-sub").textContent =
        `${done} text nodes translated · code & names preserved`;
    } else if (status === "cancelled") {
      isPageTranslating = false;
    } else if (status === "error") {
      isPageTranslating = false;
      switchPanelView("setup");
      showToast("⚠ " + (message || "Page translation failed"), 4000);
    }
  });

  try {
    await translatePage(tgt_lang, apiKey);
  } catch (err) {
    isPageTranslating = false;
    switchPanelView("setup");
    showToast("⚠ " + err.message, 4000);
  }
}

// ── Language picker (Alt+T) ───────────────────────────────────────────────────
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
  if (top + 210 > window.innerHeight + window.scrollY) top = y - 210;

  langPicker.style.left = left + "px";
  langPicker.style.top  = top + "px";

  requestAnimationFrame(() => langPicker.classList.add("tmt-picker-visible"));

  langPicker.querySelectorAll(".tmt-pick-btn").forEach(btn => {
    btn.onclick = async () => {
      const tgt = btn.dataset.lang;
      hideLangPicker(); hideTooltip();
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
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

// ── Tooltip card (hover preview) ──────────────────────────────────────────────
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
        <select id="tmt-src"><option value="en">English</option><option value="ne">Nepali</option><option value="tmg">Tamang</option></select>
        <button id="tmt-swap">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <select id="tmt-tgt"><option value="ne">Nepali</option><option value="en">English</option><option value="tmg">Tamang</option></select>
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
let _tgtLangForReplace = "ne";

function showTooltip(x, y, text, savedRange) {
  if (!tooltip) tooltip = createTooltip();
  _savedRangeForTooltip = savedRange || null;

  const srcSelect  = tooltip.querySelector("#tmt-src");
  const tgtSelect  = tooltip.querySelector("#tmt-tgt");
  const sourceEl   = tooltip.querySelector("#tmt-source-text");
  const outputEl   = tooltip.querySelector("#tmt-output");
  const copyBtn    = tooltip.querySelector("#tmt-copy");
  const replaceBtn = tooltip.querySelector("#tmt-replace");
  const closeBtn   = tooltip.querySelector("#tmt-close");
  const swapBtn    = tooltip.querySelector("#tmt-swap");

  const detected = detectLanguage(text);
  srcSelect.value = detected;
  tgtSelect.value = detected === "en" ? "ne" : "en";
  _tgtLangForReplace = tgtSelect.value;

  sourceEl.textContent = text.length > 120 ? text.slice(0, 120) + "…" : text;
  outputEl.innerHTML = '<div class="tmt-spinner"></div>';
  copyBtn.style.display = "none";
  replaceBtn.style.display = "none";

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
  runTooltipTranslate(text, srcSelect.value, tgtSelect.value);

  const retranslate = () => {
    if (srcSelect.value === tgtSelect.value) tgtSelect.value = srcSelect.value === "en" ? "ne" : "en";
    _tgtLangForReplace = tgtSelect.value;
    outputEl.innerHTML = '<div class="tmt-spinner"></div>';
    copyBtn.style.display = "none"; replaceBtn.style.display = "none";
    runTooltipTranslate(text, srcSelect.value, tgtSelect.value);
  };

  srcSelect.onchange = retranslate;
  tgtSelect.onchange = () => { _tgtLangForReplace = tgtSelect.value; retranslate(); };
  swapBtn.onclick = () => { [srcSelect.value, tgtSelect.value] = [tgtSelect.value, srcSelect.value]; _tgtLangForReplace = tgtSelect.value; retranslate(); };
  closeBtn.onclick = hideTooltip;

  copyBtn.onclick = () => {
    const result = outputEl.querySelector(".tmt-result");
    if (!result) return;
    navigator.clipboard.writeText(result.textContent).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`; }, 1500);
    });
  };

  replaceBtn.onclick = async () => {
    hideTooltip();
    if (_savedRangeForTooltip) {
      const sel = window.getSelection(); sel.removeAllRanges();
      try { sel.addRange(_savedRangeForTooltip); } catch {}
    }
    await translateInline(window.getSelection(), _tgtLangForReplace);
  };
}

function runTooltipTranslate(text, src_lang, tgt_lang) {
  const outputEl  = tooltip?.querySelector("#tmt-output");
  const copyBtn   = tooltip?.querySelector("#tmt-copy");
  const replaceBtn= tooltip?.querySelector("#tmt-replace");

  chrome.runtime.sendMessage({ type: "TRANSLATE", text, src_lang, tgt_lang }, (res) => {
    if (!outputEl) return;
    if (res?.success) {
      outputEl.innerHTML = `<div class="tmt-result">${escapeHtml(res.output)}</div>`;
      copyBtn && (copyBtn.style.display = "flex");
      replaceBtn && (replaceBtn.style.display = "flex");
    } else if (res?.error === "NO_API_KEY") {
      outputEl.innerHTML = `<div class="tmt-error">⚠ No API key. <a href="#" id="tmt-open-options">Configure →</a></div>`;
      document.getElementById("tmt-open-options")?.addEventListener("click", e => {
        e.preventDefault(); chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      });
    } else {
      outputEl.innerHTML = `<div class="tmt-error">⚠ ${escapeHtml(res?.error || "Translation failed")}</div>`;
    }
  });
}

function hideTooltip() {
  if (tooltip) {
    tooltip.classList.remove("tmt-visible");
    setTimeout(() => { tooltip && (tooltip.style.display = "none"); }, 200);
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideTooltip(); hideLangPicker(); return; }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    const sel = window.getSelection(), text = sel?.toString().trim();
    if (!text || text.length < 2) { showToast("✋ Select text first, then press Alt+T"); return; }
    let savedRange = null;
    try { savedRange = sel.getRangeAt(0).cloneRange(); } catch {}
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    hideTooltip();
    showLangPicker(rect.left + window.scrollX, rect.bottom + window.scrollY, savedRange);
    return;
  }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault(); hideLangPicker(); hideTooltip(); deTranslateLast(); return;
  }

  if (e.altKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault(); hideLangPicker(); hideTooltip(); deTranslateAll(); return;
  }

  // Alt+P — open page translate panel
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault(); showPagePanel(); return;
  }
});

// ── Mouse selection → tooltip ─────────────────────────────────────────────────
document.addEventListener("mouseup", (e) => {
  if (tooltip?.contains(e.target) || langPicker?.contains(e.target) || pagePanel?.contains(e.target)) return;
  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const sel = window.getSelection(), text = sel?.toString().trim();
    if (text && text.length > 1 && text.length < 1000) {
      if (langPicker?.classList.contains("tmt-picker-visible")) return;
      const range = sel.getRangeAt(0), rect = range.getBoundingClientRect();
      let savedRange = null;
      try { savedRange = range.cloneRange(); } catch {}
      showTooltip(rect.left + window.scrollX, rect.bottom + window.scrollY, text, savedRange);
    } else if (!text) { hideTooltip(); hideLangPicker(); }
  }, 350);
});

document.addEventListener("mousedown", (e) => {
  if (langPicker?.classList.contains("tmt-picker-visible") && !langPicker.contains(e.target)) hideLangPicker();
});

// ── Messages from background ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSLATE_SELECTION" || msg.type === "KEYBOARD_TRANSLATE") {
    const sel = window.getSelection(), text = msg.text || sel?.toString().trim();
    if (text) {
      const range = sel?.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range ? range.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 100 };
      let savedRange = null;
      try { if (range) savedRange = range.cloneRange(); } catch {}
      showTooltip(rect.left + window.scrollX, rect.bottom + window.scrollY, text, savedRange);
    }
  }
  if (msg.type === "OPEN_PAGE_PANEL")   showPagePanel();
  if (msg.type === "DETRANSLATE_LAST")  deTranslateLast();
  if (msg.type === "DETRANSLATE_ALL")   deTranslateAll();
});
