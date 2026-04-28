const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tmt-translate",
    title: "Translate with TMT",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tmt-translate" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
      text: info.selectionText.trim()
    });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "translate-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "KEYBOARD_TRANSLATE" });
  }
  if (command === "detranslate-last") {
    chrome.tabs.sendMessage(tab.id, { type: "DETRANSLATE_LAST" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE") {
    handleTranslation(message.text, message.src_lang, message.tgt_lang)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleTranslation(text, src_lang, tgt_lang) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (!apiKey) {
    return { success: false, error: "NO_API_KEY" };
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({ text, src_lang, tgt_lang })
  });

  const data = await response.json();

  if (data.message_type === "SUCCESS") {
    await saveToHistory({ text, src_lang, tgt_lang, output: data.output });
    return { success: true, output: data.output, src_lang: data.src_lang, tgt_lang: data.target_lang };
  } else {
    return { success: false, error: data.message || "Translation failed" };
  }
}

async function saveToHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  const updated = [{ ...entry, timestamp: Date.now() }, ...history].slice(0, 10);
  await chrome.storage.local.set({ history: updated });
}
