#!/usr/bin/env python
"""align_lyrics.py 单测(VAD 分段 / 行段映射 / auto 语种判定 / 质量门禁统计 /
对齐核心数据流)。

node 测试管线跑不到 python,这里用零依赖的裸 assert 脚本(node vitest 之外的
补充)。两种运行方式:

    python test_align.py           # 逐个跑 test_* 函数,全过 exit 0
    python -m pytest test_align.py # 同样可用(pytest 风格命名)

不需要 torch/qwen_asr/ffmpeg:被测函数都是纯函数;对齐核心(align_lines)
用 stub aligner + numpy 合成波形覆盖,不加载模型。
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from align_lyrics import (  # noqa: E402
    MAP_TOLERANCE,
    VAD_MIN_GAP_SECONDS,
    VAD_MIN_SEGMENT_SECONDS,
    align_lines,
    cjk_char_ratio,
    collapsed_word_fraction,
    evaluate_quality,
    line_weight,
    line_within_segment,
    map_lines_to_segments,
    parse_lrc,
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


# ---- Phase B: alignment core (LRC timeline leakage regression) -----------------


class _StubUnit:
    def __init__(self, text: str, start_time: float, end_time: float) -> None:
        self.text = text
        self.start_time = start_time
        self.end_time = end_time


class _StubAligner:
    """模拟 Qwen3 aligner 接口:unit 时间相对 clip 起点,固定节拍铺开。

    lying=True 时故意返回远离 clip 的时间(模型 artifact/时间轴泄漏),
    用于验证越界行被丢弃而不是带错误时间输出。
    collapsing=True 时前两个词给正常时长、其余词 start==end(模型把整行
    文本硬塞进不含该语音的切片时的典型塌缩输出)。
    """

    def __init__(self, lead: float = 0.35, beat: float = 0.3, lying: bool = False,
                 collapsing: bool = False) -> None:
        self.lead = lead
        self.beat = beat
        self.lying = lying
        self.collapsing = collapsing
        self.clips: list[float] = []

    def align(self, audio, text, language):
        clip, sr = audio
        clip_len = clip.size / sr
        self.clips.append(clip_len)
        tokens = text.split() or [text]
        units: list[_StubUnit] = []
        cursor = self.lead
        for position, token in enumerate(tokens):
            end = min(cursor + self.beat, max(cursor + 0.05, clip_len - 0.05))
            if self.lying:
                units.append(_StubUnit(token, cursor - 60.0, end - 60.0))
            elif self.collapsing and position >= 2:
                units.append(_StubUnit(token, end, end))
            else:
                units.append(_StubUnit(token, cursor, end))
            cursor = end
        return [units]


def _baby_like_audio():
    """Justin Bieber - Baby 形状的合成波形:前 15.8s 安静(前奏),之后两段有声。"""
    import numpy as np

    sr = 16000
    audio = np.zeros(int(40 * sr), dtype=np.float32)
    audio[int(15.8 * sr):int(21.0 * sr)] = 0.4
    audio[int(24.0 * sr):int(30.0 * sr)] = 0.4
    return audio, sr


def test_align_lines_output_timeline_comes_from_audio_not_lrc() -> None:
    # 回归(实锤 bug):LRC 首行 [00:03.41](LRCLIB 录音室时间轴),但该 MV
    # 混音/人声首段在 15.8s。输出首行必须来自音频段(15-17s 区间),绝不
    # 是 3.4s——v1 管线按 LRC 时间戳切块时首行就精确落在 3.4s。
    audio, sr = _baby_like_audio()
    with tempfile.TemporaryDirectory() as tmp:
        lrc = Path(tmp) / "baby.lrc"
        lrc.write_text(
            "[00:03.41] Oh whoa, oh whoa, oh whoa\n"
            "[00:14.64] You know you love me, I know you care\n",
            encoding="utf-8",
        )
        lines = parse_lrc(lrc)
        assert abs(lines[0][0] - 3.41) < 0.01  # LRC 确实声称首行 3.41s
        line_texts = [text for _, text in lines]

        output, unmatched, segments, first_segment_start = align_lines(
            audio, sr, line_texts, "English", _StubAligner()
        )

    assert not unmatched
    assert 15.5 <= segments[0][0] <= 16.0  # VAD 首段就是音频里的 15.8s
    assert first_segment_start == segments[0][0]
    first_start = output[0]["start"]
    # 首行来自音频段:落在 [段起点-切片余量, 段起点+2s],与 3.41 至少差 1s
    assert segments[0][0] - 0.3 <= first_start <= segments[0][0] + 2.0
    assert abs(first_start - 3.41) > 1.0
    # 每行时间都落在自己段的硬校验范围内
    for entry in output:
        assert line_within_segment(entry, segments[0]) or line_within_segment(entry, segments[1])
    # 门禁(含首行-首段偏差硬校验)应通过
    problems, stats = evaluate_quality(output, len(line_texts), first_segment_start)
    assert problems == []
    assert stats["coverage"] == 1.0


def test_align_lines_drops_lines_whose_times_escape_segment() -> None:
    # 模型 artifact(unit 时间跑到 clip 外):该行必须被丢弃(unmatched),
    # 绝不能带着远离音频段的时间输出,也不回退 LRC 时间戳。
    audio, sr = _baby_like_audio()
    line_texts = ["Oh whoa, oh whoa, oh whoa", "You know you love me, I know you care"]
    output, unmatched, segments, first_segment_start = align_lines(
        audio, sr, line_texts, "English", _StubAligner(lying=True)
    )
    assert output == []
    assert unmatched == [0, 1]
    assert first_segment_start is None
    problems, stats = evaluate_quality(output, len(line_texts), first_segment_start)
    assert stats["coverage"] == 0.0
    assert any("coverage" in problem for problem in problems)


def test_align_lines_drops_lines_with_collapsed_word_timings() -> None:
    # Baby 实锤的坏输出形态:行 span 落在段内(不越界),但超半数词 start==end
    # (模型把文本硬塞进不含该语音的段,如把整句词配到前奏 ad-lib 段)。这种行
    # 必须按 unmatched 丢弃,而不是带着塌缩词时间输出。
    audio, sr = _baby_like_audio()
    line_texts = ["Oh whoa, oh whoa, oh whoa", "You know you love me, I know you care"]
    output, unmatched, segments, first_segment_start = align_lines(
        audio, sr, line_texts, "English", _StubAligner(collapsing=True)
    )
    # 6 词塌 4 个(67%)、9 词塌 7 个(78%):两行都超 50% 阈值被丢弃
    assert output == []
    assert unmatched == [0, 1]


def test_collapsed_word_fraction_and_file_gate() -> None:
    assert collapsed_word_fraction({"words": [
        {"text": "a", "start": 0.0, "end": 0.3},
        {"text": "b", "start": 0.3, "end": 0.6},
    ]}) == 0.0
    # 4/6 塌缩 = Baby 首行实测形态
    assert collapsed_word_fraction({"words": [
        {"text": "Oh", "start": 3.36, "end": 3.92},
        {"text": "whoa", "start": 3.92, "end": 5.12},
        {"text": "oh", "start": 5.12, "end": 5.12},
        {"text": "whoa", "start": 5.12, "end": 5.12},
        {"text": "oh", "start": 5.12, "end": 5.12},
        {"text": "whoa", "start": 5.12, "end": 5.12},
    ]}) > 0.5
    assert collapsed_word_fraction({"words": []}) == 1.0
    # 文件级兜底:两行各 30-50% 塌缩(逐行阈值不丢),总体 33% > 30% => 拒绝
    lines = [
        {"start": 1.0, "end": 2.0, "text": "a b c", "words": [
            {"text": "a", "start": 1.0, "end": 1.3},
            {"text": "b", "start": 1.3, "end": 1.6},
            {"text": "c", "start": 1.6, "end": 1.6},
        ]},
        {"start": 3.0, "end": 4.0, "text": "d e f", "words": [
            {"text": "d", "start": 3.0, "end": 3.3},
            {"text": "e", "start": 3.3, "end": 3.6},
            {"text": "f", "start": 3.6, "end": 3.6},
        ]},
    ]
    problems, stats = evaluate_quality(lines, 2)
    assert any("collapsed" in problem for problem in problems)
    assert stats["collapsedWordFraction"] == round(2 / 6, 3)
    # 健康输出:零塌缩,不受影响
    healthy = [{"start": 1.0, "end": 2.0, "text": "a b", "words": [
        {"text": "a", "start": 1.0, "end": 1.5}, {"text": "b", "start": 1.5, "end": 2.0},
    ]}]
    problems, stats = evaluate_quality(healthy, 1)
    assert problems == []
    assert stats["collapsedWordFraction"] == 0.0


def test_align_lines_silent_audio_maps_nothing() -> None:
    # 全静音音频(分离失败/拿错文件):无 VAD 段,所有行 unmatched,门禁拒绝
    import numpy as np

    sr = 16000
    audio = np.zeros(int(10 * sr), dtype=np.float32)
    output, unmatched, segments, first_segment_start = align_lines(
        audio, sr, ["一句歌词", "另一句歌词"], "Chinese", _StubAligner()
    )
    assert output == [] and segments == []
    assert unmatched == [0, 1]
    assert first_segment_start is None


def test_line_within_segment_margins() -> None:
    entry = {"start": 10.0, "end": 12.0, "text": "x", "words": []}
    assert line_within_segment(entry, (10.2, 11.5))  # 起点在段内,end 12 <= 11.5+1
    assert not line_within_segment(entry, (13.0, 15.0))  # 整行在段前(>1s)
    assert not line_within_segment({"start": 3.36, "end": 5.12}, (15.81, 16.65))
    assert line_within_segment({"start": 3.36, "end": 5.12}, (3.0, 5.5))


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


def test_evaluate_quality_flags_first_line_timeline_leak() -> None:
    # 硬时间轴校验:LRC 首行 3.36s 但首个被采用 VAD 段在 15.81s(Baby 实测),
    # 偏差 >2s => 拒绝整个输出(时间轴不是这段音频的)
    leaked = [
        {"start": 3.36, "end": 5.12, "text": "Oh whoa", "words": [
            {"text": "Oh", "start": 3.36, "end": 5.12},
        ]},
    ]
    problems, _ = evaluate_quality(leaked, 1, first_segment_start=15.81)
    assert any("deviates" in problem and "15.81" in problem for problem in problems)

    # 首行贴着音频首段(+0.35s 切片内偏移) => 无此问题
    honest = [
        {"start": 16.16, "end": 17.5, "text": "Oh whoa", "words": [
            {"text": "Oh", "start": 16.16, "end": 17.5},
        ]},
    ]
    problems, _ = evaluate_quality(honest, 1, first_segment_start=15.81)
    assert not any("deviates" in problem for problem in problems)

    # 不传段起点(旧调用方式/无输出)不触发该校验
    assert evaluate_quality(leaked, 1)[0] == []


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
