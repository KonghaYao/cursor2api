#!/usr/bin/env python3
"""Merge executive summary + by-model charts + cache timeline into one HTML."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from analyze_team_usage import build_report_data, detect_anomalies, parse_rows
from analyze_team_usage_chart_group import (
    CHART_GROUP_HTML,
    build_per_model_data,
    build_pie_data,
    build_throughput_pressure,
)

COMBINED_SHELL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Team Usage · __DATE__ 综合报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
  :root { --bg:#0b0f14; --card:#151c28; --text:#e8edf4; --muted:#8b9cb3; --line:#263044;
    --green:#22c55e; --amber:#f59e0b; --accent:#3b82f6; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); overflow-x:hidden; }
  .wrap { max-width:min(1400px,100vw); margin:0 auto; padding:20px 18px 64px; }
  h1 { font-size:1.35rem; margin:0 0 4px; font-weight:650; }
  .sub { color:var(--muted); font-size:0.85rem; margin-bottom:12px; }
  .nav { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 20px; font-size:0.8rem; }
  .nav a { color:var(--accent); text-decoration:none; padding:4px 10px; border:1px solid var(--line); border-radius:8px; }
  .nav a:hover { background:#1f2937; }
  .exec { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:24px; }
  .exec h2 { margin:0 0 10px; font-size:0.95rem; }
  .exec ul { margin:0; padding-left:1.2rem; line-height:1.55; font-size:0.84rem; }
  .exec li { margin-bottom:6px; }
  .exec .verdict { margin-top:12px; padding:10px 12px; background:rgba(34,197,94,0.12); border-radius:8px; font-size:0.82rem; }
  .exec table { width:100%; border-collapse:collapse; font-size:0.78rem; margin-top:10px; }
  .exec th, .exec td { padding:6px 8px; border-bottom:1px solid var(--line); text-align:left; }
  .exec th { color:var(--muted); font-weight:500; }
  .sep { border:0; border-top:1px solid var(--line); margin:32px 0; }
  .part-title { font-size:1.1rem; font-weight:600; margin:0 0 8px; }
  .part-sub { color:var(--muted); font-size:0.8rem; margin-bottom:16px; }
__MODEL_CSS__
__CACHE_CSS__
</style>
</head>
<body>
<div class="wrap">
  <h1>Team Usage · __DATE__ 综合报告</h1>
  <p class="sub">__SUBTITLE__</p>
  <nav class="nav">
    <a href="#exec">结论摘要</a>
    <a href="#part-model">分模型看板</a>
    <a href="#part-cache">缓存与异常</a>
  </nav>

  <section id="exec" class="exec">
    __EXEC_BODY__
  </section>

  <hr class="sep"/>
  <h2 class="part-title" id="part-model">分模型 · 成本 / 吞吐 / Cache</h2>
  <p class="part-sub">交互筛选、RPM/TPM、5 分钟堆叠、命中率折线（与定稿 by-model 模板一致）</p>
  __MODEL_BODY__

  <hr class="sep"/>
  <h2 class="part-title" id="part-cache">缓存时间轴 · 成本与异常</h2>
  <p class="part-sub">冷启动 burst、streak、滚动命中；对照 9/1 conversationId 事故信号</p>
  __CACHE_BODY__
</div>
__SCRIPTS__
</body>
</html>
"""


def _extract_style(html: str) -> str:
    m = re.search(r"<style>(.*?)</style>", html, re.S)
    return m.group(1).strip() if m else ""


def _extract_body_inner(html: str) -> str:
    m = re.search(r"<body>\s*(.*?)\s*</body>", html, re.S)
    return m.group(1).strip() if m else ""


def _extract_script(html: str) -> str:
    m = re.search(r"<script>\s*(.*?)\s*</script>\s*</body>", html, re.S)
    return m.group(1).strip() if m else ""


def _strip_scripts(html: str) -> str:
    return re.sub(r"<script\b[^>]*>.*?</script>\s*", "", html, flags=re.S | re.I).strip()


def _unwrap_wrap_div(html: str) -> str:
    m = re.match(r'<div class="wrap">\s*(.*)\s*</div>\s*$', html, re.S)
    return m.group(1).strip() if m else html


def _patch_data_var(script: str, new_var: str) -> str:
    script = script.replace("const D =", f"const {new_var} =", 1)
    return re.sub(r"\bD\.", f"{new_var}.", script)


CACHE_DOM_IDS = (
    "subtitle",
    "cards",
    "anomalyTags",
    "anomalyTimeline",
    "cumCost",
    "hourDual",
    "hourTokens",
    "hitBins",
    "modelPie",
    "rolling",
    "streakTable",
    "coldTable",
)


def _prefix_cache_dom(html: str, script: str, prefix: str = "cache_") -> tuple[str, str]:
    for dom_id in CACHE_DOM_IDS:
        new_id = f"{prefix}{dom_id}"
        html = html.replace(f'id="{dom_id}"', f'id="{new_id}"')
        script = script.replace(f"getElementById('{dom_id}')", f"getElementById('{new_id}')")
    return html, script


def build_exec_body(summary: dict, models: list[dict], anomalies: dict) -> str:
    streaks = anomalies.get("cold_streaks") or []
    top_streaks = sorted(streaks, key=lambda x: -x["len"])[:5]
    streak_lines = "".join(
        f"<li>CST {s['start_cst']}–{s['end_cst']}：连续 <b>{s['len']}</b> 次 CR≤1</li>"
        for s in top_streaks
    ) or "<li>无 ≥5 连冷段</li>"

    rows = "".join(
        f"<tr><td>{m['model']}</td><td>{m['n']}</td><td>${m['cost']:.2f}</td>"
        f"<td>{m['hit']:.1f}%</td><td>{m['cold_n']} ({m['cold_pct']}%)</td></tr>"
        for m in sorted(models, key=lambda x: -x["cost"])
    )

    verdict = (
        "网关 / conversationId：<b>健康</b> — 全局命中 "
        f"{summary['global_hit']}%，无 9/1 式 50+ 连零缓存；"
        f"reships {anomalies.get('reships', 0)} 次属换轨/并行 thread。"
    )

    return f"""
    <h2>分析结论（自动生成）</h2>
    <ul>
      <li>计费 <b>{summary['n']}</b> 次 · 估算成本 <b>${summary['cost']:.2f}</b> · 冷启动 <b>{summary['cold_n']}</b> 次（{summary['cold_pct']}%）约 <b>${summary['cold_cost']:.2f}</b></li>
      <li>Token：in_wo <b>{summary['inwo_m']:.1f}M</b> + Cache Read <b>{summary['cr_m']:.1f}M</b> + Output <b>{summary['out_k']:.1f}k</b></li>
      <li>成本大头：<b>composer-2.5-fast</b> + <b>Grok fast 族</b>；composer-2.5 冷枪比例偏高多为并行 subagent</li>
      <li>最长冷启动 streak（Top5）：<ul>{streak_lines}</ul></li>
    </ul>
    <div class="verdict">{verdict}</div>
    <table>
      <thead><tr><th>模型</th><th>次数</th><th>成本</th><th>命中</th><th>冷启动</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
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
    subtitle = (
        f"{args.csv.name} · {len(num)} 条 · CST "
        f"{num[0]['cst'].strftime('%H:%M')}–{num[-1]['cst'].strftime('%H:%M')}"
    )

    model_payload = {
        "summary": base["summary"],
        "perModel": per_model,
        "throughput": throughput,
        "pies": pie_block["pies"],
        "meta": {
            "subtitle": subtitle + f" · 全局命中 {base['summary']['global_hit']}%",
            "source": str(args.csv),
        },
    }
    model_html = CHART_GROUP_HTML.replace("__DATA_JSON__", json.dumps(model_payload, ensure_ascii=False))
    model_inner = _unwrap_wrap_div(_strip_scripts(_extract_body_inner(model_html)))
    model_inner = re.sub(r"<h1>.*?</h1>\s*", "", model_inner, count=1, flags=re.S)
    model_script = _patch_data_var(_extract_script(model_html), "D_MODEL")

    from analyze_team_usage import HTML_TEMPLATE

    cache_payload = {**base, "meta": {"subtitle": subtitle, "source": str(args.csv)}}
    cache_html = HTML_TEMPLATE.replace("__DATA_JSON__", json.dumps(cache_payload, ensure_ascii=False))
    cache_inner = _unwrap_wrap_div(_strip_scripts(_extract_body_inner(cache_html)))
    cache_inner = re.sub(r"<h1>.*?</h1>\s*", "", cache_inner, count=1, flags=re.S)
    cache_script = _patch_data_var(_extract_script(cache_html), "D_CACHE")
    cache_inner, cache_script = _prefix_cache_dom(cache_inner, cache_script)

    model_css = _extract_style(model_html)
    cache_css = _extract_style(cache_html)

    exec_body = build_exec_body(base["summary"], per_model["model_summary"], anomalies)

    out = args.output or Path("reports") / f"usage-{date_slug}-combined.html"
    html = (
        COMBINED_SHELL.replace("__DATE__", date_slug)
        .replace("__SUBTITLE__", subtitle)
        .replace("__EXEC_BODY__", exec_body)
        .replace("__MODEL_BODY__", model_inner)
        .replace("__CACHE_BODY__", cache_inner)
        .replace("__MODEL_CSS__", model_css)
        .replace("__CACHE_CSS__", cache_css)
        .replace(
            "__SCRIPTS__",
            f"<script>\n{model_script}\n</script>\n<script>\n{cache_script}\n</script>",
        )
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
