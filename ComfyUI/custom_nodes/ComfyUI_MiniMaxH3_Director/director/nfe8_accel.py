"""Tutu / Comfy-native 8-NFE audio-video acceleration presets for MiniMax-H3 FL2VA.

Contract source: zhaotutu12/Tutu-MiniMax-H3-AudioVideo-20to8-NFE-LoRA (sampling_contract.json).
Requires Euler + fixed ManualSigmas + shift_video=12 / shift_audio=3, with the matching LoRA.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.nfe8_accel")

_NFE8_LORA_HINT_RE = re.compile(r"(20to8|tutu-t8|tutu.*nfe|nfe.*tutu)", re.I)
_STEP_RE = re.compile(r"step0*(\d+)", re.I)

_CONTRACT_PATH = (
    Path(__file__).resolve().parent.parent / "presets" / "tutu_20to8_nfe" / "sampling_contract.json"
)

# Fallback if preset file missing (must match published contract).
_FALLBACK_MANUAL_SIGMAS = [
    1.0,
    0.9855073094367981,
    0.9729729890823364,
    0.9473683834075928,
    0.9230769276618958,
    0.8659793734550476,
    0.800000011920929,
    0.5714285969734192,
    0.0,
]

NFE8_SAMPLER = "euler"
NFE8_STEPS = 8
NFE8_SHIFT_VIDEO = 12.0
NFE8_SHIFT_AUDIO = 3.0


def load_nfe8_contract() -> dict[str, Any]:
    if _CONTRACT_PATH.is_file():
        try:
            data = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("manual_sigmas"):
                return data
        except Exception as exc:
            log.warning("Failed to read NFE8 contract %s: %s", _CONTRACT_PATH, exc)
    return {
        "student_sampler": NFE8_SAMPLER,
        "student_nfe": NFE8_STEPS,
        "video_shift": NFE8_SHIFT_VIDEO,
        "audio_shift": NFE8_SHIFT_AUDIO,
        "manual_sigmas": list(_FALLBACK_MANUAL_SIGMAS),
        "base_variant": "FL2VA",
    }


def nfe8_manual_sigmas() -> list[float]:
    raw = load_nfe8_contract().get("manual_sigmas") or _FALLBACK_MANUAL_SIGMAS
    return [float(x) for x in raw]


def nfe8_sigmas_csv() -> str:
    return ", ".join(f"{x:.17g}" for x in nfe8_manual_sigmas())


def apply_nfe8_sampling_overrides(
    *,
    steps: int,
    sampler: str,
    scheduler: str,
    shift_video: float,
    shift_audio: float,
) -> tuple[int, str, str, float, float, list[float]]:
    """Force contract sampling params; returns (steps, sampler, scheduler, sv, sa, sigmas)."""
    contract = load_nfe8_contract()
    sigmas = [float(x) for x in (contract.get("manual_sigmas") or _FALLBACK_MANUAL_SIGMAS)]
    nfe = int(contract.get("student_nfe") or NFE8_STEPS)
    # Manual schedule length is NFE + terminal 0.
    steps = max(1, len(sigmas) - 1) if len(sigmas) >= 2 else nfe
    sampler = str(contract.get("student_sampler") or NFE8_SAMPLER)
    shift_video = float(contract.get("video_shift") if contract.get("video_shift") is not None else NFE8_SHIFT_VIDEO)
    shift_audio = float(contract.get("audio_shift") if contract.get("audio_shift") is not None else NFE8_SHIFT_AUDIO)
    # Scheduler unused when ManualSigmas path is active.
    return steps, sampler, scheduler, shift_video, shift_audio, sigmas


def is_nfe8_lora_none(lora_name: str | None) -> bool:
    name = str(lora_name or "").strip()
    return (not name) or name in {"none", "None", "无", "-"}


def list_nfe8_lora_candidates() -> list[str]:
    """LoRA filenames that look like Tutu 20→8 NFE (relative to models/loras/)."""
    try:
        import folder_paths

        names = list(folder_paths.get_filename_list("loras") or [])
    except Exception:
        return []
    hits = [n for n in names if n and _NFE8_LORA_HINT_RE.search(str(n).replace("\\", "/"))]
    if not hits:
        return []

    def _sort_key(n: str):
        low = str(n).lower().replace("\\", "/")
        step_m = _STEP_RE.search(low)
        step = int(step_m.group(1)) if step_m else 0
        # Prefer explicit 20to8 / tutu-t8, then higher training step.
        tier = 0 if "20to8" in low else (1 if "tutu-t8" in low else 2)
        return (tier, -step, low)

    hits.sort(key=_sort_key)
    return hits


def pick_default_nfe8_lora_name() -> str:
    """Best-effort default LoRA path for 8-NFE accel (empty if none found)."""
    hits = list_nfe8_lora_candidates()
    return hits[0] if hits else ""


def resolve_nfe8_lora_name(lora_name: str | None) -> str:
    """Return provided LoRA name, or auto-pick a Tutu 20to8 file when none."""
    if not is_nfe8_lora_none(lora_name):
        return str(lora_name).strip()
    picked = pick_default_nfe8_lora_name()
    if picked:
        log.info("NFE8 accel: auto-selected LoRA %r", picked)
    return picked or "none"


def _safe_lora_strength(strength, default: float = 0.8) -> float:
    try:
        val = float(strength)
    except (TypeError, ValueError):
        return default
    if val != val:  # NaN
        return default
    return max(-2.0, min(2.0, val))


def maybe_load_nfe8_lora(model, lora_name: str, strength: float = 1.0):
    """Apply Comfy LoraLoaderModelOnly when a LoRA filename is provided."""
    name = str(lora_name or "").strip()
    if is_nfe8_lora_none(name) or len(name) > 260 or "\n" in name:
        return model, False
    strength = _safe_lora_strength(strength, 0.8)
    try:
        from nodes import LoraLoaderModelOnly
    except Exception as exc:
        raise RuntimeError(
            "无法加载 LoraLoaderModelOnly；请确认 ComfyUI 版本完整。"
        ) from exc
    try:
        loader = LoraLoaderModelOnly()
        out = loader.load_lora_model_only(model, name, strength)
        patched = out[0] if isinstance(out, (tuple, list)) else out
        log.info("NFE8 accel: applied LoRA %r strength=%.3f", name, strength)
        return patched, True
    except Exception as exc:
        raise RuntimeError(
            f"8 步加速 LoRA 加载失败：{name}。"
            f"请将 Tutu 8-NFE LoRA 放到 ComfyUI/models/loras/ 后在节点里选择文件名。原始错误：{exc}"
        ) from exc
