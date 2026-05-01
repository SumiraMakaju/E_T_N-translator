// ═══════════════════════════════════════════════════════════════════════════
// TMT Video Engine v3 — works on every website
//
// Caption cascade (tried in order, falls back if unavailable):
//   1. HTML5 <track> / TextTrack API  — standard, works on most sites
//   2. DOM caption scraping            — YouTube, Vimeo, custom players
//   3. Whisper audio capture           — last resort, no captions at all
//
// Subtitles: position:fixed on body — no z-index/overflow trap
// ═══════════════════════════════════════════════════════════════════════════

const TMT_SUBTITLE_ID = "tmt-subtitle-overlay";
const TMT_PANEL_ID    = "tmt-video-panel";
const CHUNK_MS        = 6000; // Whisper chunk size in ms

// ── Context guard ─────────────────────────────────────────────────────────────
function isAlive() { try { return !!chrome.runtime?.id; } catch { return false; } }

function safeSend(msg, cb) {
  if (!isAlive()) return;
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return;
      cb?.(res);
    });
  } catch {}
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0900-\u097f]/.test(text)) return "ne";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  return "en";
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeVideo   = null;
let subtitleEl    = null;
let panelEl       = null;
let isTranslating = false;
let captureMode   = "idle"; // "idle" | "track" | "dom" | "whisper"
let tgtLang       = "ne";
let whisperLang   = "auto";
let clearTimer    = null;
let modeLabel     = "Auto";

// ── Translation cache ─────────────────────────────────────────────────────────
const cueCache  = new Map();
let lastCueText = "";

// ═══════════════════════════════════════════════════════════════════════════
// SUBTITLE OVERLAY  — position:fixed, body-level, tracks video via rAF
// ═══════════════════════════════════════════════════════════════════════════

function ensureSubtitleEl() {
  if (subtitleEl && document.contains(subtitleEl)) return subtitleEl;
  subtitleEl = document.createElement("div");
  subtitleEl.id = TMT_SUBTITLE_ID;

  // Inject pill CSS once
  if (!document.getElementById("tmt-sub-css")) {
    const s = document.createElement("style");
    s.id = "tmt-sub-css";
    s.textContent = `
      #${TMT_SUBTITLE_ID} {
        position: fixed;
        left: 0; right: 0;
        bottom: 12%;
        z-index: 2147483645;
        display: flex;
        justify-content: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      #${TMT_SUBTITLE_ID}.tmt-sub-visible { opacity: 1; }
      #${TMT_SUBTITLE_ID} .pill {
        display: inline-block;
        max-width: 82vw;
        background: rgba(0,0,0,0.85);
        color: #fff;
        font-family: -apple-system,'Segoe UI',sans-serif;
        font-size: clamp(14px, 1.8vw, 21px);
        font-weight: 600;
        line-height: 1.45;
        padding: 5px 18px 7px;
        border-radius: 6px;
        text-align: center;
        word-break: break-word;
      }
      /* Mode badge in corner of subtitle */
      #${TMT_SUBTITLE_ID} .mode-badge {
        position: fixed;
        font-size: 10px;
        background: rgba(56,189,248,0.15);
        color: #38bdf8;
        border: 1px solid rgba(56,189,248,0.2);
        border-radius: 4px;
        padding: 1px 5px;
        font-family: -apple-system,sans-serif;
        pointer-events: none;
        right: 8px;
        opacity: 0;
        transition: opacity 0.2s;
      }
      #${TMT_SUBTITLE_ID}.tmt-sub-visible .mode-badge { opacity: 1; }
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(subtitleEl);
  return subtitleEl;
}

function positionSubtitle() {
  if (!activeVideo || !subtitleEl) return;
  const rect = activeVideo.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // Align to video rect — 10% up from video bottom
  const bottomOffset = window.innerHeight - rect.bottom + rect.height * 0.10;
  subtitleEl.style.bottom = Math.max(8, bottomOffset) + "px";
  subtitleEl.style.left   = rect.left + "px";
  subtitleEl.style.right  = "auto";
  subtitleEl.style.width  = rect.width + "px";
}

window.addEventListener("scroll", () => positionSubtitle(), { passive: true });
window.addEventListener("resize", () => positionSubtitle(), { passive: true });

function showSubtitle(text, durationMs = 4500, mode = captureMode) {
  if (!text?.trim()) return;

  const el = ensureSubtitleEl();
  el.innerHTML = `
    <span class="pill">${escHtml(text.trim())}</span>
    <span class="mode-badge">${modeLabel}</span>
  `;

  positionSubtitle();
  el.classList.add("tmt-sub-visible");
  clearTimeout(clearTimer);
  if (durationMs > 0)
    clearTimer = setTimeout(() => el?.classList.remove("tmt-sub-visible"), durationMs);

  // Update panel preview
  const pText = document.getElementById("tmt-vp-sub-text");
  const pWrap = document.getElementById("tmt-vp-sub-preview");
  if (pText) pText.textContent = text.trim();
  if (pWrap) pWrap.style.display = "block";
}

function clearSubtitles() {
  clearTimeout(clearTimer);
  subtitleEl?.classList.remove("tmt-sub-visible");
}

function removeSubtitleEl() {
  subtitleEl?.remove();
  subtitleEl = null;
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Translate a caption string and show it ────────────────────────────────────
function translateAndShow(rawText, durationMs = 4500) {
  const text = rawText.trim();
  if (!text || text === lastCueText) return;
  lastCueText = text;

  const key = `${text}|${tgtLang}`;
  if (cueCache.has(key)) { showSubtitle(cueCache.get(key), durationMs); return; }

  const srcLang = detectLang(text);

  // Already in target language — show original
  if (srcLang === tgtLang) { showSubtitle(text, durationMs); return; }

  safeSend({ type: "TRANSLATE", text, src_lang: srcLang, tgt_lang: tgtLang }, (res) => {
    if (res?.success && res.output) {
      cueCache.set(key, res.output);
      showSubtitle(res.output, durationMs);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// METHOD 1 — HTML5 TextTrack API
// Works on: Netflix (with inject), Vimeo, Dailymotion, HTML5 video with
// <track> elements, most modern video players that use native captions.
// ═══════════════════════════════════════════════════════════════════════════

let trackCueListener  = null;
let trackPollInterval = null;

function tryTrackAPI(video) {
  // Look for an active/showing text track
  const tracks = Array.from(video.textTracks || []);

  // Prefer English tracks; fall back to any showing track
  const preferred =
    tracks.find(t => t.mode === "showing" && /^en/.test(t.language)) ||
    tracks.find(t => t.mode === "showing") ||
    tracks.find(t => t.mode !== "disabled") ||
    tracks[0];

  if (!preferred) return false;

  // Force it to "hidden" so we get cue events but the native display is suppressed
  // (we render our own overlay instead)
  try {
    preferred.mode = "hidden";
  } catch {}

  modeLabel = "CC→TMT";
  captureMode = "track";

  trackCueListener = () => {
    const cue = preferred.activeCues?.[0];
    if (!cue) return;
    const text = (cue.text || "").replace(/<[^>]+>/g, "").trim();
    if (text) translateAndShow(text, (cue.endTime - cue.startTime) * 1000 || 4500);
  };

  preferred.addEventListener("cuechange", trackCueListener);

  // Also poll activeCues as some browsers don't fire cuechange reliably
  trackPollInterval = setInterval(() => {
    const cue = preferred.activeCues?.[0];
    if (!cue) return;
    const text = (cue.text || "").replace(/<[^>]+>/g, "").trim();
    if (text && text !== lastCueText) translateAndShow(text, 4500);
  }, 500);

  return true;
}

function stopTrackAPI() {
  clearInterval(trackPollInterval);
  trackPollInterval = null;
  // Can't easily remove anonymous cuechange listener — it's stored
  trackCueListener = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// METHOD 2 — DOM Caption Scraping
// Works on: YouTube, Vimeo (DOM captions), Twitch, Disney+, Hotstar,
// any site that renders captions as visible DOM text nodes.
// ═══════════════════════════════════════════════════════════════════════════

// Ordered list of caption container selectors across major platforms
const DOM_CAPTION_SELECTORS = [
  // YouTube
  ".ytp-caption-window-container",
  ".ytp-caption-segment",
  // Vimeo
  ".vp-captions",
  ".captions",
  // Twitch
  "[data-a-target='player-captions-container']",
  // Generic
  ".caption-window",
  ".caption-text",
  ".captions-text",
  ".subtitles",
  ".subtitle-container",
  "[class*='caption']",
  "[class*='subtitle']",
  "[class*='Caption']",
  "[class*='Subtitle']",
];

let domCaptionObserver = null;
let domPollInterval    = null;

function findDOMCaptionContainer() {
  for (const sel of DOM_CAPTION_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent?.trim()) return el;
    } catch {}
  }
  return null;
}

function tryDOMCaption() {
  const container = findDOMCaptionContainer();
  if (!container) return false;

  modeLabel = "DOM→TMT";
  captureMode = "dom";
  watchDOMCaptions(container);
  return true;
}

function watchDOMCaptions(initial) {
  setStatus("✓ Captions found — translating live", "ok");

  domCaptionObserver = new MutationObserver(() => {
    // Re-query each time in case the DOM node was replaced
    const container = findDOMCaptionContainer() || initial;
    const text = container?.innerText?.trim() || container?.textContent?.trim() || "";
    if (text) translateAndShow(text, 4500);
  });

  domCaptionObserver.observe(document.body, {
    childList: true, subtree: true, characterData: true
  });

  // Initial read
  const text = initial?.innerText?.trim() || "";
  if (text) translateAndShow(text, 4500);

  return true;
}

function stopDOMCaption() {
  domCaptionObserver?.disconnect();
  domCaptionObserver = null;
  clearInterval(domPollInterval);
  domPollInterval = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// METHOD 3 — Whisper Audio Capture (last resort)
// Works on: any site, any video, no captions at all
// Requires: OpenAI API key in Settings
// ═══════════════════════════════════════════════════════════════════════════

let mediaRecorder = null;
let audioChunks   = [];
let chunkTimer    = null;

async function startWhisperMode() {
  captureMode = "whisper";
  modeLabel   = "Whisper";
  setStatus("🎙 Requesting tab audio capture…", "info");

  safeSend({ type: "START_TAB_CAPTURE" }, async (res) => {
    if (!res?.streamId) {
      setStatus("⚠ Tab audio capture failed. Check extension permissions.", "error");
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

      setStatus("🎙 Audio capture active — subtitles every ~6 sec", "ok");
      startChunkedRecording(stream);

    } catch (err) {
      setStatus("⚠ " + err.message, "error");
      isTranslating = false;
      resetButtons();
    }
  });
}

function startChunkedRecording(stream) {
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    if (!audioChunks.length) return;
    const blob = new Blob(audioChunks, { type: mimeType });
    audioChunks = [];
    sendChunkToWhisper(blob);
  };

  function scheduleChunk() {
    if (captureMode !== "whisper") return;
    // Pause recording while video is paused to save API calls
    if (activeVideo?.paused) {
      chunkTimer = setTimeout(scheduleChunk, 800);
      return;
    }
    if (mediaRecorder?.state === "inactive") mediaRecorder.start();
    chunkTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
      scheduleChunk();
    }, CHUNK_MS);
  }

  scheduleChunk();
}

async function sendChunkToWhisper(audioBlob) {
  const arrayBuf = await audioBlob.arrayBuffer();
  const bytes    = Array.from(new Uint8Array(arrayBuf));

  safeSend({
    type:       "WHISPER_TRANSCRIBE",
    audioBytes: bytes,
    mimeType:   audioBlob.type,
    language:   whisperLang === "auto" ? undefined : whisperLang,
  }, (res) => {
    if (!res?.success || !res.transcript?.trim()) return;
    translateAndShow(res.transcript.trim(), CHUNK_MS + 1000);
  });
}

function stopWhisperMode() {
  clearTimeout(chunkTimer);
  chunkTimer = null;
  if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
  mediaRecorder = null;
  audioChunks   = [];
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART CASCADE — tries methods in order, falls back automatically
// Order: TextTrack API → DOM scraping → Whisper audio
// ═══════════════════════════════════════════════════════════════════════════

async function startSmartTranslation(video) {
  setStatus("🔍 Detecting captions…", "info");
  await new Promise(r => setTimeout(r, 800)); // let player render

  // ── Step 1: HTML5 TextTrack API ──
  if (video.textTracks?.length > 0) {
    setStatus("📋 Found text tracks — connecting…", "info");
    await new Promise(r => setTimeout(r, 400));
    if (tryTrackAPI(video)) {
      setStatus("✓ Caption track active — translating", "ok");
      updateModeIndicator("📋 Text Track");
      return;
    }
  }

  // ── Step 2: DOM caption scraping ──
  setStatus("🔍 Checking for DOM captions…", "info");
  await new Promise(r => setTimeout(r, 600));

  // Poll briefly for captions to appear (player may not have rendered them yet)
  let domFound = false;
  for (let i = 0; i < 10; i++) {
    if (findDOMCaptionContainer()) { domFound = true; break; }
    await new Promise(r => setTimeout(r, 400));
  }

  if (domFound) {
    if (tryDOMCaption()) {
      updateModeIndicator("🖥 DOM Captions");
      return;
    }
  }

  // ── Step 3: Whisper audio ──
  setStatus("📡 No captions found — switching to audio (Whisper)…", "warn");
  await new Promise(r => setTimeout(r, 800));
  updateModeIndicator("🎙 Whisper Audio");
  await startWhisperMode();
}

function updateModeIndicator(label) {
  const el = document.getElementById("tmt-vp-mode");
  if (el) {
    el.textContent = label;
    el.style.display = "inline-flex";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL PANEL UI
// ═══════════════════════════════════════════════════════════════════════════

function setStatus(text, type = "info") {
  const el = document.getElementById("tmt-vp-status");
  if (!el) return;
  el.textContent   = text;
  el.className     = `tmt-vp-status tmt-vp-status-${type}`;
  el.style.display = "block";
}

function resetButtons() {
  const s = document.getElementById("tmt-vp-start");
  const p = document.getElementById("tmt-vp-stop");
  if (s) s.style.display = "flex";
  if (p) p.style.display = "none";
}

function createPanel() {
  if (document.getElementById(TMT_PANEL_ID)) return document.getElementById(TMT_PANEL_ID);

  const el = document.createElement("div");
  el.id = TMT_PANEL_ID;
  el.innerHTML = `
    <div class="tmt-vp-header">
      <div class="tmt-vp-brand">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        TMT Video Translate
      </div>
      <div class="tmt-vp-header-right">
        <button class="tmt-vp-min" id="tmt-vp-min" title="Minimise">—</button>
        <button class="tmt-vp-close" id="tmt-vp-close">✕</button>
      </div>
    </div>

    <div class="tmt-vp-body" id="tmt-vp-body">

      <!-- Target language -->
      <div class="tmt-vp-row">
        <span class="tmt-vp-label">Translate to</span>
        <div class="tmt-vp-lang-btns">
          <button class="tmt-vp-lang ${tgtLang==="ne"?"active":""}" data-lang="ne">🇳🇵 Nepali</button>
          <button class="tmt-vp-lang ${tgtLang==="en"?"active":""}" data-lang="en">🇬🇧 English</button>
          <button class="tmt-vp-lang ${tgtLang==="tmg"?"active":""}" data-lang="tmg">🏔 Tamang</button>
        </div>
      </div>

      <!-- Whisper fallback lang -->
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
          <option value="ru">Russian</option>
        </select>
      </div>

      <!-- How it works -->
      <div class="tmt-vp-info">
        <strong>Auto mode:</strong> checks for captions first (CC/subtitles), then falls back to
        Whisper audio transcription. Works on YouTube, Vimeo, Netflix, and any video site.
        <br><br>Requires <strong>CC enabled</strong> on the video for best results.
        Whisper requires an OpenAI key in Settings.
      </div>

      <!-- Active mode badge -->
      <div id="tmt-vp-mode" class="tmt-vp-mode-badge" style="display:none">
        🔍 Auto
      </div>

      <!-- Status -->
      <div id="tmt-vp-status" class="tmt-vp-status" style="display:none"></div>

      <!-- Actions -->
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

      <!-- Last subtitle preview -->
      <div class="tmt-vp-sub-preview" id="tmt-vp-sub-preview" style="display:none">
        <div class="tmt-vp-sub-label">Last subtitle</div>
        <div class="tmt-vp-sub-text" id="tmt-vp-sub-text"></div>
      </div>

    </div>
  `;

  document.body.appendChild(el);
  injectPanelCSS();
  makeDraggable(el);

  // Lang buttons
  el.querySelectorAll(".tmt-vp-lang").forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-vp-lang").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tgtLang = btn.dataset.lang;
      cueCache.clear();
      lastCueText = "";
    };
  });

  // Whisper language select
  el.querySelector("#tmt-whisper-lang").onchange = (e) => {
    whisperLang = e.target.value;
  };

  // Minimise
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
  document.getElementById("tmt-vp-start").onclick = async () => {
    if (isTranslating) return;
    if (!activeVideo) {
      activeVideo = findMainVideo();
      if (!activeVideo) { setStatus("⚠ No video detected on this page.", "error"); return; }
    }
    isTranslating = true;
    document.getElementById("tmt-vp-start").style.display = "none";
    document.getElementById("tmt-vp-stop").style.display  = "flex";
    await startSmartTranslation(activeVideo);
  };

  // Stop
  document.getElementById("tmt-vp-stop").onclick = () => {
    stopTranslation();
    resetButtons();
    const modeEl = document.getElementById("tmt-vp-mode");
    if (modeEl) modeEl.style.display = "none";
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

    const move = (e) => {
      el.style.left   = Math.max(0, ox + e.clientX - sx) + "px";
      el.style.top    = Math.max(0, oy + e.clientY - sy) + "px";
      el.style.right  = "auto";
      el.style.bottom = "auto";
    };
    const up = () => {
      header.style.cursor = "grab";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
}

function injectPanelCSS() {
  if (document.getElementById("tmt-panel-css")) return;
  const s = document.createElement("style");
  s.id = "tmt-panel-css";
  s.textContent = `
    #${TMT_PANEL_ID} {
      position: fixed;
      bottom: 80px; right: 20px;
      z-index: 2147483647;
      width: 300px;
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
    .tmt-vp-min, .tmt-vp-close {
      background:transparent;border:none;color:#475569;cursor:pointer;
      font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;
      transition:color .13s;font-family:inherit;
    }
    .tmt-vp-min:hover, .tmt-vp-close:hover { color:#94a3b8; }

    .tmt-vp-body { padding:14px; }

    .tmt-vp-row {
      display:flex;align-items:center;gap:10px;margin-bottom:12px;
    }
    .tmt-vp-label {
      font-size:10px;text-transform:uppercase;letter-spacing:.08em;
      color:#475569;font-weight:600;white-space:nowrap;
      width:62px;flex-shrink:0;
    }
    .tmt-vp-lang-btns { display:flex;gap:5px;flex:1; }
    .tmt-vp-lang {
      flex:1;background:#1e293b;border:1px solid rgba(255,255,255,0.07);
      border-radius:7px;color:#64748b;font-size:10px;font-weight:600;
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
      padding:9px 11px;margin-bottom:12px;line-height:1.6;
      border:1px solid rgba(255,255,255,0.05);
    }
    .tmt-vp-info strong { color:#64748b; }

    .tmt-vp-mode-badge {
      display:inline-flex;align-items:center;gap:5px;
      font-size:11px;font-weight:600;
      background:rgba(56,189,248,0.1);color:#38bdf8;
      border:1px solid rgba(56,189,248,0.2);border-radius:20px;
      padding:3px 10px;margin-bottom:10px;
    }

    .tmt-vp-status {
      font-size:12px;padding:7px 10px;border-radius:7px;
      margin-bottom:10px;line-height:1.45;
    }
    .tmt-vp-status-info  {background:rgba(56,189,248,.08);color:#38bdf8;border:1px solid rgba(56,189,248,.2);}
    .tmt-vp-status-ok    {background:rgba(74,222,128,.08);color:#4ade80;border:1px solid rgba(74,222,128,.2);}
    .tmt-vp-status-warn  {background:rgba(250,204,21,.08);color:#facc15;border:1px solid rgba(250,204,21,.2);}
    .tmt-vp-status-error {background:rgba(248,113,113,.08);color:#f87171;border:1px solid rgba(248,113,113,.2);}

    .tmt-vp-actions { display:flex;gap:8px;margin-bottom:10px; }
    .tmt-vp-start, .tmt-vp-stop {
      flex:1;display:flex;align-items:center;justify-content:center;gap:6px;
      border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;
      cursor:pointer;font-family:inherit;transition:opacity .15s;
    }
    .tmt-vp-start {background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#0a0f1e;}
    .tmt-vp-stop  {background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.2);}
    .tmt-vp-start:hover, .tmt-vp-stop:hover { opacity:.85; }

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
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

function stopTranslation() {
  isTranslating = false;
  stopTrackAPI();
  stopDOMCaption();
  stopWhisperMode();
  captureMode = "idle";
  modeLabel   = "Auto";
  clearSubtitles();
  cueCache.clear();
  lastCueText = "";
}

function stopAll() {
  stopTranslation();
  removeSubtitleEl();
  panelEl?.remove();
  panelEl = null;
  activeVideo = null;
}

function findMainVideo() {
  return [...document.querySelectorAll("video")]
    .filter(v => v.offsetWidth > 80 && v.offsetHeight > 50)
    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
}

function attachToVideo(video) {
  activeVideo = video;
  ensureSubtitleEl();
  positionSubtitle();
  if (!panelEl || !document.contains(panelEl)) {
    panelEl = createPanel();
  }
}

// ── Messages from background / popup ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!isAlive()) return;

  if (msg.type === "OPEN_VIDEO_PANEL") {
    const video = findMainVideo();
    if (!video) {
      const t = document.createElement("div");
      t.style.cssText = `
        position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        background:#0f172a;border:1px solid rgba(248,113,113,.3);color:#f87171;
        border-radius:20px;padding:9px 18px;font-size:13px;
        font-family:-apple-system,sans-serif;z-index:2147483647;
        box-shadow:0 4px 20px rgba(0,0,0,.4);pointer-events:none;
      `;
      t.textContent = "⚠ TMT: No video found on this page.";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
      return;
    }
    attachToVideo(video);
  }
});

// Alt+V keyboard shortcut handled here too
document.addEventListener("keydown", (e) => {
  if (!isAlive()) return;
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
    e.preventDefault();
    const video = findMainVideo();
    if (video) attachToVideo(video);
  }
});

// ── Auto-attach on video sites ────────────────────────────────────────────────
function tryAutoAttach() {
  if (panelEl && document.contains(panelEl)) return;
  const v = findMainVideo();
  if (v) attachToVideo(v);
}

// Watch for videos appearing dynamically (SPAs, lazy loading)
const videoObserver = new MutationObserver(() => {
  if (!panelEl || !document.contains(panelEl)) tryAutoAttach();
});
videoObserver.observe(document.body, { childList: true, subtree: true });

// YouTube SPA navigation
let lastHref = location.href;
const hrefObserver = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    if (panelEl) stopAll();
    setTimeout(tryAutoAttach, 1500);
  }
});
hrefObserver.observe(document.documentElement, { subtree: true, childList: true });

// Initial attach
if (document.readyState === "complete") {
  setTimeout(tryAutoAttach, 500);
} else {
  window.addEventListener("load", () => setTimeout(tryAutoAttach, 800));
}