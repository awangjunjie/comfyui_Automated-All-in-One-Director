"""Exact frame-count alignment for Director merge / cache / preview outputs."""

from __future__ import annotations

import torch


def minimax_align_frame_count(frame_count: int) -> int:
    """Round up to MiniMax H3 17k+5 frame grid (5, 22, 39, …)."""
    n = max(5, int(frame_count))
    while n % 17 != 5:
        n += 1
    return n


def wan_align_frame_count(frame_count: int) -> int:
    """Legacy alias — MiniMax H3 uses 17k+5, not Wan 4n+1."""
    return minimax_align_frame_count(frame_count)


def pad_or_trim_frames(frames: torch.Tensor, target_len: int) -> torch.Tensor:
    """Trim to at most target_len frames. Does not fabricate last-frame duplicates."""
    target_len = max(0, int(target_len))
    if target_len <= 0:
        return frames[:0]
    if int(frames.shape[0]) > target_len:
        return frames[:target_len]
    return frames
