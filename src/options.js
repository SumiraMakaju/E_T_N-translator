const API_URL = process.env.TMT_API_URL;

const apiKeyInput    = document.getElementById("api-key-input");
const keyStatus      = document.getElementById("key-status");
const saveBtn        = document.getElementById("save-btn");
const testBtn        = document.getElementById("test-btn");
const clearBtn       = document.getElementById("clear-btn");
const testResult     = document.getElementById("test-result");
const toggleVisBtn   = document.getElementById("toggle-visibility");
const autoTranslate  = document.getElementById("auto-translate");
const autoDetect     = document.getElementById("auto-detect");
const saveHistoryChk = document.getElementById("save-history");
const savePrefsBtn   = document.getElementById("save-prefs");
const apiUrlDisplay  = document.getElementById("api-url-display");

async function init() {
  const { apiKey, prefs = {} } = await chrome.storage.sync.get(["apiKey", "prefs"]);
  if (apiKey) {
    apiKeyInput.value = apiKey;
    keyStatus.textContent = "✓ API key saved";
    keyStatus.className = "key-status saved";
  }
  if (apiUrlDisplay) apiUrlDisplay.textContent = API_URL;
  autoTranslate.checked  = prefs.autoTranslate !== false;
  autoDetect.checked     = prefs.autoDetect !== false;
  saveHistoryChk.checked = prefs.saveHistory !== false;
}

toggleVisBtn?.addEventListener("click", () => {
  const show = apiKeyInput.type === "password";
  apiKeyInput.type = show ? "text" : "password";
  toggleVisBtn.querySelector("svg").style.opacity = show ? "0.4" : "1";
});

saveBtn?.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setKeyStatus("Please enter an API key.", "error"); return; }
  if (!key.startsWith("team_")) setKeyStatus("⚠ Key should start with 'team_' — double-check.", "error");
  await chrome.storage.sync.set({ apiKey: key });
  setKeyStatus("✓ API key saved!", "saved");
  setTimeout(() => setKeyStatus("", ""), 3000);
});

testBtn?.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { showTestResult(false, "Enter and save your API key first."); return; }

  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  testResult.style.display = "none";

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ text: "Hello", src_lang: "en", tgt_lang: "ne" }),
    });
    const data = await res.json();
    if (data.message_type === "SUCCESS") {
      showTestResult(true, `✓ Connection successful!\n"Hello" → "${data.output}" (Nepali)\nYour API key is valid.`);
    } else {
      showTestResult(false, `✗ ${data.message || "Check your API key."}`);
    }
  } catch (err) {
    showTestResult(false, `✗ Network error: ${err.message}`);
  }

  testBtn.disabled = false;
  testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Test Connection`;
});

clearBtn?.addEventListener("click", async () => {
  if (!confirm("Remove saved API key?")) return;
  await chrome.storage.sync.remove("apiKey");
  apiKeyInput.value = "";
  setKeyStatus("API key cleared.", "info");
  testResult.style.display = "none";
});

savePrefsBtn?.addEventListener("click", async () => {
  const prefs = {
    autoTranslate: autoTranslate.checked,
    autoDetect: autoDetect.checked,
    saveHistory: saveHistoryChk.checked,
  };
  await chrome.storage.sync.set({ prefs });
  savePrefsBtn.textContent = "✓ Saved!";
  setTimeout(() => {
    savePrefsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" stroke="currentColor" stroke-width="2"/><polyline points="17 21 17 13 7 13 7 21" stroke="currentColor" stroke-width="2"/><polyline points="7 3 7 8 15 8" stroke="currentColor" stroke-width="2"/></svg> Save Preferences`;
  }, 2000);
});

function setKeyStatus(msg, type) {
  keyStatus.textContent = msg;
  keyStatus.className = `key-status ${type}`;
}

function showTestResult(success, message) {
  testResult.style.display = "block";
  testResult.className = `test-result ${success ? "success" : "fail"}`;
  testResult.style.whiteSpace = "pre-line";
  testResult.textContent = message;
}

init();

// ── OpenAI Key (for Whisper video transcription) ──────────────────────────────
const openaiInput  = document.getElementById("openai-key-input");
const openaiStatus = document.getElementById("openai-key-status");
const openaiSave   = document.getElementById("openai-save-btn");
const openaiClear  = document.getElementById("openai-clear-btn");
const openaiToggle = document.getElementById("openai-toggle-vis");

async function initOpenAI() {
  const { openaiKey } = await chrome.storage.sync.get("openaiKey");
  if (openaiKey && openaiInput) {
    openaiInput.value = openaiKey;
    if (openaiStatus) { openaiStatus.textContent = "✓ OpenAI key saved"; openaiStatus.className = "key-status saved"; }
  }
}
initOpenAI();

openaiToggle?.addEventListener("click", () => {
  if (!openaiInput) return;
  openaiInput.type = openaiInput.type === "password" ? "text" : "password";
});

openaiSave?.addEventListener("click", async () => {
  const key = openaiInput?.value.trim();
  if (!key) { if (openaiStatus) { openaiStatus.textContent = "Enter a key first."; openaiStatus.className = "key-status error"; } return; }
  await chrome.storage.sync.set({ openaiKey: key });
  if (openaiStatus) { openaiStatus.textContent = "✓ OpenAI key saved!"; openaiStatus.className = "key-status saved"; }
  setTimeout(() => { if (openaiStatus) openaiStatus.textContent = ""; }, 3000);
});

openaiClear?.addEventListener("click", async () => {
  await chrome.storage.sync.remove("openaiKey");
  if (openaiInput) openaiInput.value = "";
  if (openaiStatus) { openaiStatus.textContent = "OpenAI key cleared."; openaiStatus.className = "key-status info"; }
});