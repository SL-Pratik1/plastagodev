const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');

const ADMIN_URL = 'http://localhost:5490';
const API = 'http://localhost:4300/api/v1';
const DEV_LOG = process.env.TEMP + '/dev.log';
const SHOTS = process.env.TEMP + '/qa-shots';

fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? '  → ' + detail : ''}`);
  }
};

/** Sign in through the real UI, reading the code out of the stub mailer's log. */
async function signIn(page) {
  await page.goto(`${ADMIN_URL}/auth/sign-in`, { waitUntil: 'networkidle' });

  const before = fs.readFileSync(DEV_LOG, 'utf8').length;
  await page.locator('#identifier').fill('matt@plastago.com.au');
  await page.getByRole('button', { name: /send code/i }).first().click();

  await page.waitForTimeout(2500);
  const tail = fs.readFileSync(DEV_LOG, 'utf8').slice(before);
  const code = [...tail.matchAll(/code is (\d{6})/g)].at(-1)?.[1];
  if (!code) throw new Error('no sign-in code appeared in the log');

  /* Six boxes, then the explicit Verify — it does not submit on its own. */
  const boxes = page.locator('input[inputmode="numeric"]');
  const count = await boxes.count();
  if (count > 1) {
    for (let i = 0; i < 6; i += 1) await boxes.nth(i).fill(code[i]);
  } else {
    await boxes.first().fill(code);
  }

  /* It auto-submits on the last digit; click only if it has not already gone. */
  await page.waitForTimeout(1200);
  if (page.url().includes('/auth/')) {
    const verify = page.getByRole('button', { name: /verify and sign in/i });
    if ((await verify.count()) > 0) await verify.click();
  }
  await page.waitForURL((url) => url.pathname.startsWith('/admin'), { timeout: 30000 });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160));
  });
  page.on('pageerror', (err) => consoleErrors.push('PAGE ERROR: ' + err.message.slice(0, 160)));

  try {
    console.log('\n── Signing in ─────────────────────────────────────────────────');
    await signIn(page);
    check('signed in through the UI', page.url().includes('/admin'), page.url());

    console.log('\n── Settings → Pricing: the Zones card ─────────────────────────');
    await page.goto(`${ADMIN_URL}/admin/settings?tab=pricing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const zonesCard = page.getByText('Service zones', { exact: true });
    check('the Zones card renders', (await zonesCard.count()) > 0);

    const body = await page.locator('body').innerText();
    check('it lists Sydney', body.includes('Sydney'));
    check('it lists the zone added during QA', body.includes('Central Coast'));
    check('it shows the immutable slug', body.includes('central-coast'));
    check('zone rows show their suburb and job counts', /\d+ suburbs? · \d+ jobs?/.test(body));
    check('each zone links to where its suburbs are managed', /Manage suburbs/.test(body));
    check('rate grids name zones, not ids', !/[0-9a-f]{24}/.test(body), (body.match(/[0-9a-f]{24}/) ?? [''])[0]);

    await page.screenshot({ path: `${SHOTS}/01-settings-zones.png`, fullPage: false });

    console.log('\n── The Suburbs screen ─────────────────────────────────────────');
    await page.goto(`${ADMIN_URL}/admin/suburbs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const subBody = await page.locator('body').innerText();
    check('the Suburbs page loads', /Suburbs/.test(subBody));
    check('rows show a suburb', /Kellyville|Oran Park|Gosford/.test(subBody));
    check('rows show the zone NAME', /Sydney|Central Coast/.test(subBody));
    check('no raw ObjectId leaks into the table', !/[0-9a-f]{24}/.test(subBody), (subBody.match(/[0-9a-f]{24}/) ?? [''])[0]);

    await page.screenshot({ path: `${SHOTS}/02-suburbs.png`, fullPage: false });

    /* The deep link from a zone row. */
    const zones = JSON.parse(
      execSync(
        `curl -s -b ${JSON.stringify(process.env.TEMP + '/qa.txt')} ${JSON.stringify(API + '/lookups/zones')}`,
        { encoding: 'utf8' },
      ),
    );
    const sydney = zones.find((z) => z.label === 'Sydney');
    await page.goto(`${ADMIN_URL}/admin/suburbs?zoneId=${sydney.value}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const filtered = await page.locator('body').innerText();
    check('the zone deep-link filters the table', /10 of/.test(filtered), (filtered.match(/\d+ of \d+/) ?? [''])[0]);

    console.log('\n── Screens that render a zone ─────────────────────────────────');
    for (const [label, path] of [
      ['jobs grid', '/admin/jobs'],
      ['dispatch board', '/admin/dispatch'],
      ['reports → zones', '/admin/reports?tab=zones'],
      ['leads queue', '/admin/queues/leads'],
      ['new customer', '/admin/customers/new'],
    ]) {
      await page.goto(ADMIN_URL + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      const text = await page.locator('body').innerText();

      const brokenState = /Something went wrong|Could not load|Unexpected error/i.test(text);
      const rawId = text.match(/\b[0-9a-f]{24}\b/);

      check(`${label} loads without an error state`, !brokenState);
      check(`${label} shows no raw zone ids`, rawId === null, rawId?.[0]);
    }

    await page.goto(`${ADMIN_URL}/admin/reports?tab=zones`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/03-reports-zones.png`, fullPage: false });

    console.log('\n── Browser console ────────────────────────────────────────────');
    const real = consoleErrors.filter((e) => !/favicon|manifest|sw\.js|workbox/i.test(e));
    check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
  } catch (error) {
    fail += 1;
    console.log(`\n  FAIL  the run itself threw → ${error.message.slice(0, 200)}`);
    await page.screenshot({ path: `${SHOTS}/99-failure.png` }).catch(() => undefined);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed   (screenshots in ${SHOTS})\n`);
})();
