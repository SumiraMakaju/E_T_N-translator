let tooltip = null;
let langPicker = null;
let selectionTimeout = null;

// Stack of <tmt-inline> wrappers for undo
const translatedNodes = [];

function detectLanguage(text) {
  const devanagari = /[\u0900-\u097F]/;
  return devanagari.test(text) ? "ne" : "en";
}

function langName(code) {
  return { en: "English", ne: "Nepali", tmg: "Tamang" }[code] || code;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let toastEl = null;
let toastTimer = null;

function showToast(msg, duration = 2000) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "tmt-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("tmt-toast-visible");
  clearTimeout(toastTimer);
  if (duration > 0) toastTimer = setTimeout(dismissToast, duration);
}

function dismissToast() {
  if (toastEl) toastEl.classList.remove("tmt-toast-visible");
}

async function translateInline(selection, tgt_lang) {
  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length < 2) return;

  const src_lang = detectLanguage(selectedText);
  if (src_lang === tgt_lang) {
    showToast(`Already in ${langName(tgt_lang)}!`, 2000);
    return;
  }

  let savedRange;
  try { savedRange = selection.getRangeAt(0).cloneRange(); } catch(e) { return; }

  showToast("Translating…", 0);

  const response = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "TRANSLATE", text: selectedText, src_lang, tgt_lang }, resolve)
  );

  dismissToast();

  if (!response || !response.success) {
    const err = response?.error === "NO_API_KEY"
      ? "No API key — click the TMT icon to configure."
      : (response?.error || "Translation failed");
    showToast("⚠ " + err, 3500);
    return;
  }

  const translatedText = response.output;

  try {
    const scrollY = window.scrollY;

    // Re-apply the saved range
    const sel2 = window.getSelection();
    sel2.removeAllRanges();
    sel2.addRange(savedRange);
    const range = sel2.getRangeAt(0);

    // Create the inline wrapper element
    const wrapper = document.createElement("tmt-inline");
    wrapper.setAttribute("data-original", selectedText);
    wrapper.setAttribute("data-translated", translatedText);
    wrapper.setAttribute("data-src", src_lang);
    wrapper.setAttribute("data-tgt", tgt_lang);
    wrapper.className = "tmt-translated";
    wrapper.title = `Original: ${selectedText} | Alt+Z to restore`;
    wrapper.textContent = translatedText;

    range.deleteContents();
    range.insertNode(wrapper);

    sel2.removeAllRanges();
    window.scrollTo(0, scrollY);

    translatedNodes.push(wrapper);
    showToast(`✓ Translated to ${langName(tgt_lang)} — Alt+Z to undo`, 2800);
  } catch (e) {
    showToast("⚠ Could not replace text here.", 3000);
  }
}

function deTranslateLast() {
  // Remove stale entries (elements removed from DOM)
  while (translatedNodes.length && !document.contains(translatedNodes[translatedNodes.length - 1])) {
    translatedNodes.pop();
  }

  if (!translatedNodes.length) {
    showToast("Nothing to restore.", 2000);
    return;
  }

  const wrapper = translatedNodes.pop();
  const original = wrapper.getAttribute("data-original");
  wrapper.replaceWith(document.createTextNode(original));
  showToast("↩ Restored original text", 2000);
}

function deTranslateAll() {
  const all = document.querySelectorAll("tmt-inline");
  if (!all.length) {
    showToast("No translated text on this page.", 2000);
    return;
  }
  all.forEach(w => w.replaceWith(document.createTextNode(w.getAttribute("data-original"))));
  translatedNodes.length = 0;
  showToast(`↩ Restored ${all.length} translation${all.length > 1 ? "s" : ""}`, 2500);
}

function createLangPicker() {
  const el = document.createElement("div");
  el.id = "tmt-lang-picker";
  el.innerHTML = `
    <div class="tmt-picker-header">
      <div class="tmt-picker-logo">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Translate to…
      </div>
      <span class="tmt-picker-hint">Alt+Z to undo</span>
    </div>
    <div class="tmt-picker-options">
      <button class="tmt-pick-btn" data-lang="en">
        <span class="tmt-pick-flag">🇬🇧</span>
        <div class="tmt-pick-text">
          <span class="tmt-pick-name">English</span>
          <span class="tmt-pick-code">en</span>
        </div>
      </button>
      <button class="tmt-pick-btn" data-lang="ne">
        <span class="tmt-pick-flag">🇳🇵</span>
        <div class="tmt-pick-text">
          <span class="tmt-pick-name">Nepali</span>
          <span class="tmt-pick-code">ne</span>
        </div>
      </button>
      <button class="tmt-pick-btn" data-lang="tmg">
        <span class="tmt-pick-flag">🏔</span>
        <div class="tmt-pick-text">
          <span class="tmt-pick-name">Tamang</span>
          <span class="tmt-pick-code">tmg</span>
        </div>
      </button>
    </div>
    <div class="tmt-picker-footer">
      <button id="tmt-restore-all" class="tmt-restore-btn">↩ Restore all on page</button>
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
  if (top + 200 > window.innerHeight + window.scrollY) top = y - 200;

  langPicker.style.left = left + "px";
  langPicker.style.top  = top + "px";

  requestAnimationFrame(() => langPicker.classList.add("tmt-picker-visible"));

  langPicker.querySelectorAll(".tmt-pick-btn").forEach(btn => {
    btn.onclick = async () => {
      const tgt = btn.getAttribute("data-lang");
      hideLangPicker();
      hideTooltip();

      // Restore the selection from the saved range
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        try { sel.addRange(savedRange); } catch(e) {}
      }
      await translateInline(window.getSelection(), tgt);
    };
  });

  const restoreAllBtn = document.getElementById("tmt-restore-all");
  if (restoreAllBtn) {
    restoreAllBtn.onclick = () => { hideLangPicker(); deTranslateAll(); };
  }
}

function hideLangPicker() {
  if (langPicker) {
    langPicker.classList.remove("tmt-picker-visible");
    setTimeout(() => { if (langPicker) langPicker.style.display = "none"; }, 180);
  }
}

function createTooltip() {
  const el = document.createElement("div");
  el.id = "tmt-tooltip";
  el.innerHTML = `
    <div class="tmt-header">
      <div class="tmt-logo">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
        <button id="tmt-replace" class="tmt-btn-replace">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          Replace on page
        </button>
        <button id="tmt-copy" class="tmt-btn-secondary">
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
    copyBtn.style.display = "none";
    replaceBtn.style.display = "none";
    runTooltipTranslate(text, srcSelect.value, tgtSelect.value);
  };

  srcSelect.onchange = retranslate;
  tgtSelect.onchange = () => { _tgtLangForReplace = tgtSelect.value; retranslate(); };

  swapBtn.onclick = () => {
    const tmp = srcSelect.value;
    srcSelect.value = tgtSelect.value;
    tgtSelect.value = tmp;
    _tgtLangForReplace = tgtSelect.value;
    retranslate();
  };

  closeBtn.onclick = hideTooltip;

  copyBtn.onclick = () => {
    const result = outputEl.querySelector(".tmt-result");
    if (!result) return;
    navigator.clipboard.writeText(result.textContent).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`;
      }, 1500);
    });
  };

  replaceBtn.onclick = async () => {
    hideTooltip();
    if (_savedRangeForTooltip) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      try { sel.addRange(_savedRangeForTooltip); } catch(e) {}
    }
    await translateInline(window.getSelection(), _tgtLangForReplace);
  };
}

function runTooltipTranslate(text, src_lang, tgt_lang) {
  const outputEl  = tooltip?.querySelector("#tmt-output");
  const copyBtn   = tooltip?.querySelector("#tmt-copy");
  const replaceBtn= tooltip?.querySelector("#tmt-replace");

  chrome.runtime.sendMessage({ type: "TRANSLATE", text, src_lang, tgt_lang }, (response) => {
    if (!outputEl) return;
    if (response?.success) {
      outputEl.innerHTML = `<div class="tmt-result">${escapeHtml(response.output)}</div>`;
      if (copyBtn) copyBtn.style.display = "flex";
      if (replaceBtn) replaceBtn.style.display = "flex";
    } else if (response?.error === "NO_API_KEY") {
      outputEl.innerHTML = `<div class="tmt-error">⚠ No API key. <a href="#" id="tmt-open-options">Configure →</a></div>`;
      document.getElementById("tmt-open-options")?.addEventListener("click", e => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      });
    } else {
      outputEl.innerHTML = `<div class="tmt-error">⚠ ${escapeHtml(response?.error || "Translation failed")}</div>`;
    }
  });
}

function hideTooltip() {
  if (tooltip) {
    tooltip.classList.remove("tmt-visible");
    setTimeout(() => { if (tooltip) tooltip.style.display = "none"; }, 200);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideTooltip();
    hideLangPicker();
    return;
  }

  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      showToast("✋ Select some text first, then press Alt+T", 2500);
      return;
    }
    let savedRange = null;
    try { savedRange = sel.getRangeAt(0).cloneRange(); } catch(e) {}
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    hideTooltip();
    showLangPicker(rect.left + window.scrollX, rect.bottom + window.scrollY, savedRange);
    return;
  }

  // Alt+Z  undo last translation
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    hideLangPicker();
    hideTooltip();
    deTranslateLast();
    return;
  }

  // Alt+Shift+Z  undo ALL translations
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    hideLangPicker();
    hideTooltip();
    deTranslateAll();
    return;
  }
});

document.addEventListener("mouseup", (e) => {
  if (tooltip?.contains(e.target) || langPicker?.contains(e.target)) return;

  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const sel  = window.getSelection();
    const text = sel?.toString().trim();

    if (text && text.length > 1 && text.length < 1000) {
      if (langPicker?.classList.contains("tmt-picker-visible")) return;

      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      let savedRange = null;
      try { savedRange = range.cloneRange(); } catch(err) {}

      showTooltip(rect.left + window.scrollX, rect.bottom + window.scrollY, text, savedRange);
    } else if (!text) {
      hideTooltip();
      hideLangPicker();
    }
  }, 350);
});

document.addEventListener("mousedown", (e) => {
  if (langPicker?.classList.contains("tmt-picker-visible") && !langPicker.contains(e.target)) {
    hideLangPicker();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TRANSLATE_SELECTION" || message.type === "KEYBOARD_TRANSLATE") {
    const sel  = window.getSelection();
    const text = message.text || sel?.toString().trim();
    if (text) {
      const range = sel?.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect  = range ? range.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 100 };
      let savedRange = null;
      try { if (range) savedRange = range.cloneRange(); } catch(e) {}
      showTooltip(rect.left + window.scrollX, rect.bottom + window.scrollY, text, savedRange);
    }
  }
  if (message.type === "DETRANSLATE_LAST") deTranslateLast();
  if (message.type === "DETRANSLATE_ALL")  deTranslateAll();
});
