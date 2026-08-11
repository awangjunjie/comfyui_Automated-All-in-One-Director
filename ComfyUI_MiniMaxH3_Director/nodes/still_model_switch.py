# -*- coding: utf-8 -*-
"""One-click still-gen MODEL/CLIP/VAE switch with lazy evaluation.

Only the selected branch (A/B/C) is loaded — unused loaders stay cold.
Also provides a filtered SDXL checkpoint loader that hides video weights.
"""

from __future__ import annotations

import re

import folder_paths

SOURCE_A = "A · SDXL"
SOURCE_B = "B · Z-Image-Turbo"
SOURCE_C = "C · 自定义"

SOURCE_OPTIONS = [SOURCE_A, SOURCE_B, SOURCE_C]

_SOURCE_META = {
    SOURCE_A: ("a", "sdxl"),
    SOURCE_B: ("b", "z_image_turbo"),
    SOURCE_C: ("c", "auto"),
}

_VIDEO_CKPT_RE = re.compile(
    r"(ltx|minimax|hunyuan.?video|wan2|wan22|mochi|cosmos|svd|i2v|t2v|fl2v|ref2v|gguf)",
    re.I,
)

_PREFERRED_CKPTS = (
    "DreamShaperXL_Turbo_v2_1.safetensors",
    "DreamShaperXL_Turbo_v2.safetensors",
    "sd_xl_base_1.0.safetensors",
    "RealVisXL_V5.0_fp16.safetensors",
    "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
)


def list_still_checkpoints() -> list[str]:
    """Checkpoint filenames suitable for T2I still gen (filter out video DiTs)."""
    names = list(folder_paths.get_filename_list("checkpoints") or [])
    still = [n for n in names if n and not _VIDEO_CKPT_RE.search(str(n))]
    return still if still else names


def default_still_checkpoint(names: list[str] | None = None) -> str:
    names = names if names is not None else list_still_checkpoints()
    if not names:
        return ""
    for pref in _PREFERRED_CKPTS:
        if pref in names:
            return pref
    for n in names:
        if re.search(r"(sdxl|dream|realvis|jugger|turbo)", n, re.I):
            return n
    return names[0]


def autoload_sdxl_still_bundle() -> tuple[object, object, object, str]:
    """Load a known-good SDXL checkpoint for still gen when wires are wrong.

    Returns (model, clip, vae, ckpt_name). Raises ValueError if none available.
    """
    import comfy.sd

    names = list_still_checkpoints()
    name = default_still_checkpoint(names)
    if not name:
        raise ValueError(
            "未找到可用的 SDXL Checkpoint。请把 DreamShaperXL_Turbo_v2_1.safetensors "
            "放到 models/checkpoints/。"
        )
    if _VIDEO_CKPT_RE.search(name):
        raise ValueError(f"自动选中的「{name}」仍是视频权重，无法文生图。")
    ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", name)
    out = comfy.sd.load_checkpoint_guess_config(
        ckpt_path,
        output_vae=True,
        output_clip=True,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    model, clip, vae = out[:3]
    if model is None or clip is None or vae is None:
        raise ValueError(
            f"自动加载「{name}」失败（缺 MODEL/CLIP/VAE）。请确认是完整 SDXL 包。"
        )
    return model, clip, vae, name


class MiniMaxH3StillCheckpointLoader:
    """Checkpoint loader for Director still gen — dropdown excludes LTX/Wan/H3 video files."""

    @classmethod
    def INPUT_TYPES(cls):
        names = list_still_checkpoints()
        default = default_still_checkpoint(names)
        return {
            "required": {
                "ckpt_name": (
                    names,
                    {
                        "default": default,
                        "tooltip": (
                            "仅列出适合文生图的 Checkpoint（已隐藏 ltx / wan / hunyuan 等视频文件）。"
                            "推荐 DreamShaperXL_Turbo_v2_1.safetensors。"
                        ),
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    FUNCTION = "load_checkpoint"
    CATEGORY = "MiniMaxH3/Director"
    DESCRIPTION = (
        "文生图专用 Checkpoint 加载器：下拉已过滤视频模型，避免误选 ltx 导致无 CLIP。"
        "接到「文生图模型切换」的 A 口。"
    )

    def load_checkpoint(self, ckpt_name):
        name = str(ckpt_name or "").strip()
        if not name:
            raise ValueError("请选择文生图 Checkpoint（推荐 DreamShaperXL_Turbo_v2_1.safetensors）")
        if _VIDEO_CKPT_RE.search(name):
            raise ValueError(
                f"「{name}」是视频权重，不能用于参考图文生图。"
                "请改选 DreamShaperXL_Turbo_v2_1.safetensors 等 SDXL 完整包。"
            )
        import comfy.sd

        ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", name)
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        model, clip, vae = out[:3]
        if clip is None:
            raise ValueError(
                f"Checkpoint「{name}」不含 CLIP/文本编码器，无法文生图。"
                "请换完整 SDXL 包（如 DreamShaperXL_Turbo_v2_1.safetensors）。"
            )
        return (model, clip, vae)


class MiniMaxH3StillModelSwitch:
    """Pick one of three still-model triples for Director ref_gen_* inputs."""

    @classmethod
    def INPUT_TYPES(cls):
        lazy = {"lazy": True}
        return {
            "required": {
                "source": (
                    SOURCE_OPTIONS,
                    {
                        "default": SOURCE_A,
                        "tooltip": (
                            "一键切换文生图模型。"
                            "A=SDXL Checkpoint；B=Z-Image-Turbo；C=自行接线（FLUX 等）。"
                            "仅加载当前所选支路，其它不占显存。"
                        ),
                    },
                ),
            },
            "optional": {
                "a_model": ("MODEL", lazy),
                "a_clip": ("CLIP", lazy),
                "a_vae": ("VAE", lazy),
                "b_model": ("MODEL", lazy),
                "b_clip": ("CLIP", lazy),
                "b_vae": ("VAE", lazy),
                "c_model": ("MODEL", lazy),
                "c_clip": ("CLIP", lazy),
                "c_vae": ("VAE", lazy),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "STRING")
    RETURN_NAMES = ("model", "clip", "vae", "profile")
    FUNCTION = "switch"
    CATEGORY = "MiniMaxH3/Director"
    DESCRIPTION = (
        "文生图模型一键切换：把 A/B/C 三组 MODEL+CLIP+VAE 接到本节点，"
        "下拉选源即可；输出接到导演台 ref_gen_*。未选支路懒加载不执行。"
    )

    def check_lazy_status(
        self,
        source,
        a_model=None,
        a_clip=None,
        a_vae=None,
        b_model=None,
        b_clip=None,
        b_vae=None,
        c_model=None,
        c_clip=None,
        c_vae=None,
    ):
        prefix, _ = _SOURCE_META.get(source, ("a", "sdxl"))
        bag = {
            "a_model": a_model,
            "a_clip": a_clip,
            "a_vae": a_vae,
            "b_model": b_model,
            "b_clip": b_clip,
            "b_vae": b_vae,
            "c_model": c_model,
            "c_clip": c_clip,
            "c_vae": c_vae,
        }
        need = []
        for suffix in ("model", "clip", "vae"):
            key = f"{prefix}_{suffix}"
            if bag.get(key) is None:
                need.append(key)
        return need

    def switch(
        self,
        source,
        a_model=None,
        a_clip=None,
        a_vae=None,
        b_model=None,
        b_clip=None,
        b_vae=None,
        c_model=None,
        c_clip=None,
        c_vae=None,
    ):
        prefix, profile = _SOURCE_META.get(source, ("a", "sdxl"))
        bag = {
            "a": (a_model, a_clip, a_vae),
            "b": (b_model, b_clip, b_vae),
            "c": (c_model, c_clip, c_vae),
        }
        model, clip, vae = bag[prefix]
        label = source
        missing = []
        if model is None:
            missing.append("MODEL")
        if clip is None:
            missing.append("CLIP")
        if vae is None:
            missing.append("VAE")
        if missing:
            raise ValueError(
                f"文生图切换「{label}」缺少：{', '.join(missing)}。"
                "请把对应加载器接到本节点的 "
                f"{prefix}_model / {prefix}_clip / {prefix}_vae。"
                "A=用「文生图 Checkpoint（仅SDXL）」选 DreamShaper；"
                "B=Z-Image UNET+CLIP+VAE；C=自定义（如 FLUX）。"
            )
        try:
            from ..director.image_director import is_video_model_for_still, _model_image_model_key

            if is_video_model_for_still(model):
                im = _model_image_model_key(model)
                raise ValueError(
                    f"「{label}」接到了视频模型（image_model={im or '?'}），不能出参考图。"
                    "请把 A 口换成「文生图 Checkpoint（仅SDXL）」并选 DreamShaperXL，"
                    "或改选 B·Z-Image-Turbo / 自行接 C。"
                )
        except ImportError:
            pass
        return (model, clip, vae, profile)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3StillModelSwitch": MiniMaxH3StillModelSwitch,
    "MiniMaxH3StillCheckpointLoader": MiniMaxH3StillCheckpointLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3StillModelSwitch": "文生图模型切换（一键）",
    "MiniMaxH3StillCheckpointLoader": "文生图 Checkpoint（仅SDXL）",
}
