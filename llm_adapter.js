// llm_adapter.js — safe Groq adapter that never throws on require
// Uses process.env.GROQ_API_KEY (preferred) or process.env.OPENAI_API_KEY as fallback.
// If no key is set, module exports a callBrain that returns a friendly fallback.

const fetch = require('node-fetch'); // already in package.json for Replit pattern

// Helper that performs a Groq/OpenAI-compatible request if key present
async function callViaGroq(prompt, opts = {}) {
  const key = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return null;

  const model = process.env.GROQ_MODEL || 'gpt-4o-mini';
  const max_tokens = opts.max_tokens || 220;

  // prefer Groq OpenAI-compatible endpoint
  const url = (process.env.GROQ_API_KEY)
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are Vaani — a Hindi-first, concise assistant.' },
      { role: 'user', content: prompt }
    ],
    max_tokens,
    temperature: 0.2
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(()=>null);
    throw new Error(`LLM HTTP ${res.status}: ${txt || res.statusText}`);
  }

  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || null;
  return text;
}

function fallbackReply(prompt) {
  const p = (prompt || '').toLowerCase();
  if (p.includes('weather')) return "Mujhe maaf kijiye — weather feature abhi offline hai.";
  if (p.includes('kaun') && p.includes('tum')) return "Main Vaani hoon. Aapki voice assistant.";
  let out = "Thik hai. Main is bare mein thoda aur bata sakti hoon, lekin abhi offline mode chal raha hai.";
  if (p.length < 60) out = "Mujhe thoda aur bataiye ya seedha sawaal puchiye.";
  return out;
}

async function callBrain(prompt, opts = {}) {
  try {
    const remote = await callViaGroq(prompt, opts);
    if (remote && remote.length) return remote;
  } catch (e) {
    console.error('LLM remote error:', e && (e.message || e));
  }

  return fallbackReply(prompt);
}

module.exports = { callBrain };
