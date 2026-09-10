import { chromium } from 'playwright';

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text()); });
page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
page.on('response', res => { if (res.status() >= 400 && !res.url().includes('favicon')) errors.push(`http ${res.status()}: ${res.url()}`); });

await page.goto('http://localhost:4317', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const views = ['projects', 'tasks', 'timeline', 'ask', 'models', 'settings', 'today'];
for (const view of views) {
  await page.click(`.nav[data-view="${view}"]`);
  await page.waitForTimeout(200);
}

// exercise a project detail view if one exists
await page.click('.nav[data-view="projects"]');
await page.waitForTimeout(200);
const viewProjectBtn = await page.$('#projectGrid [data-view-project]');
if (viewProjectBtn) { await viewProjectBtn.click(); await page.waitForTimeout(200); await page.click('#backProjects'); }

// timeline date nav
await page.click('.nav[data-view="timeline"]');
await page.click('#timelinePrev');
await page.waitForTimeout(300);
await page.click('#timelineToday');
await page.waitForTimeout(300);

// settings interactions
await page.click('.nav[data-view="settings"]');
await page.fill('#sensitiveTerms', 'testterm');
await page.click('#saveSensitiveTerms');
await page.waitForTimeout(300);

console.log('ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);


