"""MiniMax H3 Director — timeline UI + official MiniMax H3 AV execution.

Extended with embedded studio desk: Continuity board, camera/retake, local GGUF director.
"""

from __future__ import annotations

import json
import logging

import folder_paths
import comfy.samplers

from ..director.executor_core import execute_director_plan_core
from ..director.studio_enrich import apply_local_director_prompt, enrich_timeline_json
from .director_common import (
    finalize_director_outputs,
    prepare_director_plan,
    timeline_required_inputs,
    director_perf_inputs,
)

_CATEGORY = "MiniMaxH3"
_log = logging.getLogger("ComfyUI-MiniMaxH3-Director")

_DEFAULT_GLOBAL_PROMPT = "A cinematic scene with natural motion and synchronized ambience"


def _local_model_choices():
    try:
        from ..director.local_director_runtime import model_choices

        return model_choices()
    except Exception:
        return ["（未安装 LLM Text Processor / 无 GGUF）"]


def director_timeline_required_inputs() -> dict:
    """Timeline widgets — defaults aligned with official MiniMax H3 workflow templates."""
    inputs = timeline_required_inputs()
    combo_options, combo_meta = inputs["task_type"]

    gp_meta = dict(inputs["global_prompt"][1])
    gp_meta["default"] = _DEFAULT_GLOBAL_PROMPT
    gp_meta["tooltip"] = (
        "User prompt — sent directly to MiniMaxH3ImageToVideo / ReferenceToVideo. "
        "r2v: <Picture 1>. m2v: motion transfer (<Video 1> motion + <Picture 1> appearance). "
        "v2v: source-timeline edit (<Video 1>). "
        "rv2v: source timeline + reference images (<Video 1> + <Picture N>). "
        "也可由节点内「导演台」面板的本地导演扩写写入。"
    )

    frames_meta = dict(inputs["total_frames"][1])
    frames_meta["default"] = 124
    frames_meta["tooltip"] = (
        "Frame count at 24 fps; snapped to MiniMax 17k+5 grid (124 ≈ 5s)."
    )

    return {
        **inputs,
        "task_type": (combo_options, combo_meta),
        "global_prompt": ("STRING", gp_meta),
        "total_frames": ("INT", frames_meta),
    }


def director_studio_inputs() -> dict:
    """Optional local-director + image-director widgets."""
    models = _local_model_choices()
    try:
        from ..director.skill_presets import skill_option_labels

        skill_opts = skill_option_labels()
    except Exception:
        skill_opts = ["none — 通用（H3 规范）"]
    return {
        "bd_grp_studio": ("BDGROUP", {"default": "导演工台 Desk"}),
        "local_director_enable": (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": "开启后，用提示词导演把「创意简述」扩写成全局/各组提示词（本地 GGUF 或云端 API）。也可在导演台面板手动扩写。",
            },
        ),
        "local_director_brief": (
            "STRING",
            {
                "default": "",
                "multiline": True,
                "tooltip": "短创意简述。留空则跳过本地导演。",
            },
        ),
        "local_director_model": (
            models,
            {"tooltip": "models/LLM 下的 GGUF 对话模型。"},
        ),
        "local_director_mode": (
            ["T2VA", "I2VA", "FL2VA", "L2VA", "REF2VA"],
            {"default": "T2VA"},
        ),
        "local_director_skill": (
            skill_opts,
            {
                "default": skill_opts[0],
                "tooltip": "H3 风格 Skill 精简版；Queue 自动扩写时一并注入。",
            },
        ),
        "local_director_max_tokens": ("INT", {"default": 2048, "min": 256, "max": 8192}),
        "local_director_temperature": (
            "FLOAT",
            {"default": 0.6, "min": 0.0, "max": 2.0, "step": 0.05},
        ),
        "bd_grp_image_dir": ("BDGROUP", {"default": "参考图导演 Image Director"}),
        "image_director_enable": (
            "BOOLEAN",
            {
                "default": True,
                "tooltip": "开启后输出全局/分镜生图提示词；可配合下方 Checkpoint 生成全局参考图。",
            },
        ),
        "image_director_auto_inject": (
            "BOOLEAN",
            {
                "default": True,
                "tooltip": "把生成的参考图写入全局/各提示词组的「图片1」，并补上 <Picture 1> 标签。",
            },
        ),
        "ref_gen_enable": (
            "BOOLEAN",
            {
                "default": True,
                "tooltip": "Queue 时自动文生图：全局设定图 + 各提示词组分镜静帧，写入对应图片1（需连接 SD/SDXL Checkpoint）。",
            },
        ),
        "ref_gen_only": (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": "仅生成参考图并预览，跳过 H3 视频。导演台也可点「仅生参考图并预览」。确认图后关掉此项再 Queue 完整出片。",
            },
        ),
        "ref_gen_steps": ("INT", {"default": 20, "min": 1, "max": 100}),
        "ref_gen_cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.1}),
        "global_ref_image": (
            "IMAGE",
            {"tooltip": "可选：直接提供全局参考图（优先生图结果）。会注入为图片1。"},
        ),
        "ref_gen_model": (
            "MODEL",
            {
                "tooltip": (
                    "本地参考图/首尾帧生图用 MODEL。请接完整 SD1.5/SDXL Checkpoint"
                    "（CheckpointLoaderSimple），不要用 MiniMax H3 或仅 UNET 的 FLUX。"
                ),
            },
        ),
        "ref_gen_clip": (
            "CLIP",
            {
                "tooltip": (
                    "与 ref_gen_model 配套的 CLIP。若 Checkpoint 提示 no CLIP weights，"
                    "说明该文件不含文本编码器——请换 SDXL 完整模型，或改用云端生图。"
                ),
            },
        ),
        "ref_gen_vae": (
            "VAE",
            {"tooltip": "与 ref_gen_model 配套的 VAE（SD/SDXL）。"},
        ),
    }


class MiniMaxH3Director:
    """In-node timeline Director using ComfyUI official MiniMax H3 pipeline."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (
                    "MODEL",
                    {"tooltip": "MiniMax H3 UNET (UNETLoader)."},
                ),
                "video_vae": (
                    "VAE",
                    {"tooltip": "MiniMax H3 video VAE (minimax_h3_video_vae)."},
                ),
                "audio_vae": (
                    "VAE",
                    {"tooltip": "MiniMax H3 audio VAE (minimax_h3_audio_vae). Required for r2v / m2v / v2v / rv2v."},
                ),
                "clip": (
                    "CLIP",
                    {"tooltip": "CLIPLoader type=minimax (qwen3vl)."},
                ),
                **director_timeline_required_inputs(),
            },
            "optional": {
                "bd_grp_advanced": ("BDGROUP", {"default": "高级采样 Advanced"}),
                "steps": (
                    "INT",
                    {
                        "default": 25,
                        "min": 1,
                        "max": 200,
                        "tooltip": "Sampling steps — official template: 25.",
                    },
                ),
                "sampler": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "default": "res_multistep",
                        "tooltip": "Official template: KSamplerSelect res_multistep.",
                    },
                ),
                "scheduler": (
                    comfy.samplers.KSampler.SCHEDULERS,
                    {
                        "default": "simple",
                        "tooltip": "Official template: BasicScheduler simple.",
                    },
                ),
                "shift_video": (
                    "FLOAT",
                    {"default": 12.0, "min": 0.01, "max": 100.0, "step": 0.01, "tooltip": "MiniMaxH3SigmaShift shift_video."},
                ),
                "shift_audio": (
                    "FLOAT",
                    {"default": 3.0, "min": 0.01, "max": 100.0, "step": 0.01, "tooltip": "MiniMaxH3SigmaShift shift_audio."},
                ),
                "nfe8_accel_enable": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": (
                            "开启 8 步音视频加速（Tutu 20→8 NFE）：强制 Euler + 固定 ManualSigmas + "
                            "shift 12/3；下方选择匹配 LoRA（也可在成片栏勾选同名开关）。"
                            "最适合 FL2VA（t2v/i2v/fl2v）。"
                        ),
                    },
                ),
                "nfe8_lora_name": (
                    ["none"] + folder_paths.get_filename_list("loras"),
                    {
                        "default": "none",
                        "tooltip": (
                            "Tutu 20→8 NFE LoRA（models/loras/，如 comfyui/tutu-t8-*20to8*.safetensors）。"
                            "选 none 时开启加速会尽量自动匹配 *20to8* / tutu-t8*。"
                        ),
                    },
                ),
                "nfe8_lora_strength": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": -2.0,
                        "max": 2.0,
                        "step": 0.05,
                        "tooltip": "8 步加速 LoRA 强度（建议先试 0.8）。",
                    },
                ),
                **director_perf_inputs(),
                **director_studio_inputs(),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **_kwargs):
        if input_types is not None:
            expected = {
                "model": "MODEL",
                "video_vae": "VAE",
                "audio_vae": "VAE",
                "clip": "CLIP",
            }
            for name, want in expected.items():
                got = input_types.get(name)
                if got is not None and got != want:
                    return f"{name}: expected {want}, linked node returns {got}."
        return True

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "IMAGE", "STRING", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = (
        "images",
        "audio",
        "fps",
        "frame_count",
        "source_images",
        "report",
        "ref_image_prompt",
        "shot_image_prompts",
        "global_ref_out",
    )
    OUTPUT_IS_LIST = (True, True, False, False, True, False, False, False, False)
    FUNCTION = "execute"
    CATEGORY = _CATEGORY
    DESCRIPTION = (
        "H3 导演工台（完整版）：时间线采样 + 连续性设定 + 运镜/Retake + 本地 GGUF 导演 "
        "+ 参考图导演（全局参考图提示词/生成/注入）。"
        "支持 t2v / i2v / fl2v / r2v / novel（小说短剧）/ film（电影模式）/ m2v（动作迁移）/ v2v / rv2v。"
    )

    def execute(
        self,
        model,
        video_vae,
        audio_vae,
        clip,
        task_type,
        global_prompt,
        frame_rate,
        width,
        height,
        ref_max_size,
        total_frames,
        timeline_data,
        unique_id=None,
        steps=25,
        sampler="res_multistep",
        scheduler="simple",
        cfg=1.0,
        seed=0,
        shift_video=12.0,
        shift_audio=3.0,
        nfe8_accel_enable=False,
        nfe8_lora_name="none",
        nfe8_lora_strength=0.8,
        clear_vram_between_segments=True,
        export_source_images=False,
        local_director_enable=False,
        local_director_brief="",
        local_director_model="",
        local_director_mode="T2VA",
        local_director_skill="none — 通用（H3 规范）",
        local_director_max_tokens=2048,
        local_director_temperature=0.6,
        image_director_enable=True,
        image_director_auto_inject=True,
        ref_gen_enable=False,
        ref_gen_only=False,
        ref_gen_steps=20,
        ref_gen_cfg=7.0,
        global_ref_image=None,
        ref_gen_model=None,
        ref_gen_clip=None,
        ref_gen_vae=None,
        **kwargs,
    ):
        del kwargs

        # Harden against workflow widget misalignment (bool/str in numeric slots).
        try:
            ref_gen_steps = int(ref_gen_steps)
        except (TypeError, ValueError):
            ref_gen_steps = 20
        try:
            ref_gen_cfg = float(ref_gen_cfg)
        except (TypeError, ValueError):
            ref_gen_cfg = 7.0
        try:
            nfe8_lora_strength = float(nfe8_lora_strength)
        except (TypeError, ValueError):
            nfe8_lora_strength = 0.8
        if not isinstance(nfe8_lora_name, str) or len(str(nfe8_lora_name)) > 260:
            nfe8_lora_name = "none"
        nfe8_accel_enable = bool(nfe8_accel_enable)
        ref_gen_enable = bool(ref_gen_enable)
        ref_gen_only = bool(ref_gen_only)
        image_director_enable = bool(image_director_enable)
        image_director_auto_inject = bool(image_director_auto_inject)
        local_director_enable = bool(local_director_enable)

        if timeline_data and str(timeline_data).strip():
            try:
                tl = json.loads(timeline_data)
            except Exception:
                tl = {}
        else:
            tl = {}

        # m2v：动作迁移不走提示词导演 / 参考图导演（角色图在素材卡，动作在媒体轨）
        from ..lib.task_prompts import resolve_task_key

        _g = tl.get("global") if isinstance(tl.get("global"), dict) else {}
        _task_key = resolve_task_key(
            _g.get("taskType") or _g.get("task_type") or task_type or ""
        )
        if _task_key == "m2v":
            local_director_enable = False
            image_director_enable = False
            image_director_auto_inject = False
            ref_gen_enable = False
            ref_gen_only = False
            desk_m2v = tl.get("desk") if isinstance(tl.get("desk"), dict) else None
            if desk_m2v is not None:
                td_m2v = desk_m2v.get("text_director")
                if isinstance(td_m2v, dict):
                    td_m2v["enabled"] = False
                    td_m2v["expand_on_queue"] = False

        if ref_gen_only:
            # Stills-only run always generates + injects
            ref_gen_enable = True
            image_director_enable = True
            image_director_auto_inject = True

        from ..director.image_director import (
            empty_image_placeholder,
            ensure_image_director,
            run_auto_ref_generation,
        )

        ensure_image_director(tl)
        tl["image_director"]["enabled"] = bool(image_director_enable)
        tl["image_director"]["auto_inject"] = bool(image_director_auto_inject)
        tl["image_director"]["generate_on_queue"] = bool(ref_gen_enable)
        # Keep legacy flag aligned with groups_gen stills
        gg = tl["image_director"].get("groups_gen") or []
        tl["image_director"]["generate_shot_stills"] = any(
            isinstance(r, dict) and r.get("still") for r in gg
        )

        # Optional Queue-time prompt director expand → sync into each prompt group
        desk_pre = tl.get("desk") if isinstance(tl.get("desk"), dict) else {}
        td_pre = desk_pre.get("text_director") if isinstance(desk_pre.get("text_director"), dict) else {}
        queue_brief = str(local_director_brief or "").strip() or str(td_pre.get("brief") or "").strip()
        if local_director_enable and queue_brief:
            try:
                from ..director.local_director_runtime import (
                    director_mode_from_task_key,
                    expand_brief,
                    expand_prompt_groups,
                    normalize_director_backend,
                )

                segs = tl.get("segments") if isinstance(tl.get("segments"), list) else []
                edit_mode = str(tl.get("editMode") or tl.get("edit_mode") or "global")
                is_batch = (
                    str(tl.get("timelineMode") or "") in ("prompt_batch", "image_batch", "gen_blank", "fl2v")
                    or edit_mode == "segment"
                    or len(segs) > 1
                )

                cont = tl.get("continuity") or {}
                cont_parts = []
                if cont.get("characters"):
                    cont_parts.append(f"角色：{cont['characters']}")
                if cont.get("locations"):
                    cont_parts.append(f"场景：{cont['locations']}")
                if cont.get("props"):
                    cont_parts.append(f"道具：{cont['props']}")
                continuity = "；".join(cont_parts)
                out_block = tl.get("output") or {}
                task_key_guess = ""
                if isinstance(tl.get("global"), dict):
                    task_key_guess = str(tl["global"].get("taskType") or "")
                chain_continuity = bool(
                    out_block.get("continuityEnabled") is True
                    or out_block.get("continuity_enabled") is True
                    or "fl_chain" in task_key_guess
                )
                story = queue_brief

                task_raw = ""
                if isinstance(tl.get("global"), dict):
                    task_raw = str(tl["global"].get("taskType") or "")
                if not task_raw:
                    task_raw = str(task_type or "")
                # Always follow generation task (i2v→I2VA, fl2v→FL2VA, …), not stale T2VA widget
                mode = director_mode_from_task_key(task_raw)

                td = td_pre if isinstance(td_pre, dict) else {}
                backend = normalize_director_backend(td.get("backend"))
                if backend == "cloud":
                    model_name = str(td.get("llm_model") or local_director_model or "").strip()
                else:
                    model_name = str(local_director_model or "").strip()

                from ..director.skill_presets import skill_id_from_value

                skill_id = skill_id_from_value(
                    td.get("skill_id") or local_director_skill
                )
                force_style_refresh = bool(
                    td.get("style_refresh") or td.get("force_style_refresh")
                )
                desk_style_s = str(desk_pre.get("style") or "")
                gp_raw = str((tl.get("global") or {}).get("prompt") or "")
                if force_style_refresh or desk_style_s:
                    try:
                        from ..director.local_director_runtime import (
                            reconcile_prompt_with_desk_style,
                            strip_stale_medium_style,
                        )

                        if force_style_refresh and gp_raw:
                            gp_raw = strip_stale_medium_style(gp_raw) or gp_raw
                        if desk_style_s:
                            gp_raw = reconcile_prompt_with_desk_style(gp_raw, desk_style_s)
                        tl.setdefault("global", {})["prompt"] = gp_raw
                    except Exception:
                        pass

                common = dict(
                    model=model_name,
                    mode=mode,
                    ratio="16:9" if width >= height else "9:16",
                    max_tokens=int(local_director_max_tokens or 2048),
                    temperature=float(local_director_temperature or 0.6),
                    seed=int(seed or 1),
                    continuity=continuity,
                    backend=backend,
                    llm_url=str(td.get("llm_url") or ""),
                    api_format=str(td.get("llm_api_format") or "Ollama"),
                    api_key=str(td.get("llm_api_key") or ""),
                    global_prompt=gp_raw,
                    desk_style=desk_style_s,
                    desk_soundscape=str(desk_pre.get("soundscape") or ""),
                    desk_music=str(desk_pre.get("music") or ""),
                    skill_id=skill_id,
                    chain_continuity=chain_continuity,
                    force_style_refresh=force_style_refresh,
                )
                default_dur = max(1.0, float(total_frames or 124) / max(1.0, float(frame_rate or 24)))
                dur = default_dur

                if is_batch and segs:
                    groups = []
                    for i, seg in enumerate(segs):
                        if not isinstance(seg, dict):
                            continue
                        raw = str(seg.get("prompt") or "").strip()
                        looks_expanded = (
                            ("综合多模态描述" in raw)
                            or ("整体声景" in raw)
                            or ("主体定义" in raw)
                            or ("详细描述" in raw)
                        )
                        if looks_expanded and not force_style_refresh:
                            continue
                        brief = raw or story
                        if force_style_refresh and looks_expanded:
                            try:
                                from ..director.local_director_runtime import (
                                    strip_stale_medium_style,
                                )

                                brief = strip_stale_medium_style(raw) or raw or story
                            except Exception:
                                brief = raw or story
                        seg_dur = float(seg.get("durationSec") or 0) or default_dur
                        groups.append({
                            "index": i,
                            "brief": brief,
                            "prompt": raw,
                            "label": str(seg.get("label") or f"分镜{i + 1}"),
                            "duration": seg_dur,
                        })
                    if groups:
                        result = expand_prompt_groups(
                            groups=groups,
                            story_context=story,
                            default_duration=default_dur,
                            **common,
                        )
                        shots = result.get("shots") if isinstance(result, dict) else result
                        g_exp = (result.get("global_prompt") if isinstance(result, dict) else "") or ""
                        for shot in (shots or []):
                            idx = int(shot.get("index", 0))
                            if 0 <= idx < len(segs) and isinstance(segs[idx], dict):
                                segs[idx]["prompt"] = shot.get("prompt") or ""
                                if shot.get("label"):
                                    segs[idx]["label"] = shot["label"]
                        if g_exp.strip():
                            tl.setdefault("global", {})["prompt"] = g_exp.strip()
                        _log.info(
                            "Prompt director expanded %d/%d prompt groups (backend=%s mode=%s task=%s)",
                            len(shots or []),
                            len(segs),
                            backend,
                            mode,
                            task_raw or "?",
                        )
                    else:
                        g_exp = str((tl.get("global") or {}).get("prompt") or "")
                        if force_style_refresh and (story or g_exp):
                            try:
                                g_exp = expand_brief(
                                    brief=story or g_exp,
                                    duration=dur,
                                    expand_global=True,
                                    **common,
                                )
                                _log.info(
                                    "Local director: style refresh re-expanded global (%d chars)",
                                    len(g_exp or ""),
                                )
                            except Exception as exc:
                                _log.warning("style refresh global expand failed: %s", exc)
                        else:
                            _log.info("Local director: all prompt groups already expanded; keeping as-is")
                    tl["editMode"] = "segment"
                    # Keep existing timelineMode (prompt_batch / fl2v / …) — do not force t2v batch
                    if not tl.get("timelineMode"):
                        tl["timelineMode"] = "prompt_batch"
                    tl["segments"] = segs
                    if g_exp.strip():
                        tl.setdefault("global", {})["prompt"] = g_exp.strip()
                        global_prompt = g_exp.strip()
                    elif story and not str((tl.get("global") or {}).get("prompt") or "").strip():
                        tl.setdefault("global", {})["prompt"] = story
                        global_prompt = story
                    else:
                        global_prompt = str((tl.get("global") or {}).get("prompt") or "") or global_prompt
                    if isinstance(td_pre, dict) and force_style_refresh:
                        td_pre["style_refresh"] = False
                        desk_block = tl.setdefault("desk", {})
                        if isinstance(desk_block, dict):
                            tdx = desk_block.setdefault("text_director", {})
                            if isinstance(tdx, dict):
                                tdx["style_refresh"] = False
                else:
                    expanded = expand_brief(
                        brief=story,
                        duration=dur,
                        expand_global=True,
                        **common,
                    )
                    apply_local_director_prompt(tl, expanded, scope="all")
                    global_prompt = expanded
                    if isinstance(td_pre, dict) and force_style_refresh:
                        td_pre["style_refresh"] = False
                    _log.info("Local director expanded prompt (%d chars, mode=%s)", len(expanded), mode)
            except Exception as exc:
                _log.warning("Local director skipped: %s", exc)

        # --- Reference Image Director: auto-generate stills → 图片1 slots ---
        ref_image_prompt = ""
        shot_image_prompts = ""
        global_ref_out = empty_image_placeholder(64, 64)
        if image_director_enable or ref_gen_enable or global_ref_image is not None:
            from ..director.image_director import rebuild_still_prompts

            # After text director (if any), always rebuild still prompts from latest video text
            rebuild_still_prompts(tl, force=True)
            ref_image_prompt = str((tl.get("image_director") or {}).get("global_ref_prompt") or "")
            shot_image_prompts = str((tl.get("image_director") or {}).get("shot_image_prompts") or "")

            if ref_gen_enable or global_ref_image is not None:
                try:
                    # Desk timeline.image_director holds tunable still params;
                    # node widgets supply fallbacks for steps/cfg/size/seed.
                    gen_shots = bool((tl.get("image_director") or {}).get("generate_shot_stills", True))
                    tl, global_ref_out, saved_paths = run_auto_ref_generation(
                        tl,
                        global_ref_image=global_ref_image,
                        ref_gen_enable=bool(ref_gen_enable),
                        ref_gen_model=ref_gen_model,
                        ref_gen_clip=ref_gen_clip,
                        ref_gen_vae=ref_gen_vae,
                        ref_image_prompt=ref_image_prompt,
                        width=int(width or 1024),
                        height=int(height or 576),
                        seed=int(seed or 0),
                        steps=int(ref_gen_steps or 8),
                        cfg=float(ref_gen_cfg if ref_gen_cfg is not None else 2.0),
                        auto_inject=bool(image_director_auto_inject),
                        generate_shot_stills=gen_shots,
                        node_id=unique_id,
                        stills_only=bool(ref_gen_only),
                    )
                    _log.info(
                        "Image director injected %d ref file(s) into timeline slots",
                        len(saved_paths),
                    )
                    errs = (tl.get("image_director") or {}).get("last_gen_errors") or []
                    if errs:
                        _log.warning(
                            "Image director partial success: %d ok, %d failed — re-queue ② to fill missing",
                            len(saved_paths), len(errs),
                        )
                    # Keep node global_prompt in sync if tags were prefixed on timeline
                    g_prompt = str((tl.get("global") or {}).get("prompt") or "").strip()
                    if g_prompt:
                        global_prompt = g_prompt
                except Exception as exc:
                    _log.exception("Image director generation failed: %s", exc)
                    hint = ""
                    if "timed out" in str(exc).lower() or "timeout" in str(exc).lower():
                        hint = (
                            "（云端 GLM-Image 较慢/网络不稳。已成功的图会保留；"
                            "可再点「② 仅生参考图」重试剩余槽位。）"
                        )
                    raise RuntimeError(f"参考图导演生图失败：{exc}{hint}") from exc

        # --- Stills-only: skip H3 video, return previews ---
        if ref_gen_only:
            import torch

            timeline_data = json.dumps(tl, ensure_ascii=False)
            # Persist timeline into report; UI already got refs via websocket
            n_files = 0
            try:
                n_files = len([
                    r for r in ((tl.get("global") or {}).get("refs") or [])
                    if isinstance(r, dict) and r.get("imageFile")
                ])
                for seg in tl.get("segments") or []:
                    if not isinstance(seg, dict):
                        continue
                    n_files += sum(
                        1 for r in (seg.get("refs") or [])
                        if isinstance(r, dict) and r.get("imageFile")
                    )
            except Exception:
                pass
            report = (
                "[首尾帧/参考图导演·仅生图] 已跳过 H3 视频采样。\n"
                f"结果已写入时间线并输出到 global_ref_out。\n"
                f"提示词汇总 {len(shot_image_prompts or '')} 字。\n"
                "确认预览后：关闭「仅生成参考图」，并可关闭「Queue 时生成」，再 Queue 完整出片。"
            )
            empty_img = empty_image_placeholder(64, 64)
            empty_audio = {
                "waveform": torch.zeros((1, 1, 1), dtype=torch.float32),
                "sample_rate": 44100,
            }
            _log.info("ref_gen_only: returning stills preview, skip video")
            return (
                [empty_img],
                [empty_audio],
                float(frame_rate or 24),
                0,
                [],
                report,
                ref_image_prompt,
                shot_image_prompts,
                global_ref_out,
            )

        timeline_data = json.dumps(tl, ensure_ascii=False)

        # Always enrich Continuity / camera / desk (also done inside prepare)
        try:
            timeline_data = enrich_timeline_json(timeline_data)
        except Exception:
            pass

        plan = prepare_director_plan(
            timeline_data=timeline_data,
            task_type=task_type,
            global_prompt=global_prompt,
            total_frames=total_frames,
            frame_rate=frame_rate,
            width=width,
            height=height,
            ref_max_size=ref_max_size,
            unique_id=unique_id,
        )

        manual_sigmas = None
        if nfe8_accel_enable:
            from ..director.nfe8_accel import (
                apply_nfe8_sampling_overrides,
                maybe_load_nfe8_lora,
                resolve_nfe8_lora_name,
            )

            steps, sampler, scheduler, shift_video, shift_audio, manual_sigmas = (
                apply_nfe8_sampling_overrides(
                    steps=steps,
                    sampler=sampler,
                    scheduler=scheduler,
                    shift_video=shift_video,
                    shift_audio=shift_audio,
                )
            )
            nfe8_lora_name = resolve_nfe8_lora_name(nfe8_lora_name)
            model, lora_on = maybe_load_nfe8_lora(model, nfe8_lora_name, nfe8_lora_strength)
            _log.info(
                "NFE8 accel ON: steps=%s sampler=%s shift_v/a=%s/%s lora=%s",
                steps,
                sampler,
                shift_video,
                shift_audio,
                (nfe8_lora_name if lora_on else "none"),
            )

        combined, segment_outputs, segment_audios, report = execute_director_plan_core(
            plan,
            node_id=unique_id,
            model=model,
            vae=video_vae,
            audio_vae=audio_vae,
            clip=clip,
            cfg=cfg,
            seed=seed,
            steps=steps,
            sampler=sampler,
            scheduler=scheduler,
            shift_video=shift_video,
            shift_audio=shift_audio,
            clear_vram_between_segments=clear_vram_between_segments,
            manual_sigmas=manual_sigmas,
        )
        if nfe8_accel_enable:
            report = (
                (report or "")
                + "\n\n[8步音视频加速] Euler + ManualSigmas (Tutu 20→8 NFE)；"
                + f"steps={steps}, shift_video={shift_video}, shift_audio={shift_audio}, "
                + f"lora={nfe8_lora_name if str(nfe8_lora_name or '').strip() not in {'', 'none'} else 'none'}."
            )

        images_out, audio_out, fps_out, frame_count, source_images_out, report = finalize_director_outputs(
            plan,
            combined,
            segment_outputs,
            report,
            export_source_images=export_source_images,
            segment_audios=segment_audios,
        )
        if ref_image_prompt:
            report = report + f"\n\n[参考图导演] 全局参考图提示词：{len(ref_image_prompt)} 字"
        if shot_image_prompts:
            report = report + f"\n[参考图导演] 分镜生图提示词组数：{shot_image_prompts.count('【生图-')}"

        try:
            novel_block = tl.get("novel") if isinstance(tl, dict) else None
            if isinstance(novel_block, dict) and novel_block.get("projectId") and _task_key in {"novel", "film"}:
                from ..director.novel_runtime import mark_chapter_done_from_timeline

                done = mark_chapter_done_from_timeline(tl, output_path="")
                if done and isinstance(done.get("chapter"), dict):
                    report = (
                        (report or "")
                        + f"\n\n[小说章节] 已标记完成：{done['chapter'].get('title')}"
                        + f"（project={novel_block.get('projectId')}）"
                    )
        except Exception as _novel_exc:
            report = (report or "") + f"\n\n[小说章节] 进度回写失败：{_novel_exc}"

        return (
            images_out,
            audio_out,
            fps_out,
            frame_count,
            source_images_out,
            report,
            ref_image_prompt,
            shot_image_prompts,
            global_ref_out,
        )
