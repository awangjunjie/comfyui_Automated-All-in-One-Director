# -*- coding: utf-8 -*-
"""Studio planning features embedded into official MiniMaxH3Director.

Adds Continuity board, camera/transition/retake metadata, style/soundscape/music,
and applies them to prompts before sampling. All fields live inside timeline_data.
"""

from __future__ import annotations

import copy
import json
import logging
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.studio")

CAMERA_PRESETS = [
    "固定机位",
    "小幅度缓慢推近",
    "缓慢拉远",
    "左摇",
    "右摇",
    "跟随",
    "过肩",
    "特写",
    "剧烈抖动",
    "航拍俯冲",
]

TRANSITIONS = ["cut", "dissolve", "flash", "whip", "none"]


def default_continuity() -> dict:
    return {
        "characters": "",
        "locations": "",
        "props": "",
        "inject": True,
    }


def default_desk() -> dict:
    return {
        "style": "写实，电影感，景深层次清晰，光影克制",
        "soundscape": "",
        "music": "",
        "image_director_note": "",
        "text_director": {
            "enabled": False,
            "scope": "none",  # none | segment | all
            "backend": "local",  # local | cloud
            "brief": "",
            "llm_api_format": "Ollama",
            "llm_url": "http://127.0.0.1:11434",
            "llm_model": "qwen3.5",
            "llm_api_key": "",
        },
    }


def default_image_director_block() -> dict:
    return {
        "enabled": False,
        "unified_ref_note": "统一角色外貌、服装、年龄与画风，全身或半身清晰可见，干净背景",
        "style_suffix": "电影静帧，高细节，写实光影，16:9 构图，无文字水印",
        "global_ref_prompt": "",
        "shot_image_prompts": "",
        "auto_inject": True,
        "generate_on_queue": False,
        "generate_shot_stills": True,
        "use_video_size": False,
        "width": 1024,
        "height": 576,
        "steps": 8,
        "cfg": 2.0,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "denoise": 1.0,
        "seed": -1,
        "negative": (
            "blurry, lowres, low quality, worst quality, jpeg artifacts, watermark, text, logo, "
            "deformed, bad anatomy, extra limbs, mutated hands, poorly drawn face, duplicate"
        ),
        "guide_refs": [],
        "fl_global_refs": [],
        "global_gen": {
            "character": False,
            "scene": False,
            "prop": False,
            "still": True,
        },
        "groups_gen": [],
        "gen_targets": {
            "global": True,
            "character": False,
            "scene": False,
            "prop": False,
            "shot_stills": True,
        },
        "gen_scope": "all",
        "gen_group_indices": [],
        "gen_backend": "local",
        "gen_api_format": "智谱 GLM",
        "gen_api_url": "https://open.bigmodel.cn/api/paas/v4",
        "gen_api_key": "",
        "gen_api_model": "cogview-3-flash",
    }


def ensure_studio_fields(timeline: dict) -> dict:
    """Normalize studio fields on a timeline dict (in-place + return)."""
    if not isinstance(timeline, dict):
        return timeline

    cont = timeline.get("continuity")
    if not isinstance(cont, dict):
        cont = default_continuity()
    else:
        base = default_continuity()
        base.update({k: cont.get(k, base[k]) for k in base})
        cont = base
    cont["inject"] = bool(cont.get("inject", True))
    timeline["continuity"] = cont

    desk = timeline.get("desk")
    if not isinstance(desk, dict):
        desk = default_desk()
    else:
        base = default_desk()
        for k, v in base.items():
            if k not in desk:
                desk[k] = copy.deepcopy(v)
        td = desk.get("text_director")
        base_td = copy.deepcopy(base["text_director"])
        if not isinstance(td, dict):
            desk["text_director"] = base_td
        else:
            scope = str(td.get("scope") or "none")
            if scope not in ("none", "segment", "all"):
                scope = "none"
            backend = str(td.get("backend") or "local").strip().lower()
            if backend not in ("local", "cloud"):
                backend = "local"
            merged = dict(base_td)
            merged.update({k: td.get(k, merged.get(k)) for k in merged})
            merged["enabled"] = bool(td.get("enabled", False))
            merged["scope"] = scope
            merged["backend"] = backend
            merged["brief"] = str(td.get("brief") or "")
            merged["llm_api_format"] = str(td.get("llm_api_format") or base_td["llm_api_format"])
            merged["llm_url"] = str(td.get("llm_url") or base_td["llm_url"])
            merged["llm_model"] = str(td.get("llm_model") or base_td["llm_model"])
            merged["llm_api_key"] = str(td.get("llm_api_key") or "")
            desk["text_director"] = merged
    timeline["desk"] = desk

    idir = timeline.get("image_director")
    if not isinstance(idir, dict):
        idir = default_image_director_block()
    else:
        base = default_image_director_block()
        for k, v in base.items():
            if k not in idir:
                idir[k] = copy.deepcopy(v)
    idir["enabled"] = bool(idir.get("enabled", False))
    idir["auto_inject"] = bool(idir.get("auto_inject", True))
    idir["generate_on_queue"] = bool(idir.get("generate_on_queue", False))
    if not isinstance(idir.get("guide_refs"), list):
        idir["guide_refs"] = []
    if not isinstance(idir.get("global_gen"), dict):
        idir["global_gen"] = copy.deepcopy(
            default_image_director_block().get("global_gen")
            or {"character": False, "scene": False, "prop": False, "still": True}
        )
    if not isinstance(idir.get("groups_gen"), list):
        idir["groups_gen"] = []
    # Soft sync legacy flags
    gg = idir["global_gen"]
    any_group_still = any(
        isinstance(r, dict) and r.get("still") for r in idir["groups_gen"]
    )
    idir["generate_shot_stills"] = bool(any_group_still)
    if not isinstance(idir.get("gen_targets"), dict):
        idir["gen_targets"] = {}
    idir["gen_targets"]["character"] = bool(gg.get("character"))
    idir["gen_targets"]["scene"] = bool(gg.get("scene"))
    idir["gen_targets"]["prop"] = bool(gg.get("prop"))
    idir["gen_targets"]["global"] = bool(gg.get("still"))
    idir["gen_targets"]["shot_stills"] = bool(any_group_still)
    timeline["image_director"] = idir

    for seg in timeline.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        if "label" not in seg:
            seg["label"] = ""
        if "camera" not in seg:
            seg["camera"] = ""
        if "transition" not in seg:
            seg["transition"] = "cut"
        elif seg["transition"] not in TRANSITIONS:
            seg["transition"] = "cut"
        seg["retake"] = bool(seg.get("retake", False))
        if "retake_note" not in seg:
            seg["retake_note"] = ""
        if "run_selected" not in seg:
            seg["run_selected"] = True
        else:
            seg["run_selected"] = bool(seg.get("run_selected", True))

    # run_scope: all | selected | retake — maps onto runSelectEnabled/runSelection
    scope = str(timeline.get("run_scope") or "").lower()
    if scope in ("all", "selected", "retake"):
        _apply_run_scope(timeline, scope)
    elif scope:
        timeline["run_scope"] = "all"

    return timeline


def _apply_run_scope(timeline: dict, scope: str) -> None:
    segs = timeline.get("segments") or []
    n = len(segs)
    if scope == "all":
        timeline["runSelectEnabled"] = False
        timeline["runSelection"] = []
        timeline["run_scope"] = "all"
        return

    if scope == "retake":
        selection = [i for i, s in enumerate(segs) if isinstance(s, dict) and s.get("retake")]
    else:  # selected
        selection = [
            i
            for i, s in enumerate(segs)
            if isinstance(s, dict) and s.get("run_selected", True)
        ]

    if not selection:
        # Nothing marked → fall back to all
        timeline["runSelectEnabled"] = False
        timeline["runSelection"] = []
        timeline["run_scope"] = scope
        return

    timeline["runSelectEnabled"] = True
    timeline["runSelection"] = selection
    timeline["run_scope"] = scope
    # Keep indices valid
    timeline["runSelection"] = [i for i in selection if 0 <= i < n]


def continuity_prefix(timeline: dict) -> str:
    c = timeline.get("continuity") or {}
    if not c.get("inject", True):
        return ""
    parts = []
    if str(c.get("characters", "")).strip():
        parts.append(f"角色设定：{str(c['characters']).strip()}")
    if str(c.get("locations", "")).strip():
        parts.append(f"场景设定：{str(c['locations']).strip()}")
    if str(c.get("props", "")).strip():
        parts.append(f"道具设定：{str(c['props']).strip()}")
    return "；".join(parts)


def inject_continuity(prompt: str, timeline: dict) -> str:
    prefix = continuity_prefix(timeline)
    prompt = (prompt or "").strip()
    if not prefix:
        return prompt
    if not prompt:
        return prefix
    if prefix in prompt:
        return prompt
    return f"{prefix}。{prompt}"


def append_camera(prompt: str, camera: str) -> str:
    cam = (camera or "").strip()
    prompt = (prompt or "").strip()
    if not cam:
        return prompt
    tag = f"运镜：{cam}"
    if tag in prompt or cam in prompt:
        return prompt
    if not prompt:
        return tag
    return f"{prompt}\n{tag}"


def build_desk_global_suffix(timeline: dict) -> str:
    desk = timeline.get("desk") or {}
    parts = []
    style = str(desk.get("style") or "").strip()
    if style:
        parts.append(style)
    sound = str(desk.get("soundscape") or "").strip()
    music = str(desk.get("music") or "").strip()
    if sound:
        parts.append(f"整体声景：{sound}")
    if music and music not in ("无", "none", "None"):
        parts.append(f"非叙事配乐：{music}")
    note = str(desk.get("image_director_note") or "").strip()
    if note:
        parts.append(f"画面导演备注：{note}")
    return "\n".join(parts).strip()


def enrich_segment_prompt(prompt: str, seg: dict, timeline: dict, *, is_global_mode: bool) -> str:
    """Apply continuity + camera. In global mode continuity goes on global prompt once."""
    text = (prompt or "").strip()
    if not is_global_mode:
        text = inject_continuity(text, timeline)
    text = append_camera(text, str(seg.get("camera") or ""))
    return text


def enrich_timeline_dict(timeline: dict) -> dict:
    """Mutate timeline: inject studio semantics into prompts / run selection.

    Critical for prompt groups (t2v/i2v/r2v batch):
    - Force segment semantics so each group's prompt is kept.
    - Never replace a non-empty group prompt with the global prompt.
    - Never fill an empty group with the global story (that made every clip look the same).
    """
    ensure_studio_fields(timeline)

    task_key = ""
    try:
        from ..lib.task_prompts import resolve_task_key

        task_key = resolve_task_key((timeline.get("global") or {}).get("taskType") or "")
    except Exception:
        task_key = ""

    timeline_mode = str(timeline.get("timelineMode") or "").lower()
    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    is_prompt_batch = (
        timeline_mode in ("prompt_batch", "image_batch", "fl2v")
        or task_key in ("t2v", "i2v", "r2v", "fl2v")
        or len(segs) > 1
    )

    edit_mode = str(timeline.get("editMode") or timeline.get("edit_mode") or "global")
    if is_prompt_batch:
        edit_mode = "segment"
        timeline["editMode"] = "segment"
        if timeline_mode not in ("fl2v", "gen_blank", "gen_image", "video"):
            timeline["timelineMode"] = "prompt_batch"
    is_global = edit_mode != "segment"

    g = timeline.get("global")
    if not isinstance(g, dict):
        g = {}
        timeline["global"] = g

    base_prompt = str(g.get("prompt") or "").strip()
    # Desk style/soundscape only enrich the global field — do not copy onto every group.
    desk_suffix = build_desk_global_suffix(timeline)
    if desk_suffix:
        for line in desk_suffix.splitlines():
            line = line.strip()
            if line and line not in base_prompt:
                base_prompt = f"{base_prompt}\n{line}".strip() if base_prompt else line

    if is_global:
        base_prompt = inject_continuity(base_prompt, timeline)

    g["prompt"] = base_prompt

    for seg in segs:
        raw = str(seg.get("prompt") or "").strip()
        if is_prompt_batch:
            # Keep each group's own text; only inject continuity/camera onto non-empty prompts.
            if raw:
                seg["prompt"] = enrich_segment_prompt(raw, seg, timeline, is_global_mode=False)
            else:
                seg["prompt"] = ""
            continue

        if is_global and not raw:
            seg["prompt"] = ""
            continue
        # Non-batch segment mode: empty segment may inherit global (single-timeline workflows).
        seg["prompt"] = enrich_segment_prompt(raw or base_prompt, seg, timeline, is_global_mode=is_global)

    return timeline


def enrich_timeline_json(timeline_data: str) -> str:
    """Parse → enrich → dump. Returns original on empty / invalid JSON."""
    if not timeline_data or not str(timeline_data).strip():
        return timeline_data
    try:
        timeline = json.loads(timeline_data)
    except json.JSONDecodeError:
        return timeline_data
    if not isinstance(timeline, dict):
        return timeline_data
    enrich_timeline_dict(timeline)
    return json.dumps(timeline, ensure_ascii=False)


def export_shot_list_markdown(timeline: dict) -> str:
    ensure_studio_fields(timeline)
    fps = float(timeline.get("frameRate") or 24.0)
    lines = [
        "# MiniMax H3 分镜表",
        "",
        f"- 编辑模式：{timeline.get('editMode') or 'global'}",
        f"- FPS：{fps}",
        f"- 总帧数：{timeline.get('totalFrames')}",
        "",
        "| # | 标签 | 起止帧 | 运镜 | 转场 | 重拍 | 提示词 |",
        "|---|------|--------|------|------|------|--------|",
    ]
    for i, s in enumerate(timeline.get("segments") or [], 1):
        if not isinstance(s, dict):
            continue
        start = int(s.get("start") or 0)
        length = int(s.get("length") or s.get("frameCount") or 0)
        prompt = str(s.get("prompt") or "").replace("|", "/")
        lines.append(
            f"| {i} | {s.get('label') or '-'} | {start}-{start + length} | "
            f"{s.get('camera') or '-'} | {s.get('transition') or 'cut'} | "
            f"{'是' if s.get('retake') else '否'} | {prompt} |"
        )
    return "\n".join(lines)


def apply_local_director_prompt(timeline: dict, expanded: str, *, scope: str = "all") -> dict:
    """Write GGUF-expanded prompt into timeline."""
    text = (expanded or "").strip()
    if not text:
        return timeline
    ensure_studio_fields(timeline)
    g = timeline.setdefault("global", {})
    if scope == "all" or str(timeline.get("editMode") or "global") == "global":
        g["prompt"] = text
        return timeline
    # segment scope: write into selected / all segments
    segs = timeline.get("segments") or []
    if scope == "segment" and segs:
        # Prefer selectedIndex-like metadata if present
        idx = timeline.get("selectedSegmentIndex")
        if isinstance(idx, int) and 0 <= idx < len(segs):
            segs[idx]["prompt"] = text
        else:
            segs[0]["prompt"] = text
        timeline["editMode"] = "segment"
    else:
        for seg in segs:
            if isinstance(seg, dict):
                seg["prompt"] = text
        timeline["editMode"] = "segment"
    return timeline
