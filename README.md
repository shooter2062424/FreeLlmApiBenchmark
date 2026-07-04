# Free LLM API Benchmark — NVIDIA NIM

A self-contained benchmark that **dynamically discovers every model** exposed by your
[NVIDIA NIM](https://build.nvidia.com) (`integrate.api.nvidia.com`) API key, **classifies**
each one (chat / embedding / rerank / …), measures real performance, and renders an
**interactive HTML report**.

Nothing is hard-coded: on every run it calls `/v1/models`, so new models appear
automatically and retired ones are flagged.

**🌐 Live report:** https://shooter2062424.github.io/FreeLlmApiBenchmark/ (each report is annotated with its scan date)

---

## What it measures

| Metric | How |
|--------|-----|
| **Type** | Empirically — whichever endpoint (`/chat/completions`, `/embeddings`, `/ranking`) actually succeeds, plus id heuristics. |
| **Reasoning** | Live detection — does the stream emit `reasoning_content`, or `<think>` tags in content? |
| **Cache** | Live detection — send the same long prompt twice; is `usage.prompt_tokens_details.cached_tokens > 0`? |
| **TTFT** (time-to-first-token) | Streamed: request sent → first output token. Median of warm runs. |
| **Token rate** | `(output_tokens − 1) / (t_last_token − t_first_token)` — steady-state generation, **excludes** TTFT. |
| **Cold start** | Wall time of the first call (NVCF cold start), recorded separately. |
| **Context / Max-out** | NVIDIA's API does **not** expose these. Filled from the pi model DB where available (marked *declared*); blank otherwise. |

### Fairness by design
- Same prompt, same `max_tokens`, uniform temperature for every chat model.
- First call = cold start (excluded from the headline numbers); subsequent **warm** runs are measured and the **median** is reported.
- TTFT is anchored on the first *output* token regardless of reasoning-vs-content, so reasoning and non-reasoning models are compared consistently.
- Buffered "all-at-once" responses (where generation time ≈ 0) have their token rate marked `null` instead of reporting a nonsense number.

---

## Quick start

Requires **Node.js 18+** (uses the global `fetch` + streaming). No dependencies.

```bash
export NVIDIA_API_KEY=nvapi-xxxxxxxx           # your NVIDIA NIM key
# optional: lets the tool fill the declared context/max-out columns
export PI_EXE=/path/to/pi                       # pi CLI that ships a model DB

node benchmark.js            # discover all models → classify → benchmark → write report.html
```

Open `report.html` in a browser. It supports column sorting, type filtering,
"chat-only comparable" toggle, and free-text search — all offline, single file.

### Other modes

```bash
node benchmark.js --resume                                   # continue an interrupted run
node benchmark.js --only meta/llama-3.1-8b-instruct,z-ai/glm-5.2   # specific models
node benchmark.js --report-only                              # rebuild report.html from results.json
node report.js [results.json] [report.html]                  # standalone report generator
```

Results are written incrementally to `results.json`, so a run can be interrupted and resumed at any time.

---

## Configuration

Edit the `CFG` block at the top of `benchmark.js`:

| Key | Default | Meaning |
|-----|---------|---------|
| `CONCURRENCY` | 6 | Models benchmarked in parallel |
| `WARM_RUNS` | 2 | Warm runs measured (median taken) after the cold call |
| `MAX_TOKENS` | 256 | Generation length per benchmark run |
| `REQ_TIMEOUT_MS` | 90000 | Time-to-headers timeout |
| `DO_CACHE_PROBE` | true | Run the 2-call cache-detection probe |
| `BENCH_PROMPT` | TCP handshake prompt | The shared prompt used for all chat models |

---

## Sample findings (this account, 121 models listed)

| Status | Count | Meaning |
|--------|-------|---------|
| ✅ measured | **61** | 56 chat + 5 embedding |
| ⚠️ unavailable | **47** | `404 Function not found` — listed in the catalog but **not provisioned for this key** |
| ❌ error | 10 | 5xx / 422 etc. |
| ⏱️ timeout | 3 | Slower than the header timeout |

Highlights:
- **Fastest token rate:** `nvidia/nemotron-3-nano-30b-a3b` ~250 tok/s @ 95 ms TTFT.
- **Lowest TTFT:** `meta/llama-3.1-8b-instruct` ~93 ms.
- **Prompt caching observed on only 4 models** — most NIM models never return a `cached_tokens` field.
- **Big models can be painfully slow on the free tier:** `bytedance/seed-oss-36b` showed ~106 s to first token.

> The single biggest takeaway: **the model catalog (`/v1/models`) lists far more than your key can actually call.** Almost 40% here returned "not provisioned for this account."

---

## Files

| File | Purpose |
|------|---------|
| `benchmark.js` | Benchmark engine — discovery, classification, measurement |
| `report.js` | Standalone HTML report generator (also called by `benchmark.js`) |
| `results.json` | Raw results from the last scan |
| `docs/index.html` | Published static report (GitHub Pages) |
| `report.html` | Local duplicate of the report — gitignored |
| `nvmodels.json` | Snapshot of `/v1/models` from the last run |
| `pi-nvidia-listmodels.txt` | Declared context / max-out reference (from pi model DB) |
| `context-db.json` | Web-sourced context windows with source + confidence (curated, maintainable) |

---

## Limitations

- **Context window & max output** are not returned by NVIDIA's OpenAI-compatible API, and probing (oversized `max_tokens`) is silently truncated. This column is therefore backfilled from `context-db.json` — a curated table sourced from each model's card (NVIDIA / HuggingFace config / official docs), with `source` + `confidence` per entry. Web-sourced values are marked `ᵂ` in the report (hover for the source). Only a few pure image/OCR models with no token context remain blank. NVIDIA does not distinguish input vs output context.
- `cache` blank ≠ unsupported; it means the model never reported `cached_tokens`, so it can't be measured.
- The header timeout does not bound streaming, so a few giant models report very long but *real* TTFTs.
- Cold-start numbers depend on NVCF warm/cold state at run time and will vary.

Account identifiers are redacted from error messages before they are written to disk.
