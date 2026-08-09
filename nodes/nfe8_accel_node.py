# -*- coding: utf-8 -*-
"""Thin MODEL→MODEL wrapper for Tutu 20→8 NFE LoRA (discoverable in node menu).

Sampling contract (Euler + ManualSigmas + shift 12/3) is applied inside MiniMaxH3Director
when its「8步音视频加速」is enabled. This node only loads the matching LoRA so users can
find「8步」in the node search menu. Prefer one path: either Director checkbox+LoRA, or
this node for LoRA + Director checkbox with LoRA=none (sampling-only).
"""

from __future__ import annotations

import folder_paths

from ..director.nfe8_accel import (
    maybe_load_nfe8_lora,
    pick_default_nfe8_lora_name,
    resolve_nfe8_lora_name,
)


def _lora_choices() -> list[str]:
    return ["none"] + list(folder_paths.get_filename_list("loras") or [])


def _default_lora() -> str:
    return pick_default_nfe8_lora_name() or "none"


class MiniMaxH3Nfe8Accel:
    """Load Tutu 8-NFE audio-video LoRA onto MODEL."""

    @classmethod
    def INPUT_TYPES(cls):
        choices = _lora_choices()
        default = _default_lora()
        if default not in choices:
            default = "none"
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "MiniMax H3 UNET / 加速链输出 MODEL。"}),
                "enable": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "关闭则原样透传 MODEL，不加载 LoRA。",
                    },
                ),
                "lora_name": (
                    choices,
                    {
                        "default": default,
                        "tooltip": (
                            "Tutu 20→8 NFE LoRA（models/loras/，如 "
                            "comfyui/tutu-t8-*20to8*.safetensors）。none 时会尝试自动匹配。"
                        ),
                    },
                ),
                "lora_strength": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": -2.0,
                        "max": 2.0,
                        "step": 0.05,
                        "tooltip": "LoRA 强度（建议先试 0.8）。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = "MiniMaxH3"
    DESCRIPTION = (
        "MiniMax H3 8 步音视频加速（仅加载 Tutu LoRA）。"
        "完整加速还需在导演台成片栏勾选「8步音视频加速」（采样契约）。"
    )

    def apply(self, model, enable=True, lora_name="none", lora_strength=0.8):
        if not enable:
            return (model,)
        name = resolve_nfe8_lora_name(lora_name)
        patched, _on = maybe_load_nfe8_lora(model, name, float(lora_strength))
        return (patched,)
