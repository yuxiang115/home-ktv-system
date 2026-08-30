#!/usr/bin/env python
"""align_lyrics.py 纯函数单测(VAD 分段 / 行段映射 / auto 语种判定 / 质量门禁统计)。

node 测试管线跑不到 python,这里用零依赖的裸 assert 脚本(node vitest 之外的
补充)。两种运行方式:

    python test_align.py           # 逐个跑 test_* 函数,全过 exit 0
    python -m pytest test_align.py # 同样可用(pytest 风格命名)

不需要 torch/qwen_asr/ffmpeg:被测函数都是纯函数,只有 numpy 依赖(帧能量)。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from align_lyrics import (  # noqa: E402
    MAP_TOLERANCE,
    VAD_MIN_GAP_SECONDS,
    VAD_MIN_SEGMENT_SECONDS,
    cjk_char_ratio,
    evaluate_quality,
    line_weight,
    map_lines_to_segments,
    resolve_language,
    voiced_segments_from_energy,
)


# ---- Phase A: language auto-detection -------------------------------------


def test_resolve_language_explicit_passthrough() -> None:
    # 非 auto 的显式语言(规范名映射表产出)不做任何改写
    assert resolve_language("Chinese", "") == "Chinese"
    assert resolve_language("Cantonese", "hello world") == "Cantonese"
    assert resolve_language("Japanese", "普通文本") == "Japanese"
    assert resolve_language("", "任意") == ""


def test_resolve_language_auto_english() -> None:
    # 「其他」等未命中语种段的英文歌:<30% CJK 判 English(修复按中文字符
    # 预算对齐英文歌导致的词粘连)
    text = "\n".join(
        ["Oh baby baby how was I supposed to know", "that you were wrong for me"]
    )
    assert resolve_language("auto", text) == "English"
    assert resolve_language("Auto", text) == "English"
    assert resolve_language("auto", "") == "English"


def test_resolve_language_auto_chinese() -> None:
    text = "\n".join(["agent 007 的传说", "永远流传"])
    assert cjk_char_ratio(text) >= 0.30
    assert resolve_language("auto", text) == "Chinese"


def test_resolve_language_auto_japanese_korean() -> None:
    # 假名/谚文是比"有汉字"更特异的判别式:日语假名混汉字判 Japanese,
    # 韩语谚文判 Korean
    japanese = "君が代は 千代に八千代に さざれ石の"
    korean = "동해물과 백두산이 마르고 닳도록"
    assert resolve_language("auto", japanese) == "Japanese"
    assert resolve_language("auto", korean) == "Korean"


def test_cjk_char_ratio_ignores_whitespace_and_latin() -> None:
    assert cjk_char_ratio("我爱你") == 1.0
    assert abs(cjk_char_ratio("i love 你") - 1 / 6) < 1e-9
    assert cjk_char_ratio("plain english text") == 0.0
    assert cjk_char_ratio("   ") == 0.0


# ---- Phase B: VAD -----------------------------------------------------------


def test_voiced_segments_basic_runs() -> None:
    # 100 帧 @10fps:0-20 有声,20-40 静音,40-70 有声,70-100 静音。
    # 有声占比恰好 50%(中位数落在两峰之间)也必须正确分段:阈值被 p90
    # 一半的封顶压到有声水平之下
    energy = [0.5] * 20 + [0.01] * 20 + [0.5] * 30 + [0.01] * 30
    segments = voiced_segments_from_energy(energy, frame_rate=10.0)
    assert segments == [(0.0, 2.0), (4.0, 7.0)]


def test_voiced_segments_dense_vocals_still_segmented() -> None:
    # 演唱占比 80%(中位数=人声能量,median*2 会全判静音):靠封顶规则,
    # 静音 gap 仍被切出来
    energy = [0.5] * 40 + [0.01] * 10 + [0.5] * 50
    segments = voiced_segments_from_energy(energy, frame_rate=10.0)
    assert segments == [(0.0, 4.0), (5.0, 10.0)]


def test_voiced_segments_merges_small_gaps() -> None:
    # 句中换气 0.2s(<0.3s)合并成一段;段边界按帧粒度
    energy = [0.5] * 30 + [0.01] * 2 + [0.5] * 30
    segments = voiced_segments_from_energy(energy, frame_rate=10.0)
    assert segments == [(0.0, 6.2)]


def test_voiced_segments_drops_short_segments() -> None:
    # 0.4s 的孤立噪声段(<0.5s)被丢弃,1s 的段保留
    energy = [0.5] * 4 + [0.01] * 6 + [0.5] * 10
    segments = voiced_segments_from_energy(energy, frame_rate=10.0)
    assert segments == [(1.0, 2.0)]


def test_voiced_segments_threshold_factor_matters_between_floor_and_ceiling() -> None:
    # 中位数在静音质量(0.01)上:阈值 = median*factor,未触及 p90 封顶,
    # factor 决定中等响度(0.04)帧是否算有声
    energy = [0.01] * 70 + [0.04] * 15 + [0.5] * 15
    loose = voiced_segments_from_energy(energy, frame_rate=10.0, threshold_factor=2.0)
    strict = voiced_segments_from_energy(energy, frame_rate=10.0, threshold_factor=5.0)
    assert loose == [(7.0, 10.0)]
    assert strict == [(8.5, 10.0)]


def test_voiced_segments_silence_floor_and_empty() -> None:
    # 全数字静音:median*factor 仍 ~0,靠 energy_floor 抬门槛 -> 无段
    assert voiced_segments_from_energy([1e-9] * 100, frame_rate=10.0) == []
    assert voiced_segments_from_energy([], frame_rate=10.0) == []
    assert voiced_segments_from_energy([0.5] * 10, frame_rate=0.0) == []
    # 首尾即有声(run 收尾覆盖到末帧)
    assert voiced_segments_from_energy([0.5] * 10, frame_rate=10.0) == [(0.0, 1.0)]


# ---- Phase B: line<->segment mapping ------------------------------------------


def test_map_lines_equal_count_pairs_in_order() -> None:
    weights = [10.0, 10.0, 10.0, 10.0]
    durations = [10.0, 10.0, 10.0, 10.0]
    assert map_lines_to_segments(weights, durations) == [0, 1, 2, 3]


def test_map_lines_skips_adlib_segment() -> None:
    # 4 行歌词,段列表里混进一个短的 ad-lib 段(占 5% 时长):第一行应跳过
    # 它配到真正的演唱段,后续顺延(段多余时跳过端点最不像歌词行的段)
    weights = [25.0, 25.0, 25.0, 25.0]
    durations = [5.0, 25.0, 25.0, 25.0, 20.0]
    assert map_lines_to_segments(weights, durations) == [1, 2, 3, 4]


def test_map_lines_more_lines_than_segments_marks_unmatched() -> None:
    # 行多于段(如相邻行被 VAD 合并成一段):累计端点离所有剩余段都超过
    # 容差的行标 None(unmatched,进 QA 报告),其余行仍按序配对
    assert map_lines_to_segments([10.0] * 6, [30.0] * 3) == [None, 0, None, 1, None, 2]
    assert map_lines_to_segments([25.0] * 4, [10.0, 10.0]) == [None, 0, None, 1]


def test_map_lines_rejects_far_segments() -> None:
    # 容差拒绝:第 1 行的累计占比与最近段的端点差 0.4,默认容差下 unmatched,
    # 放宽容差到 0.45 后才允许配对
    assert map_lines_to_segments([10.0, 10.0], [10.0, 90.0], tolerance=0.1) == [None, 1]
    assert map_lines_to_segments([10.0, 10.0], [10.0, 90.0], tolerance=0.45) == [0, 1]


def test_map_lines_empty_inputs() -> None:
    assert map_lines_to_segments([], [1.0]) == []
    assert map_lines_to_segments([1.0], []) == [None]
    assert map_lines_to_segments([], []) == []


def test_line_weight_counts_non_whitespace_only() -> None:
    assert line_weight("我爱你") == 3.0
    assert line_weight("i love you") == 8.0
    assert line_weight("  ") == 0.0


# ---- Phase B: quality gate ------------------------------------------------------


def test_evaluate_quality_passes_on_sane_output() -> None:
    lines = [
        {"start": 1.0, "end": 2.0, "text": "a", "words": [
            {"text": "a", "start": 1.0, "end": 1.5},
            {"text": "b", "start": 1.5, "end": 2.0},
        ]},
        {"start": 3.0, "end": 4.0, "text": "b", "words": [
            {"text": "c", "start": 3.0, "end": 3.5},
            {"text": "d", "start": 3.5, "end": 4.0},
        ]},
    ]
    problems, stats = evaluate_quality(lines, 2)
    assert problems == []
    assert stats["coverage"] == 1.0
    assert stats["medianWordDuration"] == 0.5


def test_evaluate_quality_flags_regression_increasing() -> None:
    lines = [
        {"start": 2.0, "end": 3.0, "text": "a", "words": [{"text": "a", "start": 2.0, "end": 2.5}]},
        {"start": 2.0, "end": 4.0, "text": "b", "words": [{"text": "b", "start": 2.0, "end": 3.5}]},
    ]
    problems, _ = evaluate_quality(lines, 2)
    assert "line times not strictly increasing" in problems


def test_evaluate_quality_flags_coverage_and_word_duration() -> None:
    # 覆盖率 1/5 = 20% < 80%,且词时长中位数 4s 超出 [0.05, 2.0]
    lines = [
        {"start": 1.0, "end": 5.0, "text": "a", "words": [{"text": "a", "start": 1.0, "end": 5.0}]},
    ]
    problems, stats = evaluate_quality(lines, 5)
    assert len(problems) == 2
    assert stats["coverage"] == 0.2
    assert any("coverage" in problem for problem in problems)
    assert any("median word duration" in problem for problem in problems)


def test_defaults_are_sensible() -> None:
    # 默认参数快照:改默认值必须连带评估对存量歌曲的影响
    assert VAD_MIN_GAP_SECONDS == 0.3
    assert VAD_MIN_SEGMENT_SECONDS == 0.5
    assert 0.05 < MAP_TOLERANCE < 0.2


def _run_all() -> int:
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as error:
            failed += 1
            print(f"FAIL {name}: {error}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all())
