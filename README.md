# TMT Translator Extension 🌍

A powerful, smart, and comprehensive browser extension for real-time translation between **English, Nepali, and Tamang**. Designed for seamless reading, email communication, and video watching, this extension leverages the TMT Translation Engine and OpenAI Whisper for an unparalleled multilingual experience.

## ✨ Features

### 1. 🎬 Live Video Translation (Smart Captioning)

### 2. 📄 Smart Page Translation
Translate entire web pages into your target language without breaking the page's layout.
*   **Context Protection:** Automatically skips and protects code blocks, emails, URLs, API keys, and over 50 brand names (like "Google" or "Facebook") from being corrupted by translation.
*   **Gmail Mode:** Specifically detects when you are reading an email on Gmail and translates only the email body, rather than translating the entire Gmail user interface.

### 3. 📝 Inline Selection Translation
Translate specific paragraphs or sentences without leaving the page.
*   Highlight any text to reveal a floating translation tooltip.
*   **Undo/Restore:** Replaces the text on the page with the translation. If you select multiple paragraphs, the exact HTML structure (like line breaks and paragraph tags) is perfectly preserved. Press `Alt+Z` to seamlessly restore the original text.

### 4. 🔊 Intelligent Text-to-Speech (Speak)
Listen to the translated text with a single click.
*   Automatically detects the script being used.
*   If Devanagari script (Nepali/Tamang) is detected, the extension will automatically search your operating system for a compatible Nepali (`ne-NP`) or Hindi (`hi-IN`) voice pack to ensure the text is spoken correctly, rather than failing silently with an English voice.

## ⌨️ Keyboard Shortcuts
| Shortcut | Action |
| :--- | :--- |
| `Alt + P` | Open Smart Page Translate Panel |
| `Alt + T` | Translate selected text inline |
| `Alt + Z` | Undo/Restore the last inline translation |
| `Alt + Shift + Z` | Undo/Restore *all* inline translations |
| `Alt + V` | Open Video Translate Panel (if a video is present) |

## 🏗 Architecture
*   **`src/background.js`:** Manages API requests, API keys, regex protection logic, history, and Whisper chunking.
*   **`src/content.js`:** Handles DOM manipulation, inline tooltip rendering, Smart Page Translation logic, Text-to-Speech generation, and keyboard listeners.
*   **`src/video-engine.js`:** A dedicated engine for tracking HTML5 video, observing DOM subtitle mutations, and capturing tab audio streams.
*   **`build.js`:** The esbuild configuration that bundles the source code and CSS into the `dist/` folder for browser consumption.