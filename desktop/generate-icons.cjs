const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default || pngToIcoModule;

async function main() {
  const pngUrl = "https://raw.githubusercontent.com/tarik-ab/damm-pulse/main/damm-plus-app-icon.png";
  const response = await fetch(pngUrl);
  if (!response.ok) throw new Error(`Could not download Damm Plus icon: HTTP ${response.status}`);
  const source = Buffer.from(await response.arrayBuffer());
  const pngPath = path.join(__dirname, "icon.png");
  const icoPath = path.join(__dirname, "icon.ico");
  await sharp(source).resize(512, 512).png().toFile(pngPath);
  await fs.writeFile(icoPath, await pngToIco(pngPath));
  console.log("Damm Plus desktop icons generated from damm-plus-app-icon.png.");
}
main().catch(error => { console.error(error); process.exit(1); });
