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
const PRED_START = "<!-- AI-PREDICT-START -->";
const PRED_END = "<!-- AI-PREDICT-END -->";
const SUM_START = "<!-- AI-SUMMARY-START -->";
const SUM_END = "<!-- AI-SUMMARY-END -->";
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
  "summary": "…",
  "bullets": [ { "label": "颱風強度", "text": "…" }, { "label": "路徑與警報", "text": "…" }, { "label": "郵輪業界慣例", "text": "…" }, { "label": "行程異動", "text": "…" } ],
  "official": false,
  "official_note": "",
  "prediction": { "verdict": "…", "confidence": "低/中/中高/高", "reason": "…" }
}
規則：
- summary 是給登船同仁看的「目前現況摘要」：用 2~3 句繁體中文，綜合颱風最新動態與 7/9 榮耀號航次的現況重點，語氣沉穩、提醒大家以官方簡訊為準。純文字、不要 HTML 標籤。
- bullets 3~5 條，text 為繁體中文純文字（可含「/」「～」，不要放 HTML 標籤），聚焦可查證的最新資訊。
- prediction 是你根據以上所有資訊做的「綜合研判與 7/9 榮耀號航次最可能走向」：verdict 用一句話下結論（例如「極可能改為純海上巡航避風、不停靠日本港口」或「照原行程機率高」等）；confidence 為你的信心水準（低/中/中高/高）；reason 用 2~4 句說明推理依據（颱風路徑與警報時程、業界避風慣例、社群跡象等）。全部繁體中文純文字、不要 HTML 標籤。這是推測，語氣要標明不確定性。
- official 的判定要非常嚴格：只有在查到「MSC 官方網站/官方社群公告」「聯營旅行社（雄獅/東南/新進等）對本航次旅客發出的正式通知」或「主流媒體直接引述船公司/旅行社的正式決定」，且內容是明確、具體的行程調整結論時，才把 official 設為 true。
- 下列情況一律視為「非官方，official 仍為 false」：僅為預期/研判/臆測、網站顯示「調整中」「暫停銷售」「洽詢中」、社群或部落格的二手推測、尚未證實的傳言、或只提到颱風可能影響但無正式行程結論。寧可保守判 false，也不要因間接消息誤判 true。
- official 為 false 時 official_note 留空字串；為 true 時用一句話摘要官方公告的具體調整內容（繁體中文純文字）。
- 極重要：輸出必須是「可直接被 JSON.parse 解析的合法 JSON」。只輸出這一個 JSON 物件，不要 markdown 圍欄、不要前後任何多餘文字或說明；字串內若出現雙引號請用反斜線跳脫（\\"），字串內不要有換行。`;

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

  // 從第一個 { 開始做「括號平衡掃描」，略過字串內的括號，找到對應的結尾 }
  const start = t.indexOf("{");
  if (start === -1) throw new Error("回覆中找不到 JSON 起點：" + text.slice(0, 300));
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error("JSON 大括號不平衡：" + text.slice(0, 300));

  let js = t.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"); // 去除尾逗號
  return JSON.parse(js);
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

function buildPredictBlock(parsed, ts) {
  const p = parsed.prediction || {};
  const conf = p.confidence
    ? `<div class="predict-conf">信心水準：${esc(p.confidence)}</div>`
    : "";
  return `${PRED_START}
    <div class="search-box predict-box">
        <h3 style="margin-top:0;">🔮 AI 綜合預測<span class="badge-predict">AI 推測 · 僅供參考</span></h3>
        <div class="snapshot-time" style="color:#4338ca;">🕐 更新於 ${ts}（雲端每 30 分鐘自動更新）</div>
        <div class="disclaimer" style="background:#e0e7ff;border-color:#6366f1;color:#3730a3;">
            ⚠️ 以下為 AI 根據颱風路徑、警報時程、郵輪業界慣例與網路社群消息所做的<strong>綜合研判與可能走向推測</strong>，<strong>並非官方決定、也不保證準確</strong>，實際行程一律以 MSC 官方與船公司簡訊為準。
        </div>
        <div class="predict-verdict">${esc(p.verdict || "（本次未產生預測）")}</div>
        <div class="predict-reason">${esc(p.reason || "")}</div>
        ${conf}
    </div>
    ${PRED_END}`;
}

function buildSummaryBlock(parsed, ts) {
  const summary = parsed.summary
    ? esc(parsed.summary)
    : "（本次未產生摘要，請以下方 AI 彙整與官方公告為準）";
  return `${SUM_START}
        <div class="timeline-item">
            <div class="timeline-time">${ts}（AI 自動彙整）</div>
            <div class="timeline-title">目前現況摘要<span class="badge-alert">重要</span></div>
            <div class="timeline-content">${summary}</div>
        </div>
        ${SUM_END}`;
}

function replaceRegion(html, start, end, block) {
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s === -1 || e === -1) throw new Error(`index.html 找不到標記：${start}`);
  return html.slice(0, s) + block + html.slice(e + end.length);
}

// 呼叫 + 解析，最多重試 2 次（Gemini 偶爾吐出格式不乾淨的 JSON）
let parsed, lastErr;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    parsed = extractJson(await callGemini());
    break;
  } catch (e) {
    lastErr = e;
    console.warn(`第 ${attempt} 次解析失敗，重試中：${e.message}`);
  }
}
if (!parsed) throw lastErr;
const ts = taipeiTimestamp();

let html = readFileSync(FILE, "utf8");
html = replaceRegion(html, SUM_START, SUM_END, buildSummaryBlock(parsed, ts));
html = replaceRegion(html, START, END, buildBlock(parsed, ts));
html = replaceRegion(html, PRED_START, PRED_END, buildPredictBlock(parsed, ts));
writeFileSync(FILE, html, "utf8");
console.log(`已更新摘要+快照+預測（official=${!!parsed.official}）@ ${ts}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `official=${parsed.official ? "true" : "false"}\n`);
}
