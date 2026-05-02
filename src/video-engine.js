const TMT_SUBTITLE_ID = "tmt-subtitle-overlay";
const TMT_PANEL_ID = "tmt-video-panel";
const CHUNK_MS = 6000;

function isAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function safeSend(msg, cb) {
  if (!isAlive()) return;
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return;
      cb?.(res);
    });
  } catch {}
}

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

let activeVideo = null;
let subtitleEl = null;
let panelEl = null;
let isTranslating = false;
let captureMode = "idle";
let tgtLang = "ne";
let whisperLang = "auto";
let clearTimer = null;
let modeLabel = "Auto";

const cueCache = new Map();
let lastCueText = "";

function injectCSS() {
  if (document.getElementById("tmt-engine-css")) return;
  const link = document.createElement("link");
  link.id = "tmt-engine-css";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("video-engine.css");
  document.head.appendChild(link);
}

function ensureSubtitleEl() {
  if (subtitleEl && document.contains(subtitleEl)) return subtitleEl;
  injectCSS();
  subtitleEl = document.createElement("div");
  subtitleEl.id = TMT_SUBTITLE_ID;
  document.body.appendChild(subtitleEl);
  return subtitleEl;
}

function positionSubtitle() {
  if (!activeVideo || !subtitleEl) return;
  const rect = activeVideo.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const bottomOffset = window.innerHeight - rect.bottom + rect.height * 0.1;
  subtitleEl.style.bottom = Math.max(8, bottomOffset) + "px";
  subtitleEl.style.left = rect.left + "px";
  subtitleEl.style.right = "auto";
  subtitleEl.style.width = rect.width + "px";
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
    clearTimer = setTimeout(
      () => el?.classList.remove("tmt-sub-visible"),
      durationMs,
    );
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function translateAndShow(rawText, durationMs = 4500) {
  const text = rawText.trim();
  if (!text || text === lastCueText) return;
  lastCueText = text;
  const key = `${text}|${tgtLang}`;
  if (cueCache.has(key)) {
    showSubtitle(cueCache.get(key), durationMs);
    return;
  }
  const srcLang = detectLang(text);
  if (srcLang === tgtLang) {
    showSubtitle(text, durationMs);
    return;
  }
  safeSend(
    { type: "TRANSLATE", text, src_lang: srcLang, tgt_lang: tgtLang },
    (res) => {
      if (res?.success && res.output) {
        cueCache.set(key, res.output);
        showSubtitle(res.output, durationMs);
      }
    },
  );
}

let trackCueListener = null;
let trackPollInterval = null;

function tryTrackAPI(video) {
  const tracks = Array.from(video.textTracks || []);
  const preferred =
    tracks.find((t) => t.mode === "showing" && /^en/.test(t.language)) ||
    tracks.find((t) => t.mode === "showing") ||
    tracks.find((t) => t.mode !== "disabled") ||
    tracks[0];
  if (!preferred) return false;
  try {
    preferred.mode = "hidden";
  } catch {}
  modeLabel = "CC→TMT";
  captureMode = "track";
  trackCueListener = () => {
    const cue = preferred.activeCues?.[0];
    if (!cue) return;
    const text = (cue.text || "").replace(/<[^>]+>/g, "").trim();
    if (text)
      translateAndShow(text, (cue.endTime - cue.startTime) * 1000 || 4500);
  };
  preferred.addEventListener("cuechange", trackCueListener);
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
  trackCueListener = null;
}

const DOM_CAPTION_SELECTORS = [
  ".ytp-caption-window-container",
  ".ytp-caption-segment",
  ".vp-captions",
  ".captions",
  "[data-a-target='player-captions-container']",
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
let domPollInterval = null;

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
  setStatus("✓ Captions found translating live", "ok");
  domCaptionObserver = new MutationObserver(() => {
    const container = findDOMCaptionContainer() || initial;
    const text =
      container?.innerText?.trim() || container?.textContent?.trim() || "";
    if (text) translateAndShow(text, 4500);
  });
  domCaptionObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
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

let mediaRecorder = null;
let audioChunks = [];
let chunkTimer = null;

async function startWhisperMode() {
  captureMode = "whisper";
  modeLabel = "Whisper";
  setStatus("🎙 Requesting tab audio capture…", "info");
  safeSend({ type: "START_TAB_CAPTURE" }, async (res) => {
    if (!res?.streamId) {
      setStatus(
        "⚠ Tab audio capture failed. Check extension permissions.",
        "error",
      );
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
          },
        },
        video: false,
      });
      setStatus("🎙 Audio capture active subtitles every ~6 sec", "ok");
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
  const bytes = Array.from(new Uint8Array(arrayBuf));
  safeSend(
    {
      type: "WHISPER_TRANSCRIBE",
      audioBytes: bytes,
      mimeType: audioBlob.type,
      language: whisperLang === "auto" ? undefined : whisperLang,
    },
    (res) => {
      if (!res?.success || !res.transcript?.trim()) return;
      translateAndShow(res.transcript.trim(), CHUNK_MS + 1000);
    },
  );
}

function stopWhisperMode() {
  clearTimeout(chunkTimer);
  chunkTimer = null;
  if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
  mediaRecorder = null;
  audioChunks = [];
}

async function startSmartTranslation(video) {
  setStatus(" Detecting captions…", "info");
  await new Promise((r) => setTimeout(r, 800));
  if (video.textTracks?.length > 0) {
    setStatus("Found text tracks, connecting…", "info");
    await new Promise((r) => setTimeout(r, 400));
    if (tryTrackAPI(video)) {
      setStatus("✓ Caption track active, translating", "ok");
      updateModeIndicator("Text Track");
      return;
    }
  }
  setStatus("🔍 Checking for DOM captions…", "info");
  await new Promise((r) => setTimeout(r, 600));
  let domFound = false;
  for (let i = 0; i < 10; i++) {
    if (findDOMCaptionContainer()) {
      domFound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (domFound) {
    if (tryDOMCaption()) {
      updateModeIndicator("🖥 DOM Captions");
      return;
    }
  }
  setStatus("📡 No captions found switching to audio", "warn");
  await new Promise((r) => setTimeout(r, 800));
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

function setStatus(text, type = "info") {
  const el = document.getElementById("tmt-vp-status");
  if (!el) return;
  el.textContent = text;
  el.className = `tmt-vp-status tmt-vp-status-${type}`;
  el.style.display = "block";
}

function resetButtons() {
  const s = document.getElementById("tmt-vp-start");
  const p = document.getElementById("tmt-vp-stop");
  if (s) s.style.display = "flex";
  if (p) p.style.display = "none";
}

function createPanel() {
  if (document.getElementById(TMT_PANEL_ID))
    return document.getElementById(TMT_PANEL_ID);
  injectCSS();
  const el = document.createElement("div");
  const iconUrl = chrome.runtime.getURL("icons/icon16.png");
  el.id = TMT_PANEL_ID;
  el.innerHTML = `
   

     <div class="tmt-vp-header">
      <div class="tmt-vp-brand">
      <img src="${iconUrl}" alt="icon" width="35" height="35" />
        Video Translate
       </div>
       </div>
      <div class="tmt-vp-header-right">
        <button class="tmt-vp-min" id="tmt-vp-min" title="Minimise">—</button>
        <button class="tmt-vp-close" id="tmt-vp-close" title="Close">×</button>
      </div>
    </div>

    <div class="tmt-vp-body" id="tmt-vp-body">

      <div class="tmt-vp-row">
        <div class="tmt-vp-label">Translate to</div>
        <div class="tmt-vp-lang-btns">
          <button class="tmt-vp-lang ${tgtLang === "ne" ? "active" : ""}" data-lang="ne">🇳🇵 Nepali</button>
          <button class="tmt-vp-lang ${tgtLang === "en" ? "active" : ""}" data-lang="en">🇬🇧 English</button>
          <button class="tmt-vp-lang ${tgtLang === "tmg" ? "active" : ""}" data-lang="tmg">🏔 Tamang</button>
        </div>
      </div>

      <div class="tmt-vp-row">
        <div class="tmt-vp-label">Audio lang</div>
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

      <div class="tmt-vp-info">
        Requires <strong>CC enabled</strong> on the video for best results.
        Whisper requires an OpenAI key in Settings.
      </div>

      <div id="tmt-vp-mode" class="tmt-vp-mode-badge" style="display:none">
       Auto
      </div>

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

  el.querySelectorAll(".tmt-vp-lang").forEach((btn) => {
    btn.onclick = () => {
      el.querySelectorAll(".tmt-vp-lang").forEach((b) =>
        b.classList.remove("active"),
      );
      btn.classList.add("active");
      tgtLang = btn.dataset.lang;
      cueCache.clear();
      lastCueText = "";
    };
  });

  el.querySelector("#tmt-whisper-lang").onchange = (e) => {
    whisperLang = e.target.value;
  };

  let minimised = false;
  document.getElementById("tmt-vp-min").onclick = () => {
    minimised = !minimised;
    const body = document.getElementById("tmt-vp-body");
    if (body) body.style.display = minimised ? "none" : "block";
    el.classList.toggle("tmt-vp-minimised", minimised);
    el.querySelector("#tmt-vp-min").textContent = minimised ? "+" : "—";
  };

  document.getElementById("tmt-vp-close").onclick = () => stopAll();

  document.getElementById("tmt-vp-start").onclick = async () => {
    if (isTranslating) return;
    if (!activeVideo) {
      activeVideo = findMainVideo();
      if (!activeVideo) {
        setStatus("⚠ No video detected on this page.", "error");
        return;
      }
    }
    isTranslating = true;
    document.getElementById("tmt-vp-start").style.display = "none";
    document.getElementById("tmt-vp-stop").style.display = "flex";
    await startSmartTranslation(activeVideo);
  };

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
  let ox = 0,
    oy = 0,
    sx = 0,
    sy = 0;
  header.style.cursor = "grab";
  header.onmousedown = (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    sx = e.clientX;
    sy = e.clientY;
    const rect = el.getBoundingClientRect();
    ox = rect.left;
    oy = rect.top;
    header.style.cursor = "grabbing";
    const move = (e) => {
      el.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      el.style.top = Math.max(0, oy + e.clientY - sy) + "px";
      el.style.right = "auto";
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

function stopTranslation() {
  isTranslating = false;
  stopTrackAPI();
  stopDOMCaption();
  stopWhisperMode();
  captureMode = "idle";
  modeLabel = "Auto";
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
  return (
    [...document.querySelectorAll("video")]
      .filter((v) => v.offsetWidth > 80 && v.offsetHeight > 50)
      .sort(
        (a, b) =>
          b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight,
      )[0] || null
  );
}

function attachToVideo(video) {
  activeVideo = video;
  ensureSubtitleEl();
  positionSubtitle();
  if (!panelEl || !document.contains(panelEl)) {
    panelEl = createPanel();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!isAlive()) return;
  if (msg.type === "OPEN_VIDEO_PANEL") {
    const video = findMainVideo();
    if (!video) {
      const t = document.createElement("div");
      t.style.cssText = `
        position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        background:#fff5ed;border:1.5px solid rgba(239,68,68,0.3);color:#ef4444;
        border-radius:20px;padding:9px 18px;font-size:13px;font-weight:700;
        font-family:'Nunito',-apple-system,sans-serif;z-index:2147483647;
        box-shadow:0 4px 20px rgba(249,115,22,0.15);pointer-events:none;
      `;
      t.textContent = "⚠ TMT: No video found on this page.";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
      return;
    }
    attachToVideo(video);
  }
});

document.addEventListener("keydown", (e) => {
  if (!isAlive()) return;
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
    e.preventDefault();
    const video = findMainVideo();
    if (video) attachToVideo(video);
  }
});

function tryAutoAttach() {
  if (panelEl && document.contains(panelEl)) return;
  const v = findMainVideo();
  if (v) attachToVideo(v);
}

const videoObserver = new MutationObserver(() => {
  if (!panelEl || !document.contains(panelEl)) tryAutoAttach();
});
videoObserver.observe(document.body, { childList: true, subtree: true });

let lastHref = location.href;
const hrefObserver = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    if (panelEl) stopAll();
    setTimeout(tryAutoAttach, 1500);
  }
});
hrefObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
});

if (document.readyState === "complete") {
  setTimeout(tryAutoAttach, 500);
} else {
  window.addEventListener("load", () => setTimeout(tryAutoAttach, 800));
}
