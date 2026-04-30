// build.js — compiles src/ → dist/ and inlines .env values
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Load .env if it exists (won't crash if missing)
try { require("dotenv").config(); } catch {}

const dist = path.join(__dirname, "dist");
const pub  = path.join(__dirname, "public");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function copyPublic() {
  if (!fs.existsSync(pub)) {
    console.error(`\n❌  Missing "public/" folder.\n`);
    console.error(`    This folder contains manifest.json, HTML, CSS, and icons.`);
    console.error(`    Make sure you cloned/extracted the FULL project zip.\n`);
    process.exit(1);
  }
  fs.mkdirSync(dist, { recursive: true });
  copyDir(pub, dist);
  console.log("✓ Static files copied  (public/ → dist/)");
}

const define = {
  "process.env.TMT_API_URL": JSON.stringify(
    process.env.TMT_API_URL || "https://tmt.ilprl.ku.edu.np/lang-translate"
  ),
};

async function build() {
  copyPublic();
  await esbuild.build({
    entryPoints: [
      "src/background.js",
      "src/content.js",
      "src/popup.js",
      "src/options.js",
      "src/page-engine.js",
    ],
    bundle: true,
    outdir: dist,
    define,
    format: "iife",
    platform: "browser",
    minify: true,
    logLevel: "info",
  });
  console.log("✓ Build complete →", dist);
  console.log("\n📦 Load the dist/ folder in Chrome:");
  console.log("   chrome://extensions → Developer Mode ON → Load unpacked → select dist/\n");
}

build().catch(e => { console.error(e); process.exit(1); });
