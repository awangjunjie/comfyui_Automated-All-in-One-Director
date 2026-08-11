"""MiniMax H3 conditioning nodes tokenize internally — no separate CLIPTextEncode pass."""

from __future__ import annotations


def encode_core_conditioning(
    clip,
    *,
    task_type: str,
    positive_prompt: str,
    negative_prompt: str,
):
    """Stub kept for import compatibility; executor passes raw prompts to MiniMax nodes."""
    del clip, task_type, negative_prompt
    return positive_prompt, []
