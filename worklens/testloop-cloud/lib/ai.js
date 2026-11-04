import './env.js';
// AI calls through OpenRouter (same key style as WorkLens). Screenshots are sent as base64 data
// URLs, never as Telegram file links: those links contain the bot token.
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
export const aiConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

async function chat(model, messages) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'TestLoop bot' },
    body: JSON.stringify({ model, temperature: 0.1, messages }),
    signal: AbortSignal.timeout(60000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${result?.error?.message || response.statusText}`);
  const raw = result.choices?.[0]?.message?.content || '';
  return JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
}

// Vision check of the two onboarding screenshots. Returns { valid, reason, manual }.
// On any AI failure the tester goes to the WorkLens queue for a human decision (manual: true)
// rather than being auto-approved or blocked.
export async function verifyScreenshots(appName, images) {
  if (!aiConfigured()) return { valid: false, manual: true, reason: 'AI not configured, manual review' };
  try {
    const out = await chat(process.env.VISION_MODEL || 'openai/gpt-4o', [{
      role: 'user',
      content: [
        { type: 'text', text: `You are verifying closed testing for the Android app "${appName}". Image 1 must show the Google Play listing of "${appName}" with an Uninstall or Open button (meaning it is installed). Image 2 must show the "${appName}" app itself open on a phone. Return ONLY JSON {"valid": boolean, "reason": "short reason"}.` },
        ...images.map(url => ({ type: 'image_url', image_url: { url } }))
      ]
    }]);
    return { valid: out.valid === true, reason: String(out.reason || '').slice(0, 200), manual: false };
  } catch (error) {
    console.error('[ai] verify failed:', error.message);
    return { valid: false, manual: true, reason: 'AI check failed, manual review' };
  }
}

export async function scoreFeedback(appName, text) {
  if (!aiConfigured()) return null;
  try {
    const out = await chat(process.env.TEXT_MODEL || 'openai/gpt-4o-mini', [
      { role: 'system', content: 'Rate tester feedback 1-5 for how useful it is to the developer (5 = specific, reproducible, actionable). Return strict JSON, no fences: {"score":1,"summary":"one short sentence","tag":"Bug|Feature|UX|Praise|Other"}' },
      { role: 'user', content: `App: ${appName}\nFeedback: ${text.slice(0, 4000)}` }
    ]);
    return { score: Math.min(5, Math.max(1, Math.round(Number(out.score)))) || null, summary: String(out.summary || '').slice(0, 300), tag: ['Bug', 'Feature', 'UX', 'Praise', 'Other'].includes(out.tag) ? out.tag : 'Other' };
  } catch (error) {
    console.error('[ai] score failed:', error.message);
    return null;
  }
}
