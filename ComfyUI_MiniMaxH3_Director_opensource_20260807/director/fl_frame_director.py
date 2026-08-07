# -*- coding: utf-8 -*-
"""First/Last Frame Director — generate start/end keyframes for fl2v from prompts + refs."""

from __future__ import annotations

import logging
from typing import Any

import torch

from .image_director import (
    _clip_body,
    _join_still_parts,
    _style_tail,
    _visual_body_from_prompt,
    ensure_image_director,
    generate_still,
    pick_guide_init_image,
    resolve_gen_backend,
    resolve_still_gen_params,
    save_image_tensor_to_input,
)
from .studio_enrich import continuity_prefix

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.fl_frame_director")


def is_fl2v_timeline(timeline: dict) -> bool:
    mode = str(timeline.get("timelineMode") or "").lower()
    if mode == "fl2v":
        return True
    g = timeline.get("global") or {}
    task = str(g.get("taskType") or g.get("task_type") or "").lower()
    return "fl2v" in task or task.startswith("fl2v")


def default_fl_gen() -> dict:
    return {
        "gen_start": True,
        "gen_end": True,
        "start_prompt": "",
        "end_prompt": "",
        "start_refs": [],
        "end_refs": [],
    }


def ensure_fl_director(timeline: dict) -> dict:
    """Normalize fl_global_refs on image_director + fl_gen on each shot."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    if not isinstance(idir.get("fl_global_refs"), list):
        idir["fl_global_refs"] = []
    shots = timeline.get("shots")
    if not isinstance(shots, list):
        return timeline
    for shot in shots:
        if not isinstance(shot, dict):
            continue
        fg = shot.get("fl_gen")
        if not isinstance(fg, dict):
            shot["fl_gen"] = default_fl_gen()
        else:
            base = default_fl_gen()
            for k, v in base.items():
                if k not in fg:
                    fg[k] = v if not isinstance(v, list) else []
            if not isinstance(fg.get("start_refs"), list):
                fg["start_refs"] = []
            if not isinstance(fg.get("end_refs"), list):
                fg["end_refs"] = []
            shot["fl_gen"] = fg
    return timeline


def sync_fl_shot_prompts_from_segments(timeline: dict) -> int:
    """Copy segment prompts → shots so FL builders see text-director output."""
    shots = timeline.get("shots") or []
    segs = timeline.get("segments") or []
    if not isinstance(shots, list) or not isinstance(segs, list):
        return 0
    n = 0
    for i, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        if i >= len(segs) or not isinstance(segs[i], dict):
            continue
        sp = str(segs[i].get("prompt") or "").strip()
        if not sp:
            continue
        shot["prompt"] = sp
        if segs[i].get("label") and not str(shot.get("label") or "").strip():
            shot["label"] = segs[i]["label"]
        n += 1
    return n


def _shot_motion_body(shot: dict) -> str:
    return _visual_body_from_prompt(str(shot.get("prompt") or ""))


def _looks_legacy_still_prompt(text: str) -> bool:
    """Old templates used meta labels that SD often paints as literal text."""
    t = text or ""
    markers = (
        "本镜画面起点",
        "本镜画面落点",
        "参考静帧",
        "参考图导演已提供",
        "故事语境：",
        "画面：",
        "构图：",
        "【",
        "视频首帧静帧",
        "视频尾帧静帧",
    )
    return any(m in t for m in markers)


def build_fl_start_prompt(timeline: dict, shot: dict, shot_index: int = 0, *, force: bool = False) -> str:
    ensure_fl_director(timeline)
    idir = timeline["image_director"]
    desk = timeline.get("desk") or {}
    fg = shot.get("fl_gen") or {}
    stored = str(fg.get("start_prompt") or "").strip()
    from_director = str(fg.get("source") or "") == "prompt_director"
    # Keep LLM / good stored prompts unless force rebuild (① template path)
    if stored and not force and (from_director or not _looks_legacy_still_prompt(stored)):
        return stored
    cont = continuity_prefix(timeline)
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    body = _shot_motion_body(shot)
    return _join_still_parts(
        "视频开场关键静帧，主体外貌服装稳定完整",
        cont,
        _clip_body(body, 420) if body else "",
        "定格在运动开始前或刚开始的瞬间，构图清晰",
        "无文字、无水印、无字幕",
        _style_tail(style=style, unified=unified, suffix=suffix),
    )


def build_fl_end_prompt(timeline: dict, shot: dict, shot_index: int = 0, *, force: bool = False) -> str:
    ensure_fl_director(timeline)
    idir = timeline["image_director"]
    desk = timeline.get("desk") or {}
    fg = shot.get("fl_gen") or {}
    stored = str(fg.get("end_prompt") or "").strip()
    from_director = str(fg.get("source") or "") == "prompt_director"
    if stored and not force and (from_director or not _looks_legacy_still_prompt(stored)):
        return stored
    cont = continuity_prefix(timeline)
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    body = _shot_motion_body(shot)
    return _join_still_parts(
        "视频收束关键静帧，与开场同一角色与场景设定",
        cont,
        _clip_body(body, 420) if body else "",
        "定格在运动完成后的落点姿态与构图",
        "无文字、无水印、无字幕",
        _style_tail(style=style, unified=unified, suffix=suffix),
    )


def fill_fl_prompts(timeline: dict, *, force: bool = False) -> dict:
    """Write start/end prompts onto each shot.fl_gen and pack into image_director text fields."""
    ensure_fl_director(timeline)
    shots = timeline.get("shots") or []
    blocks: list[str] = []
    for i, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        fg = shot.setdefault("fl_gen", default_fl_gen())
        sp = build_fl_start_prompt(timeline, shot, i, force=force)
        ep = build_fl_end_prompt(timeline, shot, i, force=force)
        fg["start_prompt"] = sp
        fg["end_prompt"] = ep
        if force and str(fg.get("source") or "") == "prompt_director":
            # Template rebuild via ① — drop LLM marker so later edits behave normally
            fg.pop("source", None)
        blocks.append(sp)
        blocks.append(ep)
    idir = timeline["image_director"]
    idir["shot_image_prompts"] = "\n\n".join(blocks)
    if force or not str(idir.get("global_ref_prompt") or "").strip():
        idir["global_ref_prompt"] = (
            "按各组首帧/尾帧提示词与参考图生成关键帧，并注入到对应组。"
        )
    return timeline


def _load_init_from_refs(refs: list) -> Any:
    from .plan import load_reference_tensor

    for it in refs or []:
        if not isinstance(it, dict):
            continue
        path = str(it.get("imageFile") or "").strip()
        if not path:
            continue
        try:
            return load_reference_tensor(
                {"imageFile": path, "imageB64": it.get("imageB64") or ""}
            )
        except Exception as exc:
            log.warning("fl init ref load failed %s: %s", path, exc)
    return None


def pick_fl_init_image(timeline: dict, shot: dict, *, kind: str = "start"):
    """Prefer per-frame refs → global fl refs → director guide_refs."""
    ensure_fl_director(timeline)
    fg = shot.get("fl_gen") or {}
    local = fg.get("start_refs") if kind == "start" else fg.get("end_refs")
    img = _load_init_from_refs(local if isinstance(local, list) else [])
    if img is not None:
        return img
    idir = timeline["image_director"]
    img = _load_init_from_refs(idir.get("fl_global_refs") or [])
    if img is not None:
        return img
    return pick_guide_init_image(timeline, prefer_role="character")


def _set_shot_image(shot: dict, *, kind: str, rel_path: str) -> None:
    entry = {"imageFile": rel_path, "width": 0, "height": 0}
    if kind == "start":
        shot["startImage"] = entry
        shot["genImage"] = {"imageFile": rel_path, "imageB64": ""}
        shot["imageFile"] = rel_path
    else:
        shot["endImage"] = entry


def sync_fl_shots_to_segments(timeline: dict) -> None:
    """Mirror shots start/end into segments for canvas compatibility."""
    shots = timeline.get("shots") or []
    segs = timeline.get("segments") or []
    for i, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        start = shot.get("startImage") or {}
        end = shot.get("endImage") or {}
        start_path = str(start.get("imageFile") or "").strip()
        end_path = str(end.get("imageFile") or "").strip()
        if i < len(segs) and isinstance(segs[i], dict):
            seg = segs[i]
            if start_path:
                seg["genImage"] = {"imageFile": start_path, "imageB64": ""}
                seg["imageFile"] = start_path
                seg["isStartFrame"] = True
            if end_path:
                seg["endImage"] = {"imageFile": end_path, "width": 0, "height": 0}
                seg["isEndFrame"] = True


def run_fl_frame_generation(
    timeline: dict,
    *,
    ref_gen_enable: bool = False,
    ref_gen_model=None,
    ref_gen_clip=None,
    ref_gen_vae=None,
    width: int = 1024,
    height: int = 576,
    seed: int = 0,
    steps: int = 8,
    cfg: float = 2.0,
    auto_inject: bool = True,
    node_id: Any = None,
    stills_only: bool = False,
) -> tuple[dict, torch.Tensor, list[str]]:
    """Generate selected start/end frames for fl2v shots."""
    from .image_director import (
        _stack_preview_images,
        empty_image_placeholder,
        push_refs_to_ui,
    )

    ensure_fl_director(timeline)
    fill_fl_prompts(timeline)
    saved: list[str] = []
    previews: list[torch.Tensor] = []

    can_local = (
        ref_gen_model is not None
        and ref_gen_clip is not None
        and ref_gen_vae is not None
    )
    backend = resolve_gen_backend(timeline)
    if backend == "cloud":
        from .image_gen_api import merge_gen_api_fields, resolve_api_key

        idir_cfg = merge_gen_api_fields(timeline["image_director"])
        has_key = bool(resolve_api_key(
            str(idir_cfg.get("gen_api_format") or ""),
            str(idir_cfg.get("gen_api_key") or ""),
        ))
        can_gen = bool(ref_gen_enable) and bool(idir_cfg.get("gen_api_model")) and has_key
    else:
        can_gen = bool(ref_gen_enable) and can_local
    if ref_gen_enable and not can_gen:
        if backend == "cloud":
            raise ValueError(
                "已开启首尾帧导演生图（云端 API），请填写生图模型与 API Key。"
            )
        raise ValueError(
            "已开启首尾帧导演生图，但未连接文生图 Checkpoint 的 "
            "ref_gen_model / ref_gen_clip / ref_gen_vae。"
            "或将生图后端改为「云端 API」。"
        )

    gp = resolve_still_gen_params(
        timeline,
        fallback_width=int(width or 1024),
        fallback_height=int(height or 576),
        fallback_seed=int(seed or 0),
        fallback_steps=int(steps or 8),
        fallback_cfg=float(cfg if cfg is not None else 2.0),
    )

    shots = timeline.get("shots") or []
    job_i = 0
    for si, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        fg = shot.get("fl_gen") or default_fl_gen()
        for kind, want, prompt_key, prefix in (
            ("start", bool(fg.get("gen_start", True)), "start_prompt", f"mmh3_fl{si+1}_start"),
            ("end", bool(fg.get("gen_end", True)), "end_prompt", f"mmh3_fl{si+1}_end"),
        ):
            if not want or not can_gen:
                continue
            job_i += 1
            prompt = str(fg.get(prompt_key) or "").strip()
            if not prompt:
                prompt = (
                    build_fl_start_prompt(timeline, shot, si)
                    if kind == "start"
                    else build_fl_end_prompt(timeline, shot, si)
                )
            try:
                init = None
                if backend != "cloud":
                    init = pick_fl_init_image(timeline, shot, kind=kind)
                    # If generating end and start already exists, bias toward start for consistency
                    if kind == "end" and init is None:
                        start_path = str((shot.get("startImage") or {}).get("imageFile") or "").strip()
                        if start_path:
                            init = _load_init_from_refs([{"imageFile": start_path}])
                img = generate_still(
                    timeline,
                    prompt=prompt,
                    ref_gen_model=ref_gen_model,
                    ref_gen_clip=ref_gen_clip,
                    ref_gen_vae=ref_gen_vae,
                    width=gp["width"],
                    height=gp["height"],
                    seed=int(gp["seed"]) + 19 * job_i + (7 if kind == "end" else 0),
                    steps=gp["steps"],
                    cfg=gp["cfg"],
                    sampler_name=gp["sampler"],
                    scheduler=gp["scheduler"],
                    denoise=gp["denoise"],
                    negative=gp["negative"],
                    init_image=init,
                )
                previews.append(img)
                rel = save_image_tensor_to_input(img, prefix=prefix)
                saved.append(rel)
                if auto_inject:
                    _set_shot_image(shot, kind=kind, rel_path=rel)
                    log.info("fl2v %s frame shot %s -> %s", kind, si + 1, rel)
            except Exception as exc:
                log.warning("fl2v %s frame shot %s failed: %s", kind, si + 1, exc)
                if stills_only:
                    raise

    if auto_inject and saved:
        sync_fl_shots_to_segments(timeline)
        from .image_director import ensure_picture_tags_on_timeline

        ensure_picture_tags_on_timeline(timeline, slot=0)
        if stills_only:
            timeline["image_director"]["stills_only_done"] = True
            timeline["image_director"]["generate_on_queue"] = False
        push_refs_to_ui(node_id, timeline, preview_files=saved)

    out = _stack_preview_images(previews) if previews else empty_image_placeholder(64, 64)
    return timeline, out, saved
