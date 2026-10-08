// Renders role-settings.html to role-settings.png. Needs Chromium and playwright-core
// (CHROMIUM_PATH overrides /usr/bin/chromium). Run: node docs/media/render-role-settings.mjs
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const html = fileURLToPath(new URL("role-settings.html", import.meta.url));
const png = fileURLToPath(new URL("role-settings.png", import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1.5 });
  await page.goto(`file://${html}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: png });
} finally {
  await browser.close();
}
