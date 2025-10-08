const express = require('express');
const fetch = require('node-fetch'); // npm install node-fetch
const app = express();
app.use(express.json());
app.use(express.static('.')); // 服 index.html

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
  const resp = await fetch(JWT_URL, { method: 'GET', headers });
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

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = "gemini-2.5-flash-lite-preview-06-17", messages, stream = false, thinking_budget } = req.body;
    const { query, history } = pickQueryAndHistory(messages);

    let tb = undefined;
    if (thinking_budget !== undefined) {
      if (typeof thinking_budget === "number") tb = thinking_budget;
      else if (typeof thinking_budget === "string") tb = (reasoningEffortMap[thinking_budget.toLowerCase()] ?? parseInt(thinking_budget)) || 2048;
    }

    const inputs = { llm_model: model, web_search: "off", thinking_budget: tb };
    const srcMessages = history.map((m, idx) => ({ id: m.id || idx, role: m.role, content: m.content, token: m.token || 1, llm_model: m.llm_model || model, created_at: m.created_at || new Date().toISOString(), updated_at: m.updated_at || new Date().toISOString(), deleted_at: m.deleted_at || null }));
    const srcBody = { messages: srcMessages, query, conversation_id: req.body.conversation_id || "", user: "web-user", inputs, response_mode: "streaming" };

    const jwt = await getJwt();
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'Accept': '*/*', 'Origin': 'https://beta.aiipo.jp', 'User-Agent': USER_AGENT, 'Referer': REFERER, 'x-requested-with': 'XMLHttpRequest' };
    const srcResp = await fetch(CHAT_URL, { method: 'POST', headers, body: JSON.stringify(srcBody) });

    if (!srcResp.ok) {
      const text = await srcResp.text();
      return res.status(502).json({ error: `source error: ${srcResp.status} ${text}` });
    }

    if (!stream) {
      // Non-stream: 聚合 SSE 或 JSON
      const contentType = srcResp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const j = await srcResp.json();
        let text = j.text || j.choices?.[0]?.message?.content || JSON.stringify(j);
        const id = `chatcmpl-${Date.now()}`;
        return res.json(openAiNonStreamResponse({ id, model, text }));
      }
      // Fallback SSE 聚合 (简化版)
      const reader = srcResp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          const lines = chunk.split(/\r?\n/).filter(l => l.trim());
          let dataPayloads = [];
          for (const line of lines) {
            if (/^[0-9a-fA-F]+$/.test(line)) continue;
            if (line.startsWith("data:")) dataPayloads.push(line.slice(5).trim());
            else dataPayloads.push(line);
          }
          for (const payload of dataPayloads) {
            if (payload === "[DONE]") break;
            try {
              const pj = JSON.parse(payload);
              if (pj.event === "message_delta") acc += pj.data.delta || "";
              else if (pj.event === "message") acc += pj.data.text || "";
              else if (pj.data.delta) acc += pj.data.delta;
            } catch { acc += payload; }
          }
        }
      }
      const id = `chatcmpl-${Date.now()}`;
      res.json(openAiNonStreamResponse({ id, model, text: acc }));
    } else {
      // Stream: 转发 SSE
      res.set('Content-Type', 'text/event-stream');
      res.set('Cache-Control', 'no-cache');
      res.set('Connection', 'keep-alive');
      const reader = srcResp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const sendChunk = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const messageId = `chatcmpl-${Date.now()}`;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!block) continue;
          const lines = block.split(/\r?\n/).filter(l => l.trim());
          let dataParts = [];
          for (const line of lines) {
            if (/^[0-9a-fA-F]+$/.test(line)) continue;
            if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
            else dataParts.push(line);
          }
          const payload = dataParts.join("\n");
          if (!payload) continue;
          if (payload === "[DONE]") {
            sendChunk({ id: messageId, object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: "stop" }] });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          let pj;
          try { pj = JSON.parse(payload); } catch { sendChunk(makeChunkObject({ id: messageId, model, fragment: payload })); continue; }
          const ev = pj.event;
          if (ev === "message_delta") {
            const frag = pj.data.delta || "";
            sendChunk(makeChunkObject({ id: messageId, model, fragment: frag }));
          } else if (ev === "message") {
            const text = pj.data.text || "";
            sendChunk(makeChunkObject({ id: messageId, model, fragment: text }));
          } else if (ev === "message_end") {
            sendChunk(makeChunkObject({ id: messageId, model, finish: true }));
            res.write('data: [DONE]\n\n');
            return res.end();
          } else if (pj.data.delta) {
            sendChunk(makeChunkObject({ id: messageId, model, fragment: pj.data.delta }));
          } else {
            sendChunk(makeChunkObject({ id: messageId, model, fragment: JSON.stringify(pj) }));
          }
        }
      }
      sendChunk({ id: messageId, object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: "stop" }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server on port ${port}`));
