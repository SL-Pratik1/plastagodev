/**
 * Captures the Weights screen for the driver handover update.
 *
 * ── Why this is not `capture-driver-handover.mjs` ──────────────────────────
 * That script drives the mock data layer, which was deleted in the cutover to
 * the real API: it types a fixed code and reads job ids out of a fixtures hook
 * that no longer exists. Rewriting all 57 shots against real data is a job in
 * itself, and only this one screen changed — so this captures that screen and
 * leaves the rest of the document's images alone.
 *
 * Needs, locally: the API on 4000 with AUTH_REVEAL_OTP_CODE=true and stub
 * providers, the driver app on 5174, and demo data seeded.
 *
 *   node scripts/capture-weights.mjs
 */
import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'driver-handover', 'screenshots');
const APP = process.env.DRIVER_BASE_URL ?? 'http://localhost:5174';
const API = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';

const MOBILE = '0455112233';
const WEIGHABLE_JOB = process.env.WEIGHTS_JOB_ID ?? '6aa3b5e24df9c15ca9034bad';

async function settle(page, extra = 400) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(extra);
}

/**
 * The code for the challenge THE BROWSER just created.
 *
 * Requesting one over a separate fetch mints a DIFFERENT challenge, and its
 * code is then rejected against the one the page is holding — so the value is
 * read off the page's own response instead.
 */
function awaitDevCode(page) {
  return page
    .waitForResponse(
      (res) => res.url().includes('/auth/otp/request') && res.request().method() === 'POST',
      { timeout: 20000 },
    )
    .then(async (res) => {
      const body = await res.json();
      if (!body.devCode) {
        throw new Error('No devCode in the response — is AUTH_REVEAL_OTP_CODE=true with stub providers? Got: ' + JSON.stringify(body));
      }
      return body.devCode;
    });
}

/**
 * A sticky header renders wherever the viewport happened to be when a
 * full-page screenshot is taken, so it slices through the middle of the
 * image. Pinning it static for the shot puts it back at the top where a
 * reader expects it.
 */
async function shoot(page, name) {
  await settle(page);
  const unpin = await page.addStyleTag({
    content: '.sticky { position: static !important; } .fixed { position: static !important; }',
  });
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  await unpin.evaluate((el) => { el.remove(); });
  process.stdout.write(`  ${name}.png
`);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const context = await browser.newContext({
  ...devices['iPhone 14 Pro'],
  locale: 'en-AU',
  timezoneId: 'Australia/Sydney',
  geolocation: { latitude: -33.9271, longitude: 150.8102 },
  permissions: ['geolocation'],
  colorScheme: 'light',
  serviceWorkers: 'block',
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
page.on('pageerror', (e) => process.stderr.write(`  ! ${e.message}\n`));

try {
  await page.goto(`${APP}/sign-in`);
  await settle(page);

  if (page.url().includes('sign-in')) {
    await page.fill('#driver-mobile', MOBILE);
    // Listen BEFORE the click, or the response can land before we are waiting.
    const pending = awaitDevCode(page);
    await page.getByRole('button', { name: /text me a code/i }).click();
    const code = await pending;
    process.stdout.write(`signing in with ${code}
`);
    await page.getByText(/6-digit code/i).waitFor();
    await page.keyboard.type(code);
    await page.waitForURL((url) => !url.pathname.includes('sign-in'));
  }
  await settle(page);
  process.stdout.write('signed in\n\n');

  const weights = `${APP}/jobs/${WEIGHABLE_JOB}/weights`;

  // 1 — the new per-bag screen, empty.
  await page.goto(weights);
  await shoot(page, 'after-weights-per-bag-empty');

  // 2 — filled in, so the derived total is visible.
  const boxes = page.locator('input[id^="weights-bag-"]');
  const n = await boxes.count();
  const readings = ['320', '290', '310', '340'];
  for (let i = 0; i < n; i += 1) await boxes.nth(i).fill(readings[i] ?? '300');
  await shoot(page, 'after-weights-per-bag-filled');

  // 3 — the count changed, so the number of boxes changes with it.
  await page.fill('#weights-bags', '6');
  await shoot(page, 'after-weights-count-changed');

  process.stdout.write('\ndone\n');
} finally {
  await browser.close();
}
