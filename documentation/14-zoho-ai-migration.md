# 14 · Migration to Zoho/Zia AI (removing the third‑party GPT dependency)

This documents the switch from a third‑party GPT LLM to **Zoho‑native** services,
what is fully done vs. what needs one‑time provisioning, and the honest engineering trade‑offs.

## Summary of the switch

| Capability | Was | Now | Status |
|---|---|---|---|
| Conversational LLM (text‑to‑ZCQL agent) | (third‑party GPT LLM) | **Zoho Catalyst QuickML — GLM‑4.7‑Flash** (`crm-di-glm47b_30b_it`) | ✅ Live — the sole LLM, native tool‑calling; no third‑party fallback |
| FIR OCR | Sarvam Document Intelligence | **Catalyst Zia OCR** (native) | ✅ Done & verified live (confidence 98) |
| Voice STT + TTS | Sarvam `saarika`/`bulbul` | **Sarvam AI** (retained) | ✅ Kept — Catalyst has **no** speech model, so Sarvam is the one justified third party for voice |

Catalyst has **no developer STT/TTS API** — verified from the live console (Zia has only IMAGE +
TEXT components; "Zia Voice" is a Zoho CRM product feature, not a Catalyst microservice). So voice
**stays on Sarvam AI** (`saarika:v2.5` STT, `bulbul:v3` TTS) — the single justified third party,
since Catalyst genuinely cannot provide speech. LLM (Zoho GLM) and OCR (Zia) are fully native.

## 1 · LLM → Zoho QuickML LLM Serving (GLM‑4.7‑Flash)

Catalyst QuickML offers **LLM Serving** (Generative AI) on the IN/US/EU data centers, authenticated
by a Zoho OAuth token (scope `QuickML.deployment.READ`).

**Live model catalog (verified from the QuickML console, July 2026)** — the public docs are stale;
these are the models actually available:

| Model (display) | API model id | Spec | Notes |
|---|---|---|---|
| **GLM‑4.7‑Flash** ← we use this | `crm-di-glm47b_30b_it` | 30B MoE (3B active), 200K context | Coding, reasoning, **agent workflows**, **native Tool & Agent support**, OpenAI‑style chat completions |
| Qwen 3.6 – 35B Vision Language | `VL-Qwen3.6-35B-A3B` (8‑bit) | 35B MoE (3B active) | Multimodal (text + image), agentic |
| ~~Qwen 2.5 – 14B Instruct / 7B Coder / 7B Vision~~ | — | — | **Deprecated** (retire 2026‑07‑31 → migrate to GLM‑4.7‑Flash) |

We target **GLM‑4.7‑Flash** — it's the current text/agent model, it uses an **OpenAI‑style
chat‑completions API with native tool‑calling** (so the agent uses the clean tool path, not ReAct),
and it has 200K context. The API `model` id is `crm-di-glm47b_30b_it`, set via `QUICKML_MODEL`.

**Endpoint (this project):** `https://api.catalyst.zoho.in/quickml/v1/project/51589000000013024/glm/chat`
· **POST** · `Authorization: Zoho-oauthtoken <token>` · `CATALYST-ORG: 60079622152`.
Request/response are OpenAI‑style (`messages`, `tools`, `choices[0].message.tool_calls`), plus a GLM
`chat_template_kwargs.enable_thinking` toggle (`QUICKML_THINKING`, off by default for latency).

**Agent path — native tool‑calling (GLM supports it).** GLM‑4.7‑Flash exposes OpenAI‑style function
calling on Catalyst, so the agent uses the **native tool‑calling loop** (`handleChatTools`) — best
reliability and latency. A **provider‑agnostic ReAct loop** is also built and kept as a fallback for
any model *without* tool support (enable via `LLM_FORCE_REACT=true`):

- The model is instructed to reply with **only** a fenced ```zcql block to read data, optionally
  preceded by a `PURPOSE:` line.
- The server extracts + safety‑validates + `LIMIT`‑enforces the query, executes it, and feeds the
  rows back as a `DATA (rows=N): …` message.
- The model queries again (to refine/compare) or returns a **final prose answer** (no code block).
- Grounding, citations, evidence assembly and the audit log are **identical** to before.

**Validation:** this ReAct loop was validated with `LLM_FORCE_REACT=true` and produced correct,
grounded answers with the right ZCQL — proving the exact path a non‑tool model would use.

**Provider** (`functions/api/lib/llm.js`):
- `LLM_PROVIDER=quickml` → Zoho QuickML (GLM‑4.7‑Flash) is the **sole LLM**.
- GLM uses its native tool‑calling path; the ReAct loop stays available for any non‑tool model via
  `LLM_FORCE_REACT=true`.

### What YOU must provision (one‑time, in the Zoho console)

The QuickML LLM endpoint + OAuth credentials can only be created in your Zoho account:

1. **Enable QuickML LLM Serving** — Catalyst → QuickML → *Generative AI → LLM Serving*. Open the
   **GLM‑4.7‑Flash** model → *API Details* → copy the **Endpoint URL** and the exact **model id**
   (put it in `QUICKML_MODEL`), and note whether the sample request is `messages`+`tools`
   (OpenAI‑style) or `prompt`/`system_prompt`.
2. **Create a Self‑Client OAuth app** — https://api-console.zoho.in → *Self Client* → generate a
   **refresh token** with scope **`QuickML.deployment.READ`**. Note the **Client ID/Secret**.
3. **Set the function env vars** (`functions/api/catalyst-config.json` → `env_variables`):
   ```json
   "LLM_PROVIDER": "quickml",
   "QUICKML_LLM_ENDPOINT": "<endpoint URL from step 1>",
   "QUICKML_MODEL": "crm-di-glm47b_30b_it",
   "QUICKML_ORG_ID": "60079622152",
   "ZOHO_CLIENT_ID": "<from step 2>",
   "ZOHO_CLIENT_SECRET": "<from step 2>",
   "ZOHO_REFRESH_TOKEN": "<from step 2>",
   "ZOHO_ACCOUNTS_URL": "https://accounts.zoho.in"
   ```
4. **Redeploy**: `catalyst deploy --only functions --org 60079622152`.

That's it — the agent runs on GLM‑4.7‑Flash (no code change). Verify with a `/chat` call:
the audit log's `ModelUsed` will read `zoho-quickml:GLM-4.7-Flash`.

> **Note on the exact request body.** The QuickML client sends
> `{ model, prompt, system_prompt, temperature, top_p, top_k, max_tokens }` and parses the response
> flexibly. Each deployed model's *API Details* page shows the exact sample request/response for your
> account — if the field names differ, adjust `chatQuickML()` in `lib/llm.js` (it's isolated there).

### Latency / quality tuning

- GLM‑4.7‑Flash on QuickML has its own latency profile. Tunables live in
  `chatQuickML()` and env: `temperature` (default 0.1 for precise ZCQL), `top_p`, `top_k`,
  `max_tokens`, and `LLM_TIMEOUT_MS`.
- The ReAct loop caps at 5 steps; most queries resolve in 1–2 model calls.
- For lowest latency on simple lookups, the model answers after a single query round‑trip.

## 2 · OCR → Catalyst Zia OCR (`functions/api/lib/ocr.js`)

- Uses the Node SDK: `app.zia().extractOpticalCharacters(fileStream, { language, modelType:'OCR' })`
  → `{ text, confidence }`.
- Supports jpg/jpeg/png/tiff/bmp/**pdf**, ≤20 MB, 9 international + 10 Indian languages (incl.
  **Kannada**). Language is mapped (`en→eng`, `kn→kan`, `hi→hin`) with an **auto‑detect retry** for
  mixed‑language FIRs. Files are processed one‑time and never stored/trained on (Catalyst privacy).
- The extracted text is structured into FIR fields by the LLM (now the Zoho provider) exactly as
  before, then inserted into the Data Store.
- **Verified live**: a rendered test FIR returned `engine=catalyst-zia-ocr, confidence=98` and correct
  structured fields. No `sarvamai`/`adm-zip` dependencies remain.

## 3 · Voice → Sarvam AI (retained)

Catalyst has no speech model (confirmed from the live console), so voice remains on **Sarvam AI** —
the one justified third party. Everything else is Zoho‑native (GLM LLM) or Catalyst‑native (Zia OCR).

- **STT**: client captures mic audio with `MediaRecorder` (`audio/webm;codecs=opus`) → base64 →
  `POST /voice/stt` → Sarvam `saarika:v2.5` → transcript into the composer.
- **TTS**: `POST /voice/tts` → Sarvam `bulbul:v3` (speaker `ritu`, mp3) → played back client‑side.
- Language maps `kn→kn-IN`, else `en-IN`. Keys are server‑side only (`SARVAM_API_KEY`).
- Files: `functions/api/index.js` (`/voice/stt`, `/voice/tts`), `client/src/lib/voice.js`,
  `client/src/api.js` (`stt`/`tts`).

## Files changed

| File | Change |
|---|---|
| `functions/api/lib/llm.js` | Added QuickML provider (the sole LLM), provider resolution, `modelLabel()`, placeholder‑aware `quickmlReady()`. |
| `functions/api/lib/chat.js` | Added provider‑agnostic **ReAct** agent loop; GLM uses the native tool‑calling path. |
| `functions/api/lib/ocr.js` | Sarvam Document Intelligence → **Zia OCR**. |
| `functions/api/index.js` | Removed Sarvam `/voice/*` routes; audit `ModelUsed` + brief use `modelLabel()`. |
| `functions/api/lib/investigator.js` | Model label via `modelLabel()`. |
| `functions/api/package.json` | Removed `sarvamai`, `adm-zip`. |
| `functions/api/catalyst-config*.json` | Removed `SARVAM_*`; added QuickML/Zoho OAuth env; `LLM_PROVIDER=quickml`. |
| `client/src/lib/voice.js` | Sarvam STT/TTS → **Web Speech API**. |
| `client/src/api.js` | Removed `stt`/`tts` methods. |
| `client/src/components/Composer.jsx`, `Ingest.jsx` | Relabeled to Zia/generic (no vendor names, no emoji). |

## Current live status

- **Deployed.** Chat runs on GLM‑4.7‑Flash (Zoho QuickML) with native tool‑calling — the sole LLM.
- **OCR = Zia (live, verified).** **Voice = browser (live).**
- To point at your own QuickML deployment, set the 4 provisioning values above and redeploy — zero
  code changes required.
