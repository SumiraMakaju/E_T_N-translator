//  EXTENSION CONTEXT GUARD 
function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function safeSendMessage(payload, cb) {
  if (!isExtensionAlive()) return;
  try {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) { return; }
      cb && cb(res);
    });
  } catch { }
}

//  SHARED STATE 
let tooltip           = null;
let langPicker        = null;
let pagePanel         = null;
let selectionTimeout  = null;
let isPageTranslating = false;
const translatedNodes = [];

//  HELPERS 
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

// GMAIL DETECTION 
const IS_GMAIL = location.hostname === "mail.google.com";

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
  if (duration > 0)
    _toastTimer = setTimeout(
      () => _toastEl?.classList.remove("tmt-toast-visible"), duration
    );
}
function hideToast() { _toastEl?.classList.remove("tmt-toast-visible"); }
// 🔊 VOICE / PRONUNCIATION ENGINE

const ACCENTS = {
  "US English":     { lang: "en-US", voiceHint: ["US", "United States"] },
  "UK English":     { lang: "en-GB", voiceHint: ["UK", "United Kingdom", "British"] },
  "Nepali English": { lang: "ne-NP", voiceHint: ["Nepali", "Nepal"] },
};

let _currentAccent = "US English";
let _speechSynth   = window.speechSynthesis;
let _voiceCache    = null;

function getVoices() {
  if (_voiceCache && _voiceCache.length > 0) return _voiceCache;
  _voiceCache = _speechSynth?.getVoices() || [];
  return _voiceCache;
}

function pickVoice(accentKey) {
  const cfg    = ACCENTS[accentKey];
  const voices = getVoices();
  if (!voices.length) return null;
  for (const hint of cfg.voiceHint) {
    const v = voices.find(
      v => v.lang.startsWith(cfg.lang.split("-")[0]) && v.name.includes(hint)
    );
    if (v) return v;
  }
  const byLang = voices.find(v => v.lang === cfg.lang);
  if (byLang) return byLang;
  const langPrefix = cfg.lang.split("-")[0];
  return voices.find(v => v.lang.startsWith(langPrefix)) || null;
}

if (_speechSynth) {
  _speechSynth.addEventListener("voiceschanged", () => { _voiceCache = null; });
}

let _activeSpeech = null;

function speakText(text, accentKey = _currentAccent) {
  if (!_speechSynth) { showToast("🔇 Speech not supported in this browser."); return; }
  _speechSynth.cancel();
  
  const utter = new SpeechSynthesisUtterance(text);
  const isDevanagari = /[\u0900-\u097F]/.test(text);
  let voice = null;

  if (isDevanagari) {
    // For Nepali/Tamang, look for a Nepali or Hindi voice (Hindi reads Devanagari script perfectly)
    const voices = getVoices();
    voice = voices.find(v => v.lang.startsWith("ne")) || voices.find(v => v.lang.startsWith("hi"));
    utter.lang = voice ? voice.lang : "hi-IN"; // Fallback to Hindi locale
    
    if (!voice && voices.length > 0) {
      showToast("⚠ No Nepali/Hindi voice pack installed on your OS.", 3500);
    }
  } else {
    // English text
    const cfg = ACCENTS[accentKey] || ACCENTS["US English"];
    utter.lang = cfg.lang;
    voice = pickVoice(accentKey);
  }

  utter.rate  = 0.92;
  utter.pitch = 1.0;
  if (voice) utter.voice = voice;
  
  utter.onstart = () => { _activeSpeech = utter; };
  utter.onend   = () => { _activeSpeech = null;  };
  utter.onerror = (e) => {
    _activeSpeech = null;
    if (e.error !== "interrupted" && e.error !== "canceled") {
      showToast("🔇 Speech error: " + e.error, 2500);
    }
  };
  _speechSynth.speak(utter);
  _activeSpeech = utter;
}

function stopSpeech() { _speechSynth?.cancel(); _activeSpeech = null; }
function isSpeaking() { return _speechSynth?.speaking ?? false; }

function buildAccentSelector(onChange) {
  const row = document.createElement("div");
  row.className = "tmt-accent-row";
  Object.keys(ACCENTS).forEach(label => {
    const btn = document.createElement("button");
    btn.className = "tmt-accent-btn" + (label === _currentAccent ? " active" : "");
    btn.textContent = label;
    btn.title = `Speak with ${label} pronunciation`;
    btn.onclick = () => {
      _currentAccent = label;
      row.querySelectorAll(".tmt-accent-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      onChange && onChange(label);
    };
    row.appendChild(btn);
  });
  return row;
}

function buildSpeakButton(getText) {
  const btn = document.createElement("button");
  btn.className = "tmt-speak-btn";
  btn.title     = "Hear pronunciation";
  btn.innerHTML = speakerSVG() + " Speak";
  let playing = false;
  btn.onclick = () => {
    if (playing) {
      stopSpeech(); playing = false;
      btn.innerHTML = speakerSVG() + " Speak";
      btn.classList.remove("tmt-speak-active");
      return;
    }
    const text = getText();
    if (!text) return;
    playing = true;
    btn.innerHTML = pauseSVG() + " Stop";
    btn.classList.add("tmt-speak-active");
    speakText(text, _currentAccent);
    const poll = setInterval(() => {
      if (!isSpeaking()) {
        clearInterval(poll); playing = false;
        btn.innerHTML = speakerSVG() + " Speak";
        btn.classList.remove("tmt-speak-active");
      }
    }, 300);
  };
  return btn;
}

function speakerSVG() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}
function pauseSVG() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>
  </svg>`;
}


const SKIP_TAGS = new Set([
  "SCRIPT","STYLE","NOSCRIPT","CODE","PRE","KBD","SAMP","VAR",
  "MATH","SVG","CANVAS","VIDEO","AUDIO","IFRAME","OBJECT","EMBED",
  "HEAD","META","LINK","TEMPLATE","SLOT","TMT-INLINE",
]);
const SKIP_ROLES   = new Set(["navigation","banner","contentinfo","search","complementary"]);

// Gmail uses obfuscated class names, so broad class-based skipping kills
// most of the page. We limit class/id skipping to clearly non-content nodes.
const SKIP_CLASSES = IS_GMAIL
  ? /\b(ad|ads|cookie|captcha|code|hljs)\b/i           // minimal for Gmail
  : /\b(nav|navbar|sidebar|footer|header|breadcrumb|menu|ad|ads|cookie|captcha|code|hljs)\b/i;

const SKIP_IDS = IS_GMAIL
  ? /\b(cookie|ad)\b/i                                  // minimal for Gmail
  : /\b(nav|sidebar|footer|header|menu|cookie|ad)\b/i;

function shouldSkipNode(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (SKIP_TAGS.has(el.tagName))                                    return true;
  if (el.getAttribute("translate") === "no")                        return true;
  if (el.getAttribute("contenteditable") === "true")                return true;
  if (SKIP_ROLES.has(el.getAttribute("role")))                      return true;
  if (el.className && typeof el.className === "string"
      && SKIP_CLASSES.test(el.className))                           return true;
  if (el.id && SKIP_IDS.test(el.id))                               return true;
  return false;
}

// Instead of walking all of document.body (which includes the entire Gmail
// chrome), we target only opened message bodies and the inbox list.
function getTranslationRoot() {
  if (!IS_GMAIL) return document.body;

  // Open email reading pane Gmail's message body lives here
  const msgBody = document.querySelector(
    ".a3s.aiL, .gs .ii.gt, [data-message-id] .a3s"
  );
  if (msgBody) return msgBody;

  // Inbox/list view subject lines and snippet text
  const inbox = document.querySelector(".AO, .BltHke");
  if (inbox) return inbox;

  return document.body;
}

function collectTextNodes(root) {
  const nodes  = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const txt = node.textContent.trim();
      if (!txt || txt.length < 3) return NodeFilter.FILTER_REJECT;
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
    if (len + t.length > 400 && current.length) {
      batches.push(current); current = []; len = 0;
    }
    current.push(node);
    len += t.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function callTranslateAPI(text, src_lang, tgt_lang) {
  return new Promise((resolve, reject) => {
    if (!isExtensionAlive()) { reject(new Error("Extension context invalidated")); return; }
    safeSendMessage({ type: "TRANSLATE", text, src_lang, tgt_lang }, (res) => {
      if (!res) { reject(new Error("No response from background")); return; }
      if (res.success) resolve(res.output);
      else reject(new Error(res.error === "NO_API_KEY" ? "NO_API_KEY" : res.error || "API error"));
    });
  });
}

let _progressCb      = null;
let _cancelRequested = false;
const _pageNodes     = [];

function setProgressCallback(cb) { _progressCb = cb; }
function cancelPageTranslation()  { _cancelRequested = true; }

async function translatePage(tgt_lang, apiKey) {
  _cancelRequested = false;
  _pageNodes.length = 0;

  const root = getTranslationRoot();

  const sample   = root.innerText?.slice(0, 200) || "";
  const src_lang = detectLanguage(sample);

  if (src_lang === tgt_lang) {
    _progressCb?.({ status: "error", message: `Page already in ${langName(tgt_lang)}.` });
    return;
  }

  const nodes = collectTextNodes(root);
  if (!nodes.length) {
    _progressCb?.({ status: "error", message: "No translatable text found." });
    return;
  }

  const batches = batchNodes(nodes);
  let done = 0, total = nodes.length;
  _progressCb?.({ status: "start", total, done: 0 });

  for (const batch of batches) {
    if (_cancelRequested || !isExtensionAlive()) {
      _progressCb?.({ status: "cancelled", done, total }); return;
    }

    for (const node of batch) {
      if (_cancelRequested || !isExtensionAlive()) break;
      if (!document.contains(node)) { done++; continue; }

      const originalText = node.textContent;
      try {
        const translated = await callTranslateAPI(originalText.trim(), src_lang, tgt_lang);
        if (!translated || translated === originalText.trim()) {
          done++;
          _progressCb?.({ status: "progress", done, total });
          continue;
        }

  
        // A plain <span> with a data attribute survives intact.
        const wrapper = IS_GMAIL
          ? document.createElement("span")
          : document.createElement("tmt-inline");

        wrapper.setAttribute("data-original",   originalText);
        wrapper.setAttribute("data-translated", translated);
        wrapper.setAttribute("data-src",        src_lang);
        wrapper.setAttribute("data-tgt",        tgt_lang);
        wrapper.setAttribute("data-tmt-page",   "true");   // renamed to avoid Gmail stripping
        wrapper.className = "tmt-translated tmt-page-translated";
        wrapper.title     = `Original: ${originalText.slice(0, 80)}`;
        wrapper.textContent = translated;

        node.parentNode?.replaceChild(wrapper, node);
        _pageNodes.push(wrapper);
      } catch (err) {
        if (err.message === "NO_API_KEY") {
          _cancelRequested = true;
          _progressCb?.({ status: "error", message: "No API key open Settings." });
          return;
        }
        if (err.message.includes("context invalidated")) {
          _cancelRequested = true;
          _progressCb?.({ status: "cancelled", done, total });
          return;
        }
      }

      done++;
      _progressCb?.({ status: "progress", done, total });
      await new Promise(r => setTimeout(r, 80));
    }
  }

  _progressCb?.({ status: "done", done, total });
}

function restorePageTranslation() {

  const all = document.querySelectorAll(
    "tmt-inline[data-tmt-page], span[data-tmt-page], tmt-inline[data-page]"
  );
  all.forEach(w => w.replaceWith(document.createTextNode(w.getAttribute("data-original"))));
  _pageNodes.length = 0;
  return all.length;
}


let _gmailObserver = null;
let _lastGmailMsgId = null;

function startGmailObserver() {
  if (!IS_GMAIL || _gmailObserver) return;

  _gmailObserver = new MutationObserver(() => {
    // Detect when a new message body appears
    const msgEl = document.querySelector("[data-message-id]");
    const msgId = msgEl?.getAttribute("data-message-id");

    if (msgId && msgId !== _lastGmailMsgId) {
      _lastGmailMsgId = msgId;
      // Show a toast nudge so user knows they can translate the new email
      if (pagePanel?.classList.contains("tmt-pp-visible")) {
        showToast("new email opened press Translate Page to translate it.", 3500);
        // Reset panel back to setup view so user can retranslate
        restorePageTranslation();
        switchView("setup");
      }
    }
  });

  _gmailObserver.observe(document.body, { childList: true, subtree: true });
}

// Start observer immediately on Gmail
startGmailObserver();

// INLINE TRANSLATION (selection replace)

async function translateInline(selection, tgt_lang) {
  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length < 2) return;

  const src_lang = detectLanguage(selectedText);
  if (src_lang === tgt_lang) { showToast(`Already in ${langName(tgt_lang)}!`); return; }

  let savedRange;
  try { savedRange = selection.getRangeAt(0).cloneRange(); } catch { return; }

  showToast("Translating…", 0);

  const response = await new Promise(r =>
    safeSendMessage({ type: "TRANSLATE", text: selectedText, src_lang, tgt_lang }, r)
  );
  hideToast();

  if (!response?.success) {
    showToast("⚠ " + (response?.error === "NO_API_KEY"
      ? "No API key: open Settings."
      : (response?.error || "Translation failed")), 3500);
    return;
  }

  try {
    const scrollY = window.scrollY;
    const sel2 = window.getSelection();
    sel2.removeAllRanges();
    sel2.addRange(savedRange);
    const range = sel2.getRangeAt(0);

    // Use <span> on Gmail, <tmt-inline> elsewhere
    const wrapper = IS_GMAIL
      ? document.createElement("span")
      : document.createElement("tmt-inline");

    wrapper.setAttribute("data-original",   selectedText);
    wrapper.setAttribute("data-translated", response.output);
    wrapper.setAttribute("data-src",        src_lang);
    wrapper.setAttribute("data-tgt",        tgt_lang);
    wrapper.setAttribute("data-tmt-inline", "true");
    wrapper.className = "tmt-translated";
    wrapper.title     = `Original: ${selectedText} | Alt+Z to restore`;
    wrapper.style.whiteSpace = "pre-wrap"; // Preserve newlines
    wrapper.textContent = response.output;

    const originalFragment = range.extractContents();
    wrapper._tmtOriginalFragment = originalFragment;
    range.insertNode(wrapper);
    sel2.removeAllRanges();
    window.scrollTo(0, scrollY);

    translatedNodes.push(wrapper);
    showToast(`✓ Translated to ${langName(tgt_lang)}  Alt+Z to undo`);
  } catch {
    showToast("⚠ Could not replace text here.", 3000);
  }
}

function deTranslateLast() {
  while (translatedNodes.length && !document.contains(translatedNodes.at(-1))) translatedNodes.pop();
  if (!translatedNodes.length) { showToast("Nothing to restore."); return; }
  const w = translatedNodes.pop();
  if (w._tmtOriginalFragment) {
    w.replaceWith(w._tmtOriginalFragment);
  } else {
    w.replaceWith(document.createTextNode(w.getAttribute("data-original")));
  }
  showToast("↩ Restored original text");
}

function deTranslateAll() {

  const all = document.querySelectorAll(
    "tmt-inline[data-tmt-inline], span[data-tmt-inline]"
  );
  if (!all.length) { showToast("No inline translations to restore."); return; }
  all.forEach(w => {
    if (w._tmtOriginalFragment) {
      w.replaceWith(w._tmtOriginalFragment);
    } else {
      w.replaceWith(document.createTextNode(w.getAttribute("data-original")));
    }
  });
  translatedNodes.length = 0;
  showToast(`↩ Restored ${all.length} translation${all.length !== 1 ? "s" : ""}`);
}

// TOOLTIP  with voice playback


function createTooltip() {
  const el = document.createElement("div");
  el.id = "tmt-tooltip";
  el.innerHTML = `
    <div class="tmt-header">
      <div class="tmt-logo">
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

    <div class="tmt-source-wrap">
      <div id="tmt-source-text" class="tmt-source"></div>
      <button id="tmt-speak-src" class="tmt-speak-icon" title="Hear original">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          <path d="M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div id="tmt-output" class="tmt-output"><div class="tmt-spinner"></div></div>

    <div id="tmt-accent-wrap" class="tmt-accent-wrap" style="display:none"></div>

    <div class="tmt-actions">
      <div class="tmt-action-left">
        <button id="tmt-speak-out" class="tmt-btn-speak" style="display:none">
          ${speakerSVG()}  Speak
        </button>
        <button id="tmt-replace" class="tmt-btn-replace" style="display:none">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          Replace
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
let _currentSourceText    = "";

function showTooltipEl(x, y, text, savedRange) {
  if (!tooltip) tooltip = createTooltip();
  _savedRangeForTooltip = savedRange || null;
  _currentSourceText    = text;

  const srcSel     = tooltip.querySelector("#tmt-src");
  const tgtSel     = tooltip.querySelector("#tmt-tgt");
  const srcEl      = tooltip.querySelector("#tmt-source-text");
  const outEl      = tooltip.querySelector("#tmt-output");
  const copyBtn    = tooltip.querySelector("#tmt-copy");
  const repBtn     = tooltip.querySelector("#tmt-replace");
  const speakOut   = tooltip.querySelector("#tmt-speak-out");
  const speakSrc   = tooltip.querySelector("#tmt-speak-src");
  const accentWrap = tooltip.querySelector("#tmt-accent-wrap");
  const closeBtn   = tooltip.querySelector("#tmt-close");
  const swapBtn    = tooltip.querySelector("#tmt-swap");

  const detected = detectLanguage(text);
  srcSel.value = detected;
  tgtSel.value = detected === "en" ? "ne" : "en";
  _tgtLangForReplace = tgtSel.value;

  srcEl.textContent = text.length > 120 ? text.slice(0, 120) + "…" : text;
  outEl.innerHTML   = '<div class="tmt-spinner"></div>';
  copyBtn.style.display    = "none";
  repBtn.style.display     = "none";
  speakOut.style.display   = "none";
  accentWrap.style.display = "none";
  accentWrap.innerHTML     = "";

  speakSrc.onclick = () => speakText(text, _currentAccent);

  tooltip.style.display = "block";
  tooltip.classList.remove("tmt-visible");

  const vw = window.innerWidth;
  let left = x, top = y + 16;
  if (left + 310 > vw) left = vw - 318;
  if (left < 8) left = 8;
  if (top + 270 > window.innerHeight + window.scrollY) top = y - 280;

  tooltip.style.left = left + "px";
  tooltip.style.top  = top + "px";

  requestAnimationFrame(() => tooltip.classList.add("tmt-visible"));
  runTooltipTranslate(text, srcSel.value, tgtSel.value);

  const retranslate = () => {
    if (srcSel.value === tgtSel.value) tgtSel.value = srcSel.value === "en" ? "ne" : "en";
    _tgtLangForReplace = tgtSel.value;
    outEl.innerHTML          = '<div class="tmt-spinner"></div>';
    copyBtn.style.display    = "none";
    repBtn.style.display     = "none";
    speakOut.style.display   = "none";
    accentWrap.style.display = "none";
    accentWrap.innerHTML     = "";
    runTooltipTranslate(text, srcSel.value, tgtSel.value);
  };

  srcSel.onchange = retranslate;
  tgtSel.onchange = () => { _tgtLangForReplace = tgtSel.value; retranslate(); };
  swapBtn.onclick = () => {
    [srcSel.value, tgtSel.value] = [tgtSel.value, srcSel.value];
    _tgtLangForReplace = tgtSel.value;
    retranslate();
  };
  closeBtn.onclick = () => { stopSpeech(); hideTooltipEl(); };

  copyBtn.onclick = () => {
    const r = outEl.querySelector(".tmt-result");
    if (!r) return;
    navigator.clipboard.writeText(r.textContent).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
        </svg> Copy`;
      }, 1500);
    });
  };

  repBtn.onclick = async () => {
    stopSpeech(); hideTooltipEl();
    if (_savedRangeForTooltip) {
      const sel = window.getSelection(); sel.removeAllRanges();
      try { sel.addRange(_savedRangeForTooltip); } catch {}
    }
    await translateInline(window.getSelection(), _tgtLangForReplace);
  };

  speakOut.onclick = () => {
    const r = outEl.querySelector(".tmt-result");
    if (!r) return;
    if (isSpeaking()) {
      stopSpeech();
      speakOut.innerHTML = speakerSVG() + " 🔊 Speak";
      speakOut.classList.remove("tmt-speak-active");
    } else {
      speakText(r.textContent, _currentAccent);
      speakOut.innerHTML = pauseSVG() + " Stop";
      speakOut.classList.add("tmt-speak-active");
      const poll = setInterval(() => {
        if (!isSpeaking()) {
          clearInterval(poll);
          speakOut.innerHTML = speakerSVG() + " 🔊 Speak";
          speakOut.classList.remove("tmt-speak-active");
        }
      }, 300);
    }
  };
}

function runTooltipTranslate(text, src_lang, tgt_lang) {
  const outEl      = tooltip?.querySelector("#tmt-output");
  const copyBtn    = tooltip?.querySelector("#tmt-copy");
  const repBtn     = tooltip?.querySelector("#tmt-replace");
  const speakOut   = tooltip?.querySelector("#tmt-speak-out");
  const accentWrap = tooltip?.querySelector("#tmt-accent-wrap");

  safeSendMessage({ type: "TRANSLATE", text, src_lang, tgt_lang }, (res) => {
    if (!outEl) return;
    if (res?.success) {
      outEl.innerHTML = `<div class="tmt-result">${escapeHtml(res.output)}</div>`;
      if (copyBtn)  copyBtn.style.display  = "flex";
      if (repBtn)   repBtn.style.display   = "flex";
      if (speakOut) speakOut.style.display = "flex";
      if (accentWrap) {
        accentWrap.innerHTML = "";
        accentWrap.appendChild(buildAccentSelector(null));
        accentWrap.style.display = "block";
      }
    } else if (res?.error === "NO_API_KEY") {
      outEl.innerHTML = `<div class="tmt-error">⚠ No API key. <a href="#" id="tmt-open-opts">Configure →</a></div>`;
      document.getElementById("tmt-open-opts")?.addEventListener("click", e => {
        e.preventDefault();
        safeSendMessage({ type: "OPEN_OPTIONS" });
      });
    } else {
      outEl.innerHTML = `<div class="tmt-error">⚠ ${escapeHtml(res?.error || "Translation failed")}</div>`;
    }
  });
}

function hideTooltipEl() {
  if (tooltip) {
    tooltip.classList.remove("tmt-visible");
    setTimeout(() => { if (tooltip) tooltip.style.display = "none"; }, 200);
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
        const sel = window.getSelection();
        sel.removeAllRanges();
        try { sel.addRange(savedRange); } catch {}
      }
      await translateInline(window.getSelection(), tgt);
    };
  });

  const restoreBtn = document.getElementById("tmt-restore-all");
  if (restoreBtn) restoreBtn.onclick = () => { hideLangPicker(); deTranslateAll(); };
}

function hideLangPicker() {
  if (langPicker) {
    langPicker.classList.remove("tmt-picker-visible");
    setTimeout(() => { if (langPicker) langPicker.style.display = "none"; }, 180);
  }
}

// PAGE TRANSLATE PANEL

function createPagePanel() {
  const el = document.createElement("div");
  const iconUrl = chrome.runtime.getURL("icons/icon16.png");
  el.id = "tmt-page-panel";
  el.innerHTML = `
    <div class="tmt-pp-header">
      <div class="tmt-pp-brand">
       <img src="${iconUrl}" alt="icon" width="35" height="35" /> 
        Smart Page Translate${IS_GMAIL ? " · Gmail Mode" : ""}
      </div>
      <button class="tmt-pp-close" id="tmt-pp-close">✕</button>
    </div>
    <div class="tmt-pp-body">
      <div id="tmt-pp-setup" style="display:flex;flex-direction:column;gap:14px">
        ${IS_GMAIL ? `<div class="tmt-pp-gmail-hint">📧 Opens the current email for translation. Open an email first, then click Translate.</div>` : ""}
        <div class="tmt-pp-lang-group">
          <span class="tmt-pp-lang-label">Translate to</span>
          <div class="tmt-pp-lang-btns">
            <button class="tmt-pp-lang-btn active" data-lang="ne">🇳🇵 Nepali</button>
            <button class="tmt-pp-lang-btn" data-lang="en">🇬🇧 English</button>
            <button class="tmt-pp-lang-btn" data-lang="tmg">🏔 Tamang</button>
          </div>
        </div>
        <div class="tmt-pp-features">
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-skip"></span>Skips code, scripts, nav, footer</div>
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-keep"></span>Preserves emails, URLs, brand names</div>
          <div class="tmt-pp-feature"><span class="tmt-pp-feature-dot tmt-dot-smart"></span>🔊 Voice playback on translated text</div>
        </div>
        <button class="tmt-pp-go" id="tmt-pp-go">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
          </svg>
          Translate${IS_GMAIL ? " Email" : " Page"}
        </button>
      </div>

      <div id="tmt-pp-progress" style="display:none">
        <div class="tmt-pp-status-row">
          <span id="tmt-pp-status-text">Starting…</span>
          <span id="tmt-pp-count" style="font-family:monospace;font-size:11px;color:#475569">0 / 0</span>
        </div>
        <div class="tmt-pp-bar-track">
          <div class="tmt-pp-bar-fill" id="tmt-pp-bar"></div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="tmt-pp-cancel" id="tmt-pp-cancel">Cancel</button>
        </div>
      </div>

      <div id="tmt-pp-done" style="display:none">
        <div class="tmt-pp-done-row">
          <div class="tmt-pp-done-icon">✓</div>
          <div>
            <div class="tmt-pp-done-title" id="tmt-pp-done-title">Translated</div>
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

  document.getElementById("tmt-pp-go").onclick    = () => startPageTranslate(selectedLang);
  document.getElementById("tmt-pp-cancel").onclick = () => {
    cancelPageTranslation(); isPageTranslating = false;
    switchView("setup"); showToast("Translation cancelled.");
  };
  document.getElementById("tmt-pp-restore").onclick = () => {
    const n = restorePageTranslation();
    switchView("setup");
    showToast(`↩ Restored ${n} element${n !== 1 ? "s" : ""}`);
  };
  document.getElementById("tmt-pp-again").onclick = () => {
    restorePageTranslation(); switchView("setup");
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


  if (IS_GMAIL && !document.querySelector(".a3s.aiL, .gs .ii.gt, [data-message-id] .a3s")) {
    showToast("📧 Please open an email first, then click Translate Email.", 4000);
    return;
  }

  const result = await new Promise(r => chrome.storage.sync.get("apiKey", r));
  const apiKey = result.apiKey;
  if (!apiKey) {
    showToast("⚠ No API key: click the TMT icon → Settings.", 4000); return;
  }

  isPageTranslating = true;
  switchView("progress");

  const statusEl = document.getElementById("tmt-pp-status-text");
  const countEl  = document.getElementById("tmt-pp-count");
  const barEl    = document.getElementById("tmt-pp-bar");

  setProgressCallback(({ status, done, total, message }) => {
    if (status === "start") {
      if (statusEl) statusEl.textContent = `Translating to ${langName(tgt_lang)}…`;
      if (countEl)  countEl.textContent  = `0 / ${total}`;
      if (barEl)    barEl.style.width    = "0%";
    } else if (status === "progress") {
      const pct = total ? Math.round((done / total) * 100) : 0;
      if (barEl)    barEl.style.width    = pct + "%";
      if (countEl)  countEl.textContent  = `${done} / ${total}`;
      if (statusEl) statusEl.textContent = `Translating… ${pct}%`;
    } else if (status === "done") {
      isPageTranslating = false;
      switchView("done");
      const t = document.getElementById("tmt-pp-done-title");
      const s = document.getElementById("tmt-pp-done-sub");
      if (t) t.textContent = `✓ Translated to ${langName(tgt_lang)}`;
      if (s) s.textContent = `${done} text blocks · code & names preserved`;
    } else if (status === "cancelled") {
      isPageTranslating = false;
    } else if (status === "error") {
      isPageTranslating = false;
      switchView("setup");
      showToast("⚠ " + (message || "Translation failed"), 4000);
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

// KEYBOARD SHORTCUTS

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideTooltipEl(); hideLangPicker(); stopSpeech(); return; }

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
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 1 && text.length < 1000) {
      if (langPicker?.classList.contains("tmt-picker-visible")) return;
      const range = sel.getRangeAt(0), rect = range.getBoundingClientRect();
      let sr = null; try { sr = range.cloneRange(); } catch {}
      showTooltipEl(rect.left + window.scrollX, rect.bottom + window.scrollY, text, sr);
    } else if (!text) {
      hideTooltipEl(); hideLangPicker();
    }
  }, 350);
});

document.addEventListener("mousedown", (e) => {
  if (langPicker?.classList.contains("tmt-picker-visible") && !langPicker.contains(e.target))
    hideLangPicker();
});

// MESSAGES FROM BACKGROUND

chrome.runtime.onMessage.addListener((msg) => {
  if (!isExtensionAlive()) return;

  if (msg.type === "TRANSLATE_SELECTION" || msg.type === "KEYBOARD_TRANSLATE") {
    const sel = window.getSelection(), text = msg.text || sel?.toString().trim();
    if (text) {
      const range = sel?.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect  = range
        ? range.getBoundingClientRect()
        : { left: window.innerWidth / 2, bottom: 100 };
      let sr = null; try { if (range) sr = range.cloneRange(); } catch {}
      showTooltipEl(rect.left + window.scrollX, rect.bottom + window.scrollY, text, sr);
    }
  }
  if (msg.type === "OPEN_PAGE_PANEL")  showPagePanel();
  if (msg.type === "DETRANSLATE_LAST") deTranslateLast();
  if (msg.type === "DETRANSLATE_ALL")  deTranslateAll();
});