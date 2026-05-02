const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config();
} catch {}

const dist = path.join(__dirname, "dist");
const pub = path.join(__dirname, "public");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f),
      d = path.join(dst, f);
    fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function copyPublic() {
  if (!fs.existsSync(pub)) {
    console.error(
      `\n  Missing "public/" folder — make sure you have the full project.\n`,
    );
    process.exit(1);
  }
  fs.mkdirSync(dist, { recursive: true });
  copyDir(pub, dist);
  console.log("✓ Static files copied  (public/ → dist/)");
}

const define = {
  "process.env.TMT_API_URL": JSON.stringify(
    process.env.TMT_API_URL || "https://tmt.ilprl.ku.edu.np/lang-translate",
  ),
};

async function build() {
  copyPublic();

  await esbuild.build({
    entryPoints: [
      "src/background.js",
      "src/content.js",
      "src/video-engine.js",
      "src/popup.js",
      "src/options.js",
    ],
    bundle: true,
    outdir: dist,
    define,
    format: "iife",
    platform: "browser",
    minify: true,
    logLevel: "info",
  });

  const stray = path.join(dist, "page-engine.js");
  if (fs.existsSync(stray)) fs.unlinkSync(stray);

  console.log("✓ Build complete →", dist);
  console.log("  page-engine.js bundled inside content.js ✓");
  console.log("\nLoad the dist/ folder in Chrome:");
  console.log(
    "   chrome://extensions → Developer Mode ON → Load unpacked → select dist/\n",
  );
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
