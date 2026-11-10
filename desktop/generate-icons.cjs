const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico");

async function main() {
  const root = path.resolve(__dirname, "../..");
  const svg = await fs.readFile(path.join(root, "icon.svg"));
  const pngPath = path.join(__dirname, "icon.png");
  const icoPath = path.join(__dirname, "icon.ico");
  await sharp(svg).resize(512, 512).png().toFile(pngPath);
  await fs.writeFile(icoPath, await pngToIco(pngPath));
  console.log("DammPulse red desktop icons generated.");
}
main().catch(error => { console.error(error); process.exit(1); });
