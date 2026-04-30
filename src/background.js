const API_URL = process.env.TMT_API_URL;

// ── Context menu ──────────────────────────────────────────────────────────────
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

// ── Safe tab messenger (injects content script if missing) ────────────────────
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

// ── Context menu clicks ───────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tmt-translate" && info.selectionText) {
    safeSend(tab.id, { type: "TRANSLATE_SELECTION", text: info.selectionText.trim() });
  }
  if (info.menuItemId === "tmt-translate-page") {
    safeSend(tab.id, { type: "OPEN_PAGE_PANEL" });
  }
});

// ── Keyboard commands ─────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "translate-selection") safeSend(tab.id, { type: "KEYBOARD_TRANSLATE" });
  if (command === "detranslate-last")    safeSend(tab.id, { type: "DETRANSLATE_LAST" });
  if (command === "open-page-panel")     safeSend(tab.id, { type: "OPEN_PAGE_PANEL" });
});

// ── Translation API handler ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE") {
    handleTranslation(message.text, message.src_lang, message.tgt_lang)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

async function handleTranslation(text, src_lang, tgt_lang) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (!apiKey) return { success: false, error: "NO_API_KEY" };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ text, src_lang, tgt_lang }),
    });
    const data = await res.json();

    if (data.message_type === "SUCCESS") {
      await saveToHistory({ text, src_lang, tgt_lang, output: data.output });
      return { success: true, output: data.output };
    }
    return { success: false, error: data.message || "Translation failed" };
  } catch (err) {
    return { success: false, error: "Network error — check your connection" };
  }
}

async function saveToHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  const updated = [{ ...entry, timestamp: Date.now() }, ...history].slice(0, 10);
  await chrome.storage.local.set({ history: updated });
}
