
const TMT_SUBTITLE_ID = "tmt-subtitle-overlay";
const TMT_PANEL_ID    = "tmt-video-panel";
const CHUNK_MS        = 6000;

//  Context guard 
function isAlive() { try { return !!chrome.runtime?.id; } catch { return false; } }
function safeSend(msg, cb) {
  if (!isAlive()) return;
  try {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return;
      cb?.(res);
    });
  } catch {}
}

const isYouTube = () => location.hostname.includes("youtube.com");
const LANG_NAMES = { en: "English", ne: "Nepali", tmg: "Tamang" };

function detectCaptionLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0900-\u097f]/.test(text)) return "ne";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  return "en";
}

//  State 
let activeVideo    = null;
let subtitleEl     = null;
let panelEl        = null;
let isTranslating  = false;
let captureMode    = "idle";
let tgtLang        = "ne";
let whisperLang    = "auto";
let clearTimer     = null;
// SUBTITLE OVERLAY
// Always appended to document.body with position:fixed, calculated to sit
// at the bottom of the video rect. This avoids all overflow/z-index traps.

function ensureSubtitleEl() {
  if (subtitleEl && document.contains(subtitleEl)) return subtitleEl;
  subtitleEl = document.createElement("div");
  subtitleEl.id = TMT_SUBTITLE_ID;
  document.body.appendChild(subtitleEl);
  return subtitleEl;
}

function positionSubtitle() {
  if (!activeVideo || !subtitleEl) return;
  const rect = activeVideo.getBoundingClientRect();
  if (rect.width === 0) return;

  // Sit 10% up from the video bottom, centred horizontally on the video
  const subBottom = window.innerHeight - rect.bottom + rect.height * 0.10;
  subtitleEl.style.bottom = Math.max(8, subBottom) + "px";
  subtitleEl.style.left   = rect.left + "px";
  subtitleEl.style.width  = rect.width + "px";
}

function showSubtitle(text, durationMs = 4500) {
  if (!text?.trim()) return;
  const el = ensureSubtitleEl();
  el.textContent = text.trim();
  positionSubtitle();
  el.classList.add("tmt-sub-visible");
  clearTimeout(clearTimer);
  if (durationMs > 0)
    clearTimer = setTimeout(() => el?.classList.remove("tmt-sub-visible"), durationMs);

  // Also update the "Last subtitle" preview inside the panel
  const prev = document.getElementById("tmt-vp-sub-text");
  const wrap = document.getElementById("tmt-vp-sub-preview");
  if (prev) { prev.textContent = text.trim(); }
  if (wrap) { wrap.style.display = "block"; }
}

function clearSubtitles() {
  subtitleEl?.classList.remove("tmt-sub-visible");
  clearTimeout(clearTimer);
}

function removeSubtitleEl() {
  subtitleEl?.remove();
  subtitleEl = null;
}

// Reposition on scroll/resize so subtitle tracks the video
window.addEventListener("scroll",  () => positionSubtitle(), { passive: true });
window.addEventListener("resize",  () => positionSubtitle(), { passive: true });

// YOUTUBE CAPTION MODE

const cueCache = new Map();
let lastCueText       = "";
let ytCaptionObserver = null;
let ytPollInterval    = null;

// YouTube caption selectors in priority order (YouTube updates their classes)
const YT_CAPTION_SELECTORS = [
  ".ytp-caption-window-container",
  ".ytp-caption-segment",
  ".captions-text",
  "[class^='ytp-caption']",
];

function findYTCaptionContainer() {
  for (const sel of YT_CAPTION_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function startYouTubeMode() {
  captureMode = "youtube";
  setStatus("🎬 Looking for captions… (enable CC if not on)", "info");

  const existing = findYTCaptionContainer();
  if (existing) {
    watchYTCaptions(existing);
    return;
  }

  let attempts = 0;
  ytPollInterval = setInterval(() => {
    attempts++;
    const el = findYTCaptionContainer();
    if (el) {
      clearInterval(ytPollInterval);
      ytPollInterval = null;
      watchYTCaptions(el);
      return;
    }
    if (attempts >= 60) { // 30 seconds
      clearInterval(ytPollInterval);
      ytPollInterval = null;
      setStatus("⚠ No captions found. Enable CC on the video, then click Start again.", "warn");
      isTranslating = false;
      const startBtn = document.getElementById("tmt-vp-start");
      const stopBtn  = document.getElementById("tmt-vp-stop");
      if (startBtn) startBtn.style.display = "flex";
      if (stopBtn)  stopBtn.style.display  = "none";
    }
  }, 500);
}

function watchYTCaptions(container) {
  setStatus("✓ Live captions connected — translating…", "ok");

  // Observe the ENTIRE caption window for any text changes
  ytCaptionObserver = new MutationObserver(() => {
    // Collect text from all caption segments visible right now
    const container2 = findYTCaptionContainer();
    if (!container2) return;

    const allText = container2.innerText?.trim() || container2.textContent?.trim() || "";
    if (!allText || allText === lastCueText) return;
    lastCueText = allText;

    const cacheKey = `${allText}→${tgtLang}`;
    if (cueCache.has(cacheKey)) {
      showSubtitle(cueCache.get(cacheKey));
      return;
    }

    const srcLang = detectCaptionLang(allText);

    // If already in target language, show as-is
    if (srcLang === tgtLang) {
      showSubtitle(allText);
      return;
    }

    safeSend({ type: "TRANSLATE", text: allText, src_lang: srcLang, tgt_lang: tgtLang }, (res) => {
      if (res?.success && res.output) {
        cueCache.set(cacheKey, res.output);
        showSubtitle(res.output);
      }
    });
  });

  // Observe the whole body subtree — YouTube swaps out caption nodes aggressively
  ytCaptionObserver.observe(document.body, {
    childList: true, subtree: true, characterData: true
  });
}

function stopYouTubeMode() {
  ytCaptionObserver?.disconnect();
  ytCaptionObserver = null;
  clearInterval(ytPollInterval);
  ytPollInterval = null;
  cueCache.clear();
  lastCueText = "";
}


// WHISPER STREAMING MODE — general video sites

let mediaRecorder = null;
let audioChunks   = [];
let chunkTimer    = null;

async function startWhisperMode() {
  captureMode = "whisper";
  setStatus("🎙 Requesting tab audio…", "info");

  safeSend({ type: "START_TAB_CAPTURE" }, async (res) => {
    if (!res?.streamId) {
      setStatus("⚠ Tab capture unavailable. Check extension permissions.", "error");
      isTranslating = false;
      resetButtons();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: res.streamId,
          }
        },
        video: false,
      });
      setStatus("🎙 Listening — subtitle every ~6 seconds", "ok");
      startChunkedRecording(stream);
    } catch (err) {
      setStatus("⚠ " + err.message, "error");
      isTranslating = false;
      resetButtons();
    }
  });
}

function startChunkedRecording(stream) {
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    if (!audioChunks.length) return;
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    audioChunks = [];
    sendToWhisper(blob);
  };

  function scheduleChunk() {
    if (captureMode !== "whisper") return;
    if (activeVideo?.paused) { chunkTimer = setTimeout(scheduleChunk, 800); return; }
    if (mediaRecorder.state === "inactive") mediaRecorder.start();
    chunkTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
      scheduleChunk();
    }, CHUNK_MS);
  }
  scheduleChunk();
}

async function sendToWhisper(audioBlob) {
  const arrayBuf = await audioBlob.arrayBuffer();
  const bytes    = Array.from(new Uint8Array(arrayBuf));

  safeSend({
    type:       "WHISPER_TRANSCRIBE",
    audioBytes: bytes,
    mimeType:   "audio/webm",
    language:   whisperLang === "auto" ? undefined : whisperLang,
  }, (res) => {
    if (!res?.success || !res.transcript?.trim()) return;

    const transcript = res.transcript.trim();
    const srcLang    = detectCaptionLang(transcript);

    if (srcLang === tgtLang) {
      showSubtitle(transcript, CHUNK_MS + 500);
      return;
    }

    safeSend(
      { type: "TRANSLATE", text: transcript, src_lang: srcLang, tgt_lang: tgtLang },
      (tRes) => {
        showSubtitle(tRes?.success ? tRes.output : transcript, CHUNK_MS + 500);
      }
    );
  });
}

function stopWhisperMode() {
  clearTimeout(chunkTimer);
  chunkTimer = null;
  if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
  mediaRecorder = null;
  audioChunks   = [];
}

// CONTROL PANEL UI

function setStatus(text, type = "info") {
  const el = document.getElementById("tmt-vp-status");
  if (!el) return;
  el.textContent   = text;
  el.className     = `tmt-vp-status tmt-vp-status-${type}`;
  el.style.display = "block";
}

function resetButtons() {
  const startBtn = document.getElementById("tmt-vp-start");
  const stopBtn  = document.getElementById("tmt-vp-stop");
  if (startBtn) startBtn.style.display = "flex";
  if (stopBtn)  stopBtn.style.display  = "none";
}

function createPanel(video) {
  const el = document.createElement("div");
  el.id = TMT_PANEL_ID;

  const ytMode = isYouTube();

  el.innerHTML = `
    <div class="tmt-vp-header">
      <div class="tmt-vp-brand">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        TMT ${ytMode ? "Caption" : "Audio"} Translate
      </div>
      <div class="tmt-vp-header-right">
        <button class="tmt-vp-min" id="tmt-vp-min" title="Minimise">—</button>
        <button class="tmt-vp-close" id="tmt-vp-close" title="Close">✕</button>
      </div>
    </div>

    <div class="tmt-vp-body" id="tmt-vp-body">

      <div class="tmt-vp-row">
        <span class="tmt-vp-label">Translate to</span>
        <div class="tmt-vp-lang-btns">
          <button class="tmt-vp-lang ${tgtLang==="ne"?"active":""}" data-lang="ne">🇳🇵 Nepali</button>
          <button class="tmt-vp-lang ${tgtLang==="en"?"active":""}" data-lang="en">🇬🇧 English</button>
          <button class="tmt-vp-lang ${tgtLang==="tmg"?"active":""}" data-lang="tmg">🏔 Tamang</button>
        </div>
      </div>

      ${ytMode ? `
        <div class="tmt-vp-info">
          Enable <strong>CC</strong> on the video first, then click Start.
          TMT translates each caption live as it appears.
        </div>
      ` : `
        <div class="tmt-vp-row">
          <span class="tmt-vp-label">Audio lang</span>
          <select id="tmt-whisper-lang" class="tmt-vp-select">
            <option value="auto">Auto-detect</option>
            <option value="en">English</option>
            <option value="ne">Nepali</option>
            <option value="zh">Chinese</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="hi">Hindi</option>
            <option value="ar">Arabic</option>
          </select>
        </div>
        <div class="tmt-vp-info">
          Transcribes audio via Whisper every 6 s, then translates. Requires OpenAI key in Settings.
        </div>
      `}

      <div id="tmt-vp-status" class="tmt-vp-status" style="display:none"></div>

      <div class="tmt-vp-actions">
        <button class="tmt-vp-start" id="tmt-vp-start">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
          </svg>
          Start
        </button>
        <button class="tmt-vp-stop" id="tmt-vp-stop" style="display:none">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/>
          </svg>
          Stop
        </button>
      </div>

      <div class="tmt-vp-sub-preview" id="tmt-vp-sub-preview" style="display:none">
        <div class="tmt-vp-sub-label">Last subtitle</div>
        <div class="tmt-vp-sub-text" id="tmt-vp-sub-text"></div>
      </div>

    </div>
  `;

  document.body.appendChild(el);
  makeDraggable(el);

  // Lang buttons
  el.querySelectorAll(".tmt-vp-lang").forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-vp-lang").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tgtLang = btn.dataset.lang;
      cueCache.clear();
    };
  });

  // Whisper lang select
  el.querySelector("#tmt-whisper-lang")?.addEventListener("change", (e) => {
    whisperLang = e.target.value;
  });

  // Minimise toggle
  let minimised = false;
  document.getElementById("tmt-vp-min").onclick = () => {
    minimised = !minimised;
    const body = document.getElementById("tmt-vp-body");
    if (body) body.style.display = minimised ? "none" : "block";
    el.classList.toggle("tmt-vp-minimised", minimised);
    el.querySelector("#tmt-vp-min").textContent = minimised ? "+" : "—";
  };

  // Close
  document.getElementById("tmt-vp-close").onclick = () => stopAll();

  // Start
  document.getElementById("tmt-vp-start").onclick = () => {
    if (isTranslating) return;
    isTranslating = true;
    document.getElementById("tmt-vp-start").style.display = "none";
    document.getElementById("tmt-vp-stop").style.display  = "flex";

    if (isYouTube()) startYouTubeMode();
    else             startWhisperMode();
  };

  // Stop
  document.getElementById("tmt-vp-stop").onclick = () => {
    stopTranslation();
    resetButtons();
    setStatus("Stopped.", "info");
  };

  return el;
}

function makeDraggable(el) {
  const header = el.querySelector(".tmt-vp-header");
  let ox = 0, oy = 0, sx = 0, sy = 0;
  header.style.cursor = "grab";

  header.onmousedown = (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const rect = el.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    header.style.cursor = "grabbing";

    const onMove = (e) => {
      el.style.left   = Math.max(0, ox + e.clientX - sx) + "px";
      el.style.top    = Math.max(0, oy + e.clientY - sy) + "px";
      el.style.right  = "auto";
      el.style.bottom = "auto";
    };
    const onUp = () => {
      header.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  };
}

// CSS — injected once into the page

function injectVideoCSS() {
  if (document.getElementById("tmt-video-css")) return;
  const style = document.createElement("style");
  style.id = "tmt-video-css";
  style.textContent = `
    #${TMT_SUBTITLE_ID} {
      position: fixed;
      z-index: 2147483645;
      left: 0;
      width: 100%;
      text-align: center;
      pointer-events: none;

      /* default position — overridden per-video by positionSubtitle() */
      bottom: 12%;

      opacity: 0;
      transition: opacity 0.22s ease;
    }
    #${TMT_SUBTITLE_ID}.tmt-sub-visible { opacity: 1; }

    #${TMT_SUBTITLE_ID} span,
    #${TMT_SUBTITLE_ID}::after { display: none; }

    /* The actual text pill */
    #${TMT_SUBTITLE_ID}:not(:empty) {
      /* inner pill — we achieve this by using outline + bg on the element itself */
    }

    /* We render text via textContent, so style the element directly */
    #${TMT_SUBTITLE_ID} {
      display: inline-block;
      /* override: make it a block that centres itself */
      display: flex;
      justify-content: center;
      align-items: flex-end;
    }

    /* Trick: wrap text in a visible pill without extra elements */
    #${TMT_SUBTITLE_ID}::before {
      content: attr(data-text);
    }

    /* ── Real approach: style text directly on the element ── */
    #${TMT_SUBTITLE_ID} {
      font-family: -apple-system, 'Segoe UI', sans-serif;
      font-size: clamp(15px, 2vw, 22px);
      font-weight: 600;
      line-height: 1.45;
      color: #fff;

      /* The pill background lives on a pseudo-child; since we use textContent
         we instead set a text-shadow for legibility + a bg via box-shadow trick */
      text-shadow:
        0 1px 3px rgba(0,0,0,0.9),
        0 0 8px rgba(0,0,0,0.7),
        1px 1px 0 rgba(0,0,0,0.8),
       -1px -1px 0 rgba(0,0,0,0.8),
        1px -1px 0 rgba(0,0,0,0.8),
       -1px  1px 0 rgba(0,0,0,0.8);
    }

    #${TMT_PANEL_ID} {
      position: fixed;
      bottom: 80px;
      right: 20px;
      z-index: 2147483647;
      width: 290px;
      background: #0a0f1e;
      border: 1px solid rgba(56,189,248,0.25);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04);
      font-family: -apple-system,'Segoe UI',sans-serif;
      font-size: 13px;
      color: #e2e8f0;
      overflow: hidden;
      user-select: none;
    }
    #${TMT_PANEL_ID}.tmt-vp-minimised { width: 200px; }

    .tmt-vp-header {
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 13px 9px;
      background:#0f172a;
      border-bottom:1px solid rgba(255,255,255,0.06);
    }
    .tmt-vp-brand {
      display:flex;align-items:center;gap:7px;
      font-size:11px;font-weight:700;letter-spacing:.07em;
      color:#38bdf8;text-transform:uppercase;
    }
    .tmt-vp-header-right { display:flex;gap:4px; }
    .tmt-vp-min,.tmt-vp-close {
      background:transparent;border:none;color:#475569;cursor:pointer;
      font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;
      transition:color .13s;font-family:inherit;
    }
    .tmt-vp-min:hover,.tmt-vp-close:hover { color:#94a3b8; }

    .tmt-vp-body { padding:14px; }

    .tmt-vp-row {
      display:flex;align-items:center;gap:10px;margin-bottom:12px;
    }
    .tmt-vp-label {
      font-size:10px;text-transform:uppercase;letter-spacing:.08em;
      color:#475569;font-weight:600;white-space:nowrap;
      width:68px;flex-shrink:0;
    }
    .tmt-vp-lang-btns { display:flex;gap:5px;flex:1; }
    .tmt-vp-lang {
      flex:1;background:#1e293b;border:1px solid rgba(255,255,255,0.07);
      border-radius:7px;color:#64748b;font-size:11px;font-weight:500;
      padding:5px 2px;cursor:pointer;font-family:inherit;
      transition:all .13s;text-align:center;
    }
    .tmt-vp-lang:hover { border-color:rgba(56,189,248,0.2);color:#94a3b8; }
    .tmt-vp-lang.active {
      background:rgba(56,189,248,0.12);border-color:rgba(56,189,248,0.4);color:#38bdf8;
    }
    .tmt-vp-select {
      flex:1;background:#1e293b;color:#e2e8f0;
      border:1px solid rgba(255,255,255,0.08);border-radius:6px;
      padding:5px 8px;font-size:12px;outline:none;cursor:pointer;
    }
    .tmt-vp-info {
      font-size:11px;color:#475569;background:#0f172a;border-radius:7px;
      padding:8px 10px;margin-bottom:12px;line-height:1.55;
      border:1px solid rgba(255,255,255,0.05);
    }
    .tmt-vp-info strong { color:#64748b; }
    .tmt-vp-status {
      font-size:12px;padding:7px 10px;border-radius:7px;
      margin-bottom:10px;line-height:1.4;
    }
    .tmt-vp-status-info  {background:rgba(56,189,248,.08);color:#38bdf8;border:1px solid rgba(56,189,248,.2);}
    .tmt-vp-status-ok    {background:rgba(74,222,128,.08);color:#4ade80;border:1px solid rgba(74,222,128,.2);}
    .tmt-vp-status-warn  {background:rgba(250,204,21,.08);color:#facc15;border:1px solid rgba(250,204,21,.2);}
    .tmt-vp-status-error {background:rgba(248,113,113,.08);color:#f87171;border:1px solid rgba(248,113,113,.2);}

    .tmt-vp-actions { display:flex;gap:8px;margin-bottom:10px; }
    .tmt-vp-start,.tmt-vp-stop {
      flex:1;display:flex;align-items:center;justify-content:center;gap:6px;
      border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;
      cursor:pointer;font-family:inherit;transition:opacity .15s;
    }
    .tmt-vp-start {background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#0a0f1e;}
    .tmt-vp-stop  {background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.25);}
    .tmt-vp-start:hover,.tmt-vp-stop:hover { opacity:.85; }

    .tmt-vp-sub-preview {
      background:#0f172a;border:1px solid rgba(255,255,255,0.06);
      border-radius:7px;overflow:hidden;
    }
    .tmt-vp-sub-label {
      font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#334155;
      padding:5px 10px;border-bottom:1px solid rgba(255,255,255,0.04);
    }
    .tmt-vp-sub-text {
      padding:8px 10px;font-size:12px;color:#94a3b8;line-height:1.5;min-height:34px;
    }
  `;
  document.head.appendChild(style);
}

// SUBTITLE RENDERING — use a pill span so the background clips to text width

// Override showSubtitle to use a real pill (span with background)
const _showSubtitleBase = showSubtitle;

// Patch: render text inside a <span> pill for clean background
function renderSubtitle(text, durationMs) {
  if (!text?.trim()) return;
  const el = ensureSubtitleEl();

  // Replace innerHTML with a styled span
  el.innerHTML = `<span class="tmt-sub-pill">${text.trim()}</span>`;

  // Inject pill style if not present
  if (!document.getElementById("tmt-pill-css")) {
    const s = document.createElement("style");
    s.id = "tmt-pill-css";
    s.textContent = `
      .tmt-sub-pill {
        display: inline-block;
        background: rgba(0,0,0,0.82);
        color: #fff;
        font-family: -apple-system,'Segoe UI',sans-serif;
        font-size: clamp(15px, 2vw, 22px);
        font-weight: 600;
        line-height: 1.45;
        padding: 5px 16px 6px;
        border-radius: 6px;
        max-width: 80vw;
        text-align: center;
        word-break: break-word;
      }
    `;
    document.head.appendChild(s);
  }

  positionSubtitle();
  el.classList.add("tmt-sub-visible");
  clearTimeout(clearTimer);
  if (durationMs > 0)
    clearTimer = setTimeout(() => el?.classList.remove("tmt-sub-visible"), durationMs);

  // Update panel preview
  const prev = document.getElementById("tmt-vp-sub-text");
  const wrap = document.getElementById("tmt-vp-sub-preview");
  if (prev) prev.textContent = text.trim();
  if (wrap) wrap.style.display = "block";
}


function stopTranslation() {
  isTranslating = false;
  if (captureMode === "youtube") stopYouTubeMode();
  if (captureMode === "whisper") stopWhisperMode();
  captureMode = "idle";
  clearSubtitles();
}

function stopAll() {
  stopTranslation();
  removeSubtitleEl();
  panelEl?.remove();
  panelEl = null;
  activeVideo = null;
}

function findMainVideo() {
  const all = [...document.querySelectorAll("video")]
    .filter(v => v.offsetWidth > 80 && v.offsetHeight > 50);
  if (!all.length) return null;
  return all.sort(
    (a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight)
  )[0];
}

function attachToVideo(video) {
  if (panelEl && document.contains(panelEl)) return;
  activeVideo = video;
  injectVideoCSS();
  panelEl = createPanel(video);
  ensureSubtitleEl(); // create now so positionSubtitle works immediately
  positionSubtitle();
}

//  Override showSubtitle globally to use pill renderer 
// All internal callers (YouTube + Whisper) call showSubtitle()
function showSubtitle(text, durationMs = 4500) {
  renderSubtitle(text, durationMs);
}

//  Messages 
chrome.runtime.onMessage.addListener((msg) => {
  if (!isAlive()) return;

  if (msg.type === "OPEN_VIDEO_PANEL") {
    const video = findMainVideo();
    if (!video) {
      // Show a toast-style message instead of alert
      const t = document.createElement("div");
      t.style.cssText = `
        position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        background:#0f172a;border:1px solid rgba(248,113,113,0.3);
        color:#f87171;border-radius:20px;padding:9px 18px;font-size:13px;
        font-family:-apple-system,sans-serif;z-index:2147483647;
        box-shadow:0 4px 20px rgba(0,0,0,0.4);
      `;
      t.textContent = "⚠ TMT: No video found on this page.";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
      return;
    }
    attachToVideo(video);
  }
});

//  Auto-attach on YouTube 
if (isYouTube()) {
  const tryAttach = () => {
    if (panelEl && document.contains(panelEl)) return;
    const v = findMainVideo();
    if (v) attachToVideo(v);
  };

  // YouTube is a SPA — watch for navigation
  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      // Page navigated — reset panel if it was for a different video
      if (panelEl) { stopAll(); }
      setTimeout(tryAttach, 1500);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // Initial attach
  if (document.readyState === "complete") tryAttach();
  else window.addEventListener("load", () => setTimeout(tryAttach, 1000));
  setTimeout(tryAttach, 2500); // extra fallback
}