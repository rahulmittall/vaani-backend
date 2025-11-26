// index.js — full updated server (replace whole file)
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const cors = require('cors');

// LLM adapter (ngrok remote -> local -> OpenAI fallback)
const { callBrain } = require('./llm_adapter');

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// --- CONFIG ---
// Path to a sample uploaded screenshot (from conversation / uploads).
// Dev note: this file path exists on the host as you uploaded earlier.
const SAMPLE_IMAGE_PATH = "/mnt/data/Screenshot 2025-11-25 130326.png";

// Reminders file
const REM_FILE = 'reminders.json';

// --- Reminders helpers ---
function loadReminders() {
  try {
    if (!fs.existsSync(REM_FILE)) return [];
    const raw = fs.readFileSync(REM_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('loadReminders error', e);
    return [];
  }
}
function saveReminders(arr) {
  try {
    fs.writeFileSync(REM_FILE, JSON.stringify(arr, null, 2));
    return true;
  } catch (e) {
    console.error('saveReminders error', e);
    return false;
  }
}
function addReminder(user_id, title, datetime_iso) {
  const arr = loadReminders();
  const id = 'R-' + Date.now();
  arr.push({ id, user_id, title, datetime: datetime_iso, created_at: new Date().toISOString(), delivered: false });
  saveReminders(arr);
  return id;
}

// Mark due reminders; returns array of reminders that became due now
function checkAndMarkDue() {
  const now = new Date();
  const arr = loadReminders();
  const due = [];
  let changed = false;
  arr.forEach(r => {
    if (!r.delivered) {
      const d = new Date(r.datetime);
      if (d <= now) {
        r.delivered = true;
        r.delivered_at = now.toISOString();
        due.push(r);
        changed = true;
      }
    }
  });
  if (changed) saveReminders(arr);
  if (due.length) {
    console.log('Reminders due now:', JSON.stringify(due, null, 2));
    try {
      fs.appendFileSync('delivered.log', new Date().toISOString() + ' - ' + JSON.stringify(due) + '\n');
    } catch (e) {}
  }
  return due;
}
// Run checker every minute
cron.schedule('* * * * *', () => {
  try {
    checkAndMarkDue();
  } catch (e) {
    console.error('cron check error', e);
  }
});

// --- Helper: generate prompt for LLM ---
function buildVaaniPrompt(userText, ctx = {}) {
  // Keep it concise; prefer Hindi-first responses and short actionable style
  const context = ctx || {};
  const remindersSummary = (context.recent_reminders || []).map(r => `${r.title} at ${r.datetime}`).slice(0,3);
  const ctxStr = remindersSummary.length ? `RecentReminders: ${remindersSummary.join('; ')}.` : '';
  // Provide instruction to produce short Hindi-first answer, simple language
  const prompt = `Aap Vaani AI ho — ek Hindi-first, voice-first assistant for everyday users. Provide a short, accurate, step-by-step or direct answer in Hindi. Keep it simple and action-focused. Context: ${ctxStr}\n\nUser: ${userText}\n\nAnswer:`;
  return prompt;
}

// --- Minimal decideReply (fuzzy rules, but route broad / capability queries to LLM) ---
function decideReply(t, hasImage=false, stt_confidence=null) {
  const raw = (t || '').trim();
  const text = raw.toLowerCase();

  console.log('STT transcript:', JSON.stringify(raw), ' confidence:', stt_confidence);

  // If there's an image attached, handle that quickly
  if (hasImage) {
    return "Maine photo dekha — isme dukan ya sadak nazar aa rahi hai.";
  }

  // Force LLM for broad "what can you do" style queries or capability questions
  if (
    text.includes("tum kya kar") ||
    text.includes("kya kar sakti") ||
    text.includes("kya kar sakta") ||
    text.includes("what can you do") ||
    text.includes("aap kya kar sakte") ||
    text.includes("kya kar") && text.length < 80
  ) {
    return "__USE_LLM__";
  }

  // Short canned responses that are safe and simple:
  if (text.includes('namaste') || text.includes('hello') || text.includes('hi') || text.includes('pranam')) {
    return "Namaste! Main Vaani hoon. Aapko kis cheez mein madad chahiye?";
  }

  if ((text.includes('remind') || text.includes('reminder') || text.includes('remind me') || text.includes('रिमाइंडर') || text.includes('याद दिला')) ||
      text.includes('जगाना') || text.includes('जगाना')) {
    return "Thik hai — kab set karun? (udaharan: 'kal subah 7 baje')";
  }

  if (text.length < 3) {
    return "Mujhe thoda aur bataiye ya seedha sawaal puchiye.";
  }

  // fallback marker to let main handler decide whether to call LLM
  return ""; // empty means we will likely call LLM for anything non-trivial
}

// --- API routes ---

// Health & debug
app.get('/_health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Serve sample uploaded image (useful for debugging / UI)
app.get('/sample_image', (req, res) => {
  try {
    if (fs.existsSync(SAMPLE_IMAGE_PATH)) {
      return res.sendFile(path.resolve(SAMPLE_IMAGE_PATH));
    } else {
      return res.status(404).json({ error: 'sample image not found', path: SAMPLE_IMAGE_PATH });
    }
  } catch (e) {
    console.error('sample_image error', e);
    return res.status(500).json({ error: String(e) });
  }
});

// Main action endpoint used by the UI: /act
app.post('/act', async (req, res) => {
  try {
    const text = (req.body.text || '').toString();
    const image = req.body.image || null;
    const stt_conf = req.body.stt_confidence || null;

    let intentReply = decideReply(text, !!image, stt_conf);
    console.log('decideReply returned:', JSON.stringify(intentReply));

    // Special-case: show reminders marker (if decideReply used a specific token)
    if (intentReply === "__SHOW_REMINDERS__") {
      const arr = loadReminders();
      const pending = arr.filter(r => !r.delivered);
      let spoken;
      if (pending.length === 0) spoken = "Aapke koi pending reminders nahi hain.";
      else {
        spoken = `Aapke ${pending.length} pending reminders hain. Sabse pehla: ${pending[0].title}, scheduled ${new Date(pending[0].datetime).toLocaleString('en-IN')}.`;
      }
      return res.json({ success: true, action_id: 'A-' + Date.now(), reply: spoken, reminders: pending });
    }

    // Demo reminder creation detection (keep this simple)
    const markerLower = (intentReply || '').toLowerCase();
    if (markerLower.includes('demo reminder') || markerLower.includes('kal subah 7 baje') || markerLower.includes('reminder set')) {
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 7, 0, 0);
      const iso = tomorrow.toISOString();
      const remId = addReminder('user_demo', 'Dawai yaad dilana', iso);
      const spoken = `Done. Main ne reminder set kar diya. ID: ${remId}`;
      return res.json({ success: true, action_id: remId, reply: spoken });
    }

    // Decide when to call LLM:
    const shouldCallLLM = intentReply === "__USE_LLM__" ||
                          !intentReply || // empty or not matched
                          intentReply.includes("Mujhe thoda") ||
                          intentReply.includes("Samajh nahi aaya");

    if (shouldCallLLM) {
      // build prompt and context
      const ctx = {
        user_id: 'user_demo',
        recent_reminders: loadReminders().filter(r => !r.delivered).slice(0,3)
      };
      const prompt = buildVaaniPrompt(text, ctx);
      console.log('Calling LLM with prompt (truncated):', prompt.slice(0,400));

      try {
        const llmReply = await callBrain(prompt, { max_tokens: 220 });
        const reply = (llmReply && llmReply.length) ? llmReply.trim() : "Maaf kijiye, abhi jawab dene mein dikkat ho rahi hai.";
        return res.json({ success: true, action_id: 'A-' + Date.now(), reply });
      } catch (err) {
        console.error('LLM call error', err);
        return res.json({ success: false, error: String(err) });
      }
    }

    // Otherwise return the canned reply
    return res.json({ success: true, action_id: 'A-' + Date.now(), reply: intentReply });
  } catch (e) {
    console.error('POST /act error', e);
    return res.json({ success: false, error: String(e) });
  }
});

// Endpoint to list reminders
app.get('/reminders', (req, res) => {
  try {
    const arr = loadReminders();
    res.json({ success: true, reminders: arr });
  } catch (e) {
    res.json({ success: false, error: String(e) });
  }
});

// Manual trigger to check due reminders
app.get('/check_due', (req, res) => {
  try {
    const due = checkAndMarkDue();
    res.json({ success: true, due });
  } catch (e) {
    res.json({ success: false, error: String(e) });
  }
});

// serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
