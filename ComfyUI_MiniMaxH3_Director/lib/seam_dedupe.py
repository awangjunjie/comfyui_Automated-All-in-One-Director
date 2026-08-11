"""Adjacent-shot seam dedupe: trim highly similar frames at segment junctions."""

from __future__ import annotations

import logging
from typing import Any

import torch

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.lib.seam_dedupe")

DEFAULT_JUDGE_FRAMES = 8
MIN_JUDGE_FRAMES = 2
MAX_JUDGE_FRAMES = 32
DEFAULT_MAD_THRESHOLD = 8.0
MIN_SEGMENT_FRAMES = 5


def _proxy_mad(a: torch.Tensor, b: torch.Tensor) -> float:
    """Cheap mean-abs diff on a spatial proxy (RGB only). Scale ~0..255."""
    if a is None or b is None or a.shape[0] != b.shape[0] or a.shape[0] == 0:
        return 1e9
    aa = a[..., :3].float()
    bb = b[..., :3].float()
    step_h = max(1, int(aa.shape[1]) // 64)
    step_w = max(1, int(aa.shape[2]) // 64)
    aa = aa[:, ::step_h, ::step_w, :]
    bb = bb[:, ::step_h, ::step_w, :]
    return float((aa - bb).abs().mean().item() * 255.0)


def count_echo_frames(
    next_head: torch.Tensor,
    prev_tail: torch.Tensor,
    *,
    max_skip: int,
    mad_threshold: float = DEFAULT_MAD_THRESHOLD,
) -> tuple[int, float]:
    """Longest k where next[:k] matches prev[-k:] under MAD threshold."""
    if (
        next_head is None
        or prev_tail is None
        or max_skip <= 0
        or int(next_head.shape[0]) <= 0
        or int(prev_tail.shape[0]) <= 0
    ):
        return 0, 1e9
    limit = min(int(max_skip), int(next_head.shape[0]), int(prev_tail.shape[0]))
    if limit <= 0:
        return 0, 1e9
    best_mad = 1e9
    for k in range(limit, 0, -1):
        mad = _proxy_mad(next_head[:k], prev_tail[-k:])
        if mad < best_mad:
            best_mad = mad
        if mad <= mad_threshold:
            return k, mad
    return 0, best_mad


def _seg_bounds(seg: dict) -> tuple[int, int]:
    start = int(seg.get("start") or 0)
    length = int(seg.get("length") or seg.get("frameCount") or 0)
    return start, max(0, length)


def compute_seam_trims(
    timeline: dict,
    *,
    judge_frames: int = DEFAULT_JUDGE_FRAMES,
    mad_threshold: float = DEFAULT_MAD_THRESHOLD,
    min_segment_frames: int = MIN_SEGMENT_FRAMES,
) -> dict[str, Any]:
    """Compare adjacent segment seams; return how many head frames to drop on each next seg."""
    from .video_io import load_timeline_segment

    n_judge = max(MIN_JUDGE_FRAMES, min(MAX_JUDGE_FRAMES, int(judge_frames or DEFAULT_JUDGE_FRAMES)))
    thr = float(mad_threshold if mad_threshold is not None else DEFAULT_MAD_THRESHOLD)
    min_len = max(1, int(min_segment_frames or MIN_SEGMENT_FRAMES))

    segs = list(timeline.get("segments") or [])
    ordered = sorted(
        enumerate(segs),
        key=lambda it: (int((it[1] or {}).get("start") or 0), it[0]),
    )
    trims: list[dict[str, Any]] = []
    total_dropped = 0

    if len(ordered) < 2:
        return {"trims": [], "totalDropped": 0, "judgeFrames": n_judge, "madThreshold": thr}

    for i in range(len(ordered) - 1):
        prev_idx, prev = ordered[i]
        next_idx, nxt = ordered[i + 1]
        p_start, p_len = _seg_bounds(prev if isinstance(prev, dict) else {})
        n_start, n_len = _seg_bounds(nxt if isinstance(nxt, dict) else {})
        if p_len < 1 or n_len < 1:
            continue

        take_p = min(n_judge, p_len)
        take_n = min(n_judge, n_len)
        # Keep at least min_len on next after trim
        max_drop = max(0, n_len - min_len)
        take_n = min(take_n, max_drop) if max_drop > 0 else 0
        if take_p < 1 or take_n < 1:
            continue

        try:
            prev_tail = load_timeline_segment(timeline, p_start + p_len - take_p, p_start + p_len)
            next_head = load_timeline_segment(timeline, n_start, n_start + take_n)
        except Exception as exc:
            log.warning("seam_dedupe load failed prev=%s next=%s: %s", prev_idx, next_idx, exc)
            continue

        drop, mad = count_echo_frames(
            next_head,
            prev_tail,
            max_skip=take_n,
            mad_threshold=thr,
        )
        drop = min(int(drop), max_drop)
        if drop <= 0:
            continue
        trims.append(
            {
                "prevIndex": int(prev_idx),
                "nextIndex": int(next_idx),
                "dropFrames": int(drop),
                "mad": round(float(mad), 3),
                "prevStart": p_start,
                "prevLength": p_len,
                "nextStart": n_start,
                "nextLength": n_len,
            }
        )
        total_dropped += int(drop)

    return {
        "trims": trims,
        "totalDropped": int(total_dropped),
        "judgeFrames": n_judge,
        "madThreshold": thr,
    }
