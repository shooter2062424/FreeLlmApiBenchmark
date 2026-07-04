#!/usr/bin/env node
/**
 * NVIDIA NIM benchmark → HTML report 產生器(獨立可執行)
 *   node report.js                # 讀 results.json → 產生 report.html
 *   node report.js in.json out.html
 * 也被 benchmark.js 以 require("./report.js").generateReport(data) 呼叫。
 * 產出的 report.html 為單一自包含檔案(內嵌 CSS/JS,可排序/篩選/搜尋)。
 */
const fs = require("fs");
const path = require("path");

function fmtNum(x, d = 0) {
  if (x == null || Number.isNaN(x)) return "";
  const f = Math.pow(10, d);
  return (Math.round(x * f) / f).toLocaleString("en-US");
}
function fmtCtx(n) {
  if (n == null) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "K";
  return String(n);
}

function generateReport(data) {
  const meta = data.meta || {};
  const rows = (data.results || []).slice();

  // 統計
  const byType = {};
  rows.forEach((r) => { byType[r.type || "?"] = (byType[r.type || "?"] || 0) + 1; });
  const chatOk = rows.filter((r) => r.type === "chat" && r.status === "ok");
  const okCount = rows.filter((r) => r.status === "ok").length;
  const fastestTtft = chatOk.filter((r) => r.ttftMs != null).sort((a, b) => a.ttftMs - b.ttftMs)[0];
  const topRate = chatOk.filter((r) => r.tokenRate != null).sort((a, b) => b.tokenRate - a.tokenRate)[0];

  // 每列資料(給前端 JS 用)
  const jsonRows = rows.map((r) => {
    const d = r.declared || {};
    return {
      id: r.id,
      owned_by: r.owned_by || "",
      type: r.type || "?",
      status: r.status || "",
      context: d.context ?? null,
      maxOut: d.maxOutput ?? r.probedMaxOutput ?? null,
      maxOutSrc: d.maxOutput != null ? "declared" : (r.probedMaxOutput != null ? "probed" : ""),
      reasoning: r.type === "chat" && r.status === "ok" ? !!r.reasoning : (d.reasoning ?? null),
      reasoningMeasured: r.type === "chat" && r.status === "ok",
      cache: r.cache == null ? null : !!r.cache,
      coldMs: r.coldStartMs ?? null,
      ttftMs: r.ttftMs ?? null,
      rate: r.tokenRate ?? null,
      outTok: r.outputTokens ?? null,
      dim: r.dim ?? null,
      latencyMs: r.latencyMs ?? null,
      err: r.err || r.note || "",
    };
  });

  const summaryCards = [
    ["Model 總數", meta.totalModels ?? rows.length],
    ["成功量測", okCount],
    ["Chat 可用", chatOk.length],
    ["type 種類", Object.keys(byType).length],
    ["最低 TTFT", fastestTtft ? `${fmtNum(fastestTtft.ttftMs)}ms` : "-", fastestTtft ? fastestTtft.id : ""],
    ["最高 token rate", topRate ? `${fmtNum(topRate.tokenRate, 1)} tok/s` : "-", topRate ? topRate.id : ""],
  ];

  const typeChips = Object.entries(byType).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="chip">${esc(t)} <b>${n}</b></span>`).join("");

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NVIDIA NIM Model Benchmark</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --border:#2b3444; --text:#e6edf3;
    --muted:#8b949e; --accent:#4dabf7; --green:#3fb950; --red:#f85149; --yellow:#d29922; --purple:#bc8cff;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f6f8fa; --panel:#fff; --panel2:#f0f3f6; --border:#d0d7de; --text:#1f2328;
           --muted:#636c76; --accent:#0969da; --green:#1a7f37; --red:#cf222e; --yellow:#9a6700; --purple:#8250df; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Microsoft JhengHei",sans-serif}
  .wrap{max-width:1400px;margin:0 auto;padding:24px 20px 80px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
  .card .k{color:var(--muted);font-size:12px} .card .v{font-size:22px;font-weight:700;margin-top:4px}
  .card .sub2{color:var(--muted);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chips{margin:10px 0 16px;display:flex;flex-wrap:wrap;gap:8px}
  .chip{background:var(--panel2);border:1px solid var(--border);border-radius:20px;padding:3px 12px;font-size:12px;color:var(--muted)}
  .chip b{color:var(--text)}
  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  input[type=search]{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;min-width:240px}
  select{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px}
  .tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
  table{border-collapse:collapse;width:100%;font-size:13px;min-width:1100px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
  th{background:var(--panel);position:sticky;top:0;cursor:pointer;user-select:none;font-weight:600}
  th:hover{color:var(--accent)}
  th .arrow{color:var(--accent);font-size:10px}
  tr:hover td{background:var(--panel2)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .b-ok{background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green)}
  .b-err{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
  .b-warn{background:color-mix(in srgb,var(--yellow) 20%,transparent);color:var(--yellow)}
  .b-type{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
  .yes{color:var(--green);font-weight:700} .no{color:var(--muted)} .unk{color:var(--muted)}
  .measured{border-bottom:1px dotted var(--purple)}
  .err{color:var(--red);font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
  .note{color:var(--muted);font-size:12px;margin-top:24px;line-height:1.7}
  .bar{display:inline-block;height:8px;border-radius:4px;background:var(--accent);vertical-align:middle;margin-left:6px;opacity:.55}
</style>
</head>
<body>
<div class="wrap">
  <h1>NVIDIA NIM — 全 Model Benchmark</h1>
  <div class="sub">
    產生時間 ${esc(meta.generatedAt || "")} ·
    endpoint <span class="mono">${esc(meta.baseUrl || "")}</span> ·
    公平設定:temperature=0,固定 prompt,冷啟動後熱機 ${esc(String((meta.config && meta.config.warmRuns) ?? "?"))} 次取中位數,max_tokens=${esc(String((meta.config && meta.config.maxTokens) ?? "?"))}
  </div>

  <div class="cards">
    ${summaryCards.map((c) => `<div class="card"><div class="k">${esc(c[0])}</div><div class="v">${esc(String(c[1]))}</div>${c[2] ? `<div class="sub2 mono" title="${esc(c[2])}">${esc(c[2])}</div>` : ""}</div>`).join("")}
  </div>
  <div class="chips">${typeChips}</div>

  <div class="toolbar">
    <input id="q" type="search" placeholder="搜尋 model id / owner…">
    <select id="ftype"><option value="">全部 type</option>${Object.keys(byType).sort().map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select>
    <select id="fstatus"><option value="">全部狀態</option><option value="ok">僅成功</option><option value="err">僅失敗</option></select>
    <label style="color:var(--muted);font-size:12px"><input type="checkbox" id="onlyChat"> 僅 chat 且可比較</label>
  </div>

  <div class="tablewrap">
    <table id="t">
      <thead><tr>
        <th data-k="id">Model</th>
        <th data-k="owner">Owner</th>
        <th data-k="type">Type</th>
        <th data-k="context" class="num">Context</th>
        <th data-k="maxOut" class="num">Max out</th>
        <th data-k="reasoning">Reasoning</th>
        <th data-k="cache">Cache</th>
        <th data-k="coldMs" class="num">Cold start</th>
        <th data-k="ttftMs" class="num">TTFT</th>
        <th data-k="rate" class="num">Token rate</th>
        <th data-k="outTok" class="num">Out tok</th>
        <th data-k="status">Status</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>

  <div class="note">
    <b>量測方法(公平性)</b><br>
    • <b>TTFT</b>:送出請求 → 收到第一個 content token 的毫秒數,串流量測;取熱機多次的中位數。<br>
    • <b>Token rate</b>:(生成 token 數 − 1) ÷ (最後 token 時間 − 第一個 token 時間),<b>排除 TTFT</b>,只算穩態生成速度。<br>
    • <b>Cold start</b>:每個 model 第一次呼叫(含 NVCF 冷啟動)的總 wall time,單獨記錄、<b>不</b>計入上面兩者。<br>
    • <b>Reasoning</b>:<span class="measured">虛線底</span>=實測(串流是否出現 reasoning_content);其餘為 pi 內建 DB 宣告值。<br>
    • <b>Cache</b>:同一長 prompt 連打兩次,第二次 usage.prompt_tokens_details.cached_tokens &gt; 0 才算 yes;空白=該 model 未回報 cache 欄位。<br>
    • <b>Context / Max out</b>:NVIDIA <span class="mono">/v1/models</span> <b>不回傳</b>這些欄位。Context 一律取自 pi 內建 model DB 的宣告值(僅內建 model 有);Max out 優先用宣告值,否則用「送超大 max_tokens 讀 400 錯誤」探測到的上限(標 probed)。空白代表無法取得。<br>
    • NVIDIA 未區分 input/output context;宣告值中 Context=總視窗,Max out=單次輸出上限。
  </div>
</div>

<script>
const ROWS = ${JSON.stringify(jsonRows)};
let sortK = "rate", sortDir = -1;
const tb = document.getElementById("tb");
const q = document.getElementById("q"), ft = document.getElementById("ftype"),
      fs2 = document.getElementById("fstatus"), oc = document.getElementById("onlyChat");

function cell(v, cls){ return '<td class="'+(cls||'')+'">'+v+'</td>'; }
function ynMeasured(v, measured){
  if(v===null||v===undefined) return '<span class="unk">—</span>';
  const s = v ? '<span class="yes">yes</span>' : '<span class="no">no</span>';
  return measured ? '<span class="measured">'+s+'</span>' : s;
}
function statusBadge(r){
  if(r.status==='ok') return '<span class="badge b-ok">ok</span>';
  if(r.status==='eol') return '<span class="badge b-err">EOL 410</span>';
  if(r.status==='timeout') return '<span class="badge b-warn">timeout</span>';
  if(r.status==='unavailable') return '<span class="badge b-warn">未開通</span>';
  if(r.status==='unsupported') return '<span class="badge b-warn">不支援</span>';
  return '<span class="badge b-err">'+(r.status||'error')+'</span>';
}
const maxRate = Math.max(...ROWS.map(r=>r.rate||0), 1);

function render(){
  const term = q.value.toLowerCase(), ty = ft.value, st = fs2.value, chatOnly = oc.checked;
  let list = ROWS.filter(r=>{
    if(term && !(r.id.toLowerCase().includes(term)||(r.owner||r.owned_by||'').toLowerCase().includes(term))) return false;
    if(ty && r.type!==ty) return false;
    if(st==='ok' && r.status!=='ok') return false;
    if(st==='err' && r.status==='ok') return false;
    if(chatOnly && !(r.type==='chat' && r.status==='ok')) return false;
    return true;
  });
  list.sort((a,b)=>{
    let x=a[sortK], y=b[sortK];
    if(sortK==='id'||sortK==='type'||sortK==='status'||sortK==='owner'){
      x=(x||'')+''; y=(y||'')+''; return x.localeCompare(y)*sortDir;
    }
    x = (x==null)? -Infinity : x; y = (y==null)? -Infinity : y;
    return (x-y)*sortDir;
  });
  tb.innerHTML = list.map(r=>{
    const barW = r.rate? Math.round((r.rate/maxRate)*60):0;
    return '<tr>'
      + cell('<span class="mono">'+esc(r.id)+'</span>')
      + cell('<span class="mono" style="color:var(--muted)">'+esc(r.owned_by||'')+'</span>')
      + cell('<span class="badge b-type">'+esc(r.type)+'</span>')
      + cell(r.context!=null? fmtCtx(r.context): '', 'num')
      + cell(r.maxOut!=null? (fmtCtx(r.maxOut)+(r.maxOutSrc==='probed'?' <span style="color:var(--muted);font-size:10px">(p)</span>':'')): '', 'num')
      + cell(ynMeasured(r.reasoning, r.reasoningMeasured))
      + cell(ynMeasured(r.cache, r.cache!=null))
      + cell(r.coldMs!=null? fmtNum(r.coldMs): '', 'num')
      + cell(r.ttftMs!=null? fmtNum(r.ttftMs): (r.latencyMs!=null? fmtNum(r.latencyMs)+'<span style="color:var(--muted);font-size:10px"> (lat)</span>':''), 'num')
      + cell(r.rate!=null? (fmtNum(r.rate,1)+(barW?'<span class="bar" style="width:'+barW+'px"></span>':'')): (r.dim!=null? 'dim '+r.dim:''), 'num')
      + cell(r.outTok!=null? fmtNum(r.outTok): '', 'num')
      + cell(statusBadge(r)+(r.err? ' <span class="err" title="'+esc(r.err)+'">'+esc(r.err)+'</span>':''))
      + '</tr>';
  }).join('') || '<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:24px">沒有符合的資料</td></tr>';
  document.querySelectorAll('th').forEach(th=>{
    const k=th.dataset.k; th.innerHTML = th.textContent.replace(/ [▲▼]$/,'') + (k===sortK? (sortDir<0?' ▼':' ▲'):'');
  });
}
function fmtCtx(n){ if(n==null)return''; if(n>=1e6)return (n/1e6).toFixed(n%1e6?1:0)+'M'; if(n>=1e3)return (n/1e3).toFixed(n%1e3?1:0)+'K'; return ''+n; }
function fmtNum(x,d){ d=d||0; const f=Math.pow(10,d); return (Math.round(x*f)/f).toLocaleString('en-US'); }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{
  const k=th.dataset.k; if(sortK===k) sortDir*=-1; else { sortK=k; sortDir=(k==='id'||k==='type'||k==='owner'||k==='status')?1:-1; } render();
}));
[q,ft,fs2,oc].forEach(el=>el.addEventListener('input',render));
render();
</script>
</body>
</html>`;
  return html;
}

module.exports = { generateReport };

// 獨立執行
if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "results.json");
  const outPath = process.argv[3] || path.join(__dirname, "report.html");
  const data = JSON.parse(fs.readFileSync(inPath, "utf8"));
  fs.writeFileSync(outPath, generateReport(data));
  console.log("report 已產生:", outPath);
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
