#!/usr/bin/env python3
"""Team Usage CSV → per-model chart-group HTML: cost, tokens, concurrency, cache."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path

from analyze_team_usage import build_report_data, detect_anomalies, parse_rows

PALETTE = [
    "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#ef4444", "#06b6d4",
    "#ec4899", "#84cc16", "#6366f1", "#14b8a6", "#f97316", "#94a3b8",
]


def bucket_5m(cst) -> str:
    floored = cst.replace(minute=(cst.minute // 5) * 5, second=0, microsecond=0)
    return floored.strftime("%m-%d %H:%M")


def bucket_1m(cst) -> str:
    floored = cst.replace(second=0, microsecond=0)
    return floored.strftime("%m-%d %H:%M")


def build_per_model_data(num: list[dict]) -> dict:
    model_order = [m for m, _ in Counter(r["model"] for r in num).most_common()]
    colors = {m: PALETTE[i % len(PALETTE)] for i, m in enumerate(model_order)}

    by_5m: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(
            lambda: {
                "cost": 0.0,
                "tokens": 0.0,
                "inwo": 0.0,
                "cr": 0.0,
                "inwo_hit": 0.0,
                "cr_hit": 0.0,
                "n": 0,
            }
        )
    )
    by_1m: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    meta: dict[str, dict] = {
        m: {
            "n": 0,
            "cost": 0.0,
            "tokens": 0.0,
            "inwo": 0.0,
            "cr": 0.0,
            "inwo_hit": 0.0,
            "cr_hit": 0.0,
            "cold": 0,
            "cold_cost": 0.0,
        }
        for m in model_order
    }

    for r in num:
        m = r["model"]
        b5 = bucket_5m(r["cst"])
        b1 = bucket_1m(r["cst"])
        cell = by_5m[b5][m]
        cell["cost"] += r["cost"]
        tok = r["inwo"] + r["cr"] + r["out"]
        cell["tokens"] += tok
        cell["inwo"] += r["inwo"]
        cell["cr"] += r["cr"]
        cell["n"] += 1
        if not r.get("first_turn"):
            cell["inwo_hit"] += r["inwo"]
            cell["cr_hit"] += r["cr"]
        by_1m[b1][m] += 1

        meta[m]["n"] += 1
        meta[m]["cost"] += r["cost"]
        meta[m]["tokens"] += tok
        meta[m]["inwo"] += r["inwo"]
        meta[m]["cr"] += r["cr"]
        if not r.get("first_turn"):
            meta[m]["inwo_hit"] += r["inwo"]
            meta[m]["cr_hit"] += r["cr"]
        if r["cold"]:
            meta[m]["cold"] += 1
            meta[m]["cold_cost"] += r["cost"]

    buckets_5m = sorted(by_5m.keys())
    buckets_1m = sorted(by_1m.keys())

    def matrix(field: str) -> dict[str, list[float]]:
        return {
            m: [round(by_5m[b].get(m, {}).get(field, 0), 4) for b in buckets_5m]
            for m in model_order
        }

    cost_5m = matrix("cost")
    tokens_5m = matrix("tokens")
    req_5m = matrix("n")

    hit_5m: dict[str, list[float | None]] = {}
    for m in model_order:
        series: list[float | None] = []
        for b in buckets_5m:
            c = by_5m[b].get(m, {})
            den = c.get("inwo_hit", 0) + c.get("cr_hit", 0)
            series.append(round(c.get("cr_hit", 0) / den * 100, 1) if den else None)
        hit_5m[m] = series

    rpm_by_model: dict[str, list[int]] = {m: [] for m in model_order}
    for b in buckets_1m:
        for m in model_order:
            rpm_by_model[m].append(by_1m[b].get(m, 0))

    roll_labels: list[str] = []
    roll_by_model: dict[str, list[int]] = {m: [] for m in model_order}
    step = max(1, len(num) // 100)
    for i in range(0, len(num), step):
        t = num[i]["dt"]
        lo = t - timedelta(seconds=60)
        roll_labels.append(num[i]["cst"].strftime("%H:%M"))
        chunk = [r for r in num if lo <= r["dt"] <= t]
        cm = Counter(r["model"] for r in chunk)
        for m in model_order:
            roll_by_model[m].append(cm.get(m, 0))

    model_summary = []
    for m in model_order:
        t = meta[m]
        den = t["inwo_hit"] + t["cr_hit"]
        model_summary.append(
            {
                "model": m,
                "color": colors[m],
                "n": t["n"],
                "cost": round(t["cost"], 2),
                "tokens": int(t["tokens"]),
                "hit": round(t["cr_hit"] / den * 100, 2) if den else 0,
                "cold_n": t["cold"],
                "cold_pct": round(t["cold"] / t["n"] * 100, 1) if t["n"] else 0,
                "cold_cost": round(t["cold_cost"], 2),
            }
        )

    return {
        "models": model_order,
        "colors": colors,
        "model_summary": model_summary,
        "buckets_5m": buckets_5m,
        "cost_5m": cost_5m,
        "tokens_5m": tokens_5m,
        "req_5m": req_5m,
        "hit_5m": hit_5m,
        "buckets_1m": buckets_1m,
        "rpm_by_model": rpm_by_model,
        "roll_labels": roll_labels,
        "roll_by_model": roll_by_model,
    }


def model_family(name: str) -> str:
    ml = name.lower()
    if "composer" in ml:
        return "Composer"
    if "grok" in ml:
        return "Grok"
    return "Other"


def build_pie_data(num: list[dict], summary: dict) -> dict:
    family_cost: dict[str, float] = defaultdict(float)
    model_cost: dict[str, float] = defaultdict(float)
    grok_cost: dict[str, float] = defaultdict(float)
    hour_cost: dict[str, float] = defaultdict(float)
    cold_n = warm_n = 0
    cold_cost = warm_cost = 0.0
    bins = {"0–1% (冷)": 0, "1–50%": 0, "50–80%": 0, "80–90%": 0, "90–98%": 0, "98–100%": 0}
    total_cost = 0.0
    grok_n = composer_n = 0

    for r in num:
        m = r["model"]
        c = r["cost"]
        total_cost += c
        family_cost[model_family(m)] += c
        model_cost[m] += c
        if "grok" in m.lower():
            grok_cost[m] += c
            grok_n += 1
        if "composer" in m.lower():
            composer_n += 1
        hour_cost[r["cst"].strftime("%H:00")] += c
        if r["cold"]:
            cold_n += 1
            cold_cost += c
        else:
            warm_n += 1
            warm_cost += c
        if r.get("first_turn"):
            continue
        den = r["inwo"] + r["cr"]
        h = r["cr"] / den * 100 if den else 0
        if h <= 1:
            bins["0–1% (冷)"] += 1
        elif h < 50:
            bins["1–50%"] += 1
        elif h < 80:
            bins["50–80%"] += 1
        elif h < 90:
            bins["80–90%"] += 1
        elif h < 98:
            bins["90–98%"] += 1
        else:
            bins["98–100%"] += 1

    sorted_models = sorted(model_cost.items(), key=lambda x: -x[1])
    top5 = sorted_models[:5]
    other_cost = round(sum(c for _, c in sorted_models[5:]), 2)
    top_labels = [m for m, _ in top5]
    top_values = [round(c, 2) for _, c in top5]
    if other_cost > 0.001:
        top_labels.append("其他模型")
        top_values.append(other_cost)

    grok_sorted = sorted(grok_cost.items(), key=lambda x: -x[1])
    grok_labels = [m for m, c in grok_sorted if c > 0]
    grok_values = [round(c, 2) for _, c in grok_sorted if c > 0]

    hour_sorted = sorted(hour_cost.items())
    n = len(num)
    global_hit = summary.get("global_hit", 0)
    global_hit_all = summary.get("global_hit_all", global_hit)
    excl = summary.get("first_turn_excluded_n", 0)
    thr = summary.get("first_turn_threshold", 0)

    def pie(
        pid: str,
        title: str,
        labels: list[str],
        values: list[float],
        note: str,
        unit: str = "$",
    ) -> dict:
        return {
            "id": pid,
            "title": title,
            "labels": labels,
            "values": values,
            "note": note,
            "unit": unit,
        }

    pies = [
        pie(
            "cost_family",
            "成本占比 · Composer vs Grok",
            ["Composer", "Grok", "Other"],
            [
                round(family_cost.get("Composer", 0), 2),
                round(family_cost.get("Grok", 0), 2),
                round(family_cost.get("Other", 0), 2),
            ],
            f"总 ${total_cost:.2f}；Grok {grok_n} 次占 {grok_n/n*100:.1f}% 请求却约 {family_cost.get('Grok',0)/total_cost*100:.1f}% 成本",
        ),
        pie(
            "cost_model_top",
            "成本占比 · 按模型 (Top5 + 其他)",
            top_labels,
            top_values,
            "定位账单大头：fast Composer 量 vs Grok 推理档单价",
        ),
        pie(
            "req_cold_warm",
            "冷 / 热 请求结构",
            ["冷启动 (CR≤1)", "热路径 (CR>1)"],
            [cold_n, warm_n],
            f"冷 ${cold_cost:.2f}（{cold_cost/total_cost*100:.1f}% 成本）· 热 ${warm_cost:.2f}",
            unit="次",
        ),
        pie(
            "hit_bins",
            "命中率分布",
            list(bins.keys()),
            list(bins.values()),
            f"跨轮次 {global_hit}%（含首轮 {global_hit_all}% · 剔 {excl} · T={thr}）· 近满 {bins['98–100%']} 次",
            unit="次",
        ),
    ]

    return {"pies": pies}


# 绝对 RPM 分档（按「每分钟完成请求数」，不用分位数，避免 19 RPM 被标成高）
RPM_PRESSURE_BREAKS = (0, 10, 25, 40)  # 0 | 1-10 低 | 11-25 中 | 26-40 高 | 41+ 极高


def rpm_pressure_level(v: int) -> int:
    if v <= 0:
        return 0
    if v <= RPM_PRESSURE_BREAKS[1]:
        return 1
    if v <= RPM_PRESSURE_BREAKS[2]:
        return 2
    if v <= RPM_PRESSURE_BREAKS[3]:
        return 3
    return 4


# Token 吞吐绝对分档：tokens / minute（与 RPM 同 1min 桶）
TPM_PRESSURE_BREAKS = (0, 500_000, 2_000_000, 5_000_000)


def row_total_tokens(r: dict) -> float:
    return r["inwo"] + r["cr"] + r["out"]


def tpm_pressure_level(v: float) -> int:
    if v <= 0:
        return 0
    if v <= TPM_PRESSURE_BREAKS[1]:
        return 1
    if v <= TPM_PRESSURE_BREAKS[2]:
        return 2
    if v <= TPM_PRESSURE_BREAKS[3]:
        return 3
    return 4


def build_throughput_pressure(num: list[dict]) -> dict:
    minute_counts: dict = defaultdict(int)
    minute_tokens: dict = defaultdict(float)
    for r in num:
        t = r["cst"].replace(second=0, microsecond=0)
        minute_counts[t] += 1
        minute_tokens[t] += row_total_tokens(r)
    if not minute_counts:
        return {}

    start = min(minute_counts.keys())
    end = max(minute_counts.keys())
    labels: list[str] = []
    rpm: list[int] = []
    tpm: list[float] = []
    t = start
    while t <= end:
        labels.append(t.strftime("%H:%M"))
        rpm.append(minute_counts.get(t, 0))
        tpm.append(minute_tokens.get(t, 0.0))
        t += timedelta(minutes=1)

    roll5: list[int] = []
    roll5_tpm: list[float] = []
    for i in range(len(rpm)):
        roll5.append(sum(rpm[max(0, i - 4) : i + 1]))
        roll5_tpm.append(sum(tpm[max(0, i - 4) : i + 1]))

    pressure = [rpm_pressure_level(v) for v in rpm]
    tpm_pressure = [tpm_pressure_level(v) for v in tpm]
    pressure_names = ["空闲", "低", "中", "高", "极高"]
    pressure_colors = ["#475569", "#22c55e", "#eab308", "#f97316", "#ef4444"]

    level_minutes: dict[str, int] = defaultdict(int)
    for lv in pressure:
        level_minutes[pressure_names[lv]] += 1

    return {
        "labels": labels,
        "rpm": rpm,
        "tpm": tpm,
        "roll5": roll5,
        "roll5_tpm": roll5_tpm,
        "pressure": pressure,
        "tpm_pressure": tpm_pressure,
        "pressure_names": pressure_names,
        "pressure_colors": pressure_colors,
        "thresholds": {
            "max_rpm": max(rpm),
            "max_roll5": max(roll5),
            "max_tpm": max(tpm),
            "max_roll5_tpm": max(roll5_tpm),
            "rpm_low_max": RPM_PRESSURE_BREAKS[1],
            "rpm_mid_max": RPM_PRESSURE_BREAKS[2],
            "rpm_high_max": RPM_PRESSURE_BREAKS[3],
            "tpm_low_max": TPM_PRESSURE_BREAKS[1],
            "tpm_mid_max": TPM_PRESSURE_BREAKS[2],
            "tpm_high_max": TPM_PRESSURE_BREAKS[3],
        },
        "pressure_minutes": dict(level_minutes),
        "pressure_rule": (
            "RPM 压力（柱色）：空闲 0 · 低 1–10 · 中 11–25 · 高 26–40 · 极高 ≥41"
        ),
        "tpm_pressure_rule": (
            "TPM 压力（柱色）：空闲 0 · 低 ≤0.5M · 中 ≤2M · 高 ≤5M · 极高 >5M tokens/min"
        ),
        "spec": {
            "timezone": "CST（由 CSV Date +8h）",
            "bucket": "1 分钟，秒归零；无事件分钟记 0",
            "rpm": "该分钟内计费行数",
            "tpm": "该分钟 Σ(Input w/o Cache Write + Cache Read + Output)，等同 Total Tokens",
            "roll5": "含当前分钟共 5 分钟的 RPM 或 TPM 之和",
            "note_5min_charts": "下方「5 分钟桶」堆叠图按完成时刻划入 5min 槽，仅作分模型结构，不与本处 1min 吞吐混算",
        },
    }


CHART_GROUP_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Team Usage · 分模型</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root { --bg:#0b0f14; --card:#151c28; --text:#e8edf4; --muted:#8b9cb3; --line:#263044; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); overflow-x:hidden; }
  .wrap { max-width:min(1400px,100vw); margin:0 auto; padding:20px 18px 64px; overflow-x:hidden; }
  h1 { font-size:1.35rem; margin:0 0 4px; font-weight:650; }
  .sub { color:var(--muted); font-size:0.85rem; margin-bottom:12px; }
  .sticky-bar { position:sticky; top:0; z-index:20; background:rgba(11,15,20,0.92); backdrop-filter:blur(8px);
    border:1px solid var(--line); border-radius:12px; padding:10px 12px 12px; margin-bottom:18px; }
  .sticky-bar p { margin:0 0 8px; font-size:0.75rem; color:var(--muted); }
  .section { margin-bottom:22px; }
  .section > h2 { font-size:0.78rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
    margin:0 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px 14px; margin-bottom:12px; }
  .panel h3 { margin:0 0 8px; font-size:0.88rem; font-weight:600; }
  .chart { position:relative; height:280px; }
  .chart.throughput { height:320px; }
  .chart.stack5 { height:300px; }
  .chart.hit { height:300px; }
  .chart.pie { height:200px; max-width:100%; }
  .pies-block { padding:16px 14px 10px; overflow:hidden; }
  .pies-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 16px; width:100%; }
  .pie-cell { min-width:0; overflow:hidden; }
  .pie-cell h4 { margin:0 0 4px; font-size:0.72rem; font-weight:600; text-align:center; color:var(--muted); line-height:1.25; padding:0 4px; }
  .spec-details { font-size:0.72rem; color:var(--muted); line-height:1.5; margin-bottom:10px; }
  .spec-details summary { cursor:pointer; color:var(--text); font-weight:600; margin-bottom:6px; }
  .spec-details[open] summary { margin-bottom:8px; }
  .spec-inner { padding:8px 10px; background:rgba(0,0,0,0.2); border-radius:8px; border:1px solid var(--line); }
  .spec-inner code { color:#94a3b8; font-size:0.68rem; }
  .tab-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .tab { font-size:0.72rem; padding:5px 12px; border-radius:8px; border:1px solid var(--line);
    background:transparent; color:var(--muted); cursor:pointer; }
  .tab.on { color:var(--text); background:#1f2937; border-color:#4b5563; }
  .pressure-badges { display:flex; flex-wrap:wrap; gap:6px 10px; margin-bottom:8px; font-size:0.72rem; align-items:center; }
  .pressure-group { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .pressure-group > span.lbl { font-size:0.68rem; color:var(--muted); font-weight:600; margin-right:2px; }
  .badge { padding:4px 10px; border-radius:8px; border:1px solid var(--line); }
  .badge b { font-weight:600; }
  .insights { margin:0; padding-left:1.1rem; font-size:0.82rem; line-height:1.55; color:var(--text); }
  .insights li { margin-bottom:6px; }
  .insights li span { color:var(--muted); }
  .note { font-size:0.76rem; color:var(--muted); margin-top:8px; line-height:1.45; }
  table { width:100%; border-collapse:collapse; font-size:0.8rem; }
  th, td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:left; }
  th { color:var(--muted); font-weight:500; cursor:pointer; user-select:none; }
  tr:hover td { background:rgba(255,255,255,0.03); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .toolbar { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { font-size:0.72rem; padding:4px 10px; border-radius:999px; border:1px solid var(--line);
    background:transparent; color:var(--muted); cursor:pointer; max-width:100%; }
  .chip.on { color:var(--text); border-color:#4b5563; background:#1f2937; }
  .chip .dot { width:6px; height:6px; margin-right:4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Team Usage · 分模型（成本 / Token / 并发 / Cache）</h1>
  <p class="sub" id="subtitle"></p>

  <div class="sticky-bar">
    <p>默认仅显示<strong>使用量（次数）Top 4</strong>模型；切换后下方所有图表同步（也可点图例）</p>
    <div class="toolbar" id="modelChips"></div>
  </div>

  <div class="section">
    <h2>吞吐 · 1 分钟（CST）</h2>
    <div class="panel">
      <details class="spec-details">
        <summary>计算标准</summary>
        <div class="spec-inner" id="throughputSpec"></div>
      </details>
      <div class="tab-row" id="throughputTabs">
        <button type="button" class="tab on" data-tp="rpm">请求 RPM</button>
        <button type="button" class="tab" data-tp="tpm">Token TPM</button>
      </div>
      <div class="pressure-badges" id="pressureLegend"></div>
      <div class="chart throughput"><canvas id="throughputChart"></canvas></div>
      <p class="note" id="throughputNote"></p>
    </div>
  </div>

  <div class="section">
    <h2>结构占比</h2>
    <div class="panel pies-block">
      <div class="pies-row" id="pieGrid"></div>
    </div>
  </div>

  <div class="section">
    <h2>模型汇总</h2>
    <div class="panel">
      <table id="sumTable">
        <thead><tr>
          <th data-k="model">模型</th><th data-k="n">次数</th><th data-k="cost">成本 $</th>
          <th data-k="tokens">Token</th><th data-k="hit">命中率 %</th>
          <th data-k="cold_pct">冷启动 %</th><th data-k="cold_cost">冷启动 $</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <h2>5 分钟桶 · 分模型</h2>
    <p class="note" style="margin:-4px 0 10px">按完成时刻划入 5min 槽，只看各模型占比；与上方 1min 吞吐/RPM 压力分开计算。</p>
    <div class="panel">
      <div class="tab-row" id="stack5Tabs">
        <button type="button" class="tab on" data-stack="cost">成本 $</button>
        <button type="button" class="tab" data-stack="tok">Token</button>
        <button type="button" class="tab" data-stack="req">请求数</button>
      </div>
      <div class="chart stack5"><canvas id="stack5Chart"></canvas></div>
    </div>
  </div>

  <div class="section">
    <h2>缓存命中率</h2>
    <div class="panel">
      <p class="note" style="margin:0 0 8px">5 分钟桶 · 桶内 CR/(CR+in_wo)；无请求的桶为断点。建议只开 2–4 个模型。</p>
      <div class="chart hit"><canvas id="hitLines"></canvas></div>
    </div>
  </div>
</div>
<script>
const D = __DATA_JSON__;
const PM = D.perModel;
const grid = 'rgba(139,156,179,0.1)';
const labels5 = PM.buckets_5m;

function topByUsage(k) {
  return [...PM.model_summary].sort((a, b) => b.n - a.n).slice(0, k).map(r => r.model);
}
let enabled = new Set(topByUsage(4));

function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + ' B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + ' M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + ' k';
  return String(Math.round(v));
}

function tokenScaleForMatrix(matrix) {
  let max = 0;
  for (const m of PM.models) {
    (matrix[m] || []).forEach(v => { max = Math.max(max, v); });
  }
  if (max >= 1e9) return { div: 1e9, suffix: 'B' };
  if (max >= 1e6) return { div: 1e6, suffix: 'M' };
  if (max >= 1e3) return { div: 1e3, suffix: 'k' };
  return { div: 1, suffix: '' };
}

function labelOf(m) { return m; }

function stackBarDatasets(matrix, tokenDiv = 1) {
  return PM.models.filter(m => enabled.has(m)).map(m => ({
    label: labelOf(m),
    data: matrix[m].map(v => v / tokenDiv),
    backgroundColor: PM.colors[m] + 'cc',
    borderColor: PM.colors[m],
    borderWidth: 1,
    stack: 's0',
  }));
}

function stackedOpts(yTitle, yTickCb) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: '#8b9cb3', boxWidth: 10, font: { size: 10 } },
        onClick: legendToggle,
      },
      tooltip: {
        callbacks: {
          label(ctx) {
            const raw = ctx.dataset._raw ? ctx.dataset._raw[ctx.dataIndex] : ctx.parsed.y;
            if (ctx.dataset._isToken) return `${ctx.dataset.label}: ${fmtTokens(raw)}`;
            if (ctx.dataset._isCost) return `${ctx.dataset.label}: $${Number(raw).toFixed(3)}`;
            return `${ctx.dataset.label}: ${ctx.parsed.y}`;
          }
        }
      }
    },
    scales: {
      x: { stacked: true, ticks: { color: '#8b9cb3', maxRotation: 45, autoSkip: true, maxTicksLimit: 28 }, grid: { color: grid } },
      y: {
        stacked: true,
        title: yTitle ? { display: true, text: yTitle, color: '#8b9cb3' } : undefined,
        ticks: { color: '#8b9cb3', callback: yTickCb || (v => v) },
        grid: { color: grid },
      }
    }
  };
}

function legendToggle(_e, legendItem, legend) {
  const m = PM.models.find(x => labelOf(x) === legendItem.text);
  if (!m) return;
  if (enabled.has(m)) enabled.delete(m); else enabled.add(m);
  if (enabled.size === 0) enabled = new Set(PM.models);
  renderChips();
  refreshCharts();
}

const charts = {};
function mk(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), cfg);
}

let stack5Mode = 'cost';

function refreshStack5() {
  const tokSc = tokenScaleForMatrix(PM.tokens_5m);
  if (stack5Mode === 'cost') {
    const costDs = stackBarDatasets(PM.cost_5m);
    costDs.forEach((ds, i) => {
      const m = PM.models.filter(x => enabled.has(x))[i];
      if (m) ds._raw = PM.cost_5m[m];
      ds._isCost = true;
    });
    mk('stack5Chart', {
      type: 'bar',
      data: { labels: labels5, datasets: costDs },
      options: stackedOpts('USD / 5min', v => '$' + v.toFixed(2)),
    });
  } else if (stack5Mode === 'tok') {
    const tokDs = stackBarDatasets(PM.tokens_5m, tokSc.div);
    tokDs.forEach((ds, i) => {
      const m = PM.models.filter(x => enabled.has(x))[i];
      if (m) ds._raw = PM.tokens_5m[m];
      ds._isToken = true;
    });
    mk('stack5Chart', {
      type: 'bar',
      data: { labels: labels5, datasets: tokDs },
      options: stackedOpts(`Token (${tokSc.suffix}) / 5min`, v => v.toFixed(2)),
    });
  } else {
    mk('stack5Chart', {
      type: 'bar',
      data: { labels: labels5, datasets: stackBarDatasets(PM.req_5m) },
      options: stackedOpts('请求数 / 5min', v => v),
    });
  }
}

function refreshCharts() {
  refreshStack5();

  const hitDs = PM.models.filter(m => enabled.has(m)).map(m => ({
    label: labelOf(m),
    data: PM.hit_5m[m],
    borderColor: PM.colors[m],
    backgroundColor: PM.colors[m] + '33',
    fill: false,
    tension: 0.25,
    pointRadius: 1,
    pointHoverRadius: 4,
    borderWidth: 2,
    spanGaps: true,
  }));
  mk('hitLines', {
    type: 'line',
    data: { labels: labels5, datasets: hitDs },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b9cb3', font: { size: 11 } }, onClick: legendToggle },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? '—' : c.parsed.y + '%'}` } }
      },
      scales: {
        x: { ticks: { color: '#8b9cb3', maxRotation: 45, autoSkip: true, maxTicksLimit: 36 }, grid: { color: grid } },
        y: { min: 0, max: 100, ticks: { color: '#8b9cb3', callback: v => v + '%' }, grid: { color: grid } },
      }
    }
  });

}

document.querySelectorAll('#stack5Tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    stack5Mode = btn.dataset.stack;
    document.querySelectorAll('#stack5Tabs .tab').forEach(b => b.classList.toggle('on', b === btn));
    refreshStack5();
  });
});

document.getElementById('subtitle').textContent = D.meta.subtitle;

const tbody = document.querySelector('#sumTable tbody');
function renderTable(rows) {
  tbody.innerHTML = rows.map(r => `<tr>
    <td><span class="dot" style="background:${r.color}"></span><code style="font-size:0.78rem">${r.model}</code></td>
    <td>${r.n}</td><td>$${r.cost}</td><td>${fmtTokens(r.tokens)}</td>
    <td>${r.hit}%</td><td>${r.cold_pct}% (${r.cold_n})</td><td>$${r.cold_cost}</td>
  </tr>`).join('');
}
let sortK = 'cost', sortDesc = true;
function sortRows() {
  const rows = [...PM.model_summary].sort((a,b) => {
    const va = a[sortK], vb = b[sortK];
    if (sortK === 'model') return sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
    return sortDesc ? vb - va : va - vb;
  });
  renderTable(rows);
}
document.querySelectorAll('#sumTable th[data-k]').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortK === k) sortDesc = !sortDesc; else { sortK = k; sortDesc = k !== 'model'; }
    sortRows();
  });
});
sortRows();

const chips = document.getElementById('modelChips');
function renderChips() {
  chips.innerHTML = PM.model_summary.map(r => {
    const on = enabled.has(r.model) ? 'on' : '';
    return `<button type="button" class="chip ${on}" data-m="${r.model}" title="${r.model}">
      <span class="dot" style="background:${r.color}"></span>${r.model}</button>`;
  }).join('') +
    `<button type="button" class="chip" id="allOn">全选</button>` +
    `<button type="button" class="chip" id="top4usage">Top4 使用量</button>` +
    `<button type="button" class="chip" id="top4cost">Top4 成本</button>`;
  chips.querySelectorAll('.chip[data-m]').forEach(btn => btn.addEventListener('click', () => {
    const m = btn.dataset.m;
    if (enabled.has(m)) enabled.delete(m); else enabled.add(m);
    if (enabled.size === 0) enabled = new Set(PM.models);
    renderChips(); refreshCharts();
  }));
  document.getElementById('allOn').onclick = () => { enabled = new Set(PM.models); renderChips(); refreshCharts(); };
  document.getElementById('top4usage').onclick = () => {
    enabled = new Set(topByUsage(4));
    renderChips(); refreshCharts();
  };
  document.getElementById('top4cost').onclick = () => {
    const top = [...PM.model_summary].sort((a, b) => b.cost - a.cost).slice(0, 4).map(r => r.model);
    enabled = new Set(top);
    renderChips(); refreshCharts();
  };
}
renderChips();
refreshCharts();

let throughputMode = 'rpm';
let throughputChart = null;

function badgeHtml(names, colors, minutesByName, totalLen, peakLabel, peakVal) {
  const badges = names.map((name, i) => {
    const mins = minutesByName[name] || 0;
    const pct = totalLen ? (mins / totalLen * 100).toFixed(1) : 0;
    return `<span class="badge" style="border-left:3px solid ${colors[i]}"><b>${name}</b> ${mins}min (${pct}%)</span>`;
  }).join('');
  return badges + `<span class="badge">${peakLabel} <b>${peakVal}</b></span>`;
}

function renderThroughputLegend(T) {
  const th = T.thresholds;
  const leg = document.getElementById('pressureLegend');
  const tpmMins = {};
  T.tpm_pressure.forEach(lv => { const n = T.pressure_names[lv]; tpmMins[n] = (tpmMins[n]||0)+1; });
  const rpmBadges = badgeHtml(
    T.pressure_names, T.pressure_colors, T.pressure_minutes, T.labels.length,
    '峰值 RPM', th.max_rpm
  );
  const tpmBadges = badgeHtml(
    T.pressure_names, T.pressure_colors, tpmMins, T.labels.length,
    '峰值 TPM', fmtTokens(th.max_tpm)
  );
  leg.innerHTML =
    `<div class="pressure-group"><span class="lbl">RPM</span>${rpmBadges}</div>` +
    `<div class="pressure-group"><span class="lbl">TPM</span>${tpmBadges}</div>`;
}

function throughputChartConfig(T, mode) {
  const th = T.thresholds;
  const grid = 'rgba(139,156,179,0.1)';
  if (mode === 'rpm') {
    const barColors = T.rpm.map((v, i) => T.pressure_colors[T.pressure[i]] + 'cc');
    return {
      type: 'bar',
      data: {
        labels: T.labels,
        datasets: [
          { type: 'bar', label: 'RPM', data: T.rpm, backgroundColor: barColors, borderWidth: 0, order: 2 },
          { type: 'line', label: 'Roll5 请求', data: T.roll5, borderColor: 'rgba(148,163,184,0.65)', borderWidth: 1.5, pointRadius: 0, tension: 0.25, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b9cb3' } },
          tooltip: {
            callbacks: {
              afterBody(items) {
                const i = items[0].dataIndex;
                return [`RPM 压力: ${T.pressure_names[T.pressure[i]]}`, `Roll5: ${T.roll5[i]}`];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8b9cb3', maxRotation: 0, autoSkip: true, maxTicksLimit: 24 }, grid: { color: grid } },
          y: { title: { display: true, text: '请求 / min', color: '#8b9cb3' }, ticks: { color: '#8b9cb3', stepSize: 1 }, grid: { color: grid }, beginAtZero: true },
        },
      },
    };
  }
  const tpmBar = T.tpm.map((v, i) => T.pressure_colors[T.tpm_pressure[i]] + 'cc');
  const tpmDiv = th.max_tpm >= 1e9 ? 1e9 : th.max_tpm >= 1e6 ? 1e6 : 1e3;
  const tpmSuf = tpmDiv >= 1e9 ? 'B' : tpmDiv >= 1e6 ? 'M' : 'k';
  return {
    type: 'bar',
    data: {
      labels: T.labels,
      datasets: [
        { type: 'bar', label: 'TPM', data: T.tpm.map(v => v / tpmDiv), backgroundColor: tpmBar, borderWidth: 0, order: 2 },
        { type: 'line', label: 'Roll5 Token', data: T.roll5_tpm.map(v => v / tpmDiv), borderColor: 'rgba(148,163,184,0.65)', borderWidth: 1.5, pointRadius: 0, tension: 0.25, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b9cb3' } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const raw = ctx.datasetIndex === 0 ? T.tpm[ctx.dataIndex] : T.roll5_tpm[ctx.dataIndex];
              return `${ctx.dataset.label}: ${fmtTokens(raw)}`;
            },
            afterBody(items) {
              const i = items[0].dataIndex;
              return [`TPM 压力: ${T.pressure_names[T.tpm_pressure[i]]}`];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b9cb3', maxRotation: 0, autoSkip: true, maxTicksLimit: 24 }, grid: { color: grid } },
        y: { title: { display: true, text: `Token / min (${tpmSuf})`, color: '#8b9cb3' }, ticks: { color: '#8b9cb3' }, grid: { color: grid }, beginAtZero: true },
      },
    },
  };
}

function setThroughputTab(mode) {
  throughputMode = mode;
  document.querySelectorAll('#throughputTabs .tab').forEach(b => {
    b.classList.toggle('on', b.dataset.tp === mode);
  });
  const T = D.throughput;
  if (!T || !T.labels) return;
  document.getElementById('throughputNote').textContent =
    mode === 'rpm' ? (T.pressure_rule || '') : (T.tpm_pressure_rule || '');
  const cfg = throughputChartConfig(T, mode);
  if (throughputChart) throughputChart.destroy();
  throughputChart = new Chart(document.getElementById('throughputChart'), cfg);
}

function renderThroughput() {
  const T = D.throughput;
  if (!T || !T.labels) return;
  const spec = T.spec || {};
  document.getElementById('throughputSpec').innerHTML =
    `${spec.timezone || ''}<br/>`
    + `桶：${spec.bucket || ''}<br/>`
    + `<code>RPM</code> ${spec.rpm || ''} · <code>TPM</code> ${spec.tpm || ''} · <code>Roll5</code> ${spec.roll5 || ''}`
    + (spec.note_5min_charts ? `<br/>${spec.note_5min_charts}` : '');
  renderThroughputLegend(T);
  document.querySelectorAll('#throughputTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => setThroughputTab(btn.dataset.tp));
  });
  setThroughputTab('rpm');
}
renderThroughput();

const PIE_COLORS = ['#3b82f6','#22c55e','#a855f7','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16'];
function renderPies() {
  const grid = document.getElementById('pieGrid');
  grid.innerHTML = '';
  (D.pies || []).forEach(p => {
    const div = document.createElement('div');
    div.className = 'pie-cell';
    div.innerHTML = `<h4>${p.title}</h4><div class="chart pie"><canvas id="pie_${p.id}"></canvas></div>`;
    grid.appendChild(div);
  });
  (D.pies || []).forEach(p => {
    const sum = p.values.reduce((a,b) => a+b, 0) || 1;
    new Chart(document.getElementById('pie_' + p.id), {
      type: 'doughnut',
      data: {
        labels: p.labels,
        datasets: [{
          data: p.values,
          backgroundColor: p.labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]),
          borderColor: '#151c28',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed;
                const pct = (v / sum * 100).toFixed(1);
                const u = p.unit || '$';
                const val = u === '$' ? '$' + v.toFixed(2) : v + ' ' + u;
                return `${ctx.label}: ${val} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  });
}
renderPies();
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    all_rows = parse_rows(args.csv)
    num = [r for r in all_rows if not r["free"]]
    if not num:
        raise SystemExit("no billable rows")

    anomalies = detect_anomalies(num)
    base = build_report_data(num, anomalies)
    per_model = build_per_model_data(num)
    pie_block = build_pie_data(num, base["summary"])
    throughput = build_throughput_pressure(num)

    date_slug = num[0]["dt"].strftime("%Y-%m-%d")
    out = args.output or Path("reports") / f"usage-{date_slug}-by-model.html"
    payload = {
        "summary": base["summary"],
        "perModel": per_model,
        "throughput": throughput,
        "pies": pie_block["pies"],
        "meta": {
            "subtitle": (
                f"{args.csv.name} · {len(num)} 条 · CST "
                f"{num[0]['cst'].strftime('%H:%M')}–{num[-1]['cst'].strftime('%H:%M')} · "
                f"跨轮次命中 {base['summary']['global_hit']}%（含首轮 {base['summary']['global_hit_all']}%）· "
                f"{len(per_model['models'])} 个模型"
            ),
            "source": str(args.csv),
        },
    }
    html = CHART_GROUP_HTML.replace("__DATA_JSON__", json.dumps(payload, ensure_ascii=False))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
