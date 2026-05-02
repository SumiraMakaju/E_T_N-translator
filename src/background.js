const API_URL = "https://tmt.ilprl.ku.edu.np/api"; 

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const URL_RE   = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const CODE_RE  = /`[^`\n]{1,200}`/g;
const VER_RE   = /\bv?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/g;
const FILE_RE  = /\b[\w.-]+\.(?:js|ts|jsx|tsx|py|go|rs|java|cpp|c|h|css|html|json|yaml|yml|md|txt|env|sh|bat)\b/gi;
const HEX_RE   = /#[0-9a-fA-F]{6}\b/g;

const BRAND_WORDS = [
  "Gmail","Google","YouTube","Drive","Chrome","Firebase","Gemini","Maps",
  "Facebook","Instagram","WhatsApp","Meta","Twitter","TikTok","LinkedIn",
  "GitHub","GitLab","Microsoft","Office","Azure","Apple","iCloud","Amazon","AWS",
  "Netflix","Spotify","Slack","Discord","Zoom","Notion","Figma","Linear","Jira",
  "OpenAI","Anthropic","ChatGPT","Claude","Copilot","Gemini",
  "React","Angular","Vue","Next","Nuxt","Vite","Webpack","Node","Deno","Bun",
  "Python","JavaScript","TypeScript","Kotlin","Swift","Rust","Go","PHP","Ruby",
  "HTML","CSS","API","SDK","CLI","HTTP","HTTPS","REST","GraphQL","JSON","XML",
  "SQL","MongoDB","Redis","PostgreSQL","MySQL","Docker","Kubernetes","Linux","Ubuntu",
  "TMT"
];

const PROTECT_RE = new RegExp(
  [
    EMAIL_RE.source,
    URL_RE.source,
    CODE_RE.source,
    VER_RE.source,
    FILE_RE.source,
    HEX_RE.source,
    `\\b(?:${BRAND_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  ].join("|"),
  "gi"
);

function splitText(text) {
  const parts = [];
  let lastIndex = 0;
  let match;
  const re = new RegExp(PROTECT_RE.source, "gi");

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "protected", value: match[0] });
    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  return parts;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "tmt-translate",
      title: "Translate with TMT",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "tmt-translate-page",
      title: "Translate entire page (TMT)",
      contexts: ["page"],
    });
  });
});

async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await new Promise(r => setTimeout(r, 150));
      await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      console.warn("TMT: Cannot inject into tab", tabId, err.message);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tmt-translate" && info.selectionText)
    safeSend(tab.id, { type: "TRANSLATE_SELECTION", text: info.selectionText.trim() });

  if (info.menuItemId === "tmt-translate-page")
    safeSend(tab.id, { type: "OPEN_PAGE_PANEL" });
});

chrome.commands.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === "translate-selection")
    safeSend(tab.id, { type: "KEYBOARD_TRANSLATE" });

  if (command === "detranslate-last")
    safeSend(tab.id, { type: "DETRANSLATE_LAST" });

  if (command === "open-page-panel")
    safeSend(tab.id, { type: "OPEN_PAGE_PANEL" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "TRANSLATE") {
    handleTranslation(message.text, message.src_lang, message.tgt_lang)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "START_TAB_CAPTURE") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ error: "No tab ID" });
      return;
    }

    chrome.tabCapture.getMediaStreamId(
      { targetTabId: tabId },
      (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId });
        }
      }
    );

    return true;
  }

  if (message.type === "WHISPER_TRANSCRIBE") {
    handleWhisper(message, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }

  if (message.type === "OPEN_VIDEO_PANEL") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId) chrome.tabs.sendMessage(tabId, { type: "OPEN_VIDEO_PANEL" });
  }
});

async function handleTranslation(text, src_lang, tgt_lang) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (!apiKey) return { success: false, error: "NO_API_KEY" };

  const parts = splitText(text);

  if (parts.every(p => p.type === "protected")) {
    return { success: true, output: text, skipped: true };
  }

  let finalOutput = "";

  for (const part of parts) {
    if (part.type === "protected") {
      finalOutput += part.value;
      continue;
    }

    const clean = part.value.trim();

    if (!clean) {
      finalOutput += part.value;
      continue;
    }

    if (clean.length < 2 || /^[\d\s.,:;!?]+$/.test(clean)) {
      finalOutput += part.value;
      continue;
    }

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ text: clean, src_lang, tgt_lang }),
      });

      const data = await res.json();

      if (data.message_type === "SUCCESS") {
        const leading  = part.value.match(/^\s*/)[0];
        const trailing = part.value.match(/\s*$/)[0];
        finalOutput += leading + data.output + trailing;
      } else {
        finalOutput += part.value;
      }
    } catch {
      finalOutput += part.value;
    }
  }

  await saveToHistory({ text, src_lang, tgt_lang, output: finalOutput });
  return { success: true, output: finalOutput };
}

async function saveToHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  const updated = [{ ...entry, timestamp: Date.now() }, ...history].slice(0, 10);
  await chrome.storage.local.set({ history: updated });
}

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

async function handleWhisper(message) {
  const { openaiKey } = await chrome.storage.sync.get("openaiKey");

  if (!openaiKey) return { success: false, error: "NO_OPENAI_KEY" };

  const bytes = new Uint8Array(message.audioBytes);
  const blob  = new Blob([bytes], { type: message.mimeType || "audio/webm" });
  const form  = new FormData();

  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");
  if (message.language) form.append("language", message.language);
  form.append("response_format", "json");

  const res = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${openaiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err.error?.message || `Whisper HTTP ${res.status}` };
  }

  const data = await res.json();
  return { success: true, transcript: data.text?.trim() || "" };
}