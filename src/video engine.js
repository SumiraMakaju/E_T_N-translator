// ═══════════════════════════════════════════════════════════════════════════
// TMT Video Engine — content script
// Detects <video> on any page, shows floating control panel.
// YouTube: grabs caption track → translates via TMT → overlays.
// General: tab audio capture → Whisper chunks → TMT → subtitle overlay.
// ═══════════════════════════════════════════════════════════════════════════

const TMT_SUBTITLE_ID = "tmt-subtitle-overlay";
const TMT_PANEL_ID    = "tmt-video-panel";

// ── Context guard (same as content.js) ───────────────────────────────────────
function isAlive() { try { return !!chrome.runtime?.id; } catch { return false; } }
function safeSend(msg, cb) {
  if (!isAlive()) return;
  try { chrome.runtime.sendMessage(msg, res => { if (chrome.runtime.lastError) return; cb?.(res); }); }
  catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeVideo   = null;
let subtitleEl    = null;
let panelEl       = null;
let isTranslating = false;
let captureMode   = "idle";   // "idle" | "youtube" | "whisper"
let tgtLang       = "ne";
let whisperLang   = "auto";
let clearTimer    = null;

// ═══════════════════════════════════════════════════════════════════════════
// SUBTITLE OVERLAY
// ═══════════════════════════════════════════════════════════════════════════
function ensureSubtitleEl(video) {
  if (subtitleEl && document.contains(subtitleEl)) return subtitleEl;

  subtitleEl = document.createElement("div");
  subtitleEl.id = TMT_SUBTITLE_ID;

  // Position it relative to the video
  const wrap = video.parentElement;
  const pos  = getComputedStyle(wrap).position;
  if (pos === "static") wrap.style.position = "relative";
  wrap.appendChild(subtitleEl);

  return subtitleEl;
}

function showSubtitle(text, durationMs = 4000) {
  if (!activeVideo || !text?.trim()) return;
  const el = ensureSubtitleEl(activeVideo);
  el.textContent = text.trim();
  el.classList.add("tmt-sub-visible");
  clearTimeout(clearTimer);
  if (durationMs > 0) {
    clearTimer = setTimeout(() => el.classList.remove("tmt-sub-visible"), durationMs);
  }
}

function clearSubtitles() {
  subtitleEl?.classList.remove("tmt-sub-visible");
  clearTimeout(clearTimer);
}

function removeSubtitleEl() {
  subtitleEl?.remove();
  subtitleEl = null;
}

// YOUTUBE CAPTION MODE
// Reads YouTube's existing caption/subtitle track, translates each cue.
// Handles: English captions, auto-generated captions, and foreign (e.g. Chinese)
// captions where we first get English auto-translate, then run through TMT.

// Cache so we don't re-translate the same cue text
const cueCache = new Map();
let lastCueText = "";
let ytCaptionObserver = null;
let ytPollInterval = null;

function startYouTubeMode(video) {
  captureMode = "youtube";
  setStatus("🎬 YouTube mode — reading captions…", "info");

  // Strategy 1: observe the YouTube caption renderer DOM node
  // YouTube injects captions into .ytp-caption-segment elements
  const captionContainer = document.querySelector(
    ".ytp-caption-window-container, .captions-text, [class*='caption']"
  );

  if (captionContainer) {
    watchYTCaptions(captionContainer, video);
  } else {
    // Strategy 2: poll for the caption container appearing
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const el = document.querySelector(
        ".ytp-caption-window-container, .captions-text, [class*='ytp-caption']"
      );
      if (el) { clearInterval(poll); watchYTCaptions(el, video); }
      if (attempts > 40) {
        clearInterval(poll);
        setStatus("⚠ Enable captions on the video (CC button), then restart.", "warn");
      }
    }, 500);
    ytPollInterval = poll;
  }
}

function watchYTCaptions(container, video) {
  setStatus("✓ Captions connected — translating live…", "ok");

  ytCaptionObserver = new MutationObserver(() => {
    // Grab all visible caption text
    const segments = container.querySelectorAll(
      ".ytp-caption-segment, [class*='caption-visual-line'], span"
    );
    let raw = "";
    segments.forEach(s => { raw += s.textContent + " "; });
    raw = raw.trim();

    if (!raw || raw === lastCueText) return;
    lastCueText = raw;

    // Check cache
    const cacheKey = `${raw}→${tgtLang}`;
    if (cueCache.has(cacheKey)) {
      showSubtitle(cueCache.get(cacheKey), video.paused ? 0 : 4500);
      return;
    }

    // Detect language and route appropriately
    const srcLang = detectCaptionLang(raw);
    safeSend({ type: "TRANSLATE", text: raw, src_lang: srcLang, tgt_lang: tgtLang }, (res) => {
      if (res?.success && res.output !== raw) {
        cueCache.set(cacheKey, res.output);
        showSubtitle(res.output, video.paused ? 0 : 4500);
      }
    });
  });

  ytCaptionObserver.observe(container, {
    childList: true, subtree: true, characterData: true
  });
}

function detectCaptionLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";  // Chinese
  if (/[\u0900-\u097f]/.test(text)) return "ne";  // Devanagari / Nepali
  if (/[\u3040-\u30ff]/.test(text)) return "ja";  // Japanese
  if (/[\uac00-\ud7af]/.test(text)) return "ko";  // Korean
  if (/[\u0600-\u06ff]/.test(text)) return "ar";  // Arabic
  return "en";
}

function stopYouTubeMode() {
  ytCaptionObserver?.disconnect();
  ytCaptionObserver = null;
  clearInterval(ytPollInterval);
  ytPollInterval = null;
  cueCache.clear();
  lastCueText = "";
}
// WHISPER STREAMING MODE — General video sites
// Captures tab audio in 6-second chunks, sends to background → Whisper → TMT

let mediaRecorder  = null;
let audioChunks    = [];
let chunkTimer     = null;
const CHUNK_MS     = 6000;   // 6 seconds per Whisper request

async function startWhisperMode(video) {
  captureMode = "whisper";
  setStatus("🎙 Requesting tab audio capture…", "info");

  // Ask background to start tab capture and give us the stream ID
  safeSend({ type: "START_TAB_CAPTURE" }, async (res) => {
    if (!res?.streamId) {
      setStatus("⚠ Tab capture failed. Try enabling mic permission.", "error");
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

      setStatus("🎙 Listening… translating every 6 seconds", "ok");
      startChunkedRecording(stream, video);

    } catch (err) {
      setStatus("⚠ " + err.message, "error");
    }
  });
}

function startChunkedRecording(stream, video) {
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

  // Record in rolling chunks
  function scheduleChunk() {
    if (captureMode !== "whisper") return;
    if (video.paused) {
      chunkTimer = setTimeout(scheduleChunk, 1000);
      return;
    }
    mediaRecorder.start();
    chunkTimer = setTimeout(() => {
      if (mediaRecorder.state === "recording") mediaRecorder.stop();
      scheduleChunk();
    }, CHUNK_MS);
  }

  scheduleChunk();
}

async function sendToWhisper(audioBlob) {
  // Convert blob to base64 for messaging
  const arrayBuf = await audioBlob.arrayBuffer();
  const bytes    = Array.from(new Uint8Array(arrayBuf));

  safeSend({
    type:       "WHISPER_TRANSCRIBE",
    audioBytes: bytes,
    mimeType:   "audio/webm",
    language:   whisperLang === "auto" ? undefined : whisperLang,
  }, (res) => {
    if (!res?.success || !res.transcript?.trim()) return;

    const srcLang = detectCaptionLang(res.transcript);

    // If already in target language, show as-is
    if (srcLang === tgtLang || res.transcript.length < 3) {
      showSubtitle(res.transcript, CHUNK_MS);
      return;
    }

    // Translate via TMT
    safeSend({
      type: "TRANSLATE",
      text: res.transcript,
      src_lang: srcLang,
      tgt_lang: tgtLang,
    }, (tRes) => {
      if (tRes?.success) {
        showSubtitle(tRes.output, CHUNK_MS + 1000);
      } else {
        showSubtitle(res.transcript, CHUNK_MS); // fallback: show original
      }
    });
  });
}

function stopWhisperMode() {
  clearTimeout(chunkTimer);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  audioChunks   = [];
}

// CONTROL PANEL UI
const LANG_NAMES = { en: "English", ne: "Nepali", tmg: "Tamang" };
const isYouTube  = () => location.hostname.includes("youtube.com");

function createPanel(video) {
  const el = document.createElement("div");
  el.id = TMT_PANEL_ID;

  el.innerHTML = `
    <div class="tmt-vp-header">
      <div class="tmt-vp-brand">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        TMT ${isYouTube() ? "Caption" : "Audio"} Translate
      </div>
      <div class="tmt-vp-header-right">
        <button class="tmt-vp-min" id="tmt-vp-min" title="Minimise">—</button>
        <button class="tmt-vp-close" id="tmt-vp-close" title="Close">✕</button>
      </div>
    </div>

    <div class="tmt-vp-body" id="tmt-vp-body">
      <div class="tmt-vp-row">
        <label class="tmt-vp-label">Translate to</label>
        <div class="tmt-vp-lang-btns">
          <button class="tmt-vp-lang ${tgtLang==="ne"?"active":""}" data-lang="ne">🇳🇵 Nepali</button>
          <button class="tmt-vp-lang ${tgtLang==="en"?"active":""}" data-lang="en">🇬🇧 English</button>
          <button class="tmt-vp-lang ${tgtLang==="tmg"?"active":""}" data-lang="tmg">🏔 Tamang</button>
        </div>
      </div>

      ${!isYouTube() ? `
      <div class="tmt-vp-row">
        <label class="tmt-vp-label">Audio lang</label>
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
      </div>` : `
      <div class="tmt-vp-info">
        Enable CC on the video, then click Start. TMT will translate each caption live.
      </div>`}

      <div id="tmt-vp-status" class="tmt-vp-status" style="display:none"></div>

      <div class="tmt-vp-actions">
        <button class="tmt-vp-start" id="tmt-vp-start">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
          </svg>
          Start Translating
        </button>
        <button class="tmt-vp-stop" id="tmt-vp-stop" style="display:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
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

  // Make it draggable
  makeDraggable(el);

  // Lang buttons
  el.querySelectorAll(".tmt-vp-lang").forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-vp-lang").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tgtLang = btn.dataset.lang;
      cueCache.clear(); // invalidate cache for new language
    };
  });

  // Whisper lang select
  const wLang = el.querySelector("#tmt-whisper-lang");
  if (wLang) wLang.onchange = () => { whisperLang = wLang.value; };

  // Minimise
  let minimised = false;
  document.getElementById("tmt-vp-min").onclick = () => {
    minimised = !minimised;
    const body = document.getElementById("tmt-vp-body");
    body.style.display = minimised ? "none" : "block";
    el.classList.toggle("tmt-vp-minimised", minimised);
  };

  // Close
  document.getElementById("tmt-vp-close").onclick = () => stopAll();

  // Start
  document.getElementById("tmt-vp-start").onclick = async () => {
    if (isTranslating) return;
    isTranslating = true;
    document.getElementById("tmt-vp-start").style.display = "none";
    document.getElementById("tmt-vp-stop").style.display  = "flex";

    if (isYouTube()) {
      startYouTubeMode(video);
    } else {
      await startWhisperMode(video);
    }
  };

  // Stop
  document.getElementById("tmt-vp-stop").onclick = () => {
    stopTranslation();
    document.getElementById("tmt-vp-stop").style.display  = "none";
    document.getElementById("tmt-vp-start").style.display = "flex";
    setStatus("Stopped.", "info");
  };

  return el;
}

function setStatus(text, type = "info") {
  const el = document.getElementById("tmt-vp-status");
  if (!el) return;
  el.textContent = text;
  el.className   = `tmt-vp-status tmt-vp-status-${type}`;
  el.style.display = "block";

  // Also update subtitle preview
  const preview = document.getElementById("tmt-vp-sub-preview");
  const subText = document.getElementById("tmt-vp-sub-text");
  if (preview && subText && type === "subtitle") {
    subText.textContent = text;
    preview.style.display = "block";
  }
}

// Patch showSubtitle to also update panel preview
const _origShowSubtitle = showSubtitle;
function showSubtitleAndPanel(text, ms) {
  _origShowSubtitle(text, ms);
  const subText = document.getElementById("tmt-vp-sub-text");
  const preview = document.getElementById("tmt-vp-sub-preview");
  if (subText) { subText.textContent = text; if (preview) preview.style.display = "block"; }
}

// Replace reference
// (we call showSubtitleAndPanel where needed below)

function makeDraggable(el) {
  const header = el.querySelector(".tmt-vp-header");
  let ox = 0, oy = 0, startX = 0, startY = 0;

  header.style.cursor = "grab";

  header.onmousedown = (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    header.style.cursor = "grabbing";

    const onMove = (e) => {
      el.style.left   = (ox + e.clientX - startX) + "px";
      el.style.top    = (oy + e.clientY - startY) + "px";
      el.style.right  = "auto";
      el.style.bottom = "auto";
    };
    const onUp = () => {
      header.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// LIFECYCLE
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

function attachToVideo(video) {
  if (panelEl) return; // already attached
  activeVideo = video;
  panelEl = createPanel(video);
  injectVideoCSS();
}

//  Detect videos on the page 
function findMainVideo() {
  const videos = [...document.querySelectorAll("video")];
  if (!videos.length) return null;
  // Prefer the largest visible video
  return videos
    .filter(v => v.offsetWidth > 100 && v.offsetHeight > 60)
    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
}

//  CSS injection 
function injectVideoCSS() {
  if (document.getElementById("tmt-video-css")) return;
  const style = document.createElement("style");
  style.id = "tmt-video-css";
  style.textContent = `
    /* ── Subtitle overlay ── */
    #${TMT_SUBTITLE_ID} {
      position: absolute;
      bottom: 10%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483640;
      max-width: 82%;
      background: rgba(0,0,0,0.78);
      color: #fff;
      font-family: -apple-system,'Segoe UI',sans-serif;
      font-size: clamp(14px, 2.2vw, 20px);
      font-weight: 500;
      line-height: 1.45;
      padding: 6px 14px 7px;
      border-radius: 6px;
      text-align: center;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.22s ease;
    }
    #${TMT_SUBTITLE_ID}.tmt-sub-visible { opacity: 1; }

    /* ── Floating control panel ── */
    #${TMT_PANEL_ID} {
      position: fixed;
      bottom: 80px;
      right: 20px;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 13px 9px;
      background: #0f172a;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .tmt-vp-brand {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .07em;
      color: #38bdf8;
      text-transform: uppercase;
    }
    .tmt-vp-header-right { display: flex; gap: 4px; }
    .tmt-vp-min, .tmt-vp-close {
      background: transparent;
      border: none;
      color: #475569;
      cursor: pointer;
      font-size: 13px;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
      transition: color .13s;
    }
    .tmt-vp-min:hover, .tmt-vp-close:hover { color: #94a3b8; }

    .tmt-vp-body { padding: 14px; }

    .tmt-vp-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .tmt-vp-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: #475569;
      font-weight: 600;
      white-space: nowrap;
      width: 68px;
      flex-shrink: 0;
    }
    .tmt-vp-lang-btns { display: flex; gap: 5px; flex: 1; }
    .tmt-vp-lang {
      flex: 1;
      background: #1e293b;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 7px;
      color: #64748b;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 3px;
      cursor: pointer;
      font-family: inherit;
      transition: all .13s;
      text-align: center;
    }
    .tmt-vp-lang:hover { border-color: rgba(56,189,248,0.2); color: #94a3b8; }
    .tmt-vp-lang.active {
      background: rgba(56,189,248,0.12);
      border-color: rgba(56,189,248,0.4);
      color: #38bdf8;
    }
    .tmt-vp-select {
      flex: 1;
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    .tmt-vp-info {
      font-size: 11px;
      color: #475569;
      background: #0f172a;
      border-radius: 7px;
      padding: 8px 10px;
      margin-bottom: 12px;
      line-height: 1.5;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .tmt-vp-status {
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 7px;
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .tmt-vp-status-info    { background:rgba(56,189,248,0.08);color:#38bdf8;border:1px solid rgba(56,189,248,0.2); }
    .tmt-vp-status-ok      { background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2); }
    .tmt-vp-status-warn    { background:rgba(250,204,21,0.08);color:#facc15;border:1px solid rgba(250,204,21,0.2); }
    .tmt-vp-status-error   { background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2); }

    .tmt-vp-actions { display: flex; gap: 8px; margin-bottom: 10px; }
    .tmt-vp-start, .tmt-vp-stop {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: none;
      border-radius: 8px;
      padding: 9px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: opacity .15s;
    }
    .tmt-vp-start { background: linear-gradient(135deg,#0ea5e9,#38bdf8); color: #0a0f1e; }
    .tmt-vp-stop  { background: rgba(248,113,113,0.12); color: #f87171; border: 1px solid rgba(248,113,113,0.25); }
    .tmt-vp-start:hover, .tmt-vp-stop:hover { opacity: .85; }

    .tmt-vp-sub-preview {
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 7px;
      overflow: hidden;
    }
    .tmt-vp-sub-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: #334155;
      padding: 5px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .tmt-vp-sub-text {
      padding: 8px 10px;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.5;
      min-height: 34px;
    }
  `;
  document.head.appendChild(style);
}

//  Message listener from background 
chrome.runtime.onMessage.addListener((msg) => {
  if (!isAlive()) return;
  if (msg.type === "OPEN_VIDEO_PANEL") {
    const video = findMainVideo();
    if (!video) {
      alert("TMT: No video found on this page.");
      return;
    }
    attachToVideo(video);
  }
  // Live subtitle push from background (whisper result)
  if (msg.type === "WHISPER_RESULT" && msg.transcript) {
    showSubtitleAndPanel(msg.transcript, CHUNK_MS + 500);
  }
});

//  Auto-attach on YouTube 
// On YouTube, show the panel automatically when a video is playing
if (isYouTube()) {
  const tryAttach = () => {
    const v = findMainVideo();
    if (v && !panelEl) attachToVideo(v);
  };
  // Try immediately and after navigation (YouTube is a SPA)
  tryAttach();
  const ytObserver = new MutationObserver(tryAttach);
  ytObserver.observe(document.body, { childList: true, subtree: true });
  setTimeout(tryAttach, 2000); // fallback
}