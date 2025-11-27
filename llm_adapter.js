// llm_adapter.js — Groq adapter (uses GROQ_API_KEY from env)
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY not set. LLM calls will fail.");
}

/**
 * callBrain(prompt, options) -> returns text reply
 */
async function callBrain(prompt, options = {}) {
  const model = process.env.GROQ_MODEL || "gpt-4o-mini";
  const max_tokens = options.max_tokens || 220;

  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are Vaani — a Hindi-first, concise assistant." },
        { role: "user", content: prompt }
      ],
      max_tokens,
      temperature: 0.2
    });

    const text = (resp.choices && (resp.choices[0].message?.content || resp.choices[0].text)) || "";
    return text.trim();
  } catch (err) {
    console.error("Groq API error:", err?.response?.data || err?.message || err);
    throw err;
  }
}

module.exports = { callBrain };
