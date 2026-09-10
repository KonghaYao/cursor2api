#!/usr/bin/env python3
"""Flag anomalies in Cursor team usage CSV exports."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def pi(raw: str) -> int:
    s = (raw or "").strip().strip('"')
    return int(float(s)) if s else 0


def pc(raw: str) -> float:
    s = (raw or "").strip().strip('"')
    if not s or s.lower() == "free":
        return 0.0
    return float(s)


def load_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            m = row["Model"].strip('"')
            icw = pi(row.get("Input (w/ Cache Write)"))
            inc = pi(row.get("Input (w/o Cache Write)"))
            cr = pi(row.get("Cache Read"))
            out = pi(row.get("Output Tokens"))
            tot = icw + inc + cr + out
            pr = inc + icw + cr
            hit = cr / pr if pr else 0.0
            c = pc(row.get("Cost"))
            rows.append(
                {
                    "line": i,
                    "date": row["Date"].strip('"'),
                    "model": m,
                    "cost": c,
                    "total": tot,
                    "cr": cr,
                    "inc": inc,
                    "out": out,
                    "hit": hit,
                    "prompt": pr,
                    "usd_m": c / tot * 1e6 if tot else 0.0,
                }
            )
    return rows


def flag_rows(rows: list[dict]) -> list[dict]:
    costs = [r["cost"] for r in rows if r["cost"] > 0]
    if not costs:
        return []
    p50 = statistics.median(costs)
    q1, q2, q3 = statistics.quantiles(costs, n=4)
    iqr_fence = q3 + 3 * (q3 - q1)

    flags: list[dict] = []

    def tag(r: dict, rule: str, severity: str, reason: str) -> None:
        flags.append({**r, "rule": rule, "severity": severity, "reason": reason, "cost_vs_p50": round(r["cost"] / p50, 1) if p50 else 0})

    for r in rows:
        if r["cost"] >= 1.0:
            tag(r, "COST_GE_1USD", "critical", f"单次 ≥ $1（约为中位数 {r['cost']/p50:.0f}×）")
        elif r["cost"] > iqr_fence:
            tag(r, "COST_IQR_OUTLIER", "high", f"Cost > Q3+3·IQR (${iqr_fence:.3f})")
        if r["cr"] >= 5_000_000:
            tag(r, "ULTRA_CACHE_READ", "critical", f"Cache Read ≥ 5M ({r['cr']:,})")
        elif r["cr"] >= 1_000_000:
            tag(r, "MEGA_CACHE_READ", "high", f"Cache Read ≥ 1M")
        if r["total"] >= 3_000_000:
            tag(r, "MEGA_TOTAL_TOKENS", "high", "总 token ≥ 3M")
        if r["inc"] >= 200_000:
            tag(r, "LARGE_INC", "medium", "inc ≥ 200k")
        if r["prompt"] >= 5000 and r["hit"] < 0.5:
            tag(r, "LOW_HIT_LARGE_PROMPT", "medium", f"命中率 {r['hit']*100:.1f}%")
        if r["prompt"] >= 50000 and r["cr"] <= 1000 and r["inc"] >= 20000:
            tag(r, "COLD_START_LARGE", "medium", "大 prompt、cr≈0")
        if r["cr"] >= 500_000 and r["inc"] < 15000:
            tag(r, "MEGA_CACHE_TINY_INC", "high", "超大 cache + 极小 inc")
        if "grok" in r["model"].lower() and "fast" not in r["model"].lower() and r["cost"] >= 0.5:
            tag(r, "GROK_NON_FAST_EXPENSIVE", "high", "非 fast Grok ≥ $0.5")
        if r["model"] == "composer-2.5-fast" and r["cost"] >= 0.25:
            tag(r, "COMPOSER_FAST_SPIKE", "medium", "composer fast ≥ $0.25")
        if r["usd_m"] >= 5 and r["total"] >= 1000:
            tag(r, "HIGH_BLENDED_USD_M", "medium", f"混合 ${r['usd_m']:.2f}/M")

    return flags


def dedupe_flags(flags: list[dict]) -> list[dict]:
    seen: set[tuple[int, str]] = set()
    out: list[dict] = []
    for x in flags:
        k = (x["line"], x["rule"])
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def write_flagged_csv(rows: list[dict], flags: list[dict], path: Path) -> int:
    by_line: dict[int, list[dict]] = defaultdict(list)
    for x in flags:
        by_line[x["line"]].append(x)

    order = {"critical": 3, "high": 2, "medium": 1}
    written = 0
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "csv_line",
                "date_utc",
                "model",
                "cost_usd",
                "total_tokens",
                "cache_read",
                "inc",
                "hit_rate",
                "severity",
                "rules",
                "notes",
            ]
        )
        for r in sorted(rows, key=lambda x: -x["cost"]):
            tags = by_line.get(r["line"])
            if not tags:
                continue
            sev = max(tags, key=lambda t: order[t["severity"]])["severity"]
            notes = "; ".join({t["reason"] for t in tags})
            w.writerow(
                [
                    r["line"],
                    r["date"],
                    r["model"],
                    r["cost"],
                    r["total"],
                    r["cr"],
                    r["inc"],
                    round(r["hit"], 4),
                    sev,
                    "|".join(sorted({t["rule"] for t in tags})),
                    notes,
                ]
            )
            written += 1
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description="Flag anomalies in team usage CSV")
    ap.add_argument("csv", nargs="?", default="team-usage-events-29803137-2026-09-01.csv")
    ap.add_argument("-o", "--out", default="reports/usage-flagged-events.csv")
    ap.add_argument("--json", action="store_true", help="Print summary JSON to stdout")
    args = ap.parse_args()

    path = Path(args.csv)
    if not path.is_file():
        print(f"not found: {path}", file=sys.stderr)
        return 1

    rows = load_rows(path)
    flags = dedupe_flags(flag_rows(rows))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = write_flagged_csv(rows, flags, out_path)

    costs = [r["cost"] for r in rows if r["cost"] > 0]
    by_rule: dict[str, float] = defaultdict(float)
    for x in flags:
        by_rule[x["rule"]] += x["cost"]

    summary = {
        "events": len(rows),
        "total_cost_usd": round(sum(r["cost"] for r in rows), 2),
        "cost_median": round(statistics.median(costs), 4) if costs else 0,
        "flagged_rows_written": n,
        "cost_by_rule_usd": dict(sorted(by_rule.items(), key=lambda kv: -kv[1])),
        "out_csv": str(out_path.resolve()),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"Wrote {n} flagged rows → {out_path}")
        print(f"Total ${summary['total_cost_usd']}, median ${summary['cost_median']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
