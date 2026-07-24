'use strict';

/**
 * LLM client — Zoho Catalyst QuickML LLM Serving (GLM-4.7-Flash).
 *
 * GLM-4.7-Flash (`crm-di-glm47b_30b_it`, 30B MoE / 3B active, 200K context) is exposed by
 * Catalyst QuickML as an OpenAI-compatible chat-completions API with native tool-calling.
 * Authenticated with a Zoho OAuth token (scope QuickML.deployment.READ) + the CATALYST-ORG header.
 *
 * chatLLM(app, { messages, tools?, toolChoice?, maxTokens?, temperature? }) ->
 *   { message, content, toolCalls, supportsTools, provider, usage, raw }
 */

const { getQuickMLToken } = require('./oauth');

const QUICKML_ENDPOINT = process.env.QUICKML_LLM_ENDPOINT || '';
const QUICKML_MODEL = process.env.QUICKML_MODEL || 'crm-di-glm47b_30b_it';
const QUICKML_ORG = process.env.QUICKML_ORG_ID || process.env.CATALYST_ORG_ID || '';
// GLM "thinking" mode improves reasoning but adds latency; off by default for speed.
const QUICKML_THINKING = process.env.QUICKML_THINKING === 'true';

/** GLM-4.7-Flash supports native tool-calling; the ReAct loop can be forced for testing. */
function supportsNativeTools() {
  return process.env.LLM_FORCE_REACT !== 'true';
}

/** Human-readable label of the model answering (for audit logs / UI). */
function modelLabel() {
  return 'zoho-quickml:' + QUICKML_MODEL;
}

async function chatLLM(app, opts) {
  return chatQuickML(app, opts);
}

async function chatQuickML(app, { messages, tools, toolChoice, maxTokens = 1500, temperature } = {}) {
  if (!QUICKML_ENDPOINT) throw new Error('QUICKML_LLM_ENDPOINT not set');
  const token = await getQuickMLToken(app);
  const forceReact = process.env.LLM_FORCE_REACT === 'true';

  const body = {
    model: QUICKML_MODEL,
    messages,
    max_tokens: Math.min(Number(maxTokens) || 1500, 4096),
    temperature: temperature != null ? temperature : 0.1,
    stream: false,
    // GLM "thinking" mode — extra reasoning tokens; off by default to minimise latency.
    chat_template_kwargs: { enable_thinking: QUICKML_THINKING }
  };
  if (tools && tools.length && !forceReact) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || 60000));
  let r, j;
  try {
    r = await fetch(QUICKML_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Zoho-oauthtoken ' + token,
        ...(QUICKML_ORG ? { 'CATALYST-ORG': QUICKML_ORG } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('LLM_TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok || j.error) throw new Error('QuickML GLM error: ' + JSON.stringify(j.error || j).slice(0, 400));

  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return {
    message: msg,
    content: msg.content || '',
    toolCalls: msg.tool_calls || [],
    supportsTools: !forceReact,
    provider: 'zoho-quickml',
    finishReason: j.choices && j.choices[0] && j.choices[0].finish_reason,
    usage: j.usage || null,
    raw: j
  };
}

module.exports = { chatLLM, supportsNativeTools, modelLabel };
