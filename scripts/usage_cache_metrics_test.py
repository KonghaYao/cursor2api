#!/usr/bin/env python3
"""Tests for cross-turn cache hit metrics."""

from __future__ import annotations

import unittest

from usage_cache_metrics import (
    annotate_first_turn,
    compute_first_turn_in_wo_threshold,
    hit_rate_meta,
    is_first_turn_row,
)


class UsageCacheMetricsTest(unittest.TestCase):
    def test_first_turn_row(self) -> None:
        self.assertTrue(is_first_turn_row({"cr": 0, "inwo": 1000}, 8192))
        self.assertFalse(is_first_turn_row({"cr": 0, "inwo": 50000}, 8192))
        self.assertFalse(is_first_turn_row({"cr": 100, "inwo": 1000}, 8192))

    def test_hit_rate_excludes_small_cold(self) -> None:
        num = [
            {"cr": 0, "inwo": 2000},  # first turn
            {"cr": 0, "inwo": 2000},  # first turn
            {"cr": 90000, "inwo": 5000},  # warm
            {"cr": 0, "inwo": 80000},  # large cold reship — counts
        ]
        t = annotate_first_turn(num)
        meta = hit_rate_meta(num, t)
        self.assertEqual(meta["first_turn_excluded_n"], 2)
        self.assertGreater(meta["global_hit"], meta["global_hit_all"])
        # xturn: 90000 / (90000+5000+80000) ≈ 51.4%
        self.assertAlmostEqual(meta["global_hit"], 51.43, places=1)

    def test_threshold_fixed_25k(self) -> None:
        t = compute_first_turn_in_wo_threshold([])
        self.assertEqual(t, 25_000)


if __name__ == "__main__":
    unittest.main()
