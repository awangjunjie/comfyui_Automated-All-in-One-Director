"""Standalone reference-audio helpers (MiniMax H3: up to 3 → <Audio 1>…<Audio 3>)."""

from __future__ import annotations

from typing import Any

# Official MiniMaxH3ReferenceToVideo Autogrow max=3.
MAX_REFERENCE_AUDIOS = 3
REF_AUDIO_KEY_PREFIX = "ref_audio_"


def reference_audio_label(index: int) -> str:
    """User-facing label for slot index (0-based) → 音频1…音频3."""
    return f"音频{int(index) + 1}"


def reference_audio_prompt_tag(index: int) -> str:
    return f"<Audio {int(index) + 1}>"


def ref_audios_dict(items: list[tuple[int, dict[str, Any]]]) -> dict[str, dict[str, Any]] | None:
    """Build official ``ref_audio_N`` mapping from (index, AUDIO) pairs."""
    out: dict[str, dict[str, Any]] = {}
    for index, audio in items:
        idx = int(index)
        if idx < 0 or idx >= MAX_REFERENCE_AUDIOS or not isinstance(audio, dict):
            continue
        wave = audio.get("waveform")
        if wave is None:
            continue
        out[f"{REF_AUDIO_KEY_PREFIX}{idx}"] = audio
    return out or None
