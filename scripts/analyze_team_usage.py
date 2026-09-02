#!/usr/bin/env python3
"""Analyze Cursor Team Usage CSV: cache hit rate, cost, anomalies. Emit HTML report."""

from __future__ import annotations

import argparse
import csv
import datetime
import json
import statistics
from collections import defaultdict
from pathlib import Path


def parse_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            dt = datetime.datetime.fromisoformat(rec["Date"].replace("Z", "+00:00"))
            cst = dt + datetime.timedelta(hours=8)

            def num(k: str) -> float | None:
                v = (rec.get(k) or "").strip()
                if v in ("", "Free"):
                    return None
                try:
                    return float(v)
                except ValueError:
                    return None

            free = rec.get("Cost") == "Free" or not (rec.get("Input (w/o Cache Write)") or "").strip()
            if free:
                rows.append({"dt": dt, "cst": cst, "free": True, "ts": rec["Date"], "model": rec["Model"]})
                continue

            inwo = num("Input (w/o Cache Write)") or 0.0
            cr = num("Cache Read") or 0.0
            out_t = num("Output Tokens") or 0.0
            tot = num("Total Tokens") or 0.0
            cost = num("Cost") or 0.0
            den = inwo + cr
            hit = (cr / den) if den else None
            rows.append(
                {
                    "dt": dt,
                    "cst": cst,
                    "free": False,
                    "ts": rec["Date"],
                    "model": rec["Model"],
                    "inwo": inwo,
                    "cr": cr,
                    "out": out_t,
                    "tot": tot,
                    "cost": cost,
                    "hit": hit,
                    "cold": cr <= 1,
                }
            )
    rows.sort(key=lambda r: r["dt"])
    return rows


def detect_anomalies(num: list[dict]) -> dict:
    """Heuristics documented in CLAUDE.md § Team Usage CSV."""
    clusters: list[dict] = []
    cold_streaks: list[dict] = []
    reships = 0
    token_mismatch = 0

    for r in num:
        expected = r["inwo"] + r["cr"] + r["out"]
        if abs(expected - r["tot"]) > 2:
            token_mismatch += 1

    # cold streaks (chronological)
    streak = 0
    streak_start: dict | None = None
    for r in num:
        if r["cold"]:
            if streak == 0:
                streak_start = r
            streak += 1
        else:
            if streak >= 5 and streak_start:
                cold_streaks.append(
                    {
                        "len": streak,
                        "start_utc": streak_start["ts"],
                        "start_cst": streak_start["cst"].strftime("%H:%M:%S"),
                        "end_cst": num[num.index(r) - 1]["cst"].strftime("%H:%M:%S"),
                    }
                )
            streak = 0
            streak_start = None
    if streak >= 5 and streak_start:
        cold_streaks.append(
            {
                "len": streak,
                "start_utc": streak_start["ts"],
                "start_cst": streak_start["cst"].strftime("%H:%M:%S"),
                "end_cst": num[-1]["cst"].strftime("%H:%M:%S"),
            }
        )

    # burst clusters: >=4 cold within 60s window (sliding)
    cold_only = [r for r in num if r["cold"]]
    i = 0
    while i < len(cold_only):
        j = i
        while j < len(cold_only) and (cold_only[j]["dt"] - cold_only[i]["dt"]).total_seconds() <= 60:
            j += 1
        if j - i >= 4:
            chunk = cold_only[i:j]
            clusters.append(
                {
                    "kind": "cold_burst",
                    "n": len(chunk),
                    "start_cst": chunk[0]["cst"].strftime("%H:%M"),
                    "end_cst": chunk[-1]["cst"].strftime("%H:%M"),
                    "sum_cost": round(sum(c["cost"] for c in chunk), 2),
                    "label": f"CST {chunk[0]['cst'].strftime('%H:%M')} 冷启动×{len(chunk)}",
                }
            )
            i = j
        else:
            i += 1

    # dedupe overlapping bursts (keep largest per minute bucket)
    seen_min: set[str] = set()
    unique_clusters: list[dict] = []
    for c in sorted(clusters, key=lambda x: -x["n"]):
        key = c["start_cst"][:5]
        if key in seen_min:
            continue
        seen_min.add(key)
        unique_clusters.append(c)

    # reship count
    for i in range(1, len(num)):
        a, b = num[i - 1], num[i]
        if b["cr"] > 5000 and a["cold"] and abs(a["inwo"] - b["cr"]) / b["cr"] < 0.08:
            reships += 1

    # per-request cold events for scatter (sample)
    cold_scatter = [
        {
            "x": r["cst"].strftime("%H:%M"),
            "y": round(r["hit"] * 100, 1) if r["hit"] is not None else 0,
            "cost": r["cost"],
            "cold": r["cold"],
        }
        for r in num
    ]
    step = max(1, len(cold_scatter) // 400)
    cold_scatter_s = cold_scatter[::step]

    return {
        "token_mismatch": token_mismatch,
        "reships": reships,
        "cold_streaks": sorted(cold_streaks, key=lambda x: -x["len"]),
        "clusters": unique_clusters[:12],
        "cold_scatter": cold_scatter_s,
        "annotations": [
            {"x": c["start_cst"], "label": c["label"], "severity": "warn" if c["n"] >= 6 else "info"}
            for c in unique_clusters
        ],
    }


def build_report_data(num: list[dict], anomalies: dict) -> dict:
    total_cost = sum(r["cost"] for r in num)
    total_inwo = sum(r["inwo"] for r in num)
    total_cr = sum(r["cr"] for r in num)
    total_out = sum(r["out"] for r in num)
    global_hit = total_cr / (total_cr + total_inwo) * 100 if (total_cr + total_inwo) else 0
    cold_n = sum(1 for r in num if r["cold"])
    cold_cost = sum(r["cost"] for r in num if r["cold"])

    by_hour: dict = defaultdict(lambda: {"n": 0, "cost": 0, "inwo": 0, "cr": 0, "cold": 0})
    for r in num:
        h = r["cst"].strftime("%H:00")
        by_hour[h]["n"] += 1
        by_hour[h]["cost"] += r["cost"]
        by_hour[h]["inwo"] += r["inwo"]
        by_hour[h]["cr"] += r["cr"]
        if r["cold"]:
            by_hour[h]["cold"] += 1

    hours = sorted(by_hour.keys())
    hour_cost = [round(by_hour[h]["cost"], 2) for h in hours]
    hour_hit = [
        round(by_hour[h]["cr"] / (by_hour[h]["cr"] + by_hour[h]["inwo"]) * 100, 1)
        if by_hour[h]["cr"] + by_hour[h]["inwo"]
        else 0
        for h in hours
    ]
    hour_inwo_m = [round(by_hour[h]["inwo"] / 1e6, 2) for h in hours]
    hour_cr_m = [round(by_hour[h]["cr"] / 1e6, 2) for h in hours]

    bins = {"0–1% (冷)": 0, "1–50%": 0, "50–80%": 0, "80–90%": 0, "90–98%": 0, "98–100%": 0}
    for r in num:
        h = r["hit"]
        if h is None:
            continue
        if h < 0.01:
            bins["0–1% (冷)"] += 1
        elif h < 0.5:
            bins["1–50%"] += 1
        elif h < 0.8:
            bins["50–80%"] += 1
        elif h < 0.9:
            bins["80–90%"] += 1
        elif h < 0.98:
            bins["90–98%"] += 1
        else:
            bins["98–100%"] += 1

    by_model: dict = defaultdict(lambda: {"n": 0, "cost": 0})
    for r in num:
        m = r["model"].replace("cursor-grok-4.6-medium-fast", "grok-4.6-fast")
        by_model[m]["n"] += 1
        by_model[m]["cost"] += r["cost"]

    model_labels = list(by_model.keys())
    model_cost = [round(by_model[m]["cost"], 2) for m in model_labels]
    model_n = [by_model[m]["n"] for m in model_labels]

    roll_labels, roll_hit = [], []
    window = 20
    for i in range(window - 1, len(num)):
        chunk = num[i - window + 1 : i + 1]
        inwo = sum(r["inwo"] for r in chunk)
        cr = sum(r["cr"] for r in chunk)
        roll_labels.append(num[i]["cst"].strftime("%H:%M"))
        roll_hit.append(round(cr / (cr + inwo) * 100, 1) if cr + inwo else 0)
    step = max(1, len(roll_labels) // 80)
    roll_labels_s = roll_labels[::step]
    roll_hit_s = roll_hit[::step]

    cum_labels, cum_cost = [], []
    c = 0.0
    step2 = max(1, len(num) // 100)
    for i, r in enumerate(num):
        c += r["cost"]
        if i % step2 == 0 or i == len(num) - 1:
            cum_labels.append(r["cst"].strftime("%H:%M"))
            cum_cost.append(round(c, 2))

    cold_top = sorted(
        [
            {"x": r["cst"].strftime("%H:%M:%S"), "y": r["inwo"] / 1000, "cost": r["cost"]}
            for r in num
            if r["cold"] and r["inwo"] > 5000
        ],
        key=lambda e: -e["y"],
    )[:25]

    return {
        "summary": {
            "n": len(num),
            "cost": round(total_cost, 2),
            "global_hit": round(global_hit, 2),
            "cold_n": cold_n,
            "cold_pct": round(cold_n / len(num) * 100, 1) if num else 0,
            "cold_cost": round(cold_cost, 2),
            "inwo_m": round(total_inwo / 1e6, 2),
            "cr_m": round(total_cr / 1e6, 2),
            "out_k": round(total_out / 1e3, 1),
        },
        "hours": hours,
        "hour_cost": hour_cost,
        "hour_hit": hour_hit,
        "hour_inwo_m": hour_inwo_m,
        "hour_cr_m": hour_cr_m,
        "bins": bins,
        "model_labels": model_labels,
        "model_cost": model_cost,
        "model_n": model_n,
        "roll_labels": roll_labels_s,
        "roll_hit": roll_hit_s,
        "cum_labels": cum_labels,
        "cum_cost": cum_cost,
        "cold_top": cold_top,
        "anomalies": anomalies,
    }


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Team Usage · 缓存与成本</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
  :root {
    --bg: #0f1419; --card: #1a2332; --text: #e7ecf3; --muted: #8b9cb3;
    --accent: #3b82f6; --green: #22c55e; --amber: #f59e0b; --red: #ef4444;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "SF Pro Text", system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: var(--card); border-radius: 12px; padding: 14px 16px; border: 1px solid #2a3548; }
  .card .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .card .val { font-size: 1.35rem; font-weight: 600; margin-top: 4px; }
  .card .val.good { color: var(--green); }
  .card .val.warn { color: var(--amber); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .panel { background: var(--card); border-radius: 12px; padding: 18px; border: 1px solid #2a3548; margin-bottom: 20px; }
  .panel h2 { font-size: 0.95rem; margin: 0 0 14px; font-weight: 600; }
  .chart { position: relative; height: 280px; }
  .chart.tall { height: 340px; }
  .note { font-size: 0.8rem; color: var(--muted); margin-top: 12px; }
  .badge { display: inline-block; background: #243044; color: var(--green); padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a3548; }
  th { color: var(--muted); font-weight: 500; }
  .tag { display: inline-block; font-size: 0.75rem; padding: 2px 8px; border-radius: 6px; margin: 2px 4px 2px 0; }
  .tag.warn { background: rgba(245,158,11,0.2); color: var(--amber); }
  .tag.info { background: rgba(59,130,246,0.2); color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Team Usage · 缓存与成本 <span class="badge">含异常标注</span></h1>
  <p class="sub" id="subtitle"></p>
  <div class="cards" id="cards"></div>
  <div class="panel" id="anomalyTags"></div>

  <div class="panel">
    <h2>时间轴：单次命中率 + 冷启动簇（竖线）</h2>
    <div class="chart tall"><canvas id="anomalyTimeline"></canvas></div>
    <p class="note">橙点：冷启动（CR≤1）。竖虚线：60 秒内 ≥4 次冷启动的 burst（见 CLAUDE.md 分析方法）。</p>
  </div>

  <div class="panel">
    <h2>累计成本（CST）</h2>
    <div class="chart"><canvas id="cumCost"></canvas></div>
  </div>

  <div class="grid2">
    <div class="panel">
      <h2>按小时：成本 vs 缓存命中率</h2>
      <div class="chart"><canvas id="hourDual"></canvas></div>
    </div>
    <div class="panel">
      <h2>按小时：Input 结构（百万 tokens）</h2>
      <div class="chart"><canvas id="hourTokens"></canvas></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel">
      <h2>单次请求命中率分布</h2>
      <div class="chart"><canvas id="hitBins"></canvas></div>
    </div>
    <div class="panel">
      <h2>模型成本占比</h2>
      <div class="chart"><canvas id="modelPie"></canvas></div>
    </div>
  </div>

  <div class="panel">
    <h2>滚动 20 次请求全局命中率（抽样）</h2>
    <div class="chart tall"><canvas id="rolling"></canvas></div>
  </div>

  <div class="panel">
    <h2>冷启动 streak（≥5 连 CR≤1）</h2>
    <table>
      <thead><tr><th>长度</th><th>CST 起止</th></tr></thead>
      <tbody id="streakTable"></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>大额冷启动 Top（in_wo &gt; 5k，CR≤1）</h2>
    <table>
      <thead><tr><th>CST</th><th>未命中 input (k)</th><th>成本</th></tr></thead>
      <tbody id="coldTable"></tbody>
    </table>
  </div>
</div>
<script>
const D = __DATA_JSON__;
const gridColor = 'rgba(139,156,179,0.15)';
const defaults = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#8b9cb3' } } },
  scales: {
    x: { ticks: { color: '#8b9cb3', maxRotation: 45 }, grid: { color: gridColor } },
    y: { ticks: { color: '#8b9cb3' }, grid: { color: gridColor } }
  }
};

const s = D.summary;
document.getElementById('subtitle').textContent = D.meta.subtitle;
document.getElementById('cards').innerHTML = `
  <div class="card"><div class="label">计费请求</div><div class="val">${s.n}</div></div>
  <div class="card"><div class="label">估算成本</div><div class="val">$${s.cost}</div></div>
  <div class="card"><div class="label">全局命中率</div><div class="val good">${s.global_hit}%</div></div>
  <div class="card"><div class="label">冷启动</div><div class="val warn">${s.cold_n} (${s.cold_pct}%)</div></div>
  <div class="card"><div class="label">冷启动成本</div><div class="val warn">$${s.cold_cost}</div></div>
  <div class="card"><div class="label">整前缀重送≈</div><div class="val">${D.anomalies.reships} 次</div></div>
  <div class="card"><div class="label">Token 列不一致</div><div class="val good">${D.anomalies.token_mismatch}</div></div>
`;

const tags = D.anomalies.clusters.map(c =>
  `<span class="tag ${c.n>=6?'warn':'info'}">${c.label} · $${c.sum_cost}</span>`
).join('');
document.getElementById('anomalyTags').innerHTML = '<h2>异常簇（自动检测）</h2>' + (tags || '<p class="note">未检出 burst</p>');

const scatter = D.anomalies.cold_scatter;
const ann = {};
D.anomalies.clusters.forEach((c, i) => {
  ann['line'+i] = {
    type: 'line', xMin: c.start_cst, xMax: c.start_cst, yMin: 0, yMax: 100,
    borderColor: 'rgba(245,158,11,0.85)', borderWidth: 2, borderDash: [6,4],
    label: { display: true, content: c.n+'冷', color: '#f59e0b', backgroundColor: 'rgba(0,0,0,0.5)' }
  };
});

new Chart(document.getElementById('anomalyTimeline'), {
  type: 'scatter',
  data: {
    datasets: [{
      label: '命中率 %',
      data: scatter.map(p => ({ x: p.x, y: p.y })),
      pointRadius: scatter.map(p => p.cold ? 4 : 1),
      pointBackgroundColor: scatter.map(p => p.cold ? '#f59e0b' : 'rgba(34,197,94,0.35)'),
    }]
  },
  options: {
    ...defaults,
    plugins: {
      ...defaults.plugins,
      annotation: { annotations: ann },
      legend: { display: false }
    },
    scales: {
      x: { ...defaults.scales.x, type: 'category' },
      y: { ...defaults.scales.y, min: 0, max: 100, title: { display: true, text: '命中率 %', color: '#8b9cb3' } }
    }
  }
});

new Chart(document.getElementById('cumCost'), {
  type: 'line',
  data: {
    labels: D.cum_labels,
    datasets: [{ label: '累计 $', data: D.cum_cost, borderColor: '#3b82f6', fill: true, tension: 0.2, pointRadius: 0 }]
  },
  options: { ...defaults, plugins: { legend: { display: false } } }
});

new Chart(document.getElementById('hourDual'), {
  type: 'bar',
  data: {
    labels: D.hours,
    datasets: [
      { label: '成本 $', data: D.hour_cost, backgroundColor: 'rgba(59,130,246,0.7)', yAxisID: 'y' },
      { label: '命中率 %', data: D.hour_hit, type: 'line', borderColor: '#22c55e', yAxisID: 'y1', tension: 0.3 }
    ]
  },
  options: {
    ...defaults,
    scales: {
      x: defaults.scales.x,
      y: { position: 'left', ticks: { color: '#8b9cb3' }, grid: { color: gridColor } },
      y1: { position: 'right', min: 0, max: 100, ticks: { color: '#22c55e' }, grid: { display: false } }
    }
  }
});

new Chart(document.getElementById('hourTokens'), {
  type: 'bar',
  data: {
    labels: D.hours,
    datasets: [
      { label: 'Cache Read (M)', data: D.hour_cr_m, backgroundColor: 'rgba(34,197,94,0.65)' },
      { label: '未命中 input (M)', data: D.hour_inwo_m, backgroundColor: 'rgba(245,158,11,0.75)' }
    ]
  },
  options: { ...defaults, scales: { x: { stacked: true, ...defaults.scales.x }, y: { stacked: true, ...defaults.scales.y } } }
});

new Chart(document.getElementById('hitBins'), {
  type: 'doughnut',
  data: {
    labels: Object.keys(D.bins),
    datasets: [{ data: Object.values(D.bins), backgroundColor: ['#ef4444','#f97316','#eab308','#84cc16','#22c55e','#10b981'] }]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#8b9cb3' } } } }
});

new Chart(document.getElementById('modelPie'), {
  type: 'pie',
  data: {
    labels: D.model_labels.map((m,i) => `${m} (${D.model_n[i]}次)`),
    datasets: [{ data: D.model_cost, backgroundColor: ['#3b82f6','#a855f7','#22c55e'] }]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#8b9cb3' } } } }
});

new Chart(document.getElementById('rolling'), {
  type: 'line',
  data: {
    labels: D.roll_labels,
    datasets: [{ label: '滚动命中率 %', data: D.roll_hit, borderColor: '#22c55e', pointRadius: 0, tension: 0.2 }]
  },
  options: { ...defaults, scales: { ...defaults.scales, y: { ...defaults.scales.y, min: 0, max: 100 } } }
});

document.getElementById('streakTable').innerHTML = (D.anomalies.cold_streaks.length ? D.anomalies.cold_streaks : [{len:'—',start_cst:'—',end_cst:'—'}])
  .map(r => `<tr><td>${r.len}</td><td>${r.start_cst} → ${r.end_cst}</td></tr>`).join('');
document.getElementById('coldTable').innerHTML = D.cold_top.map(r =>
  `<tr><td>${r.x}</td><td>${r.y.toFixed(0)}k</td><td>$${r.cost.toFixed(2)}</td></tr>`
).join('');
</script>
</body>
</html>
"""


def emit_html(data: dict, meta: dict, out: Path) -> None:
    payload = {**data, "meta": meta}
    html = HTML_TEMPLATE.replace("__DATA_JSON__", json.dumps(payload, ensure_ascii=False))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv", type=Path, help="team-usage-events-*.csv")
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="HTML output (default: reports/usage-<date>-cache-cost.html)",
    )
    args = ap.parse_args()

    all_rows = parse_rows(args.csv)
    num = [r for r in all_rows if not r["free"]]
    if not num:
        raise SystemExit("no billable rows")

    anomalies = detect_anomalies(num)
    data = build_report_data(num, anomalies)

    date_slug = num[0]["dt"].strftime("%Y-%m-%d")
    out = args.output or Path("reports") / f"usage-{date_slug}-cache-cost.html"
    meta = {
        "subtitle": f"{args.csv.name} · {len(num)} 条计费 · UTC {num[0]['dt'].strftime('%H:%M')}–{num[-1]['dt'].strftime('%H:%M')}（+8h=CST）",
        "source": str(args.csv),
    }
    emit_html(data, meta, out)
    print(out)


if __name__ == "__main__":
    main()
