/**
 * Captures the driver screens that changed since the 25 September handover,
 * for `docs/driver-handover/MOBILE-HANDOVER-UPDATE-4.md`.
 *
 * The driver surface lives in apps/web now, so this drives that rather than the
 * old standalone PWA. It signs in for real and reads the code off the app's OWN
 * sign-in response: requesting one over a separate fetch mints a different
 * challenge whose code the page then rejects.
 *
 * Expects, on spare ports so a running dev stack is left alone:
 *   API      4731  — throwaway DB, stub providers, AUTH_REVEAL_OTP_CODE=true
 *   surface  5901  — VITE_API_PROXY_TARGET=http://localhost:4731
 *
 *   node apps/web/scripts/capture-handover-4.mjs [--headed]
 */
import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'driver-handover', 'screenshots');
const APP = process.env.DRIVER_BASE_URL ?? 'http://localhost:5901';
const MOBILE = '0455112233';

async function settle(page, extra = 500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(extra);
}

function awaitDevCode(page) {
  return page
    .waitForResponse(
      (res) => res.url().includes('/auth/otp/request') && res.request().method() === 'POST',
      { timeout: 20_000 },
    )
    .then(async (res) => {
      const body = await res.json();
      if (!body.devCode) throw new Error(`No devCode: ${JSON.stringify(body)}`);
      return body.devCode;
    });
}

/*
 * A sticky header and fixed tab bar render wherever the viewport happened to be
 * in a full-page shot, slicing through the middle of the image.
 */
async function shoot(page, name) {
  await settle(page);
  const unpin = await page.addStyleTag({
    content: '.sticky { position: static !important; } .fixed { display: none !important; }',
  });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  await unpin.evaluate((el) => {
    el.remove();
  });
  process.stdout.write(`  ${name}.png\n`);
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
page.setDefaultTimeout(25_000);
page.on('pageerror', (e) => process.stderr.write(`  ! ${e.message}\n`));

const failures = [];
async function shot(name, run) {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stderr.write(`  FAILED ${name} — ${error instanceof Error ? error.message : ''}\n`);
  }
}

/** The first stop on today's run sheet, read from the API the page just called. */
async function firstJobId() {
  if (process.env.JOB_ID) return process.env.JOB_ID;
  const res = await page.request.get(
    `${APP}/api/v1/driver/run-sheet?date=${new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })}`,
  );
  const sheet = await res.json();
    // Prefer a stop the driver has ARRIVED at: Unarrive only shows there.
  const arrived = sheet.stops?.find((stop) => stop.status === 'arrived');
  return (arrived ?? sheet.stops?.[0])?.jobId ?? null;
}

try {
  await page.goto(`${APP}/driver`);
  await settle(page);

  if (page.url().includes('sign-in')) {
    await page.fill('#identifier', MOBILE);
    const pending = awaitDevCode(page); // listen BEFORE the click
    await page.getByRole('button', { name: /^send code$/i }).click();
    const code = await pending;
    await page.waitForTimeout(1200);
    await page.keyboard.type(code);
    await page.waitForURL((url) => !url.pathname.includes('sign-in'));
  }
  await settle(page);
  process.stdout.write('signed in\n\n');

  await shot('run-sheet', async () => {
    await page.goto(`${APP}/driver`);
    await shoot(page, 'u4-run-sheet');
  });

  // The vehicle gate: the pre-start cannot start until a truck is chosen.
  await shot('pre-start-vehicle', async () => {
    await page.goto(`${APP}/driver/pre-start`);
    await shoot(page, 'u4-pre-start-choose-vehicle');
  });

  const jobId = await firstJobId();
  if (jobId === null) throw new Error('no stops on today — reseed');
  process.stdout.write(`job: ${jobId}\n`);

  await shot('job-detail', async () => {
    await page.goto(`${APP}/driver/jobs/${jobId}`);
    await shoot(page, 'u4-job-detail');
  });

  await shot('futile', async () => {
    await page.goto(`${APP}/driver/jobs/${jobId}/futile`);
    await shoot(page, 'u4-futile-reasons');
  });

  await shot('contamination', async () => {
    await page.goto(`${APP}/driver/jobs/${jobId}/contamination`);
    await shoot(page, 'u4-contamination-types');
  });

  await shot('risk-assessment', async () => {
    await page.goto(`${APP}/driver/jobs/${jobId}/risk-assessment`);
    await shoot(page, 'u4-risk-assessment');
  });

  if (failures.length > 0) {
    process.stderr.write(`\n${String(failures.length)} failed:\n${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\ndone\n');
  }
} finally {
  await browser.close();
}
