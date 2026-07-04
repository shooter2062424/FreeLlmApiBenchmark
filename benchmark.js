#!/usr/bin/env node
/**
 * NVIDIA NIM 全 model benchmark
 * ------------------------------------------------------------------
 * 對 NVIDIA NIM (integrate.api.nvidia.com) 你 API key 可存取的所有 model,
 * 實測並推斷:
 *   - type            : chat / embedding / rerank / unsupported(用哪個 endpoint 成功來判定)
 *   - context window  : NVIDIA API 不回傳,改用 pi 內建 DB 的 declared 值 + 盡力探測 output 上限
 *   - reasoning       : 串流中是否出現 reasoning_content(實測)
 *   - cache           : 同一長 prompt 連打兩次,usage.prompt_tokens_details.cached_tokens 是否 >0(實測)
 *   - TTFT            : 送出請求 → 第一個 content token 的延遲(串流量測,取熱機中位數)
 *   - token rate      : 生成 token 數 ÷ (最後 token 時間 − 第一個 token 時間),排除 TTFT(熱機中位數)
 *   - cold start      : 第一次呼叫(NVCF 冷啟動)的總 wall time,單獨記錄
 *
 * 公平性設計:
 *   - 所有 chat model 用「同一個 prompt」、temperature=0、相同 max_tokens
 *   - 每個 model 先跑 1 次冷啟動(不列入 TTFT/rate),再跑 WARM_RUNS 次熱機取中位數
 *   - token rate 只算「穩態生成」區段,把 TTFT 排除掉
 *
 * 用法:
 *   NVIDIA_API_KEY=nvapi-xxx node benchmark.js            # 跑全部,寫 results.json,再產生 report.html
 *   NVIDIA_API_KEY=nvapi-xxx node benchmark.js --resume   # 跳過 results.json 內已完成的 model
 *   NVIDIA_API_KEY=nvapi-xxx node benchmark.js --only meta/llama-3.1-8b-instruct,z-ai/glm-5.2
 *   node benchmark.js --report-only                       # 不重跑,只用現有 results.json 產生 report.html
 */

const fs = require("fs");
const path = require("path");

// ────────────────────────────── 設定 ──────────────────────────────
const CFG = {
  BASE_URL: "https://integrate.api.nvidia.com/v1",
  API_KEY: process.env.NVIDIA_API_KEY || "",
  CONCURRENCY: 6,              // 同時並發的 model 數
  WARM_RUNS: 2,                // 冷啟動後,量測用的熱機次數(取中位數)
  MAX_TOKENS: 256,            // benchmark 生成長度(所有 chat model 一致)
  REQ_TIMEOUT_MS: 90000,      // 單次請求逾時
  RETRY_429: 3,               // 遇到 429/503 的重試次數
  DO_CACHE_PROBE: true,       // 是否做 cache 偵測(多 2 次呼叫)
  DO_MAXOUT_PROBE: false,     // NVIDIA 對超大 max_tokens 靜默截斷(回 200),探測無效 → 預設關
  OUT_DIR: __dirname,
  // 公平比較用的固定 prompt(生成量足夠讓 token rate 穩定)
  BENCH_PROMPT:
    "Write a clear, detailed, step-by-step technical explanation of how the TCP three-way handshake establishes a connection. Cover SYN, SYN-ACK, ACK, sequence numbers, and connection state transitions.",
};

const HEADERS = () => ({
  Authorization: "Bearer " + CFG.API_KEY,
  "Content-Type": "application/json",
  "NVCF-POLL-SECONDS": "3600",
});

// ────────────────────────── type 分類(啟發式,決定先打哪個 endpoint) ──────────────────────────
function guessCategory(id) {
  const s = id.toLowerCase();
  if (/(^|\/)(embed|nv-embed)|embedqa|-embed|embedding|nemoretriever.*embed|arctic-embed|bge-m3/.test(s)) return "embedding";
  if (/rerank/.test(s)) return "rerank";
  if (/paddleocr|nemoretriever-parse|nemotron-parse|deplot/.test(s)) return "ocr/parse";
  if (/parakeet|canary|fastpitch|hifigan|magpie|riva-translate/.test(s)) return "speech";
  if (/nvclip|\bsana\b|flux|stable-diffusion|sdxl|consistory|edify|genmo/.test(s)) return "image/clip";
  if (/reward/.test(s)) return "reward";
  return "chat";
}

// ────────────────────────────── 小工具 ──────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 帶逾時 + 429 退避的 fetch
async function doFetch(url, body, { stream = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= CFG.RETRY_429; attempt++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), CFG.REQ_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: HEADERS(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(to);
      if ((res.status === 429 || res.status === 503) && attempt < CFG.RETRY_429) {
        const wait = 2000 * (attempt + 1);
        await res.text().catch(() => {});
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (e.name === "AbortError") return { __timeout: true, status: 0 };
      if (attempt < CFG.RETRY_429) { await sleep(1500 * (attempt + 1)); continue; }
    }
  }
  return { __error: true, status: 0, errMsg: lastErr ? String(lastErr.message || lastErr) : "unknown" };
}

// ────────────────────── 串流 chat 量測(單次) ──────────────────────
// 回傳 { ok, status, err, ttftMs, genMs, outTokens, tokenRate, reasoning, cachedTokens, promptTokens, totalMs, text }
async function streamChatOnce(model, { safe = false } = {}) {
  // 一般模式帶 stream_options(拿 usage);safe 模式拿掉會被部分 model 拒絕的欄位
  const body = safe
    ? { model, messages: [{ role: "user", content: CFG.BENCH_PROMPT }], max_tokens: CFG.MAX_TOKENS, stream: true }
    : { model, messages: [{ role: "user", content: CFG.BENCH_PROMPT }], temperature: 0.2, max_tokens: CFG.MAX_TOKENS, stream: true, stream_options: { include_usage: true } };
  const t0 = performance.now();
  const res = await doFetch(CFG.BASE_URL + "/chat/completions", body, { stream: true });
  if (res.__timeout) return { ok: false, status: 0, err: "timeout" };
  if (res.__error) return { ok: false, status: 0, err: res.errMsg };
  if (!res.ok || !res.body) {
    let txt = "";
    try { txt = await res.text(); } catch {}
    // 參數相容問題(temperature 必須 >0、不接受 stream_options 等)→ 用 safe 模式重試一次
    if (!safe && (res.status === 422 || res.status === 400) &&
        /temperature|stream_options|extra input|not permitted|unrecognized|unexpected/i.test(txt)) {
      return streamChatOnce(model, { safe: true });
    }
    return { ok: false, status: res.status, err: shortErr(res.status, txt) };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let tFirst = null, tLast = null;
  let deltaTokens = 0, outTokens = null, promptTokens = null, cachedTokens = null;
  let reasoning = false;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (d) {
          const rc = d.reasoning_content ?? d.reasoning;
          if (rc) reasoning = true;
          const c = typeof d.content === "string" ? d.content : "";
          // TTFT/rate 以「第一個輸出 token」為錨點,不分 reasoning 或 content
          // (標準 time-to-first-token 定義,對 reasoning / 非 reasoning model 一致公平)
          const produced = (c && c.length) || (rc && String(rc).length);
          if (produced) {
            if (tFirst === null) tFirst = performance.now();
            tLast = performance.now();
            deltaTokens++;
          }
          if (c) text += c;
        }
        if (obj.usage) {
          outTokens = obj.usage.completion_tokens ?? outTokens;
          promptTokens = obj.usage.prompt_tokens ?? promptTokens;
          const det = obj.usage.prompt_tokens_details;
          if (det && typeof det.cached_tokens === "number") cachedTokens = det.cached_tokens;
        }
      }
    }
  } catch (e) {
    return { ok: false, status: res.status, err: "stream-broken: " + String(e.message || e) };
  }
  const tEnd = performance.now();
  // 有些 model(部分 qwen/deepseek/glm)把思考放進 content 的 <think> 標籤,而非 reasoning_content 欄位
  if (/<think>|<\/think>|◁think▷/i.test(text)) reasoning = true;
  const eff = outTokens ?? deltaTokens;
  const ttftMs = tFirst !== null ? tFirst - t0 : null;
  const genMs = tFirst !== null && tLast !== null ? tLast - tFirst : null;
  // token rate 合理性保護:整包一次吐回(genMs≈0)或 chunk 太少 → 無法可靠量測生成速度,標 null
  let tokenRate = genMs && genMs >= 20 && eff > 1 && deltaTokens > 1 ? ((eff - 1) / (genMs / 1000)) : null;
  if (tokenRate != null && tokenRate > 5000) tokenRate = null; // 明顯是 buffered 回應,不可信
  return {
    ok: true, status: res.status, err: null,
    ttftMs, genMs, totalMs: tEnd - t0,
    outTokens: eff, promptTokens, cachedTokens, reasoning,
    tokenRate, text,
  };
}

function shortErr(status, txt) {
  let detail = txt;
  try { const j = JSON.parse(txt); detail = j.detail || j.message || (j.error && (j.error.message || j.error)) || txt; } catch {}
  detail = String(detail).replace(/\s+/g, " ").slice(0, 180);
  // 遮蔽帳號識別資訊,避免寫進 results.json / report.html(公開分享安全)
  detail = detail.replace(/for account '[^']+'/gi, "for account '<redacted>'");
  return `HTTP ${status}: ${detail}`;
}

// ────────────────────── embedding 量測 ──────────────────────
async function benchEmbedding(model) {
  const t0 = performance.now();
  const res = await doFetch(CFG.BASE_URL + "/embeddings", {
    model, input: ["The quick brown fox jumps over the lazy dog."],
    input_type: "query", // NVIDIA nemo retriever 需要;多數會忽略
  });
  const latencyMs = performance.now() - t0;
  if (res.__timeout) return { endpoint: "embeddings", status: "timeout", err: "timeout" };
  if (res.__error) return { endpoint: "embeddings", status: "error", err: res.errMsg };
  let txt = ""; try { txt = await res.text(); } catch {}
  if (!res.ok) return { endpoint: "embeddings", status: "error", err: shortErr(res.status, txt) };
  let dim = null, promptTokens = null;
  try { const j = JSON.parse(txt); dim = j.data && j.data[0] && j.data[0].embedding && j.data[0].embedding.length;
        promptTokens = j.usage && (j.usage.total_tokens ?? j.usage.prompt_tokens); } catch {}
  return { endpoint: "embeddings", status: "ok", latencyMs, dim, promptTokens };
}

// ────────────────────── rerank 量測 ──────────────────────
async function benchRerank(model) {
  const t0 = performance.now();
  const res = await doFetch(CFG.BASE_URL + "/ranking", {
    model,
    query: { text: "What is the capital of France?" },
    passages: [{ text: "Paris is the capital of France." }, { text: "Bananas are yellow." }],
  });
  const latencyMs = performance.now() - t0;
  if (res.__timeout) return { endpoint: "ranking", status: "timeout", err: "timeout" };
  if (res.__error) return { endpoint: "ranking", status: "error", err: res.errMsg };
  let txt = ""; try { txt = await res.text(); } catch {}
  if (!res.ok) return { endpoint: "ranking", status: "error", err: shortErr(res.status, txt) };
  return { endpoint: "ranking", status: "ok", latencyMs };
}

// ────────────────────── cache 偵測(連打兩次同一長 prompt) ──────────────────────
async function probeCache(model) {
  const filler = ("The system processes data through multiple stages. ").repeat(120); // ~1.2k+ tokens
  const body = {
    model,
    messages: [{ role: "user", content: filler + "\n\nReply with the single word OK." }],
    temperature: 0.2, max_tokens: 1, stream: false,
  };
  const call = async () => {
    const res = await doFetch(CFG.BASE_URL + "/chat/completions", body);
    if (res.__timeout || res.__error || !res.ok) return null;
    let txt = ""; try { txt = await res.text(); } catch {}
    try { const j = JSON.parse(txt);
      const det = j.usage && j.usage.prompt_tokens_details;
      return { prompt: j.usage && j.usage.prompt_tokens, cached: det && det.cached_tokens };
    } catch { return null; }
  };
  const a = await call();
  if (!a) return { cache: null };
  const b = await call();
  if (!b) return { cache: null };
  const cached = (b.cached ?? 0) > 0;
  return { cache: cached, cachedTokens: b.cached ?? 0, promptTokens: b.prompt ?? null };
}

// ────────────────────── output 上限探測(送超大 max_tokens,讀 400 錯誤) ──────────────────────
async function probeMaxOutput(model) {
  const res = await doFetch(CFG.BASE_URL + "/chat/completions", {
    model, messages: [{ role: "user", content: "hi" }], max_tokens: 100000000, stream: false,
  });
  if (res.__timeout || res.__error) return null;
  let txt = ""; try { txt = await res.text(); } catch {}
  if (res.ok) return null; // 沒報錯 → 靜默截斷,拿不到上限
  const m = txt.match(/max(?:imum)?[^0-9]{0,40}?(\d{3,7})/i) || txt.match(/(\d{3,7})[^0-9]{0,20}tokens/i);
  return m ? parseInt(m[1], 10) : null;
}

// ────────────────────── 單一 model 的完整流程 ──────────────────────
async function benchModel(model, declared) {
  const cat = guessCategory(model.id);
  const base = { id: model.id, owned_by: model.owned_by, guessedCategory: cat, declared: declared || null };

  if (cat === "embedding") return { ...base, type: "embedding", ...(await benchEmbedding(model.id)) };
  if (cat === "rerank")    return { ...base, type: "rerank", ...(await benchRerank(model.id)) };

  // 其餘一律先試 chat completions(guard/reward/vision 也走這條,能不能成功由結果決定)
  // 1) 冷啟動
  const cold = await streamChatOnce(model.id);
  if (!cold.ok) {
    // chat 失敗 → 若像是 embedding/其他,回退試 embeddings
    const fb = await benchEmbedding(model.id);
    if (fb.status === "ok") return { ...base, type: "embedding", ...fb, note: "chat 失敗,embeddings 成功" };
    return { ...base, type: cat === "chat" ? "unsupported" : cat, endpoint: "chat", status: statusFromErr(cold.err), err: cold.err };
  }

  // 2) 熱機 N 次
  const warm = [];
  for (let i = 0; i < CFG.WARM_RUNS; i++) warm.push(await streamChatOnce(model.id));
  const okWarm = warm.filter((w) => w.ok && w.ttftMs !== null);
  const ttft = median(okWarm.map((w) => w.ttftMs));
  const rate = median(okWarm.map((w) => w.tokenRate).filter((x) => x != null));
  const reasoning = cold.reasoning || warm.some((w) => w.reasoning);

  // 3) cache / maxout 探測
  let cache = { cache: null };
  if (CFG.DO_CACHE_PROBE) cache = await probeCache(model.id);
  let maxOut = null;
  if (CFG.DO_MAXOUT_PROBE) maxOut = await probeMaxOutput(model.id);

  return {
    ...base,
    type: "chat",
    endpoint: "chat",
    status: "ok",
    coldStartMs: cold.totalMs,
    coldTtftMs: cold.ttftMs,
    ttftMs: ttft,
    tokenRate: rate,
    outputTokens: median(okWarm.map((w) => w.outTokens).filter((x) => x != null)),
    promptTokens: cold.promptTokens,
    reasoning,
    cache: cache.cache,
    cachedTokens: cache.cachedTokens ?? null,
    probedMaxOutput: maxOut,
    warmRunsOk: okWarm.length,
  };
}

function statusFromErr(err) {
  if (!err) return "error";
  if (/410/.test(err)) return "eol";
  if (/404/.test(err) && /not found|function/i.test(err)) return "unavailable"; // 帳號未開通此 model
  if (/timeout/i.test(err)) return "timeout";
  return "error";
}

// ────────────────────── 並發池 ──────────────────────
async function runPool(items, worker, concurrency, onDone) {
  const q = [...items.entries()];
  let active = 0, i = 0;
  const results = new Array(items.length);
  return new Promise((resolve) => {
    const next = () => {
      if (i >= q.length && active === 0) return resolve(results);
      while (active < concurrency && i < q.length) {
        const [idx, item] = q[i++];
        active++;
        worker(item, idx)
          .then((r) => { results[idx] = r; })
          .catch((e) => { results[idx] = { id: item.id, type: "error", status: "error", err: String(e.message || e) }; })
          .finally(() => { active--; onDone && onDone(results[idx], idx, items.length); next(); });
      }
    };
    next();
  });
}

// ────────────────────── 主流程 ──────────────────────
async function main() {
  const args = process.argv.slice(2);
  const resultsPath = path.join(CFG.OUT_DIR, "results.json");
  const reportPath = path.join(CFG.OUT_DIR, "report.html");

  // 只產 report
  if (args.includes("--report-only")) {
    const data = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    const { generateReport } = require("./report.js");
    fs.writeFileSync(reportPath, generateReport(data));
    console.log("report.html 已重新產生:", reportPath);
    return;
  }

  if (!CFG.API_KEY) { console.error("請設定環境變數 NVIDIA_API_KEY"); process.exit(1); }

  // 取得 model 清單
  let models;
  const cachePath = path.join(CFG.OUT_DIR, "nvmodels.json");
  const r = await fetch(CFG.BASE_URL + "/models", { headers: HEADERS() });
  const mj = await r.json();
  models = mj.data;
  fs.writeFileSync(cachePath, JSON.stringify(mj, null, 2));

  // declared 參照(context/max-out;NVIDIA API 不提供,改用 pi --list-models 解析)
  const declaredTxt = path.join(CFG.OUT_DIR, "pi-nvidia-listmodels.txt");
  ensureDeclaredFile(declaredTxt); // 若檔案不存在且有 pi 可用,自動產生
  const declaredMap = loadDeclared(declaredTxt);

  // --only 過濾
  const onlyArg = args.find((a) => a.startsWith("--only"));
  if (onlyArg) {
    const list = (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1]).split(",");
    models = models.filter((m) => list.includes(m.id));
  }

  // --resume:載入已完成
  let prev = {};
  if (args.includes("--resume") && fs.existsSync(resultsPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      old.results.forEach((x) => { prev[x.id] = x; });
      console.log("resume:已完成", Object.keys(prev).length, "個");
    } catch {}
  }

  const todo = models.filter((m) => !prev[m.id] || prev[m.id].status === "timeout");
  console.log(`共 ${models.length} 個 model,待跑 ${todo.length} 個,並發 ${CFG.CONCURRENCY}`);

  const meta = {
    generatedAt: new Date().toISOString(),
    baseUrl: CFG.BASE_URL,
    config: { warmRuns: CFG.WARM_RUNS, maxTokens: CFG.MAX_TOKENS, prompt: CFG.BENCH_PROMPT },
    totalModels: models.length,
  };
  const collected = { ...prev };
  let done = 0;

  await runPool(
    todo,
    (m) => benchModel(m, declaredMap[m.id]),
    CFG.CONCURRENCY,
    (res, idx, total) => {
      collected[res.id] = res;
      done++;
      const tag = res.status === "ok" ? "ok " : (res.status || "??");
      const extra = res.type === "chat" && res.status === "ok"
        ? `TTFT ${fmt(res.ttftMs)}ms  ${fmt(res.tokenRate)} tok/s  reason=${res.reasoning} cache=${res.cache}`
        : (res.type === "embedding" && res.status === "ok" ? `dim=${res.dim} ${fmt(res.latencyMs)}ms` : (res.err || ""));
      console.log(`[${done}/${todo.length}] ${tag.padEnd(4)} ${res.id.padEnd(48)} ${extra}`);
      // 每完成一個就落地一次(可中斷續跑)
      const arr = Object.values(collected).sort((a, b) => a.id.localeCompare(b.id));
      fs.writeFileSync(resultsPath, JSON.stringify({ meta, results: arr }, null, 2));
    }
  );

  const arr = Object.values(collected).sort((a, b) => a.id.localeCompare(b.id));
  const finalData = { meta, results: arr };
  fs.writeFileSync(resultsPath, JSON.stringify(finalData, null, 2));
  console.log("\nresults.json 已寫入。產生 report.html …");
  const { generateReport } = require("./report.js");
  fs.writeFileSync(reportPath, generateReport(finalData));
  console.log("完成:", reportPath);
}

function fmt(x) { return x == null ? "-" : (Math.round(x * 10) / 10).toString(); }

// 若 declared 檔缺失,嘗試用 pi 自動產生(需環境變數 PI_EXE 指向 pi 執行檔;無則略過,degrade gracefully)
function ensureDeclaredFile(txtPath) {
  if (fs.existsSync(txtPath)) return;
  const piExe = process.env.PI_EXE;
  if (!piExe || !fs.existsSync(piExe)) return;
  try {
    const out = require("child_process").execFileSync(piExe, ["--list-models"], { encoding: "utf8", timeout: 60000 });
    const nv = out.split(/\r?\n/).filter((l) => l.startsWith("nvidia")).join("\n");
    if (nv) { fs.writeFileSync(txtPath, nv); console.log("已用 PI_EXE 自動產生 declared 參照表"); }
  } catch (e) { /* 略過,declared 欄位留空 */ }
}

// 解析 pi --list-models 的 nvidia 行 → declared 參照
function loadDeclared(p) {
  const map = {};
  if (!fs.existsSync(p)) return map;
  const toNum = (s) => {
    const m = String(s).match(/([\d.]+)\s*([KM]?)/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2] === "K") n *= 1e3; else if (m[2] === "M") n *= 1e6;
    return Math.round(n);
  };
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 6 || parts[0] !== "nvidia") continue;
    map[parts[1]] = {
      context: toNum(parts[2]),
      maxOutput: toNum(parts[3]),
      reasoning: parts[4] === "yes",
      vision: parts[5] === "yes",
    };
  }
  return map;
}

main().catch((e) => { console.error(e); process.exit(1); });
