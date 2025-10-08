const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
app.use(express.static(path.join(__dirname, '.'))); // 服 index.html

const JWT_URL = process.env.JWT_URL || "https://beta.aiipo.jp/apmng/chat/get_jwt.php";
const CHAT_URL = process.env.CHAT_URL || "https://x162-43-21-174.static.xvps.ne.jp/chat";
const FULL_COOKIE = process.env.FULL_COOKIE || '';
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const REFERER = "https://beta.aiipo.jp/apmng/chat/llm_chat.php?chat_id=-1&p=0";

const AVAILABLE_MODELS = [
  "gemini-2.5-flash-lite-preview-06-17", "gemini-2.5-flash", "gemini-2.5-pro",
  "gpt-4.1-nano-2025-04-14", "gpt-4.1-mini-2025-04-14", "gpt-4.1-2025-04-14",
  "gpt-4o-2024-11-20", "o4-mini-2025-04-16", "gpt-5"
];

const reasoningEffortMap = { minimal: 512, low: 2048, medium: 8192, high: 24576 };

async function getJwt() {
  const headers = { 'Cookie': FULL_COOKIE, 'User-Agent': USER_AGENT, 'Referer': REFERER, 'x-requested-with': 'XMLHttpRequest' };
  const resp = await fetch(JWT_URL, { method: 'GET', headers }); // Native fetch
  if (!resp.ok) throw new Error(`get_jwt failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  if (!j.jwt) throw new Error("no jwt");
  return j.jwt;
}

function buildModelsResponse() {
  const now = Math.floor(Date.now() / 1000);
  const data = AVAILABLE_MODELS.map(id => ({ id, object: "model", created: now, owned_by: "openai" }));
  return { object: "list", data };
}

function pickQueryAndHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { query: "", history: [] };
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIndex = i; break; }
  }
  if (lastUserIndex === -1) return { query: "", history: messages };
  const query = messages[lastUserIndex].content || "";
  const history = messages.slice(0, lastUserIndex);
  return { query, history };
}

app.get('/v1/models', (req, res) => res.json(buildModelsResponse()));



function openAiNonStreamResponse({ id, model, text }) {
  return {
    id, object: "chat.completion", created: nowSecs(), model,
    choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, completion_tokens_details: {} },
    system_fingerprint: "fp_1"
  };
}

function nowSecs() { return Math.floor(Date.now() / 1000); }

function makeChunkObject({ id, model, fragment, finish }) {
  const base = { id, object: "chat.completion.chunk", created: nowSecs(), model, choices: [{ index: 0, delta: {}, finish_reason: null }] };
  if (fragment) base.choices[0].delta = { role: "assistant", content: fragment };
  if (finish) base.choices[0].finish_reason = "stop";
  return base;
}

const port = process.env.PORT || 10000; // Render 默认 10000
app.listen(port, () => console.log(`Server on port ${port}`));
