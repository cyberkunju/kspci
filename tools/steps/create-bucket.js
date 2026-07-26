'use strict';
/**
 * Create the Stratus bucket that holds the WhatsApp channel's face gallery.
 *
 * There is no CLI for Stratus, so this goes through the console like the Data Store
 * schema changes do. Idempotent: an existing bucket is reported and skipped.
 *
 * The three non-default settings are deliberate, and they are the reason this is a
 * step rather than a note in the docs telling someone to click through it:
 *
 *  - **Permission stays Authenticated, never Public.** A public bucket of face
 *    photographs collected by police is the single worst mistake available on this
 *    screen, and the option sits one radio button away from the default.
 *  - **Data Encryption on.** The contents are biometric images of identifiable
 *    people, encrypted at rest.
 *  - **PII/ePHI on.** They are personal data by any definition, so the bucket is
 *    marked as such and gets the compliance handling that goes with it.
 *
 * Versioning is left OFF on purpose. Re-enrolling a photo does not need history,
 * and every retained version is another copy of biometric data to protect; the
 * WaMessages ledger already records who enrolled what and when.
 *
 *   node tools/drive.js tools/steps/create-bucket.js ksp-field-photos
 *   node tools/drive.js tools/steps/create-bucket.js            # list only
 */
const { BASE } = require('./table-columns');

const ROUTE = BASE + '#/cloudscale/stratus';

/**
 * Bucket names from the listing grid, read out of the rendered text.
 *
 * Both structural approaches fail here. Hrefs are useless because every doc and help
 * link on the page also contains "stratus", so an href reader reports `introduction`
 * as a bucket. Cell selectors are useless because the grid is a lyte custom element
 * whose cells are not `td`/`role=gridcell` and whose text nodes are not reachable by
 * an exact-text query. The rendered text is the only honest view of it.
 */
async function bucketNames(page) {
  const text = await page.locator('body').innerText();
  const after = text.split(/Bucket Name\s*\t?\s*Created By/).pop();
  if (after === text) return [];
  return Array.from(new Set(
    after.split(/[\t\n]/).map((s) => s.trim())
      .filter((s) => /^[a-z0-9][a-z0-9._-]{2,62}$/.test(s) && !/@/.test(s))
  ));
}

async function open(page) {
  await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
}

/** Read the dialog's checkbox states from the underlying inputs, in DOM order. */
function toggleState(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 || e.offsetParent; })
    .map((e) => ({ id: e.id, checked: e.checked })));
}

module.exports = async (page, args) => {
  const name = args[0];
  await open(page);
  const existing = await bucketNames(page);
  if (!name) return { buckets: existing, hint: 'pass a bucket name to create one' };
  if (existing.includes(name)) return { bucket: name, status: 'already present', buckets: existing };

  // The empty state carries a hooked button; once a bucket exists the header button
  // has no data-zcqa at all, so fall back to the label.
  const create = page.locator('[data-zcqa="create_bucketBtn"]');
  await (await create.count()
    ? create.first()
    : page.getByRole('button', { name: 'Create Bucket', exact: true }).first()).click();
  await page.waitForTimeout(3500);

  await page.locator('#bucket_name').first().fill(name);

  // The two toggles are custom lyte elements whose shadow inputs share an id, so
  // they are driven by their own hooks and then verified from the inputs' state.
  const before = await toggleState(page);
  for (const hook of ['changeEncryption_radio', 'changeAudit_radio']) {
    const el = page.locator(`[data-zcqa="${hook}"]`).first();
    if (await el.count()) { await el.click(); await page.waitForTimeout(700); }
  }
  const after = await toggleState(page);
  const flipped = after.filter((a, i) => !before[i] || before[i].checked !== a.checked).length;

  // Confirm nothing selected Public. Fail before creating rather than after.
  const isPublic = await page.evaluate(() => /public/i.test(
    (document.querySelector('[data-zcqa="permission_template"] .selected, .lyte-radio[checked] ~ *') || {}).textContent || ''
  ));
  if (isPublic) throw new Error('refusing to create: permission template resolved to Public');

  await page.locator('[data-zcqa="commonForm_Create"]').first().click();
  await page.waitForTimeout(10000);

  await open(page);
  const now = await bucketNames(page);
  return {
    bucket: name,
    status: now.includes(name) ? 'created' : 'NOT VISIBLE after create',
    encryptionAndPiiToggled: flipped,
    toggles: after,
    buckets: now
  };
};
