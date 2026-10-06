// Renders build/icon.svg to build/icon.png (1024x1024) with headless Chromium. electron-builder turns the PNG into .icns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
const exe = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: path.join(root, 'build/icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log('wrote build/icon.png');
