'use strict';

/**
 * The field channel's message pack — every string an officer can see, in English,
 * Kannada and Hindi.
 *
 * Why a pack instead of inline strings: the single worst failure a bilingual bot
 * can commit is being written to in Kannada and answering in English. That only
 * stays fixed if every user-facing string is reachable in both languages, which
 * means none of them may be inline. `scripts/lint-banned-phrases.mjs` enforces
 * the other half: no runtime module may contain an English dead-end phrase.
 *
 * Two rules every entry follows:
 *
 *  1. NEVER DEAD-END. A failure reply must say what happened, take the blame if
 *     it is ours, and offer one or two concrete next moves. "I didn't understand"
 *     with nothing after it is the phrase that makes officers stop using a tool.
 *
 *  2. CODE-MIX ON PURPOSE. Police vocabulary — FIR, CrimeNo, district, OCR — stays
 *     in English inside Kannada copy, because that is how Karnataka officers
 *     actually speak and write it. Translating "FIR" helps nobody.
 */

const EN = {
  /* --- access + throttle --------------------------------------------------- */
  unregistered: 'This number is not registered for KSP Field Intelligence. Contact your control room to be added.',
  throttled: (limit) => `You have hit the hourly limit of ${limit} messages on this channel. It resets at the top of the hour — contact your control room directly if this is urgent.`,
  restricted: (role) => `That needs higher access than the ${role} role. Your control room can request it. I can still pull case details, prior offences and area alerts for you.`,

  /* --- open frames -------------------------------------------------------- */
  frameCancelled: 'Dropped that question. Send whatever you need next — a name, an FIR number, or a photo.',
  frameError: 'Something glitched handling your answer — that is on my side. Send it once more.',
  frameMaxRetriesSuffix: '\n\n(Leaving that one for now. Start fresh whenever you are ready.)',
  framePickPrompt: (prompt, options) =>
    `${prompt}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nReply with the number, or "cancel".`,
  frameUnknownPick: (options) =>
    `I could not tell which one you meant. Reply with a number from 1 to ${options.length}, or "cancel".`,

  /* --- media -------------------------------------------------------------- */
  imageAck: (seen) => {
    if (seen.faces === 1) return '📷 Got the photo — one face in frame.';
    if (seen.faces > 1) return `📷 Got the photo — ${seen.faces} faces in frame.`;
    return '📷 Got the photo.';
  },
  imageUnreadable: 'I could not read anything usable from it. A straighter, closer shot in better light usually works — or type what you need.',
  voiceUnclear: 'I could not make out that voice note. Try again somewhere quieter, or type it.',
  voiceFailed: 'I could not transcribe that voice note. Type your request and I will take it from there.',
  mediaTooLarge: 'That file is too large — send one under 8 MB.',
  mediaDownloadFailed: 'That attachment did not come through from WhatsApp. Send it again.',
  unsupportedType: (kind) => `I can work with text, voice notes, photos, PDFs and a shared location. ${kind ? `A ${kind} message` : 'That'} is not something I can read — send it in one of those forms.`,
  locationNote: (near, km) => `(Officer shared their location. Nearest district centroid: ${near}, about ${km} km away. Treat this as their approximate area.)`,
  locationUnmatched: '(Officer shared a location that could not be matched to a district.)',

  /* --- identification ----------------------------------------------------- */
  idNoFace: 'No face in that photo. If it is a document, FIR copy or number plate, send it again and say "read this" — I will run OCR instead.',
  idMultipleFaces: (n) => `That photo has ${n} faces, so a comparison could latch onto the wrong person. Send a single-person shot.`,
  idEmptyGallery: 'There are no reference photos enrolled yet, so there is nothing to compare against. Send a photo with a name and FIR to enrol the first one — every enrolment makes the next check work.',
  idNoMatch: (compared) => `No candidate above the reporting threshold — compared against ${compared} enrolled photo${compared === 1 ? '' : 's'}. That is not a clearance: the person may simply not be enrolled. Verify by document.`,
  idNeverProof: 'A photo comparison is a lead for verification, never an identification, and never grounds for action on its own. Confirm against a document or record.',

  /* --- enrolment ---------------------------------------------------------- */
  enrollNeedName: 'Tell me the person\'s name to enrol that photo against — and the FIR number if you have it, so a later match carries the case with it.',
  enrolled: (name, crimeNo) => `Enrolled that photo for *${name}*${crimeNo ? ` against ${crimeNo}` : ''}.`,
  enrollStale: 'That confirmation is from an older message, so I did not act on it. Here is the current one.',
  tapStale: 'That button belongs to an older message, so I did not act on it — tapping an old question is how the wrong record gets touched. Send what you need again.',

  /* --- alerts ------------------------------------------------------------- */
  alertsUpdated: (districts, severity) => `Alerts set: *${districts}* at *${severity}* and above.`,
  alertsOff: 'Alerts off. Send "alert me about <district>" whenever you want them back.',
  alertBody: (a, horizon, advisory) => [
    `*${a.severity.toUpperCase()} — ${a.district}*`,
    `Forecast for ${horizon}: *${a.predicted}* cases vs baseline ${a.baseline} (${a.trendPct >= 0 ? '+' : ''}${a.trendPct}%, z=${a.z}).`,
    advisory,
    '',
    '_Decision support for deployment planning only — not grounds for action against any individual. Reply for detail, or send "alerts off" to unsubscribe._'
  ].join('\n'),

  /* --- setup (reset → language → role) ------------------------------------ */
  languageSet: (name) => `Language set to *${name}*. I will stay in it unless you write to me in another script, or ask me to change.`,
  askRole: 'Which access context should I use? This decides what I can show you — risk scores, associate networks and financial trails need analyst or above.',
  onboardReady: (name, role) => `Ready, ${name}. Access context: *${role}*.\n\nAlerts and scheduled briefings will reach you here from now on.`,
  onboardAbandoned: 'Left your setup as it was. Send "reset" whenever you want to run through it again.',
  roleSelfDisabled: 'Your access context is set by your control room on this deployment, so I have left it alone.',
  languageOnly: (name) => `Language set to *${name}*. Everything else is unchanged.`,

  /* --- open-source research ----------------------------------------------- */
  // The officer must be told two things and no more: that it is running, and roughly how
  // long. A progress promise with no time attached is what makes people send the request
  // again, which costs the instance two runs.
  researchWait: (subject) => `Searching the open internet for *${subject}* now — news, court and government sources in English, Hindi and Kannada, plus whatever our own records hold. About a minute. I will send the findings here; you do not need to wait or ask again.`,
  researchWaitDeep: (subject) => `Running a *deep* search on *${subject}* — the same sources, read much wider. Up to five minutes. I will send the findings here when they are in; carry on with anything else meanwhile.`,

  /* --- undo --------------------------------------------------------------- */
  undoHint: (token) => `\n\n_Undo: reply ${token}_`,
  undoDone: (what) => `↩️ Reversed ${what}.`,
  undoNotFound: 'I could not find that undo code. It may have expired, or already been used.',
  undoAlready: 'That one was already reversed.',

  /* --- refused actions ---------------------------------------------------- */
  refusedNegated: 'Your message said not to do that, so I have not. Tell me plainly what you do want and I will carry it out — or send it again without the "don\'t" if that was a slip.',
  refusedHypothetical: 'That reads as a question about what would happen rather than an instruction, so I have not done anything. If you do want it done, say so directly and I will.',

  /* --- failure + fallback ------------------------------------------------- */
  engineError: 'Something broke on my side handling that — not your message. Send it again and I will retry.',
  timeout: 'That took too long to come back. Send it again.',
  notUnderstood: 'I want to get this right and I am not sure what you need. I can pull a case by FIR number, a person\'s prior offences by name, read a document photo, check who a photo might match, or give you the alert picture for a district. Which of those?',
  groundingBlocked: 'I could not confirm that against the records, so I am not going to give you numbers I cannot stand behind. Tell me the FIR number or the exact name and I will pull the real figures.',
  helpCard: `*KSP Field Intelligence*\n\nJust say what you need — no commands.\n\n- "any history on Suresh Kumar"\n- "status of FIR 4021/2026"\n- send a photo of a person → possible matches\n- send a photo + "save as Suresh Kumar in FIR 4021/2026" → enrol it\n- send a photo of a document → I read it and look it up\n- "what's flagged in Mysuru next month"\n- "alert me about Ballari" / "alerts off"\n\nVoice notes and shared locations work too. Everything here is logged against your name.`
};

const KN = {
  unregistered: 'ಈ ನಂಬರ್ KSP Field Intelligence ಗೆ ನೋಂದಾಯಿಸಿಲ್ಲ. ಸೇರಿಸಲು ನಿಮ್ಮ control room ಸಂಪರ್ಕಿಸಿ.',
  throttled: (limit) => `ಈ ಚಾನೆಲ್‌ನಲ್ಲಿ ಗಂಟೆಗೆ ${limit} ಸಂದೇಶಗಳ ಮಿತಿ ತಲುಪಿದೆ. ಮುಂದಿನ ಗಂಟೆಗೆ ಮರುಹೊಂದಿಸುತ್ತದೆ — ತುರ್ತಾಗಿದ್ದರೆ ನೇರವಾಗಿ control room ಸಂಪರ್ಕಿಸಿ.`,
  restricted: (role) => `ಇದಕ್ಕೆ ${role} ಪಾತ್ರಕ್ಕಿಂತ ಹೆಚ್ಚಿನ access ಬೇಕು. ನಿಮ್ಮ control room ಅದನ್ನು ಕೇಳಬಹುದು. ಪ್ರಕರಣದ ವಿವರ, ಹಿಂದಿನ ಅಪರಾಧಗಳು ಮತ್ತು ಪ್ರದೇಶದ alerts ನಾನು ಈಗಲೂ ಕೊಡಬಲ್ಲೆ.`,

  frameCancelled: 'ಆ ಪ್ರಶ್ನೆ ಬಿಟ್ಟುಬಿಟ್ಟೆ. ಮುಂದೆ ಏನು ಬೇಕೋ ಕಳುಹಿಸಿ — ಹೆಸರು, FIR ನಂಬರ್, ಅಥವಾ ಫೋಟೋ.',
  frameError: 'ನಿಮ್ಮ ಉತ್ತರ ನಿರ್ವಹಿಸುವಾಗ ದೋಷ ಆಯಿತು — ಅದು ನನ್ನ ಕಡೆಯ ತಪ್ಪು. ಇನ್ನೊಮ್ಮೆ ಕಳುಹಿಸಿ.',
  frameMaxRetriesSuffix: '\n\n(ಅದನ್ನು ಸದ್ಯಕ್ಕೆ ಬಿಡುತ್ತೇನೆ. ಸಿದ್ಧವಾದಾಗ ಹೊಸದಾಗಿ ಶುರು ಮಾಡಿ.)',
  framePickPrompt: (prompt, options) =>
    `${prompt}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nಸಂಖ್ಯೆ ಕಳುಹಿಸಿ, ಅಥವಾ "cancel".`,
  frameUnknownPick: (options) =>
    `ಯಾವುದು ಎಂದು ತಿಳಿಯಲಿಲ್ಲ. 1 ರಿಂದ ${options.length} ರವರೆಗಿನ ಸಂಖ್ಯೆ ಕಳುಹಿಸಿ, ಅಥವಾ "cancel".`,

  imageAck: (seen) => {
    if (seen.faces === 1) return '📷 ಫೋಟೋ ಸಿಕ್ಕಿತು — ಒಂದು ಮುಖ ಕಾಣುತ್ತಿದೆ.';
    if (seen.faces > 1) return `📷 ಫೋಟೋ ಸಿಕ್ಕಿತು — ${seen.faces} ಮುಖಗಳು ಕಾಣುತ್ತಿವೆ.`;
    return '📷 ಫೋಟೋ ಸಿಕ್ಕಿತು.';
  },
  imageUnreadable: 'ಅದರಿಂದ ಉಪಯುಕ್ತವಾದದ್ದು ಏನೂ ಓದಲಾಗಲಿಲ್ಲ. ಹತ್ತಿರದಿಂದ, ನೇರವಾಗಿ, ಒಳ್ಳೆಯ ಬೆಳಕಿನಲ್ಲಿ ತೆಗೆದ ಫೋಟೋ ಸಾಮಾನ್ಯವಾಗಿ ಕೆಲಸ ಮಾಡುತ್ತದೆ — ಅಥವಾ ಬೇಕಾದದ್ದನ್ನು ಟೈಪ್ ಮಾಡಿ.',
  voiceUnclear: 'ಆ voice note ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ಶಾಂತವಾದ ಜಾಗದಲ್ಲಿ ಪುನಃ ಪ್ರಯತ್ನಿಸಿ, ಅಥವಾ ಟೈಪ್ ಮಾಡಿ.',
  voiceFailed: 'ಆ voice note ಬರಹಕ್ಕೆ ಪರಿವರ್ತಿಸಲಾಗಲಿಲ್ಲ. ನಿಮ್ಮ ವಿನಂತಿ ಟೈಪ್ ಮಾಡಿ, ಮುಂದೆ ನಾನು ನೋಡಿಕೊಳ್ಳುತ್ತೇನೆ.',
  mediaTooLarge: 'ಆ ಫೈಲ್ ತುಂಬಾ ದೊಡ್ಡದು — 8 MB ಗಿಂತ ಕಡಿಮೆ ಇರುವುದನ್ನು ಕಳುಹಿಸಿ.',
  mediaDownloadFailed: 'ಆ attachment WhatsApp ನಿಂದ ಬರಲಿಲ್ಲ. ಇನ್ನೊಮ್ಮೆ ಕಳುಹಿಸಿ.',
  unsupportedType: (kind) => `ನಾನು ಪಠ್ಯ, voice note, ಫೋಟೋ, PDF ಮತ್ತು ಹಂಚಿದ location ನಿರ್ವಹಿಸಬಲ್ಲೆ. ${kind ? `${kind} ಸಂದೇಶ` : 'ಅದು'} ನನಗೆ ಓದಲು ಸಾಧ್ಯವಿಲ್ಲ — ಈ ರೂಪಗಳಲ್ಲಿ ಒಂದರಲ್ಲಿ ಕಳುಹಿಸಿ.`,
  locationNote: (near, km) => `(ಅಧಿಕಾರಿ location ಹಂಚಿದ್ದಾರೆ. ಹತ್ತಿರದ ಜಿಲ್ಲಾ ಕೇಂದ್ರ: ${near}, ಸುಮಾರು ${km} ಕಿ.ಮೀ. ಇದನ್ನು ಅವರ ಸರಿಸುಮಾರು ಪ್ರದೇಶ ಎಂದು ಪರಿಗಣಿಸಿ.)`,
  locationUnmatched: '(ಅಧಿಕಾರಿ ಹಂಚಿದ location ಜಿಲ್ಲೆಗೆ ಹೊಂದಿಸಲಾಗಲಿಲ್ಲ.)',

  idNoFace: 'ಆ ಫೋಟೋದಲ್ಲಿ ಮುಖ ಇಲ್ಲ. ಅದು ದಾಖಲೆ, FIR ಪ್ರತಿ ಅಥವಾ ನಂಬರ್ ಪ್ಲೇಟ್ ಆದರೆ, ಪುನಃ ಕಳುಹಿಸಿ "read this" ಎಂದು ಹೇಳಿ — ನಾನು OCR ಮಾಡುತ್ತೇನೆ.',
  idMultipleFaces: (n) => `ಆ ಫೋಟೋದಲ್ಲಿ ${n} ಮುಖಗಳಿವೆ, ಹಾಗಾಗಿ ಹೋಲಿಕೆ ತಪ್ಪು ವ್ಯಕ್ತಿಯನ್ನು ಹಿಡಿಯಬಹುದು. ಒಬ್ಬರೇ ಇರುವ ಫೋಟೋ ಕಳುಹಿಸಿ.`,
  idEmptyGallery: 'ಇನ್ನೂ ಯಾವುದೇ reference ಫೋಟೋ ನೋಂದಾಯಿಸಿಲ್ಲ, ಹಾಗಾಗಿ ಹೋಲಿಸಲು ಏನೂ ಇಲ್ಲ. ಹೆಸರು ಮತ್ತು FIR ಜೊತೆ ಫೋಟೋ ಕಳುಹಿಸಿ ಮೊದಲನೆಯದನ್ನು ನೋಂದಾಯಿಸಿ — ಪ್ರತಿ ನೋಂದಣಿ ಮುಂದಿನ ಪರಿಶೀಲನೆಯನ್ನು ಸಾಧ್ಯ ಮಾಡುತ್ತದೆ.',
  idNoMatch: (compared) => `ವರದಿ ಮಾಡುವ ಮಿತಿಗಿಂತ ಮೇಲಿನ ಯಾವುದೇ candidate ಇಲ್ಲ — ${compared} ನೋಂದಾಯಿತ ಫೋಟೋಗಳ ವಿರುದ್ಧ ಹೋಲಿಸಲಾಗಿದೆ. ಇದು ಕ್ಲಿಯರೆನ್ಸ್ ಅಲ್ಲ: ಆ ವ್ಯಕ್ತಿ ನೋಂದಾಯಿತರಾಗಿಲ್ಲದೇ ಇರಬಹುದು. ದಾಖಲೆಯಿಂದ ಪರಿಶೀಲಿಸಿ.`,
  idNeverProof: 'ಫೋಟೋ ಹೋಲಿಕೆ ಪರಿಶೀಲನೆಗೆ ಒಂದು ಸುಳಿವು ಮಾತ್ರ, ಗುರುತಿಸುವಿಕೆ ಅಲ್ಲ, ಮತ್ತು ಅದೊಂದೇ ಆಧಾರದ ಮೇಲೆ ಕ್ರಮ ತೆಗೆದುಕೊಳ್ಳಬಾರದು. ದಾಖಲೆ ಅಥವಾ ರೆಕಾರ್ಡ್ ವಿರುದ್ಧ ದೃಢಪಡಿಸಿ.',

  enrollNeedName: 'ಆ ಫೋಟೋವನ್ನು ಯಾರ ಹೆಸರಿಗೆ ನೋಂದಾಯಿಸಬೇಕು ಎಂದು ಹೇಳಿ — ಮತ್ತು FIR ನಂಬರ್ ಇದ್ದರೆ ಕೊಡಿ, ಆಗ ಮುಂದಿನ match ಪ್ರಕರಣದ ಸಹಿತ ಬರುತ್ತದೆ.',
  enrolled: (name, crimeNo) => `ಆ ಫೋಟೋವನ್ನು *${name}* ಗಾಗಿ${crimeNo ? ` ${crimeNo} ವಿರುದ್ಧ` : ''} ನೋಂದಾಯಿಸಲಾಗಿದೆ.`,
  enrollStale: 'ಆ ದೃಢೀಕರಣ ಹಳೆಯ ಸಂದೇಶದಿಂದ ಬಂದಿದೆ, ಹಾಗಾಗಿ ಕ್ರಮ ತೆಗೆದುಕೊಂಡಿಲ್ಲ. ಇದು ಈಗಿನದು.',
  tapStale: 'ಆ ಬಟನ್ ಹಳೆಯ ಸಂದೇಶಕ್ಕೆ ಸೇರಿದ್ದು, ಹಾಗಾಗಿ ಕ್ರಮ ತೆಗೆದುಕೊಂಡಿಲ್ಲ — ಹಳೆಯ ಪ್ರಶ್ನೆಗೆ ಒತ್ತಿದರೆ ತಪ್ಪು ದಾಖಲೆ ಬದಲಾಗಬಹುದು. ಬೇಕಾದದ್ದನ್ನು ಪುನಃ ಕಳುಹಿಸಿ.',

  alertsUpdated: (districts, severity) => `Alerts ಹೊಂದಿಸಲಾಗಿದೆ: *${districts}*, *${severity}* ಮತ್ತು ಮೇಲಿನ ಮಟ್ಟ.`,
  alertsOff: 'Alerts ನಿಲ್ಲಿಸಲಾಗಿದೆ. ಬೇಕಾದಾಗ "alert me about <ಜಿಲ್ಲೆ>" ಎಂದು ಕಳುಹಿಸಿ.',
  alertBody: (a, horizon, advisory) => [
    `*${a.severity.toUpperCase()} — ${a.district}*`,
    `${horizon} ಗಾಗಿ ಮುನ್ಸೂಚನೆ: *${a.predicted}* ಪ್ರಕರಣಗಳು, baseline ${a.baseline} (${a.trendPct >= 0 ? '+' : ''}${a.trendPct}%, z=${a.z}).`,
    advisory,
    '',
    '_ಇದು ನಿಯೋಜನೆ ಯೋಜನೆಗೆ ಸಹಾಯಕ ಮಾಹಿತಿ ಮಾತ್ರ — ಯಾವುದೇ ವ್ಯಕ್ತಿಯ ವಿರುದ್ಧ ಕ್ರಮಕ್ಕೆ ಆಧಾರವಲ್ಲ. ವಿವರಕ್ಕೆ ಉತ್ತರಿಸಿ, ಅಥವಾ ನಿಲ್ಲಿಸಲು "alerts off" ಕಳುಹಿಸಿ._'
  ].join('\n'),

  languageSet: (name) => `ಭಾಷೆ *${name}* ಗೆ ಹೊಂದಿಸಲಾಗಿದೆ. ನೀವು ಬೇರೆ ಲಿಪಿಯಲ್ಲಿ ಬರೆಯುವವರೆಗೆ ಅಥವಾ ಬದಲಾಯಿಸಲು ಕೇಳುವವರೆಗೆ ಇದೇ ಇರುತ್ತದೆ.`,
  askRole: 'ಯಾವ access context ಬಳಸಬೇಕು? ಇದು ನಾನು ಏನು ತೋರಿಸಬಹುದು ಎಂದು ನಿರ್ಧರಿಸುತ್ತದೆ — risk score, associate network ಮತ್ತು financial trail ಗೆ analyst ಅಥವಾ ಮೇಲಿನ ಮಟ್ಟ ಬೇಕು.',
  onboardReady: (name, role) => `ಸಿದ್ಧ, ${name}. Access context: *${role}*.\n\nಇಂದಿನಿಂದ alerts ಮತ್ತು ನಿಗದಿತ briefing ಇಲ್ಲಿಗೆ ಬರುತ್ತವೆ.`,
  onboardAbandoned: 'ನಿಮ್ಮ setup ಹಾಗೆಯೇ ಬಿಟ್ಟಿದ್ದೇನೆ. ಪುನಃ ಮಾಡಬೇಕಾದಾಗ "reset" ಕಳುಹಿಸಿ.',
  roleSelfDisabled: 'ಈ deployment ನಲ್ಲಿ ನಿಮ್ಮ access context ನಿಮ್ಮ control room ನಿರ್ಧರಿಸುತ್ತದೆ, ಹಾಗಾಗಿ ನಾನು ಅದನ್ನು ಬದಲಿಸಿಲ್ಲ.',
  languageOnly: (name) => `ಭಾಷೆ *${name}* ಗೆ ಹೊಂದಿಸಲಾಗಿದೆ. ಉಳಿದದ್ದು ಬದಲಾಗಿಲ್ಲ.`,

  undoHint: (token) => `\n\n_ಹಿಂತೆಗೆಯಲು: ${token} ಎಂದು ಕಳುಹಿಸಿ_`,
  researchWait: (subject) => `*${subject}* ಬಗ್ಗೆ ಈಗ ಆನ್‌ಲೈನ್ ಹುಡುಕುತ್ತಿದ್ದೇನೆ — ಇಂಗ್ಲಿಷ್, ಹಿಂದಿ ಮತ್ತು ಕನ್ನಡ news, court ಹಾಗೂ ಸರ್ಕಾರಿ ಮೂಲಗಳು, ಜೊತೆಗೆ ನಮ್ಮ ದಾಖಲೆಗಳೂ. ಸುಮಾರು ಒಂದು ನಿಮಿಷ. ಫಲಿತಾಂಶ ಇಲ್ಲಿಯೇ ಕಳುಹಿಸುತ್ತೇನೆ; ಕಾಯುವ ಅಥವಾ ಪುನಃ ಕೇಳುವ ಅಗತ್ಯವಿಲ್ಲ.`,
  researchWaitDeep: (subject) => `*${subject}* ಬಗ್ಗೆ *deep* ಹುಡುಕಾಟ ನಡೆಸುತ್ತಿದ್ದೇನೆ — ಅದೇ ಮೂಲಗಳು, ಹೆಚ್ಚು ವಿಸ್ತಾರವಾಗಿ. ಗರಿಷ್ಠ ಐದು ನಿಮಿಷ. ಸಿದ್ಧವಾದಾಗ ಇಲ್ಲಿಯೇ ಕಳುಹಿಸುತ್ತೇನೆ; ಅಷ್ಟರಲ್ಲಿ ಬೇರೆ ಕೆಲಸ ಮುಂದುವರಿಸಿ.`,
  undoDone: (what) => `↩️ ${what} ಹಿಂತೆಗೆಯಲಾಗಿದೆ.`,
  undoNotFound: 'ಆ undo ಕೋಡ್ ಸಿಗಲಿಲ್ಲ. ಅವಧಿ ಮುಗಿದಿರಬಹುದು, ಅಥವಾ ಈಗಾಗಲೇ ಬಳಸಿರಬಹುದು.',
  undoAlready: 'ಅದನ್ನು ಈಗಾಗಲೇ ಹಿಂತೆಗೆಯಲಾಗಿದೆ.',

  refusedNegated: 'ಅದನ್ನು ಮಾಡಬೇಡಿ ಎಂದು ನಿಮ್ಮ ಸಂದೇಶ ಹೇಳಿತು, ಹಾಗಾಗಿ ನಾನು ಮಾಡಿಲ್ಲ. ನಿಮಗೆ ಏನು ಬೇಕು ಎಂದು ಸ್ಪಷ್ಟವಾಗಿ ಹೇಳಿ, ನಾನು ಮಾಡುತ್ತೇನೆ — ಅಥವಾ ತಪ್ಪಾಗಿ ಬರೆದಿದ್ದರೆ "ಬೇಡ" ಇಲ್ಲದೆ ಪುನಃ ಕಳುಹಿಸಿ.',
  refusedHypothetical: 'ಅದು ಆದೇಶಕ್ಕಿಂತ "ಏನಾಗುತ್ತದೆ" ಎಂಬ ಪ್ರಶ್ನೆಯಂತೆ ಕಾಣುತ್ತದೆ, ಹಾಗಾಗಿ ನಾನು ಏನೂ ಮಾಡಿಲ್ಲ. ನಿಜವಾಗಿ ಮಾಡಬೇಕಿದ್ದರೆ ನೇರವಾಗಿ ಹೇಳಿ, ಮಾಡುತ್ತೇನೆ.',

  engineError: 'ಅದನ್ನು ನಿರ್ವಹಿಸುವಾಗ ನನ್ನ ಕಡೆ ದೋಷ ಆಯಿತು — ನಿಮ್ಮ ಸಂದೇಶದ ತಪ್ಪಲ್ಲ. ಪುನಃ ಕಳುಹಿಸಿ, ಮತ್ತೊಮ್ಮೆ ಪ್ರಯತ್ನಿಸುತ್ತೇನೆ.',
  timeout: 'ಪ್ರತಿಕ್ರಿಯೆ ಬರಲು ತುಂಬಾ ಸಮಯ ಆಯಿತು. ಪುನಃ ಕಳುಹಿಸಿ.',
  notUnderstood: 'ಇದನ್ನು ಸರಿಯಾಗಿ ಮಾಡಬೇಕು, ಆದರೆ ನಿಮಗೆ ಏನು ಬೇಕು ಎಂದು ಖಚಿತವಿಲ್ಲ. FIR ನಂಬರ್‌ನಿಂದ ಪ್ರಕರಣ, ಹೆಸರಿನಿಂದ ಹಿಂದಿನ ಅಪರಾಧಗಳು, ದಾಖಲೆ ಫೋಟೋ ಓದುವುದು, ಫೋಟೋ ಯಾರಿಗೆ ಹೊಂದಬಹುದು ಎಂದು ಪರಿಶೀಲಿಸುವುದು, ಅಥವಾ ಜಿಲ್ಲೆಯ alert ಚಿತ್ರಣ — ಇವುಗಳಲ್ಲಿ ಯಾವುದು?',
  groundingBlocked: 'ಅದನ್ನು ರೆಕಾರ್ಡ್‌ಗಳ ವಿರುದ್ಧ ದೃಢಪಡಿಸಲು ಆಗಲಿಲ್ಲ, ಹಾಗಾಗಿ ನಾನು ಖಾತ್ರಿ ಇಲ್ಲದ ಸಂಖ್ಯೆಗಳನ್ನು ಕೊಡುವುದಿಲ್ಲ. FIR ನಂಬರ್ ಅಥವಾ ನಿಖರ ಹೆಸರು ಹೇಳಿ, ನಿಜವಾದ ಅಂಕಿಅಂಶ ತರುತ್ತೇನೆ.',
  helpCard: `*KSP Field Intelligence*\n\nಬೇಕಾದದ್ದನ್ನು ಸರಳವಾಗಿ ಹೇಳಿ — command ಬೇಡ.\n\n- "ಸುರೇಶ್ ಕುಮಾರ್ history ಇದೆಯಾ"\n- "FIR 4021/2026 ಸ್ಥಿತಿ"\n- ವ್ಯಕ್ತಿಯ ಫೋಟೋ ಕಳುಹಿಸಿ → ಸಂಭಾವ್ಯ matches\n- ಫೋಟೋ + "FIR 4021/2026 ನಲ್ಲಿ ಸುರೇಶ್ ಕುಮಾರ್ ಎಂದು save ಮಾಡಿ" → ನೋಂದಣಿ\n- ದಾಖಲೆಯ ಫೋಟೋ ಕಳುಹಿಸಿ → ಓದಿ ಹುಡುಕುತ್ತೇನೆ\n- "ಮುಂದಿನ ತಿಂಗಳು ಮೈಸೂರಿನಲ್ಲಿ ಏನು flag ಆಗಿದೆ"\n- "ಬಳ್ಳಾರಿ ಬಗ್ಗೆ alert ಕೊಡಿ" / "alerts off"\n\nVoice note ಮತ್ತು location ಹಂಚಿಕೆಯೂ ಕೆಲಸ ಮಾಡುತ್ತದೆ. ಇಲ್ಲಿನ ಎಲ್ಲವೂ ನಿಮ್ಮ ಹೆಸರಿನಲ್ಲಿ ದಾಖಲಾಗುತ್ತದೆ.`
};

const HI = {
  unregistered: 'यह नंबर KSP Field Intelligence के लिए रजिस्टर नहीं है. जुड़ने के लिए अपने control room से संपर्क करें.',
  throttled: (limit) => `इस चैनल पर प्रति घंटा ${limit} संदेशों की सीमा पूरी हो गई है. अगले घंटे रीसेट होगी — ज़रूरी हो तो सीधे control room से संपर्क करें.`,
  restricted: (role) => `इसके लिए ${role} भूमिका से ऊपर का access चाहिए. आपका control room उसे मांग सकता है. केस विवरण, पिछले अपराध और क्षेत्र के alerts मैं अब भी दे सकता हूँ.`,

  frameCancelled: 'वह सवाल छोड़ दिया. आगे जो चाहिए भेजें — नाम, FIR नंबर, या फोटो.',
  frameError: 'आपका जवाब संभालते समय कुछ गड़बड़ हुई — गलती मेरी तरफ़ की है. एक बार फिर भेजें.',
  frameMaxRetriesSuffix: '\n\n(उसे अभी छोड़ रहा हूँ. जब तैयार हों, नए सिरे से शुरू करें.)',
  framePickPrompt: (prompt, options) =>
    `${prompt}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nनंबर भेजें, या "cancel".`,
  frameUnknownPick: (options) =>
    `समझ नहीं आया आपका मतलब कौन सा था. 1 से ${options.length} तक का नंबर भेजें, या "cancel".`,

  imageAck: (seen) => {
    if (seen.faces === 1) return '📷 फोटो मिल गई — एक चेहरा दिख रहा है.';
    if (seen.faces > 1) return `📷 फोटो मिल गई — ${seen.faces} चेहरे दिख रहे हैं.`;
    return '📷 फोटो मिल गई.';
  },
  imageUnreadable: 'उसमें से काम का कुछ नहीं पढ़ पाया. पास से, सीधा, अच्छी रोशनी में लिया गया फोटो आमतौर पर चलता है — या जो चाहिए वह टाइप कर दें.',
  voiceUnclear: 'वह voice note साफ़ सुनाई नहीं दिया. किसी शांत जगह पर दोबारा कोशिश करें, या टाइप कर दें.',
  voiceFailed: 'वह voice note लिखित में नहीं बदल सका. अपनी बात टाइप कर दें, आगे मैं देख लूँगा.',
  mediaTooLarge: 'वह फ़ाइल बहुत बड़ी है — 8 MB से कम की भेजें.',
  mediaDownloadFailed: 'वह attachment WhatsApp से नहीं आया. दोबारा भेजें.',
  unsupportedType: (kind) => `मैं text, voice note, फोटो, PDF और साझा किया गया location संभाल सकता हूँ. ${kind ? `${kind} संदेश` : 'वह'} मैं पढ़ नहीं सकता — इनमें से किसी एक रूप में भेजें.`,
  locationNote: (near, km) => `(अधिकारी ने location साझा किया. सबसे नज़दीकी ज़िला केंद्र: ${near}, लगभग ${km} कि.मी. इसे उनका अनुमानित क्षेत्र मानें.)`,
  locationUnmatched: '(अधिकारी ने जो location साझा किया वह किसी ज़िले से मेल नहीं खाया.)',

  idNoFace: 'उस फोटो में कोई चेहरा नहीं है. अगर वह दस्तावेज़, FIR कॉपी या नंबर प्लेट है तो दोबारा भेजकर "read this" कहें — मैं OCR चला दूँगा.',
  idMultipleFaces: (n) => `उस फोटो में ${n} चेहरे हैं, तो तुलना गलत व्यक्ति पर जा सकती है. सिर्फ़ एक व्यक्ति वाला फोटो भेजें.`,
  idEmptyGallery: 'अभी कोई reference फोटो दर्ज नहीं है, तो तुलना करने के लिए कुछ नहीं है. नाम और FIR के साथ फोटो भेजकर पहला दर्ज करें — हर दर्ज फोटो अगली जाँच को संभव बनाता है.',
  idNoMatch: (compared) => `रिपोर्ट करने की सीमा से ऊपर कोई candidate नहीं — ${compared} दर्ज फोटो से तुलना की गई. यह क्लीयरेंस नहीं है: वह व्यक्ति दर्ज ही न हो, यह भी हो सकता है. दस्तावेज़ से पुष्टि करें.`,
  idNeverProof: 'फोटो की तुलना पुष्टि के लिए एक सुराग है, पहचान नहीं, और अकेले उसके आधार पर कार्रवाई नहीं की जा सकती. दस्तावेज़ या रिकॉर्ड से पक्का करें.',

  enrollNeedName: 'वह फोटो किस व्यक्ति के नाम पर दर्ज करूँ, बताएँ — और FIR नंबर हो तो दें, जिससे आगे कोई match केस के साथ आए.',
  enrolled: (name, crimeNo) => `वह फोटो *${name}* के लिए${crimeNo ? ` ${crimeNo} के विरुद्ध` : ''} दर्ज कर दिया.`,
  enrollStale: 'वह पुष्टि किसी पुराने संदेश की है, तो मैंने कुछ नहीं किया. यह मौजूदा है.',
  tapStale: 'वह बटन किसी पुराने संदेश का है, तो मैंने कुछ नहीं किया — पुराने सवाल पर दबाने से गलत रिकॉर्ड छू जाता है. जो चाहिए दोबारा भेजें.',

  alertsUpdated: (districts, severity) => `Alerts सेट: *${districts}*, *${severity}* और उससे ऊपर.`,
  alertsOff: 'Alerts बंद. जब चाहें "alert me about <ज़िला>" भेज दें.',
  alertBody: (a, horizon, advisory) => [
    `*${a.severity.toUpperCase()} — ${a.district}*`,
    `${horizon} का पूर्वानुमान: *${a.predicted}* केस, baseline ${a.baseline} (${a.trendPct >= 0 ? '+' : ''}${a.trendPct}%, z=${a.z}).`,
    advisory,
    '',
    '_यह केवल तैनाती योजना के लिए सहायक जानकारी है — किसी व्यक्ति के विरुद्ध कार्रवाई का आधार नहीं. विवरण के लिए उत्तर दें, या बंद करने के लिए "alerts off" भेजें._'
  ].join('\n'),

  languageSet: (name) => `भाषा *${name}* पर सेट कर दी. जब तक आप किसी दूसरी लिपि में न लिखें या बदलने को न कहें, यही रहेगी.`,
  askRole: 'कौन सा access context इस्तेमाल करूँ? इससे तय होता है कि मैं क्या दिखा सकता हूँ — risk score, associate network और financial trail के लिए analyst या उससे ऊपर चाहिए.',
  onboardReady: (name, role) => `तैयार, ${name}. Access context: *${role}*.\n\nअब से alerts और निर्धारित briefing यहीं आएँगे.`,
  onboardAbandoned: 'आपका setup वैसा ही छोड़ दिया. दोबारा करना हो तो "reset" भेजें.',
  roleSelfDisabled: 'इस deployment पर आपका access context आपका control room तय करता है, तो मैंने उसे नहीं छेड़ा.',
  languageOnly: (name) => `भाषा *${name}* पर सेट कर दी. बाकी सब वैसा ही है.`,

  researchWait: (subject) => `*${subject}* के बारे में अभी खुले इंटरनेट पर खोज रहा हूँ — अंग्रेज़ी, हिंदी और कन्नड़ के news, court और सरकारी स्रोत, साथ में हमारे रिकॉर्ड भी. करीब एक मिनट. नतीजे यहीं भेज दूँगा; इंतज़ार करने या दोबारा पूछने की ज़रूरत नहीं.`,
  researchWaitDeep: (subject) => `*${subject}* पर *deep* खोज चल रही है — वही स्रोत, बहुत ज़्यादा गहराई से. पाँच मिनट तक लग सकते हैं. तैयार होने पर यहीं भेज दूँगा; तब तक कोई और काम देखते रहें.`,

  undoHint: (token) => `\n\n_पलटने के लिए: ${token} भेजें_`,
  undoDone: (what) => `↩️ ${what} पलट दिया.`,
  undoNotFound: 'वह undo कोड नहीं मिला. उसकी अवधि पूरी हो गई हो, या पहले ही इस्तेमाल हो गया हो.',
  undoAlready: 'वह पहले ही पलटा जा चुका है.',

  refusedNegated: 'आपके संदेश में उसे न करने को कहा गया था, तो मैंने नहीं किया. आपको जो चाहिए साफ़ बताएँ, मैं कर दूँगा — या गलती से लिखा हो तो "मत" हटाकर दोबारा भेजें.',
  refusedHypothetical: 'वह आदेश से ज़्यादा "क्या होगा" वाला सवाल लगता है, तो मैंने कुछ नहीं किया. सच में करवाना हो तो सीधे कहें, कर दूँगा.',

  engineError: 'उसे संभालते समय मेरी तरफ़ कुछ टूट गया — आपके संदेश की गलती नहीं. दोबारा भेजें, मैं फिर कोशिश करूँगा.',
  timeout: 'जवाब आने में बहुत देर लग गई. दोबारा भेजें.',
  notUnderstood: 'मैं इसे ठीक से करना चाहता हूँ पर समझ नहीं पाया आपको क्या चाहिए. मैं FIR नंबर से केस, नाम से पिछले अपराध, दस्तावेज़ के फोटो की पढ़ाई, फोटो किससे मेल खा सकता है उसकी जाँच, या किसी ज़िले की alert तस्वीर दे सकता हूँ. इनमें से कौन सा?',
  groundingBlocked: 'उसे रिकॉर्ड से पक्का नहीं कर सका, तो मैं ऐसे आंकड़े नहीं दूँगा जिन पर टिक न सकूँ. FIR नंबर या पूरा नाम बताएँ, असली आंकड़े निकाल दूँगा.',
  helpCard: `*KSP Field Intelligence*\n\nजो चाहिए सीधे कह दें — कोई command नहीं.\n\n- "सुरेश कुमार का history है क्या"\n- "FIR 4021/2026 की स्थिति"\n- किसी व्यक्ति का फोटो भेजें → संभावित matches\n- फोटो + "FIR 4021/2026 में सुरेश कुमार के नाम save करो" → दर्ज\n- दस्तावेज़ का फोटो भेजें → पढ़कर खोज लूँगा\n- "अगले महीने मैसूर में क्या flag हुआ है"\n- "बल्लारी के alerts दो" / "alerts off"\n\nVoice note और location साझा करना भी चलता है. यहाँ सब कुछ आपके नाम पर दर्ज होता है.`
};

const PACKS = { en: EN, kn: KN, hi: HI };

/**
 * The language menu, deliberately identical in every pack.
 *
 * Each name is written in its own script, because at the moment this menu is shown
 * the officer's language is exactly what we do not know — offering "Kannada" in
 * Latin script to someone who reads Kannada is the same failure this pack exists to
 * prevent, one step earlier.
 */
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
  { code: 'hi', label: 'हिन्दी' }
];

const languageName = (code) => (LANGUAGES.find((l) => l.code === code) || LANGUAGES[0]).label;

/**
 * The setup prompt, shown in all three languages at once.
 *
 * Not taken from a pack on purpose: this is the one message sent before any
 * language is known, so picking a pack for it would mean guessing, and a guess here
 * is what strands an officer who cannot read the menu.
 */
const ASK_LANGUAGE = 'Choose your language\nಭಾಷೆ ಆಯ್ಕೆ ಮಾಡಿ\nअपनी भाषा चुनें';

/** The message pack for a language, falling back to English. */
function messages(language) {
  return PACKS[String(language || 'en').toLowerCase()] || EN;
}

module.exports = { messages, EN, KN, HI, LANGUAGES, languageName, ASK_LANGUAGE };
