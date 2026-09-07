/**
 * Captures the driver PWA's screens for `docs/driver-handover/`.
 *
 * Every screenshot in the handover document comes from here, against the
 * fixtures in `apps/driver/src/services/mock/fixtures.ts`. Nothing is staged by
 * hand — a screen that cannot be reached by driving the real app is a screen the
 * document must not claim exists.
 *
 *   npm run dev:driver           # in one terminal, port 5174
 *   node scripts/capture-driver-handover.mjs
 *
 * Flags:
 *   --only=<substring>   capture just the shots whose name contains this
 *   --headed             watch it run
 */
import { chromium, devices } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'driver-handover', 'screenshots');
const BASE = process.env.DRIVER_BASE_URL ?? 'http://localhost:5174';

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const headed = process.argv.includes('--headed');

/* A real JPEG, so the camera inputs receive a genuine file rather than relying
 * on the demo's cancelled-picker fallback. 1×1 pixel is enough — the bytes are
 * irrelevant to everything these screens do with a photo. */
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAA' +
    'AAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/E' +
    'ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAA/9k=',
  'base64',
);

const WIDTH = 390;
const MIN_HEIGHT = 844;
const MAX_HEIGHT = 2600;

/** Wait for the app to settle: query resolved, mock latency spent, fonts in. */
async function settle(page, extra = 250) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(extra);
}

/**
 * Grow the viewport to the document height, then shoot the viewport.
 *
 * Not `fullPage`: the layout has a fixed bottom tab bar and a sticky header, and
 * Chromium's beyond-viewport capture paints fixed elements at the scroll origin —
 * which puts the tab bar through the middle of every long form. Sizing the
 * viewport to the content keeps both bars where a driver actually sees them.
 */
async function shoot(page, name, { width = WIDTH, keepToasts = false } = {}) {
  /* Toasts are fixed to the bottom of the screen and would cover the primary
   * action on any screen that has just saved something. Cleared unless the shot
   * is *about* the toast. */
  if (!keepToasts) {
    const dismiss = page.getByRole('button', { name: 'Dismiss' });
    for (let index = (await dismiss.count()) - 1; index >= 0; index -= 1) {
      await dismiss
        .nth(index)
        .click({ timeout: 2000 })
        .catch(() => {});
    }
    await page.waitForTimeout(200);
  }

  const height = await page.evaluate(
    () => document.documentElement.scrollHeight || document.body.scrollHeight,
  );
  await page.setViewportSize({
    width,
    height: Math.min(Math.max(Math.ceil(height), MIN_HEIGHT), MAX_HEIGHT),
  });
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await page.setViewportSize({ width: WIDTH, height: MIN_HEIGHT });
  process.stdout.write(`  ✓ ${name}.png\n`);
}

/** Type the OTP. The boxes are separate inputs, so one has to be focused first. */
async function typeCode(page, code) {
  await page.locator('input[inputmode="numeric"]').first().click();
  await page.keyboard.type(code, { delay: 40 });
}

/**
 * Sign in, if we are not already.
 *
 * Called from `open()` as well as from the sign-in shots. The guard matters: a
 * session that has been cleared for a screenshot must not silently turn every
 * later shot into a picture of the sign-in screen.
 */
async function signIn(page) {
  if (!page.url().includes('sign-in')) {
    await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
    await settle(page);
  }
  if (!page.url().includes('sign-in')) return;

  if ((await page.locator('#driver-mobile').count()) > 0) {
    await page.fill('#driver-mobile', '0455112233');
    await page.getByRole('button', { name: 'Text me a code' }).click();
    await page.getByText('We texted a 6-digit code').waitFor();
  }
  await typeCode(page, '123456');
  await page.waitForURL((url) => !url.pathname.includes('sign-in'), { timeout: 15_000 });
  await settle(page);
}

/** Navigate with a scenario, from a clean slate every time. */
async function open(page, scenario, route = '/') {
  const url = `${BASE}${route}${route.includes('?') ? '&' : '?'}scenario=${scenario}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);

  // The guard: never screenshot a redirect.
  if (page.url().includes('sign-in')) {
    await signIn(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
  }
}

const jobRoute = (jobs, jobNumber, suffix = '') => `/jobs/${jobs[jobNumber]}${suffix}`;

/* ── The shots ───────────────────────────────────────────────────────────── */

function buildShots(jobs) {
  return [
    /* ── 1 · Sign in ───────────────────────────────────────────────────── */
    {
      name: '01-sign-in-mobile',
      async run(page) {
        await page.context().clearCookies();
        await page.goto(`${BASE}/sign-in`);
        await page.evaluate(() => {
          window.localStorage.removeItem('plastago.driver.session');
          window.localStorage.removeItem('plastago.driver.challenge');
        });
        await page.reload();
        await settle(page);
        await shoot(page, '01-sign-in-mobile');
      },
    },
    {
      name: '02-sign-in-unknown-number',
      async run(page) {
        await page.fill('#driver-mobile', '0499000111');
        await page.getByRole('button', { name: 'Text me a code' }).click();
        await page.getByText('We do not have that number').waitFor();
        await shoot(page, '02-sign-in-unknown-number');
      },
    },
    {
      name: '03-sign-in-code',
      async run(page) {
        await page.fill('#driver-mobile', '0455 112 233');
        await page.getByRole('button', { name: 'Text me a code' }).click();
        await page.getByText('We texted a 6-digit code').waitFor();
        await settle(page, 120);
        await shoot(page, '03-sign-in-code');
      },
    },
    {
      name: '04-sign-in-code-wrong',
      async run(page) {
        await typeCode(page, '000000');
        await page.getByText('That code is not right').waitFor({ timeout: 10_000 });
        await shoot(page, '04-sign-in-code-wrong');
      },
    },
    {
      name: '05-sign-in-success',
      async run(page) {
        await signIn(page);
        await shoot(page, '05-sign-in-success');
      },
    },

    /* ── 2 · Run sheet ─────────────────────────────────────────────────── */
    {
      name: '10-run-sheet-start-of-day',
      async run(page) {
        await open(page, 'fresh');
        await shoot(page, '10-run-sheet-start-of-day');
      },
    },
    {
      name: '11-run-sheet-mid-run',
      async run(page) {
        await open(page, 'mid-run');
        await shoot(page, '11-run-sheet-mid-run');
      },
    },
    {
      name: '12-run-sheet-end-of-run',
      async run(page) {
        await open(page, 'end-of-run');
        await shoot(page, '12-run-sheet-end-of-run');
      },
    },
    {
      name: '13-run-sheet-closed-out',
      async run(page) {
        await open(page, 'finished');
        await shoot(page, '13-run-sheet-closed-out');
      },
    },
    {
      name: '14-run-sheet-no-run',
      async run(page) {
        await open(page, 'empty');
        await shoot(page, '14-run-sheet-no-run');
      },
    },

    /* ── 3 · Pre-start ─────────────────────────────────────────────────── */
    {
      name: '20-pre-start-empty',
      async run(page) {
        await open(page, 'fresh', '/pre-start');
        await shoot(page, '20-pre-start-empty');
      },
    },
    {
      name: '21-pre-start-validation',
      async run(page) {
        await open(page, 'fresh', '/pre-start');
        await page.getByRole('button', { name: 'Finish pre-start' }).click();
        await page.getByText('checks not answered yet').waitFor();
        await shoot(page, '21-pre-start-validation');
      },
    },
    {
      name: '22-pre-start-problem-found',
      async run(page) {
        await open(page, 'fresh', '/pre-start');
        const items = page.locator('ul > li.rounded-xl');
        const count = await items.count();
        for (let index = 0; index < count; index += 1) {
          await items
            .nth(index)
            .getByRole('button', { name: index === 0 ? 'Problem' : 'Pass' })
            .click();
        }
        await page.fill('#prestart-note-tyres', 'Nearside rear tyre down to the wear bars.');
        await page.fill('#prestart-odometer', '284915');
        await shoot(page, '22-pre-start-problem-found');
      },
    },
    {
      name: '23-pre-start-ready-to-submit',
      async run(page) {
        await open(page, 'fresh', '/pre-start');
        const items = page.locator('ul > li.rounded-xl');
        const count = await items.count();
        for (let index = 0; index < count; index += 1) {
          await items
            .nth(index)
            .getByRole('button', { name: index === 4 ? 'N/A' : 'Pass' })
            .click();
        }
        await page.fill('#prestart-odometer', '284915');
        await page.locator('#prestart-declaration').check();
        await shoot(page, '23-pre-start-ready-to-submit');
      },
    },

    /* ── 4 · Job detail ────────────────────────────────────────────────── */
    {
      name: '30-job-assigned',
      async run(page) {
        await open(page, 'fresh', jobRoute(jobs, 61528));
        await shoot(page, '30-job-assigned');
      },
    },
    {
      name: '31-job-in-transit-no-contact',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61533));
        await shoot(page, '31-job-in-transit-no-contact');
      },
    },
    {
      name: '32-job-arrived-blocked',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528));
        await shoot(page, '32-job-arrived-blocked');
      },
    },
    {
      name: '33-job-arrived-ready-to-complete',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61535));
        await shoot(page, '33-job-arrived-ready-to-complete');
      },
    },
    {
      name: '34-job-complete-dialog',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61535));
        await page
          .getByRole('button', { name: /Complete job/ })
          .first()
          .click();
        await page.getByRole('dialog').waitFor();
        await settle(page, 200);
        await shoot(page, '34-job-complete-dialog');
      },
    },
    {
      name: '35-job-message-dialog',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61535));
        await page.getByRole('button', { name: /Message the office/ }).click();
        await page.getByRole('dialog').waitFor();
        await page.fill(
          '#driver-message',
          'Gate is locked and nobody is answering. Waiting out front.',
        );
        await shoot(page, '35-job-message-dialog');
      },
    },
    {
      name: '36-job-sra-uploaded',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61544));
        await shoot(page, '36-job-sra-uploaded');
      },
    },
    {
      name: '37-job-sra-upload-failed',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61547));
        await shoot(page, '37-job-sra-upload-failed');
      },
    },
    {
      name: '38-job-sra-preparing-unsafe',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61550));
        await shoot(page, '38-job-sra-preparing-unsafe');
      },
    },
    {
      name: '39-job-completed',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61537));
        await shoot(page, '39-job-completed');
      },
    },
    {
      name: '40-job-futile',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61539));
        await shoot(page, '40-job-futile');
      },
    },
    {
      name: '41-job-cancelled',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61541));
        await shoot(page, '41-job-cancelled');
      },
    },
    {
      name: '42-job-booked-message-thread',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61553));
        await shoot(page, '42-job-booked-message-thread');
      },
    },
    {
      name: '43-job-empty-data',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61556));
        await shoot(page, '43-job-empty-data');
      },
    },

    /* ── 5 · Photos ────────────────────────────────────────────────────── */
    {
      name: '50-photos-none-taken',
      async run(page) {
        await open(page, 'fresh', jobRoute(jobs, 61528, '/photos'));
        await shoot(page, '50-photos-none-taken');
      },
    },
    {
      name: '51-photos-partly-done',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/photos'));
        await shoot(page, '51-photos-partly-done');
      },
    },
    {
      name: '52-photos-all-done',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61521, '/photos'));
        await shoot(page, '52-photos-all-done');
      },
    },
    {
      name: '53-photos-after-capture',
      async run(page) {
        await open(page, 'fresh', jobRoute(jobs, 61528, '/photos'));
        await page.locator('ul > li').first().getByRole('button', { name: 'Take' }).click();
        await page.getByText('Photo saved on this phone').waitFor({ timeout: 8000 });
        await settle(page, 200);
        await shoot(page, '53-photos-after-capture', { keepToasts: true });
      },
    },

    /* ── 6 · Weights ───────────────────────────────────────────────────── */
    {
      name: '60-weights-bagged-weighable',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/weights'));
        await shoot(page, '60-weights-bagged-weighable');
      },
    },
    {
      name: '61-weights-validation',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/weights'));
        await page.fill('#weights-bags', '900');
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByText('Whole bags, 0 to 200').waitFor();
        await shoot(page, '61-weights-validation');
      },
    },
    {
      name: '62-weights-square-metres-only',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61535, '/weights'));
        await shoot(page, '62-weights-square-metres-only');
      },
    },
    {
      name: '63-weights-hand-load',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61533, '/weights'));
        await shoot(page, '63-weights-hand-load');
      },
    },

    /* ── 7 · Could not collect ─────────────────────────────────────────── */
    {
      name: '70-futile-empty',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61533, '/futile'));
        await shoot(page, '70-futile-empty');
      },
    },
    {
      name: '71-futile-ready-to-report',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/futile'));
        await page.getByText('Truck access blocked').click();
        await page.fill(
          '#futile-note',
          'Rang Sione twice, no answer. Gate padlocked and no other access.',
        );
        await shoot(page, '71-futile-ready-to-report');
      },
    },

    /* ── 8 · Contamination ─────────────────────────────────────────────── */
    {
      name: '80-contamination-empty',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/contamination'));
        await shoot(page, '80-contamination-empty');
      },
    },
    {
      name: '81-contamination-ready-to-report',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/contamination'));
        await page.getByText('Timber offcuts').click();
        await page.getByText('Moderate — through part of the load').click();
        await page.getByRole('button', { name: 'Take' }).click();
        await page.waitForTimeout(1500);
        await page.fill('#contamination-note', 'Timber offcuts right through the second bag.');
        await settle(page, 200);
        await shoot(page, '81-contamination-ready-to-report');
      },
    },

    /* ── 9 · Site risk assessment ──────────────────────────────────────── */
    {
      name: '90-risk-required-empty',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/risk-assessment'));
        await shoot(page, '90-risk-required-empty');
      },
    },
    {
      name: '91-risk-optional',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61535, '/risk-assessment'));
        await shoot(page, '91-risk-optional');
      },
    },
    {
      name: '92-risk-validation',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/risk-assessment'));
        await page.getByRole('button', { name: 'Save and start work' }).click();
        await page.getByText('Tick what you can see').waitFor();
        await shoot(page, '92-risk-validation');
      },
    },
    {
      name: '93-risk-filled-in',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/risk-assessment'));
        await page.getByText('Overhead powerlines').click();
        await page.getByText('Other trades working nearby').click();
        await page.getByText('Exclusion zone set up').click();
        await page.getByText('Spotter used').click();
        await page.fill('input[aria-label="Builder\'s site code"]', 'DOM-CF-1097');
        await shoot(page, '93-risk-filled-in');
      },
    },
    {
      name: '94-risk-unsafe-site',
      async run(page) {
        await open(page, 'mid-run', jobRoute(jobs, 61528, '/risk-assessment'));
        await page.getByText('Overhead powerlines').click();
        await page.getByText('Work stopped — unsafe to proceed').click();
        await page.locator('#risk-safe').check();
        await page.getByRole('button', { name: 'Report unsafe site' }).click();
        await page.getByText('If it is not safe, say why').waitFor();
        await shoot(page, '94-risk-unsafe-site');
      },
    },

    /* ── 10 · Tip-off ──────────────────────────────────────────────────── */
    {
      name: '100-tipoff-empty',
      async run(page) {
        await open(page, 'end-of-run', '/tip-off');
        await shoot(page, '100-tipoff-empty');
      },
    },
    {
      name: '101-tipoff-reconciliation',
      async run(page) {
        await open(page, 'end-of-run', '/tip-off');
        await page.fill('#tipoff-total', '4180');
        await page.fill('#tipoff-docket', 'WB-449201');
        await page.getByRole('button', { name: 'Take' }).click();
        await page.waitForTimeout(1200);
        await settle(page, 400);
        // 430px — the reconciliation table is the one screen that needs a wide phone.
        await shoot(page, '101-tipoff-reconciliation', { width: 430 });
      },
    },
    {
      name: '102-tipoff-impossible-figure',
      async run(page) {
        await open(page, 'end-of-run', '/tip-off');
        await page.fill('#tipoff-total', '400');
        await settle(page, 600);
        await shoot(page, '102-tipoff-impossible-figure', { width: 430 });
      },
    },
    {
      name: '103-tipoff-validation',
      async run(page) {
        await open(page, 'end-of-run', '/tip-off');
        await page.getByRole('button', { name: 'Record the tip-off' }).click();
        await page.getByText('Enter the weighbridge figure in kilograms').waitFor();
        await shoot(page, '103-tipoff-validation');
      },
    },
    {
      name: '104-tipoff-already-recorded',
      async run(page) {
        await open(page, 'finished', '/tip-off');
        await shoot(page, '104-tipoff-already-recorded');
      },
    },

    /* ── 11 · Report a defect ──────────────────────────────────────────── */
    {
      name: '110-defect-empty',
      async run(page) {
        await open(page, 'mid-run', '/report');
        await shoot(page, '110-defect-empty');
      },
    },
    {
      name: '111-defect-validation',
      async run(page) {
        await open(page, 'mid-run', '/report');
        await page.getByRole('button', { name: 'Send to the office' }).click();
        await page.getByText('How bad is it?').last().waitFor();
        await shoot(page, '111-defect-validation');
      },
    },
    {
      name: '112-defect-unroadworthy',
      async run(page) {
        await open(page, 'mid-run', '/report');
        await page.getByText('Unsafe to drive').click();
        await page.fill('#defect-summary', 'Nearside rear tyre worn to the bars');
        await page.fill(
          '#defect-detail',
          'Started making a noise on the way to Austral. Worse under load.',
        );
        await page.getByRole('button', { name: 'Take' }).click();
        await page.waitForTimeout(1200);
        await settle(page, 200);
        await shoot(page, '112-defect-unroadworthy');
      },
    },
  ];
}

/* ── Runner ──────────────────────────────────────────────────────────────── */

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: WIDTH, height: MIN_HEIGHT },
    deviceScaleFactor: 2,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    geolocation: { latitude: -33.9271, longitude: 150.8102 },
    permissions: ['geolocation'],
    colorScheme: 'light',
    // The dev service worker reloads the page once on registration, which races
    // every locator on the first shot.
    serviceWorkers: 'block',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('filechooser', (chooser) => {
    void chooser.setFiles({ name: 'site.jpg', mimeType: 'image/jpeg', buffer: PIXEL_JPEG });
  });
  page.on('pageerror', (error) => {
    process.stderr.write(`  ! page error: ${error.message}\n`);
  });

  /* Sign in once. Every later shot reuses the session in localStorage. */
  await page.goto(`${BASE}/sign-in`);
  await settle(page);
  if (page.url().includes('sign-in')) {
    await page.fill('#driver-mobile', '0455112233');
    await page.getByRole('button', { name: 'Text me a code' }).click();
    await page.getByText('We texted a 6-digit code').waitFor();
    await page.keyboard.type('123456');
    await page.waitForURL((url) => !url.pathname.includes('sign-in'));
  }
  await settle(page);

  /* The fixtures, straight out of the running app. */
  const seed = await page.evaluate(() => window.__PLASTAGO_DRIVER_SEED__?.() ?? null);
  if (seed === null) throw new Error('The dev build did not expose __PLASTAGO_DRIVER_SEED__');

  const jobs = Object.fromEntries(
    seed.data['mid-run'].jobs.map((job) => [job.jobNumber, job.jobId]),
  );

  await writeFile(
    path.join(ROOT, 'docs', 'driver-handover', 'seed-data.json'),
    `${JSON.stringify(seed, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`Wrote seed-data.json (${Object.keys(jobs).length} jobs per scenario)\n`);

  const shots = buildShots(jobs).filter((shot) => only === undefined || shot.name.includes(only));
  const failures = [];

  for (const shot of shots) {
    try {
      await shot.run(page);
    } catch (error) {
      failures.push(`${shot.name}: ${error.message.split('\n')[0]}`);
      process.stderr.write(`  ✗ ${shot.name} — ${error.message.split('\n')[0]}\n`);
      // A failed shot must not poison the next one.
      await page.goto(`${BASE}/`).catch(() => {});
      await settle(page).catch(() => {});
    }
  }

  await browser.close();

  process.stdout.write(
    `\n${String(shots.length - failures.length)}/${String(shots.length)} captured\n`,
  );
  if (failures.length > 0) {
    process.stderr.write(`\nFailed:\n${failures.map((line) => `  ${line}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

await main();
