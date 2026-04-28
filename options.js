const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

const apiKeyInput = document.getElementById("api-key-input");
const keyStatus = document.getElementById("key-status");
const saveBtn = document.getElementById("save-btn");
const testBtn = document.getElementById("test-btn");
const clearBtn = document.getElementById("clear-btn");
const testResult = document.getElementById("test-result");
const toggleVisibility = document.getElementById("toggle-visibility");

const autoTranslate = document.getElementById("auto-translate");
const autoDetect = document.getElementById("auto-detect");
const saveHistory = document.getElementById("save-history");
const savePrefs = document.getElementById("save-prefs");

async function init() {
  const { apiKey, prefs = {} } = await chrome.storage.sync.get(["apiKey", "prefs"]);
  if (apiKey) {
    apiKeyInput.value = apiKey;
    keyStatus.textContent = "✓ API key saved";
    keyStatus.className = "key-status saved";
  }
  autoTranslate.checked = prefs.autoTranslate !== false;
  autoDetect.checked = prefs.autoDetect !== false;
  saveHistory.checked = prefs.saveHistory !== false;
}

toggleVisibility.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisibility.querySelector("svg").style.opacity = isPassword ? "0.4" : "1";
});

saveBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = "Please enter an API key.";
    keyStatus.className = "key-status error";
    return;
  }
  if (!key.startsWith("team_")) {
    keyStatus.textContent = "⚠ Key should start with 'team_'. Double-check your key.";
    keyStatus.className = "key-status error";
  }
  await chrome.storage.sync.set({ apiKey: key });
  keyStatus.textContent = "✓ API key saved successfully!";
  keyStatus.className = "key-status saved";
  setTimeout(() => {
    keyStatus.textContent = "";
  }, 3000);
});

testBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showTestResult(false, "Enter and save your API key first.");
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  testResult.style.display = "none";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        text: "Hello",
        src_lang: "en",
        tgt_lang: "ne"
      })
    });

    const data = await response.json();

    if (data.message_type === "SUCCESS") {
      showTestResult(true, `✓ Connection successful!\n"Hello" → "${data.output}" (Nepali)\nYour API key is working correctly.`);
    } else {
      showTestResult(false, `✗ ${data.message || "Translation failed. Check your API key."}`);
    }
  } catch (err) {
    showTestResult(false, `✗ Network error: ${err.message}\nCheck your internet connection.`);
  }

  testBtn.disabled = false;
  testBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Test Connection`;
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("Remove the saved API key?")) return;
  await chrome.storage.sync.remove("apiKey");
  apiKeyInput.value = "";
  keyStatus.textContent = "API key cleared.";
  keyStatus.className = "key-status info";
  testResult.style.display = "none";
});

savePrefs.addEventListener("click", async () => {
  const prefs = {
    autoTranslate: autoTranslate.checked,
    autoDetect: autoDetect.checked,
    saveHistory: saveHistory.checked
  };
  await chrome.storage.sync.set({ prefs });
  savePrefs.textContent = "✓ Saved!";
  setTimeout(() => {
    savePrefs.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" stroke="currentColor" stroke-width="2"/><polyline points="17 21 17 13 7 13 7 21" stroke="currentColor" stroke-width="2"/><polyline points="7 3 7 8 15 8" stroke="currentColor" stroke-width="2"/></svg> Save Preferences`;
  }, 2000);
});

function showTestResult(success, message) {
  testResult.style.display = "block";
  testResult.className = `test-result ${success ? "success" : "fail"}`;
  testResult.style.whiteSpace = "pre-line";
  testResult.textContent = message;
}

init();
