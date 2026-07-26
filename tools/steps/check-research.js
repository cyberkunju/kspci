'use strict';
/**
 * Drive the Open Sources panel end to end in the deployed desk app.
 *
 * Verifies the parts the unit tests cannot: that the engine health probe reaches the
 * service through the function, that the purpose gate keeps the button disabled until it
 * is satisfied, that a real run streams its stages, and that the finished report renders
 * a graded source table plus an exportable PDF.
 *
 *   node tools/drive.js tools/steps/check-research.js [role] [subject] [kind]
 *
 * Default role is admin. A standard run takes 35-70 s, so the wait is generous.
 */
module.exports = async (page, args) => {
  const role = args[0] || 'admin';
  const subject = args[1] || 'Karnataka Lokayukta';
  const kind = args[2] || 'organisation';
  const out = { role, subject, kind };

  const url = 'https://ksp.cyberkunju.com/app/#/research';
  const already = page.url().startsWith('https://ksp.cyberkunju.com/app/');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // A goto that only changes the hash does not remount the SPA, so a second run inherits
  // the first run's filled form — which silently turns the purpose-gate assertion below
  // into a pass regardless. Force the reload.
  if (already) await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);

  // The role lives in React state, so it has to be set through the control.
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) {
    try { await sel.selectOption(role); } catch (_) {
      await sel.click(); await page.waitForTimeout(600);
      await page.locator(`li:has-text("${role}"), [role=option]:has-text("${role}")`).first().click();
    }
    await page.waitForTimeout(4000);
  }

  const body = () => page.evaluate(() => document.body.innerText);
  out.panelLoaded = /OPEN-SOURCE RESEARCH/i.test(await body());
  out.engineWarning = /research engine is not reachable/i.test(await body());

  const startButton = page.locator('button:has-text("Start research")').first();
  // Located by placeholder rather than by label→`for`: the Astryx field wrapper does not
  // guarantee a `for` on every input, and a label lookup that resolves to nothing fails
  // as a 45-second timeout that reads like the panel never rendered.
  const fill = (placeholder, value) =>
    page.locator(`[placeholder="${placeholder}"]`).first().fill(value);

  await fill('A name, a case, an event or an organisation', subject);
  await page.waitForTimeout(400);
  // The purpose gate: three words are required, and until then the button must stay off.
  out.blockedWithoutPurpose = await startButton.isDisabled().catch(() => null);

  const kindControl = page.locator('select, [role=combobox]')
    .filter({ hasNot: page.locator('.sidenav-role') });
  const kindSel = page.locator('.view select, .view [role=combobox]').first();
  if (await kindSel.count()) {
    try { await kindSel.selectOption(kind); } catch (_) {
      await kindSel.click(); await page.waitForTimeout(500);
      await page.locator(`[role=option]:has-text("${kind}"), li:has-text("${kind}")`)
        .first().click().catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  out.kindControls = await kindControl.count();

  await fill('Why this research is needed', 'verifying the desk research panel end to end');
  await page.waitForTimeout(600);
  out.enabledWithPurpose = !(await startButton.isDisabled().catch(() => true));

  if (!out.enabledWithPurpose) return { ...out, stopped: 'start button never enabled' };
  // `--form-only` checks the gates without spending a real run against live sources.
  if (args.includes('--form-only')) return out;

  await startButton.click();

  // Stages, while it runs. Proves the poll loop is live rather than a spinner.
  // Read the progress badges from the DOM rather than grepping the page text. Grepping
  // reported all five stages on a run that was refused before it started, because the
  // depth hint says "reads up to 48 sources" and "Plan" appears in the copy.
  const stagesSeen = new Set();
  const deadline = Date.now() + 240000;
  let finished = false;
  while (Date.now() < deadline) {
    // textContent, not innerText: the selector also matches the BadgeCheck <svg>, which
    // has no innerText at all.
    for (const s of await page.evaluate(() => [...document.querySelectorAll('[class*=badge]')]
      .map((b) => String(b.textContent || '').trim())
      .filter((t) => ['Plan', 'Discover', 'Read', 'Grade', 'Summarise'].includes(t)))) {
      stagesSeen.add(s);
    }
    const text = await body();
    if (/Sources \(\d+\)/.test(text) || /could not be completed/i.test(text)) { finished = true; break; }
    await page.waitForTimeout(4000);
  }
  out.stagesSeen = [...stagesSeen];
  out.finished = finished;

  out.render = await page.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/Sources \((\d+)\)/);
    return {
      sourceCount: m ? Number(m[1]) : 0,
      tableRows: document.querySelectorAll('table tbody tr').length,
      sourceLinks: document.querySelectorAll('a[href^="http"]').length,
      hasAnchorPanel: /How this run was anchored/i.test(txt),
      anchorBadge: (txt.match(/Strongly anchored|Partly anchored|Name only/) || [])[0] || '',
      hasSummary: /What the engine concluded|No source could be tied/i.test(txt),
      hasRecords: /FROM OUR OWN RECORDS/i.test(txt),
      hasDisclaimer: /Read this before acting/i.test(txt),
      hasExport: Boolean([...document.querySelectorAll('button')]
        .find((b) => /Export report/i.test(b.innerText))),
      confidenceBands: [...new Set((txt.match(/Confirmed|Probable|Possible|Different person|Unrelated/g) || []))],
      errors: (txt.match(/could not be loaded|No data|not reachable/gi) || []).length,
    };
  });

  // The export builds a branded HTML document, writes it into a new window and calls
  // print(). What can actually break is the document generation, on real data — a missing
  // field, an unescaped value, a findings array the template did not expect.
  //
  // So `window.open` is stubbed and the generated HTML captured instead of letting a real
  // window open. Not squeamishness: Chrome's print preview is modal, it blocks every
  // later evaluate on that tab, and one left behind wedges the next CDP step entirely.
  // What this does NOT cover is Chrome's own print rendering, which is not ours to test.
  const exportBtn = page.locator('button:has-text("Export report")').first();
  if (await exportBtn.count()) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.evaluate(() => {
      window.__exportHtml = '';
      window.open = () => ({
        document: { write: (h) => { window.__exportHtml += h; }, close() {} },
        focus() {}, print() {}, closed: false
      });
    });
    await exportBtn.click();
    await page.waitForTimeout(2000);
    out.export = await page.evaluate(() => {
      const html = window.__exportHtml || '';
      const text = html.replace(/<[^>]+>/g, ' ');
      return {
        chars: html.length,
        title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
        rows: (html.match(/<tr>/g) || []).length,
        hasAnchorLine: /Anchored on:/.test(text),
        hasBands: /Confirmed|Probable|Possible|Unrelated/.test(text),
        hasDisclaimer: /not evidence/i.test(text)
      };
    });
    out.export.pageErrors = errors;
  }

  return out;
};
