const LANG_NAMES = { en: "English", ne: "Nepali", tmg: "Tamang" };

const srcSelect   = document.getElementById("src-lang");
const tgtSelect   = document.getElementById("tgt-lang");
const inputText   = document.getElementById("input-text");
const charCount   = document.getElementById("char-count");
const translateBtn= document.getElementById("translate-btn");
const outputWrap  = document.getElementById("output-wrap");
const outputText  = document.getElementById("output-text");
const outputLabel = document.getElementById("output-lang-label");
const copyBtn     = document.getElementById("copy-btn");
const historyList = document.getElementById("history-list");
const noKeyBanner = document.getElementById("no-key-banner");
const pageTransBtn= document.getElementById("page-translate-btn");

async function init() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  noKeyBanner.style.display = apiKey ? "none" : "flex";
  loadHistory();
}

inputText.addEventListener("input", () => {
  charCount.textContent = inputText.value.length;
});

document.getElementById("btn-options")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("banner-settings")?.addEventListener("click", e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("swap-btn")?.addEventListener("click", () => {
  [srcSelect.value, tgtSelect.value] = [tgtSelect.value, srcSelect.value];
});

// Page translate button 
pageTransBtn?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "OPEN_PAGE_PANEL" }).catch(() => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
      .then(() => chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }))
      .then(() => new Promise(r => setTimeout(r, 150)))
      .then(() => chrome.tabs.sendMessage(tab.id, { type: "OPEN_PAGE_PANEL" }))
      .catch(err => console.warn("TMT popup:", err));
  });
  window.close();
});

translateBtn.addEventListener("click", doTranslate);
inputText.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doTranslate();
});

async function doTranslate() {
  const text = inputText.value.trim();
  if (!text) return;
  if (srcSelect.value === tgtSelect.value) {
    showOutput("⚠ Source and target must differ.", true); return;
  }

  translateBtn.disabled = true;
  translateBtn.innerHTML = '<span class="spinner-inline"></span> Translating…';

  chrome.runtime.sendMessage(
    { type: "TRANSLATE", text, src_lang: srcSelect.value, tgt_lang: tgtSelect.value },
    (res) => {
      translateBtn.disabled = false;
      translateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Translate`;

      if (res?.success) {
        outputLabel.textContent = LANG_NAMES[tgtSelect.value] || tgtSelect.value;
        showOutput(res.output, false);
        loadHistory();
      } else if (res?.error === "NO_API_KEY") {
        showOutput("API key not set. Click ⚙ to configure.", true);
        noKeyBanner.style.display = "flex";
      } else {
        showOutput(res?.error || "Translation failed.", true);
      }
    }
  );
}

function showOutput(text, isError) {
  outputText.textContent = text;
  outputText.style.color = isError ? "#fb923c" : "#f0f9ff";
  copyBtn.style.display  = isError ? "none" : "flex";
  outputWrap.style.display = "block";
}

copyBtn?.addEventListener("click", () => {
  navigator.clipboard.writeText(outputText.textContent).then(() => {
    copyBtn.textContent = "✓ Copied!";
    setTimeout(() => {
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy`;
    }, 1500);
  });
});

async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  if (!history.length) {
    historyList.innerHTML = '<p class="empty-history">No translations yet.</p>';
    return;
  }
  historyList.innerHTML = history.slice(0, 5).map((item, i) => `
    <div class="history-item" data-idx="${i}">
      <div class="history-langs">${LANG_NAMES[item.src_lang] || item.src_lang} → ${LANG_NAMES[item.tgt_lang] || item.tgt_lang}</div>
      <div class="history-src">${escapeHtml(item.text)}</div>
      <div class="history-out">${escapeHtml(item.output)}</div>
    </div>
  `).join("");

  historyList.querySelectorAll(".history-item").forEach((el, i) => {
    el.addEventListener("click", () => {
      const item = history[i];
      inputText.value = item.text;
      charCount.textContent = item.text.length;
      srcSelect.value = item.src_lang;
      tgtSelect.value = item.tgt_lang;
      showOutput(item.output, false);
      outputLabel.textContent = LANG_NAMES[item.tgt_lang] || item.tgt_lang;
    });
  });
}

document.getElementById("clear-history")?.addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [] });
  loadHistory();
});

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();

// Video translate button
document.getElementById("video-translate-btn")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "OPEN_VIDEO_PANEL" }).catch(() => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["video-engine.js"] })
      .then(() => new Promise(r => setTimeout(r, 150)))
      .then(() => chrome.tabs.sendMessage(tab.id, { type: "OPEN_VIDEO_PANEL" }))
      .catch(console.warn);
  });
  window.close();
});