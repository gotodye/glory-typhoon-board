// 自動更新「🌐 非官方彙整消息」快照。
// 由 GitHub Actions 每 10 分鐘執行：呼叫 Google Gemini（含 Google 搜尋 grounding）
// 上網蒐集巴威颱風 + MSC 榮耀號 7/9 航次最新消息，整理後寫回 index.html 的標記區塊。
//
// 需要環境變數：GEMINI_API_KEY（Google AI Studio 金鑰，存為 GitHub Secret）。
// 輸出：若偵測到船公司/旅行社正式行程公告，於 $GITHUB_OUTPUT 寫入 official=true。

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("缺少 GEMINI_API_KEY 環境變數");
  process.exit(1);
}

const FILE = "index.html";
const START = "<!-- AI-SNAPSHOT-START -->";
const END = "<!-- AI-SNAPSHOT-END -->";
const MODEL = "gemini-2.5-flash";

// 台北時間戳（由本機/CI 產生，比讓模型自報更可靠）
function taipeiTimestamp() {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const SYSTEM = `你是「7/9 地中海榮耀號（MSC Bellissima）颱風看板」的自動彙整助理。
用 Google 搜尋查「巴威颱風」最新路徑/海警陸警時間、以及「MSC 地中海榮耀號 / 榮耀號 7/9 航次」是否有行程異動的官方或旅行社公告，另可參考 Threads / PTT / Dcard / 新聞的社群討論。
只輸出一個 JSON 物件（不要有 markdown 圍欄、不要有任何多餘文字），格式：
{
  "bullets": [ { "label": "颱風強度", "text": "…" }, { "label": "路徑與警報", "text": "…" }, { "label": "郵輪業界慣例", "text": "…" }, { "label": "行程異動", "text": "…" } ],
  "official": false,
  "official_note": ""
}
規則：
- bullets 3~5 條，text 為繁體中文純文字（可含「/」「～」，不要放 HTML 標籤），聚焦可查證的最新資訊。
- official 的判定要非常嚴格：只有在查到「MSC 官方網站/官方社群公告」「聯營旅行社（雄獅/東南/新進等）對本航次旅客發出的正式通知」或「主流媒體直接引述船公司/旅行社的正式決定」，且內容是明確、具體的行程調整結論時，才把 official 設為 true。
- 下列情況一律視為「非官方，official 仍為 false」：僅為預期/研判/臆測、網站顯示「調整中」「暫停銷售」「洽詢中」、社群或部落格的二手推測、尚未證實的傳言、或只提到颱風可能影響但無正式行程結論。寧可保守判 false，也不要因間接消息誤判 true。
- official 為 false 時 official_note 留空字串；為 true 時用一句話摘要官方公告的具體調整內容（繁體中文純文字）。`;

async function callGemini() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "請搜尋巴威颱風與 MSC 地中海榮耀號 7/9 航次的最新狀況，並依系統指示只回傳 JSON。",
            },
          ],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    throw new Error("Gemini 回覆缺少內容：" + JSON.stringify(data).slice(0, 400));
  }
  return cand.content.parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function extractJson(text) {
  let t = text.trim();
  // 去除可能的 ```json 圍欄
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("回覆中找不到 JSON：" + text.slice(0, 300));
  return JSON.parse(t.slice(first, last + 1));
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildBlock(parsed, ts) {
  const bullets = (parsed.bullets || [])
    .map((b) => `                <li><strong>${esc(b.label)}</strong>：${esc(b.text)}</li>`)
    .join("\n");

  const officialBadge = parsed.official
    ? `<span class="badge-source" style="background:#10b981;">✅ 官方已公告</span>`
    : "";
  const officialLine = parsed.official && parsed.official_note
    ? `\n            <div style="background:#ecfdf5;border:1px solid #10b981;color:#065f46;padding:10px 12px;border-radius:6px;margin-bottom:12px;"><strong>✅ 官方公告：</strong>${esc(parsed.official_note)}</div>`
    : "";

  return `${START}
    <div class="search-box unofficial-box">
        <h3 style="margin-top:0;">🌐 非官方彙整消息<span class="badge-source">網路 / 社群 / AI 彙整</span>${officialBadge}</h3>
        <div class="snapshot-time">🕐 AI 彙整於 ${ts}（雲端每 30 分鐘自動更新，直到船公司正式公告為止）</div>
        <div class="disclaimer">
            ⚠️ 本區為 AI 自動蒐集<strong>網路新聞、氣象論壇、Threads/PTT 等社群</strong>的整理，<strong>非官方公告、尚未經證實</strong>，僅供提前掌握風向參考。<strong>實際行程異動一律以 MSC 官方、旅行社正式通知與船公司簡訊為準。</strong>
        </div>${officialLine}
        <div class="snapshot-body">
            <strong>目前網路/社群綜合研判（截至彙整時間）：</strong>
            <ul>
${bullets}
            </ul>
        </div>
    </div>
    ${END}`;
}

const raw = await callGemini();
const parsed = extractJson(raw);
const ts = taipeiTimestamp();
const block = buildBlock(parsed, ts);

const html = readFileSync(FILE, "utf8");
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1) throw new Error("index.html 找不到快照標記");
const updated = html.slice(0, startIdx) + block + html.slice(endIdx + END.length);

writeFileSync(FILE, updated, "utf8");
console.log(`已更新快照（official=${!!parsed.official}）@ ${ts}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `official=${parsed.official ? "true" : "false"}\n`);
}
