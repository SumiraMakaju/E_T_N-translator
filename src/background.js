const API_URL = process.env.TMT_API_URL;


const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const URL_RE   = /\bhttps?:\/\/[^\s<>"']+/gi;

// brands  NEVER  translated
const BRANDS = [
  "Gmail","Google","YouTube","Facebook",
  "Instagram","GitHub","Microsoft","Apple"
];


function splitText(text) {
  const parts = [];

  const combined = new RegExp(
    `${EMAIL_RE.source}|${URL_RE.source}|${BRANDS.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}`,
    "gi"
  );

  let lastIndex = 0;
  let match;

  while ((match = combined.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        value: text.slice(lastIndex, match.index)
      });
    }

    parts.push({
      type: "protected",
      value: match[0]
    });

    lastIndex = combined.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      value: text.slice(lastIndex)
    });
  }

  return parts;
}

// CONTEXT MENU

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "tmt-translate",
      title: "Translate with TMT",
      contexts: ["selection"]
    });

    chrome.contextMenus.create({
      id: "tmt-translate-page",
      title: "Translate entire page (TMT)",
      contexts: ["page"]
    });
  });
});

async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });

      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"]
      });

      await new Promise(r => setTimeout(r, 150));

      await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      console.warn("TMT: Cannot inject into tab", tabId, err.message);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tmt-translate" && info.selectionText) {
    safeSend(tab.id, {
      type: "TRANSLATE_SELECTION",
      text: info.selectionText.trim()
    });
  }

  if (info.menuItemId === "tmt-translate-page") {
    safeSend(tab.id, { type: "OPEN_PAGE_PANEL" });
  }
});

// TRANSLATION HANDLER 
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE") {
    handleTranslation(message.text, message.src_lang, message.tgt_lang)
      .then(sendResponse)
      .catch(err =>
        sendResponse({ success: false, error: err.message })
      );
    return true;
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

async function handleTranslation(text, src_lang, tgt_lang) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");

  if (!apiKey) {
    return { success: false, error: "NO_API_KEY" };
  }

  const parts = splitText(text);

  let finalOutput = "";

  for (const part of parts) {

    // ✅ Keep protected content EXACTLY as-is
    if (part.type === "protected") {
      finalOutput += part.value;
      continue;
    }

    const clean = part.value.trim();

    if (!clean) {
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
        body: JSON.stringify({
          text: clean,
          src_lang,
          tgt_lang
        }),
      });

      const data = await res.json();

      if (data.message_type === "SUCCESS") {
        finalOutput += part.value.replace(clean, data.output);
      } else {
        finalOutput += part.value; // fallback
      }

    } catch {
      finalOutput += part.value; // fallback
    }
  }

  return { success: true, output: finalOutput };
}

 
async function saveToHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");

  const updated = [
    { ...entry, timestamp: Date.now() },
    ...history
  ].slice(0, 10);

  await chrome.storage.local.set({ history: updated });
}