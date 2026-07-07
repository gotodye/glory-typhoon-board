// 自動更新「🌐 非官方彙整消息」快照。
// 由 GitHub Actions 每 10 分鐘執行：呼叫 Claude（含 web_search 工具）上網蒐集
// 巴威颱風 + MSC 榮耀號 7/9 航次最新消息，整理後寫回 index.html 的標記區塊。
//
// 需要環境變數：ANTHROPIC_API_KEY（存為 GitHub Secret）。
// 輸出：若偵測到船公司/旅行社正式行程公告，於 $GITHUB_OUTPUT 寫入 official=true。

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("缺少 ANTHROPIC_API_KEY 環境變數");
  process.exit(1);
}

const FILE = "index.html";
const START = "<!-- AI-SNAPSHOT-START -->";
const END = "<!-- AI-SNAPSHOT-END -->";
const MODEL = "claude-sonnet-5";

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
用 web_search 工具搜尋「巴威颱風」最新路徑/海警陸警時間、以及「MSC 地中海榮耀號 / 榮耀號 7/9 航次」是否有行程異動的官方或旅行社公告，另可參考 Threads / PTT / Dcard / 新聞的社群討論。
只輸出一個 JSON 物件（不要有 markdown 圍欄、不要有任何多餘文字），格式：
{
  "bullets": [ { "label": "颱風強度", "text": "…" }, { "label": "路徑與警報", "text": "…" }, { "label": "郵輪業界慣例", "text": "…" }, { "label": "行程異動", "text": "…" } ],
  "official": false,
  "official_note": ""
}
規則：
- bullets 3~5 條，text 為繁體中文純文字（可含「/」「～」，不要放 HTML 標籤），聚焦可查證的最新資訊。
- 若查到 MSC 官方、聯營旅行社（雄獅/東南/新進等）或船公司「正式宣布本 7/9 航次行程調整」的可信來源，將 official 設為 true，並在 official_note 用一句話摘要官方調整內容（繁體中文純文字）。否則 official 為 false、official_note 為空字串。`;

async function callClaude() {
  const messages = [
    {
      role: "user",
      content:
        "請搜尋巴威颱風與 MSC 地中海榮耀號 7/9 航次的最新狀況，並依系統指示只回傳 JSON。",
    },
  ];

  for (let i = 0; i < 6; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${body}`);
    }

    const data = await res.json();

    // 伺服器端工具迴圈達上限會回 pause_turn，需把回覆接回去再送一次。
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text;
  }
  throw new Error("web search 迴圈超過上限仍未取得最終回覆");
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
        <div class="snapshot-time">🕐 AI 彙整於 ${ts}（雲端每 10 分鐘自動更新，直到船公司正式公告為止）</div>
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

const raw = await callClaude();
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
