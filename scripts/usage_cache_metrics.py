"""Cross-turn cache hit metrics: exclude session first requests from hit rate."""

from __future__ import annotations

from typing import Any

# 首轮：CR≤1 且 in_wo ≤ 25k（固定）
FIRST_TURN_INWO_THRESHOLD = 25_000


def compute_first_turn_in_wo_threshold(num: list[dict]) -> int:
    """Fixed cap for first-turn detection (tokens). `num` ignored; kept for API stability."""
    del num  # unused; threshold is global constant
    return FIRST_TURN_INWO_THRESHOLD


def is_first_turn_row(r: dict, threshold: int) -> bool:
    """Session/thread first shot: no cache read and in_wo at or below threshold."""
    return float(r.get("cr") or 0) <= 1 and float(r.get("inwo") or 0) <= threshold


def annotate_first_turn(num: list[dict], threshold: int | None = None) -> int:
    """Set r['first_turn'] on each row. Returns threshold used."""
    t = threshold if threshold is not None else compute_first_turn_in_wo_threshold(num)
    for r in num:
        r["first_turn"] = is_first_turn_row(r, t)
    return t


def rows_for_hit_rate(num: list[dict], *, exclude_first_turn: bool = True) -> list[dict]:
    if not exclude_first_turn:
        return num
    return [r for r in num if not r.get("first_turn")]


def token_hit_percent(rows: list[dict]) -> float:
    inwo = sum(float(r["inwo"]) for r in rows)
    cr = sum(float(r["cr"]) for r in rows)
    den = inwo + cr
    return (cr / den * 100) if den else 0.0


def hit_rate_meta(num: list[dict], threshold: int) -> dict[str, Any]:
    """Global inclusive vs cross-turn (xturn) hit rates."""
    all_hit = token_hit_percent(num)
    xturn_rows = rows_for_hit_rate(num, exclude_first_turn=True)
    excluded = len(num) - len(xturn_rows)
    xturn_hit = token_hit_percent(xturn_rows)
    return {
        "first_turn_threshold": threshold,
        "first_turn_excluded_n": excluded,
        "global_hit_all": round(all_hit, 2),
        "global_hit": round(xturn_hit, 2),
    }
