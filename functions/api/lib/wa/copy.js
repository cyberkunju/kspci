'use strict';

/**
 * The field channel's message pack — every string an officer can see, in English
 * and Kannada.
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

  undoHint: (token) => `\n\n_ಹಿಂತೆಗೆಯಲು: ${token} ಎಂದು ಕಳುಹಿಸಿ_`,
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

const PACKS = { en: EN, kn: KN };

/** The message pack for a language, falling back to English. */
function messages(language) {
  return PACKS[String(language || 'en').toLowerCase()] || EN;
}

module.exports = { messages, EN, KN };
