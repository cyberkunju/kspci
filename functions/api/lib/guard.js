'use strict';

/**
 * Deterministic safety pre-check that runs BEFORE the model, so safety is never
 * left to the model's discretion. Keeps scope tight: this is a law-enforcement
 * analytics tool, so discussing crimes/offences in the data is expected and fine.
 * We only hard-stop on self-harm (route to help) and clearly out-of-scope
 * real-world harm enablement (weapons/explosives synthesis).
 */

const SELF_HARM = /\b(kill myself|suicide|suicidal|end my life|want to die|hurt myself|self[-\s]?harm)\b/i;
const HARM_ENABLE = /\b(build|make|synthesi[sz]e|manufacture)\b.*\b(bomb|explosive|nerve agent|bioweapon|chemical weapon)\b/i;

function assessSafety(text, language) {
  const t = String(text || '');
  if (SELF_HARM.test(t)) {
    return {
      safe: false,
      response: language === 'kn'
        ? 'ನಿಮ್ಮ ಸುರಕ್ಷತೆ ಮುಖ್ಯ. ದಯವಿಟ್ಟು ತಕ್ಷಣ 112 ಅಥವಾ ಆತ್ಮಹತ್ಯೆ ತಡೆ ಸಹಾಯವಾಣಿ 9152987821 ಗೆ ಸಂಪರ್ಕಿಸಿ. ನೀವು ಒಬ್ಬಂಟಿಯಲ್ಲ.'
        : "Your safety matters. Please reach out right now to emergency services (112) or the iCall / KIRAN mental-health helpline (1800-599-0019). You are not alone."
    };
  }
  if (HARM_ENABLE.test(t)) {
    return {
      safe: false,
      response: "I can't help with that. I'm a crime-analytics assistant for the Karnataka State Police database — I can help you investigate cases, offenders, networks, hotspots, and trends."
    };
  }
  return { safe: true };
}

module.exports = { assessSafety };
