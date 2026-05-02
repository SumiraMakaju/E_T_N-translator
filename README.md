# TMT Translator

**A trilingual browser extension for real-time translation between English, Nepali, and Tamang.**

TMT Translator bridges the language gap for Nepali and Tamang speakers by integrating the TMT Translation Engine with to deliver smart, context-aware translation across web pages, selected text, and videos across web browser.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)

---

## Overview

TMT Translator is a Manifest V3 Chrome extension that brings trilingual translation (English, Nepali, Tamang) directly into the browser. It is designed for three primary use cases: reading web pages, reading emails in Gmail, and watching videos all without disrupting the user's workflow. It then translates as per user requirements.

The extension is powered by the TMT Translation API hosted at Kathmandu University's ILPRL lab (`tmt.ilprl.ku.edu.np`).
---

## Features

### Smart Page Translation

Translates the full visible content of any web page into the target language while preserving layout and structure.

- **Context Protection:** A regex-based guard automatically detects and skips code blocks, inline code, URLs, email addresses, hex color values, version strings, filenames, and over 50 brand names (Google, GitHub, React, etc.) to prevent them from being corrupted by translation.
- **Gmail Mode:** Detects when the active tab is Gmail (`mail.google.com`) and restricts translation to the email body only, leaving the Gmail UI intact.

### Inline Selection Translation

Translates a specific passage without navigating away from the page.

steps:

1. Highlight any text to reveal a floating translation tooltip with a language picker.
2. The selected text is replaced inplace on the page with the translated version, preserving the original HTML structure (paragraph tags, line breaks, etc.).
3.  Press `Alt+Z` to restore the last translated segment, or `Alt+Shift+Z` to restore all translated segments on the page.

### Live Video Translation

A dedicated video engine tracks HTML5 video players across any website and delivers translated subtitles as an overlay.

It observes existing on-screen captions (YouTube, Twitch, Vimeo, and others) via a `MutationObserver` and translates each caption segment as it appears, and in Whisper Mode Captures the tab's audio stream, chunks it into 6-second segments, sends each chunk to OpenAI Whisper for transcription, and then translates the transcript. Used when no native captions are present.

### Intelligent Text-to-Speech

Any translated text can be read aloud with a single click.

It automatically detects whether the output is in Devanagari script (Nepali/Tamang) or Latin script (English). For Devanagari output, the engine searches the operating system's installed voice packs for a compatible `ne-NP` or `hi-IN` voice before falling back to a default.

---

## Architecture

The extension is composed of four primary source modules:

| File | Responsibility |
|------|---------------|
| `src/background.js` | Service worker. Manages all API communication with the TMT engine and OpenAI Whisper, handles context menu registration, stores translation history in `chrome.storage`, and runs the regex-based text protection pipeline. |
| `src/content.js` | Content script injected into every page. Handles DOM manipulation, the floating tooltip UI, inline text replacement, Smart Page Translation traversal, Text-to-Speech, and all keyboard shortcut listeners. |
| `src/video-engine.js` | Content script dedicated to video translation. Detects active HTML5 video elements, manages the subtitle overlay DOM node, coordinates the DOM caption observer and Whisper audio capture modes, and positions the subtitle relative to the video. |
| `src/options.js` | Options page script. Provides the settings UI for API keys, default language preferences, and caption style. |
| `build.js` | esbuild configuration. Bundles all source modules and copies static assets into the `dist/` folder. |

**Message-passing flow:**

```
content.js / video-engine.js
        |
        |  chrome.runtime.sendMessage
        v
  background.js  <-->  TMT API / OpenAI Whisper API
        |
        |  response callback
        v
content.js / video-engine.js  (renders result to DOM)
```

---

## Installation

### From Source (Developer Mode)

**Prerequisites:** Node.js 18+ and npm.

1. Clone or extract the repository:
   ```bash
   git clone https://github.com/SumiraMakaju/TMT-translator.git
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root (see [Configuration](#configuration)).

4. Build the extension:
   ```bash
   npm run build
   //or node build.js
   ```
   The compiled extension is written to the `dist/` folder.

5. Load in Chrome:
   - Navigate to `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked** and select the `dist/` folder

---

## Configuration

Create a `.env` file in the project root with the following keys:

```env
TMT_API_URL=https://tmt.ilprl.ku.edu.np/lang-translate
TMT_API_KEY=tmt api key
OPENAI_API_KEY=openai api
```

| Variable | Description |
|----------|-------------|
| `TMT_API_URL` | Endpoint for the TMT Translation Engine (ILPRL, Kathmandu University) |
| `TMT_API_KEY` | API key for the TMT Translation Engine |
| `OPENAI_API_KEY` | OpenAI API key used for Whisper audio transcription in video mode |

These values are injected at build time by esbuild and are not exposed in the browser at runtime.


---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt + T` | Open the language picker for the current text selection |
| `Alt + P` | Open the Smart Page Translate panel |
| `Alt + V` | Open the Video Translate panel (requires a video on the page) |
| `Alt + Z` | Undo / restore the last inline translation |
| `Alt + Shift + Z` | Undo / restore all inline translations on the page |


---

## Project Structure

```
paastrans/
├── src/
│   ├── background.js       # Service worker: API, storage, context menus
│   ├── content.js          # Content script: DOM translation, tooltip, TTS
│   ├── video-engine.js     # Content script: video subtitle overlay
│   ├── options.js          # Options page logic
│   └── page-engine.js      # Page traversal helpers
├── public/
│   ├── manifest.json       # Extension manifest (MV3)
│   ├── popup.html          # Browser action popup
│   ├── options.html        # Settings page
│   ├── popup.css
│   ├── options.css
│   ├── content.css
│   ├── video-engine.css
│   └── icons/              
├── dist/                   # Compiled output (generated by build)
├── build.js                # esbuild bundler configuration
├── package.json
└── .env                    # API keys
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension platform | Chrome Extensions Manifest V3 |
| Translation engine | TMT API: Kathmandu University |
| Audio transcription | OpenAI Whisper (`whisper-1`) |
| Bundler | esbuild |
| Runtime dependencies | None (vanilla JS, Web APIs only) |

---

## Permissions

| Permission | Reason |
|------------|--------|
| `activeTab` | Access the current tab to inject content scripts on demand |
| `scripting` | Inject content scripts and CSS into tabs |
| `storage` | Persist user preferences and translation history |
| `contextMenus` | Add right-click "Translate with TMT" menu items |
| `tabs` | Query the active tab for keyboard command routing |
| `tabCapture` | Capture tab audio for Whisper-based video translation |

---
### demo video link
[DEMO CLICK HERE](https://drive.google.com/drive/folders/1RT4J5BgMJm1w6lg5P7GMuuSwlHXFmN-h?usp=sharing)