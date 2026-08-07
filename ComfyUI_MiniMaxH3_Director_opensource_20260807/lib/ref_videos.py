"""Standalone reference-video helpers (MiniMax H3: up to 3 → <Video 1>…<Video 3>)."""

from __future__ import annotations

from typing import Any

import torch

# Official MiniMaxH3ReferenceToVideo Autogrow max=3.
MAX_REFERENCE_VIDEOS = 3
REF_VIDEO_KEY_PREFIX = "ref_video_"


def reference_video_label(index: int) -> str:
    """User-facing label for slot index (0-based) → 视频1…视频3."""
    return f"视频{int(index) + 1}"


def reference_video_prompt_tag(index: int) -> str:
    return f"<Video {int(index) + 1}>"


def ref_videos_dict(items: list[tuple[int, torch.Tensor]]) -> dict[str, torch.Tensor] | None:
    """Build official ``ref_video_N`` mapping from (index, frames) pairs."""
    out: dict[str, torch.Tensor] = {}
    for index, frames in items:
        idx = int(index)
        if idx < 0 or idx >= MAX_REFERENCE_VIDEOS:
            continue
        if not isinstance(frames, torch.Tensor) or frames.numel() <= 0:
            continue
        out[f"{REF_VIDEO_KEY_PREFIX}{idx}"] = frames
    return out or None
