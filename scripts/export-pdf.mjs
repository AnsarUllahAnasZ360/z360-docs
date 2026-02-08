import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const browser = await puppeteer.launch();
const outDir = 'pdfs';

const urls = [
  '/docs',
  '/docs/architecture-diagrams',
  '/docs/system-context/system-architecture-unified',
  '/docs/platform-architectures/android-architecture-complete',
  '/docs/platform-architectures/ios-architecture-complete',
  '/docs/call-management/call-state-machine',
];

async function exportPdf(pathname) {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000' + pathname, {
    waitUntil: 'networkidle2',
  });

  await page.pdf({
    path: path.join(outDir, pathname.slice(1).replaceAll('/', '-') + '.pdf'),
    width: 950,
    printBackground: true,
  });

  console.log('PDF generated: ' + pathname);
  await page.close();
}

await fs.mkdir(outDir, { recursive: true });
await Promise.all(urls.map(exportPdf));
await browser.close();
