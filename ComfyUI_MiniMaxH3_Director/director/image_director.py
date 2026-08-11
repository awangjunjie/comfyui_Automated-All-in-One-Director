# -*- coding: utf-8 -*-
"""Reference Image Director — still prompts + auto-generate/inject refs for MiniMaxH3Director."""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Any

import numpy as np
import torch
from PIL import Image

import folder_paths

from .studio_enrich import continuity_prefix, ensure_studio_fields

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.image_director")

# Tolerate missing U+6A21 in multimodal field name
_RE_MM_DESC = re.compile('综合多模?态描述\\s*[:：]?')
_RE_SOUND = re.compile('整体声景\\s*[:：]')
_RE_MUSIC = re.compile('非叙事配乐\\s*[:：]')
_RE_SHOT_TAG = re.compile('(?=\\[镜头\\s*\\d+\\])')
_RE_SHOT_SWITCH = re.compile('(?=(?:^|[。；\\n])镜头切换到)')
_RE_TIMED_CUT = re.compile('(?=在\\s*\\d{2}:\\d{2}\\.\\d{3}[，,]\\s*.{0,12}镜头)')
_RE_DIALOGUE = re.compile(r"<d>.*?</d>", re.IGNORECASE | re.DOTALL)
_RE_MEDIA_TAG = re.compile(r"<(?:Picture|picture|图片|Video|video|视频|Audio|audio|音频)\s*\d+>", re.I)
_RE_SPEAKER_MARK = re.compile(r"[（(]说\s*\d+[）)]")
_RE_CAMERA_CLAUSE = re.compile(
    r"(?:镜头(?:小幅度|大幅度)?(?:缓慢|快速)?[^。；\n]{0,48}(?:横移|推近|拉远|跟随|切换|摇移|摇镜|推镜|拉镜|移镜|推移)[^。；\n]{0,24})"
    r"|(?:小幅度缓慢(?:右|左)?(?:横移|推近|拉远)[^。；\n]{0,24})"
    r"|(?:缓慢(?:推近|拉远|跟随)[^。；\n]{0,24})"
)

_MM_PREFIX = '综合多模态描述：'


def _punctuate(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return ""
    if s[-1] not in "。.!！？?;；…":
        s += "。"
    return s


def _join_still_parts(*chunks: str) -> str:
    """Join still-prompt chunks; avoid double periods / empty crumbs."""
    parts: list[str] = []
    for c in chunks:
        c = (c or "").strip()
        if not c:
            continue
        parts.append(_punctuate(c))
    text = "".join(parts)
    text = re.sub(r"。{2,}", "。", text)
    return text.strip()


def _visual_body_from_prompt(body: str) -> str:
    """Extract still-friendly visual prose from H3 multimodal video prompts."""
    body = (body or "").strip()
    if not body:
        return ""
    m = _RE_MM_DESC.search(body)
    if m:
        body = body[m.end() :]
    for stop_re in (_RE_SOUND, _RE_MUSIC):
        sm = stop_re.search(body)
        if sm:
            body = body[: sm.start()]
    body = _RE_DIALOGUE.sub("", body)
    body = _RE_MEDIA_TAG.sub("", body)
    body = _RE_SPEAKER_MARK.sub("", body)
    body = _RE_CAMERA_CLAUSE.sub("", body)
    # Drop shot index tags like [镜头1] but keep surrounding prose
    body = re.sub(r"\[镜头\s*\d+\]", "", body)
    body = re.sub(r"[ \t\u3000]+", " ", body)
    body = re.sub(r"[。；]{2,}", "。", body)
    body = re.sub(r"\n{2,}", "\n", body)
    return body.strip(" \n。；;，,")


def _clip_body(text: str, limit: int = 480) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[: limit - 1].rstrip("，,；; ") + "…"


def _style_tail(
    *,
    style: str = "",
    unified: str = "",
    suffix: str = "",
    guide: str = "",
) -> str:
    return _join_still_parts(style, unified, guide, suffix)


def default_image_director() -> dict:
    return {
        "enabled": False,
        "unified_ref_note": (
            "\u7edf\u4e00\u89d2\u8272\u5916\u8c8c\u3001\u670d\u88c5\u3001\u5e74\u9f84\u4e0e\u753b\u98ce\uff0c"
            "\u5168\u8eab\u6216\u534a\u8eab\u6e05\u6670\u53ef\u89c1\uff0c\u5e72\u51c0\u80cc\u666f"
        ),
        "style_suffix": (
            "\u7535\u5f71\u9759\u5e27\uff0c\u9ad8\u7ec6\u8282\uff0c\u5199\u5b9e\u5149\u5f71\uff0c"
            "16:9 \u6784\u56fe\uff0c\u65e0\u6587\u5b57\u6c34\u5370"
        ),
        "global_ref_prompt": "",
        "shot_image_prompts": "",
        "auto_inject": True,
        "generate_on_queue": False,
        "generate_shot_stills": True,
        # Still-generation params (edited in Studio Desk; avoid new Comfy widgets)
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
        # legacy (migrated into global_gen / groups_gen)
        "gen_targets": {
            "global": True,
            "character": False,
            "scene": False,
            "prop": False,
            "shot_stills": True,
        },
        "gen_scope": "all",
        "gen_group_indices": [],
        # Still generation backend: local checkpoint vs cloud image API
        "gen_backend": "local",  # local | cloud
        # Local model family profile — swap wiring + sampling defaults together.
        # auto | sdxl | flux | z_image_turbo
        "local_model_profile": "auto",
        "gen_api_format": "智谱 GLM",
        "gen_api_url": "https://open.bigmodel.cn/api/paas/v4",
        "gen_api_key": "",
        "gen_api_model": "cogview-3-flash",
        # From Prompt Director asset extract: {characters:[{name,appearance,sheet_prompt}], scenes:[...]}
        "asset_prompts": {"characters": [], "scenes": []},
    }


_ROLE_SLOT = {
    "still": 0,
    "character": 1,
    "scene": 2,
    "prop": 3,
}

_ROLE_BADGE = {
    "still": "静帧",
    "character": "人物",
    "scene": "场景",
    "prop": "道具",
}

_DEFAULT_ROLE_GEN = {
    "character": False,
    "scene": False,
    "prop": False,
    "still": True,
    "refs": [],
}


_GUIDE_ROLE_LABELS = {
    "character": "人物",
    "scene": "场景",
    "prop": "道具",
    "style": "画风",
    "other": "其他",
}


def guide_refs_note(timeline: dict) -> str:
    """Short T2I-safe continuity hint when guide refs already exist."""
    ensure_image_director(timeline)
    items = timeline["image_director"].get("guide_refs") or []
    has_any = any(
        isinstance(it, dict) and (it.get("imageFile") or it.get("imageB64"))
        for it in items
    )
    if not has_any:
        return ""
    # Avoid meta labels like「参考图导演已提供」— those often get painted as text.
    return "人物外貌服装与场景画风与已有参考图保持一致"


def _normalize_role_gen(row: Any, *, default_still: bool = False) -> dict:
    base = dict(_DEFAULT_ROLE_GEN)
    base["still"] = bool(default_still)
    base["refs"] = []
    if not isinstance(row, dict):
        return base
    out = dict(base)
    for k in ("character", "scene", "prop", "still"):
        if k in row:
            out[k] = bool(row.get(k))
    refs = row.get("refs")
    if isinstance(refs, list):
        cleaned = []
        for it in refs:
            if not isinstance(it, dict):
                continue
            path = str(it.get("imageFile") or "").strip()
            if not path and not it.get("imageB64"):
                continue
            cleaned.append(
                {
                    "imageFile": path,
                    "imageB64": str(it.get("imageB64") or ""),
                    "role": str(it.get("role") or "character"),
                    "label": str(it.get("label") or ""),
                }
            )
        out["refs"] = cleaned
    else:
        out["refs"] = []
    return out


def pick_guide_init_image(
    timeline: dict,
    prefer_role: str | None = None,
    segment_index: int | None = None,
):
    """Prefer group refs (if segment_index) → global guide_refs.

    Only user-uploaded guide images are used as img2img init.
    Auto-generated stills must NOT feed back into the director init slot.
    """
    from .plan import load_reference_tensor

    ensure_image_director(timeline)
    items: list[dict] = []
    if segment_index is not None:
        groups = timeline["image_director"].get("groups_gen") or []
        if 0 <= int(segment_index) < len(groups) and isinstance(groups[int(segment_index)], dict):
            items = [
                it
                for it in (groups[int(segment_index)].get("refs") or [])
                if isinstance(it, dict) and it.get("imageFile") and not it.get("auto_generated")
            ]
    if not items:
        items = [
            it
            for it in (timeline["image_director"].get("guide_refs") or [])
            if isinstance(it, dict) and it.get("imageFile") and not it.get("auto_generated")
        ]
    if not items:
        return None
    preferred = None
    if prefer_role:
        preferred = next((it for it in items if it.get("role") == prefer_role), None)
    if preferred is None:
        preferred = next((it for it in items if it.get("role") == "character"), items[0])
    return load_reference_tensor(
        {"imageFile": preferred["imageFile"], "imageB64": preferred.get("imageB64") or ""}
    )


def _first_image(*candidates):
    """Return first non-None image tensor/value (never use ``a or b`` on tensors)."""
    for c in candidates:
        if c is not None:
            return c
    return None


def inject_group_guide_refs(timeline: dict, seg_idx: int, *, start_slot: int = 1) -> int:
    """Inject a prompt-group's director refs into that segment's picture slots."""
    ensure_image_director(timeline)
    groups = timeline["image_director"].get("groups_gen") or []
    if not (0 <= int(seg_idx) < len(groups)):
        return 0
    items = [
        it
        for it in (groups[int(seg_idx)].get("refs") or [])
        if isinstance(it, dict) and it.get("imageFile")
    ]
    if not items:
        return 0
    segs = timeline.get("segments") or []
    seg = segs[int(seg_idx)] if 0 <= int(seg_idx) < len(segs) else None
    srefs = list((seg or {}).get("refs") or []) if isinstance(seg, dict) else []
    used = {
        int(r.get("index", r.get("slot", -1)))
        for r in srefs
        if isinstance(r, dict) and r.get("imageFile")
    }
    n = 0
    role_seen: dict[str, int] = {}
    for it in items:
        role = str(it.get("role") or "other")
        if it.get("slot") is not None:
            try:
                slot = int(it["slot"])
            except (TypeError, ValueError):
                slot = None
        else:
            slot = None
        if slot is None:
            count = role_seen.get(role, 0)
            role_seen[role] = count + 1
            preferred = int(_ROLE_SLOT[role]) if role in _ROLE_SLOT and count == 0 else None
            slot = _next_free_slot(used, preferred)
        if slot is None or slot < 0 or slot >= 9:
            continue
        path = str(it["imageFile"])
        existing = next(
            (r for r in srefs if int(r.get("index", r.get("slot", -1))) == slot and r.get("imageFile")),
            None,
        )
        # Already synced
        if existing and existing.get("imageFile") == path:
            used.add(slot)
            continue
        # Don't let stale auto guide cards overwrite a newer segment-owned director inject
        if (
            existing
            and existing.get("fromDirector")
            and not existing.get("fromGlobal")
            and it.get("auto_generated")
            and existing.get("imageFile") != path
        ):
            used.add(slot)
            continue
        badge = str(it.get("label") or "").strip() or _ROLE_BADGE.get(role, role)
        inject_ref_file(
            timeline,
            path,
            slot=slot,
            into_global=False,
            segment_index=int(seg_idx),
            role=role,
            role_label=badge,
            from_global=False,
        )
        used.add(slot)
        n += 1
    return n


def inject_guide_refs_to_global(timeline: dict, *, start_slot: int = 1) -> int:
    """Copy director guide_refs into global.refs starting at start_slot (keep slot0 for stills)."""
    ensure_image_director(timeline)
    items = [it for it in (timeline["image_director"].get("guide_refs") or []) if isinstance(it, dict) and it.get("imageFile")]
    if not items:
        return 0
    slot = max(0, int(start_slot))
    n = 0
    for it in items:
        if slot >= 9:
            break
        inject_ref_file(
            timeline,
            str(it["imageFile"]),
            slot=slot,
            into_global=True,
            into_groups=False,
        )
        # Don't overwrite genImage for guide slots > 0 — only slot0 syncs genImage
        slot += 1
        n += 1
    return n


def resolve_still_gen_params(
    timeline: dict,
    *,
    fallback_width: int = 1024,
    fallback_height: int = 576,
    fallback_seed: int = 0,
    fallback_steps: int | None = None,
    fallback_cfg: float | None = None,
) -> dict:
    """Merge image_director still params with optional node-widget fallbacks."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    use_video = bool(idir.get("use_video_size", False))
    width = int(fallback_width if use_video else (idir.get("width") or fallback_width or 1024))
    height = int(fallback_height if use_video else (idir.get("height") or fallback_height or 576))
    steps = int(idir.get("steps") if idir.get("steps") not in (None, "") else (fallback_steps or 8))
    cfg = float(idir.get("cfg") if idir.get("cfg") not in (None, "") else (fallback_cfg if fallback_cfg is not None else 2.0))
    seed_raw = idir.get("seed", -1)
    try:
        seed_i = int(seed_raw)
    except (TypeError, ValueError):
        seed_i = -1
    seed = int(fallback_seed or 0) if seed_i < 0 else seed_i
    sampler = str(idir.get("sampler") or "euler_ancestral").strip() or "euler_ancestral"
    scheduler = str(idir.get("scheduler") or "normal").strip() or "normal"
    try:
        denoise = float(idir.get("denoise", 1.0))
    except (TypeError, ValueError):
        denoise = 1.0
    negative = str(idir.get("negative") or "").strip() or default_image_director()["negative"]
    return {
        "width": max(64, width),
        "height": max(64, height),
        "steps": max(1, min(150, steps)),
        "cfg": max(0.0, min(30.0, cfg)),
        "seed": seed,
        "sampler": sampler,
        "scheduler": scheduler,
        "denoise": max(0.0, min(1.0, denoise)),
        "negative": negative,
    }


def ensure_image_director(timeline: dict) -> dict:
    ensure_studio_fields(timeline)
    idir = timeline.get("image_director")
    if not isinstance(idir, dict):
        idir = default_image_director()
    else:
        base = default_image_director()
        for k, v in base.items():
            if k not in idir:
                idir[k] = dict(v) if isinstance(v, dict) else (list(v) if isinstance(v, list) else v)
    idir["enabled"] = bool(idir.get("enabled", False))
    idir["auto_inject"] = bool(idir.get("auto_inject", True))
    idir["generate_on_queue"] = bool(idir.get("generate_on_queue", False))
    _prof = str(idir.get("local_model_profile") or "auto").strip().lower()
    if _prof not in STILL_MODEL_PROFILES:
        _prof = "auto"
    idir["local_model_profile"] = _prof
    try:
        from .image_gen_api import merge_gen_api_fields

        merge_gen_api_fields(idir)
    except Exception:
        pass
    if not isinstance(idir.get("guide_refs"), list):
        idir["guide_refs"] = []
    if not isinstance(idir.get("fl_global_refs"), list):
        idir["fl_global_refs"] = []
    if not isinstance(idir.get("asset_prompts"), dict):
        idir["asset_prompts"] = {"characters": [], "scenes": []}
    else:
        ap = idir["asset_prompts"]
        if not isinstance(ap.get("characters"), list):
            ap["characters"] = []
        if not isinstance(ap.get("scenes"), list):
            ap["scenes"] = []

    # Normalize global_gen (migrate from legacy gen_targets if needed)
    if not isinstance(idir.get("global_gen"), dict):
        legacy = idir.get("gen_targets") if isinstance(idir.get("gen_targets"), dict) else {}
        idir["global_gen"] = _normalize_role_gen(
            {
                "character": legacy.get("character", False),
                "scene": legacy.get("scene", False),
                "prop": legacy.get("prop", False),
                "still": legacy.get("global", True),
            },
            default_still=True,
        )
    else:
        idir["global_gen"] = _normalize_role_gen(idir["global_gen"], default_still=True)

    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    if not isinstance(idir.get("groups_gen"), list):
        idir["groups_gen"] = []
    legacy = idir.get("gen_targets") if isinstance(idir.get("gen_targets"), dict) else {}
    scope = str(idir.get("gen_scope") or "all")
    selected = set()
    for x in idir.get("gen_group_indices") or []:
        try:
            selected.add(int(x))
        except (TypeError, ValueError):
            pass
    while len(idir["groups_gen"]) < len(segs):
        idx = len(idir["groups_gen"])
        in_scope = scope == "all" or (scope == "selected" and idx in selected)
        want_still = bool(legacy.get("shot_stills", True)) and in_scope and scope != "global_only"
        idir["groups_gen"].append(_normalize_role_gen(None, default_still=want_still))
    if len(idir["groups_gen"]) > len(segs):
        idir["groups_gen"] = idir["groups_gen"][: len(segs)]
    idir["groups_gen"] = [
        _normalize_role_gen(row, default_still=False) for row in idir["groups_gen"]
    ]

    any_group_still = any(bool(r.get("still")) for r in idir["groups_gen"])
    idir["generate_shot_stills"] = any_group_still
    if not isinstance(idir.get("gen_targets"), dict):
        idir["gen_targets"] = {}
    idir["gen_targets"]["character"] = bool(idir["global_gen"].get("character"))
    idir["gen_targets"]["scene"] = bool(idir["global_gen"].get("scene"))
    idir["gen_targets"]["prop"] = bool(idir["global_gen"].get("prop"))
    idir["gen_targets"]["global"] = bool(idir["global_gen"].get("still"))
    idir["gen_targets"]["shot_stills"] = any_group_still

    timeline["image_director"] = idir
    desk = timeline.setdefault("desk", {})
    if not str(desk.get("image_director_note") or "").strip():
        desk["image_director_note"] = str(idir.get("unified_ref_note") or "")
    return timeline


def _asset_prompts(timeline: dict) -> dict:
    ensure_image_director(timeline)
    ap = timeline["image_director"].get("asset_prompts") or {}
    if not isinstance(ap, dict):
        return {"characters": [], "scenes": []}
    chars = [c for c in (ap.get("characters") or []) if isinstance(c, dict)]
    scenes = [s for s in (ap.get("scenes") or []) if isinstance(s, dict)]
    return {"characters": chars, "scenes": scenes}


def _next_free_slot(used: set[int], preferred: int | None = None) -> int | None:
    if preferred is not None and 0 <= int(preferred) < 9 and int(preferred) not in used:
        return int(preferred)
    for s in range(1, 9):  # keep 0 for still
        if s not in used:
            return s
    return None


def allocate_asset_slots(timeline: dict) -> list[dict]:
    """Plan slots for extracted character sheets + scene stills (图片1–9 index 0–8)."""
    assets = _asset_prompts(timeline)
    used: set[int] = set()
    plan: list[dict] = []
    for i, c in enumerate(assets["characters"]):
        pref = 1 if i == 0 else None
        slot = _next_free_slot(used, pref)
        if slot is None:
            break
        used.add(slot)
        plan.append(
            {
                "role": "character",
                "asset_index": i,
                "slot": slot,
                "name": str(c.get("name") or f"人物{i + 1}"),
                "prompt": str(c.get("sheet_prompt") or "").strip(),
            }
        )
    for i, s in enumerate(assets["scenes"]):
        pref = 2 if i == 0 else None
        slot = _next_free_slot(used, pref)
        if slot is None:
            break
        used.add(slot)
        plan.append(
            {
                "role": "scene",
                "asset_index": i,
                "slot": slot,
                "name": str(s.get("name") or f"场景{i + 1}"),
                "prompt": str(s.get("image_prompt") or "").strip(),
            }
        )
    return [p for p in plan if p.get("prompt")]


def expand_gen_jobs(timeline: dict) -> list[dict]:
    """Expand global_gen + groups_gen into discrete generation jobs.

    When asset_prompts exist and character/scene gen is checked, emit one job
    per extracted asset (with custom prompt + slot) instead of a single role job.
    """
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    jobs: list[dict] = []
    asset_plan = allocate_asset_slots(timeline)
    asset_roles_done: set[str] = set()

    if idir["global_gen"].get("character") or idir["global_gen"].get("scene"):
        for item in asset_plan:
            role = item["role"]
            if not idir["global_gen"].get(role):
                continue
            jobs.append(
                {
                    "scope": "global",
                    "seg_idx": None,
                    "role": role,
                    "asset_index": item["asset_index"],
                    "slot": item["slot"],
                    "prompt": item["prompt"],
                    "label": item["name"],
                }
            )
            asset_roles_done.add(role)

    for role in ("character", "scene", "prop", "still"):
        if not idir["global_gen"].get(role):
            continue
        if role in asset_roles_done:
            continue
        jobs.append({"scope": "global", "seg_idx": None, "role": role})

    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    for i, _seg in enumerate(segs):
        row = idir["groups_gen"][i] if i < len(idir["groups_gen"]) else {}
        for role in ("character", "scene", "prop", "still"):
            if row.get(role):
                jobs.append({"scope": "group", "seg_idx": i, "role": role})
    return jobs


def resolve_gen_plan(timeline: dict, *, generate_shot_stills: bool = True) -> dict:
    """Backward-compatible summary; prefer expand_gen_jobs."""
    ensure_image_director(timeline)
    jobs = expand_gen_jobs(timeline)
    if not generate_shot_stills:
        jobs = [j for j in jobs if not (j["scope"] == "group" and j["role"] == "still")]
    g = timeline["image_director"]["global_gen"]
    return {
        "global": bool(g.get("still")),
        "character": bool(g.get("character")),
        "scene": bool(g.get("scene")),
        "prop": bool(g.get("prop")),
        "shot_stills": any(j["scope"] == "group" and j["role"] == "still" for j in jobs),
        "scope": "plan",
        "group_indices": sorted(
            {j["seg_idx"] for j in jobs if j["scope"] == "group" and j["seg_idx"] is not None}
        ),
        "jobs": jobs,
    }


def build_role_ref_prompt(timeline: dict, role: str, *, asset_index: int | None = None) -> str:
    """Still prompt focused on character / scene / prop guide image (T2I-friendly)."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    cont = timeline.get("continuity") or {}
    desk = timeline.get("desk") or {}
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    role = str(role or "character").strip().lower()
    story = _clip_body(
        _visual_body_from_prompt(str((timeline.get("global") or {}).get("prompt") or "")),
        260,
    )
    cont_line = continuity_prefix(timeline)

    # Prefer Prompt-Director extracted asset prompts when available
    assets = _asset_prompts(timeline)
    if role == "character" and assets["characters"]:
        idx = 0 if asset_index is None else int(asset_index)
        if 0 <= idx < len(assets["characters"]):
            sheet = str(assets["characters"][idx].get("sheet_prompt") or "").strip()
            if sheet:
                return _join_still_parts(
                    sheet,
                    _style_tail(style=style, unified=unified, suffix=suffix),
                )
    if role == "scene" and assets["scenes"]:
        idx = 0 if asset_index is None else int(asset_index)
        if 0 <= idx < len(assets["scenes"]):
            scene_p = str(assets["scenes"][idx].get("image_prompt") or "").strip()
            if scene_p:
                return _join_still_parts(
                    scene_p,
                    _style_tail(style=style, unified=unified, suffix=suffix),
                )

    if role == "character":
        focus = str(cont.get("characters") or "").strip()
        return _join_still_parts(
            f"清晰人物肖像，{focus}" if focus else "清晰人物肖像，主要角色外貌与服装完整可读",
            cont_line,
            story,
            "半身或全身，正面或四分之三侧面，发型服装细节清晰，干净背景",
            "无文字、无水印、无字幕、无界面边框",
            _style_tail(style=style, unified=unified, suffix=suffix),
        )
    if role == "scene":
        focus = str(cont.get("locations") or "").strip()
        return _join_still_parts(
            f"开阔场景环境，{focus}" if focus else "开阔场景环境，关键地点空间层次清晰",
            cont_line,
            story,
            "展示光影氛围与空间纵深，可无人或仅远景剪影",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix),
        )
    if role == "prop":
        focus = str(cont.get("props") or "").strip()
        return _join_still_parts(
            f"关键道具特写，{focus}" if focus else "关键道具特写，主体居中",
            cont_line,
            "材质与细节清晰可读，干净背景",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix),
        )
    if role == "still":
        return _join_still_parts(
            "主要角色与关键场景同框的电影静帧",
            cont_line or "主要角色外貌服装与场景氛围清晰",
            story,
            "正面或四分之三侧面，主体完整稳定，适合视频一致性参考",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix),
        )
    return _join_still_parts(
        "主体清晰完整的电影静帧",
        cont_line,
        story,
        "干净背景，无文字、无水印、无字幕",
        _style_tail(style=style, unified=unified, suffix=suffix),
    )


def build_shot_role_ref_prompt(timeline: dict, seg_idx: int, role: str) -> str:
    """Per-group role/still prompt using that segment's visual body."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    cont = timeline.get("continuity") or {}
    desk = timeline.get("desk") or {}
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    role = str(role or "still").strip().lower()
    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    seg = segs[seg_idx] if 0 <= seg_idx < len(segs) else {}
    body = _clip_body(_visual_body_from_prompt(str((seg or {}).get("prompt") or "")), 480)
    camera = str((seg or {}).get("camera") or "").strip()
    cont_line = continuity_prefix(timeline)
    guide = guide_refs_note(timeline)
    # Camera as descriptive framing, not a labeled meta field
    framing = ""
    if camera and role == "still":
        framing = f"{camera}视角下的静止瞬间"

    if role == "character":
        focus = str(cont.get("characters") or "").strip()
        return _join_still_parts(
            f"清晰人物肖像，{focus}" if focus else "清晰人物肖像",
            cont_line,
            body,
            "外貌服装与角色设定一致，主体清晰，干净背景",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
        )
    if role == "scene":
        focus = str(cont.get("locations") or "").strip()
        return _join_still_parts(
            f"场景环境，{focus}" if focus else "场景环境",
            cont_line,
            body,
            "光影氛围与本镜地点一致",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
        )
    if role == "prop":
        focus = str(cont.get("props") or "").strip()
        return _join_still_parts(
            f"关键道具特写，{focus}" if focus else "关键道具特写",
            body,
            "主体居中清晰，干净背景",
            "无文字、无水印、无字幕",
            _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
        )
    return _join_still_parts(
        "本镜关键瞬间的电影静帧，适合作为首帧",
        cont_line,
        body,
        framing,
        "与全局角色外貌服装保持一致，主体完整",
        "无文字、无水印、无字幕",
        _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
    )


def _upsert_ref_list(
    items: list,
    *,
    role: str,
    image_file: str,
    label: str = "",
    id_prefix: str = "gref",
    prefer_label_match: bool = True,
) -> dict:
    """Fill empty/auto same-role card or append into a refs list.

    When label is set and prefer_label_match, update the same-label card first
    so multiple characters/scenes each keep their own guide card.
    """
    role = str(role or "other")
    image_file = str(image_file or "").strip()
    label = str(label or "").strip()
    if not image_file:
        return {}
    if prefer_label_match and label:
        for it in items:
            if not isinstance(it, dict):
                continue
            if it.get("role") != role:
                continue
            if str(it.get("label") or "").strip() != label:
                continue
            it["imageFile"] = image_file
            it["auto_generated"] = True
            return it
    for it in items:
        if not isinstance(it, dict):
            continue
        if it.get("role") != role:
            continue
        # Don't steal a labeled card belonging to another asset
        if prefer_label_match and label and str(it.get("label") or "").strip() and str(it.get("label") or "").strip() != label:
            continue
        if not it.get("imageFile") or it.get("auto_generated"):
            it["imageFile"] = image_file
            it["auto_generated"] = True
            if label and not str(it.get("label") or "").strip():
                it["label"] = label
            return it
    entry = {
        "id": f"{id_prefix}_auto_{role}_{int(time.time() * 1000)}",
        "role": role,
        "label": label or "",
        "imageFile": image_file,
        "auto_generated": True,
    }
    items.append(entry)
    return entry


def upsert_generated_guide_ref(
    timeline: dict, *, role: str, image_file: str, label: str = ""
) -> dict:
    """Write generated still into guide_refs (fill empty same-role card or append)."""
    ensure_image_director(timeline)
    items = timeline["image_director"].setdefault("guide_refs", [])
    return _upsert_ref_list(items, role=role, image_file=image_file, label=label, id_prefix="gref")


def upsert_generated_group_ref(
    timeline: dict, seg_idx: int, *, role: str, image_file: str, label: str = ""
) -> dict:
    """Write generated image into groups_gen[seg].refs for director-panel sync."""
    ensure_image_director(timeline)
    groups = timeline["image_director"].setdefault("groups_gen", [])
    idx = int(seg_idx)
    while len(groups) <= idx:
        groups.append(_normalize_role_gen(None, default_still=False))
    row = groups[idx]
    if not isinstance(row, dict):
        row = _normalize_role_gen(None, default_still=False)
        groups[idx] = row
    if not isinstance(row.get("refs"), list):
        row["refs"] = []
    return _upsert_ref_list(
        row["refs"],
        role=role,
        image_file=image_file,
        label=label,
        id_prefix=f"g{idx + 1}ref",
    )


def build_global_ref_prompt(timeline: dict) -> str:
    """Character / scene bible still — used as global reference image prompt."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    desk = timeline.get("desk") or {}
    cont = continuity_prefix(timeline)
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    story = _clip_body(_visual_body_from_prompt(str((timeline.get("global") or {}).get("prompt") or "")), 220)

    return _join_still_parts(
        "主要角色与关键场景同框的设定静帧",
        cont,
        story,
        "正面或四分之三侧面，外貌服装与场景氛围清晰完整，适合视频一致性参考",
        "无文字、无水印、无字幕",
        _style_tail(style=style, unified=unified, suffix=suffix, guide=guide_refs_note(timeline)),
    )


def _is_shot_header_crumb(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _RE_MM_DESC.fullmatch(t):
        return True
    if len(t) < 8 and "\u955c\u5934" not in t:
        return True
    return False


def split_prompt_into_shot_bodies(prompt: str) -> list[str]:
    """Split a global H3 prompt into per-shot visual bodies."""
    text = _visual_body_from_prompt(prompt)
    if not text:
        return []

    def _clean(parts: list[str]) -> list[str]:
        return [p.strip() for p in parts if p and not _is_shot_header_crumb(p)]

    for splitter in (_RE_SHOT_TAG, _RE_SHOT_SWITCH, _RE_TIMED_CUT):
        parts = _clean(splitter.split(text))
        if len(parts) >= 2:
            return parts
    return [text]


def sync_empty_segment_prompts_from_global(timeline: dict) -> int:
    """If prompt groups exist but are empty, fill from global shot-split. Returns filled count."""
    ensure_image_director(timeline)
    segs = timeline.get("segments") or []
    if not isinstance(segs, list) or not segs:
        return 0
    nonempty = sum(1 for s in segs if isinstance(s, dict) and str(s.get("prompt") or "").strip())
    if nonempty:
        return 0
    gprompt = str((timeline.get("global") or {}).get("prompt") or "").strip()
    if not gprompt:
        return 0
    bodies = split_prompt_into_shot_bodies(gprompt)
    if not bodies:
        return 0
    filled = 0
    for i, seg in enumerate(segs):
        if not isinstance(seg, dict):
            continue
        if str(seg.get("prompt") or "").strip():
            continue
        if len(bodies) == 1:
            body = bodies[0]
        elif i < len(bodies):
            body = bodies[i]
        else:
            body = bodies[min(i, len(bodies) - 1)]
        if _RE_MM_DESC.search(gprompt) and not _RE_MM_DESC.search(body):
            seg["prompt"] = _MM_PREFIX + body
        else:
            seg["prompt"] = body
        if not str(seg.get("label") or "").strip():
            seg["label"] = f"\u5206\u955c{i + 1}"
        filled += 1
    if filled:
        log.info("Filled %d empty prompt groups from global shot-split", filled)
    return filled


def build_shot_image_prompts(timeline: dict) -> list[tuple[int, str]]:
    """Return [(segment_index, still_prompt), ...] aligned to prompt groups."""
    ensure_image_director(timeline)
    sync_empty_segment_prompts_from_global(timeline)

    idir = timeline["image_director"]
    desk = timeline.get("desk") or {}
    cont = continuity_prefix(timeline)
    style = str(desk.get("style") or "").strip()
    unified = str(idir.get("unified_ref_note") or "").strip()
    suffix = str(idir.get("style_suffix") or "").strip()
    guide = guide_refs_note(timeline)
    gprompt = str((timeline.get("global") or {}).get("prompt") or "").strip()
    fallback_bodies = split_prompt_into_shot_bodies(gprompt)
    keep_consistent = "与全局角色外貌服装保持一致"

    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    out: list[tuple[int, str]] = []

    indices: list[int] = list(range(len(segs))) if segs else []
    if not indices and fallback_bodies:
        for i, body in enumerate(fallback_bodies):
            out.append(
                (
                    i,
                    _join_still_parts(
                        "本镜关键瞬间的电影静帧，适合作为首帧",
                        cont,
                        keep_consistent,
                        _clip_body(body, 480),
                        "无文字、无水印、无字幕",
                        _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
                    ),
                )
            )
        return out

    for i in indices:
        seg = segs[i]
        body = _visual_body_from_prompt(str(seg.get("prompt") or ""))
        if not body and i < len(fallback_bodies):
            body = fallback_bodies[i]
        if not body and fallback_bodies:
            body = fallback_bodies[0]
        if not body:
            # Still emit a continuity-only still so the group is not silently skipped
            body = cont or "关键叙事画面"
        camera = str(seg.get("camera") or "").strip()
        out.append(
            (
                i,
                _join_still_parts(
                    "本镜关键瞬间的电影静帧，适合作为首帧",
                    cont,
                    keep_consistent if cont else "",
                    _clip_body(body, 480),
                    f"{camera}视角下的静止瞬间" if camera else "",
                    "无文字、无水印、无字幕",
                    _style_tail(style=style, unified=unified, suffix=suffix, guide=guide),
                ),
            )
        )
    return out


def build_planned_still_prompt_blocks(timeline: dict) -> list[str]:
    """All still prompts for currently checked global/group gen targets (for UI / text director)."""
    ensure_image_director(timeline)
    idir = timeline["image_director"]
    ggen = idir.get("global_gen") if isinstance(idir.get("global_gen"), dict) else {}
    groups = idir.get("groups_gen") if isinstance(idir.get("groups_gen"), list) else []
    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    blocks: list[str] = []

    any_checked = False
    # Prefer labeled asset prompts when extracting characters/scenes
    asset_plan = allocate_asset_slots(timeline)
    used_asset_roles: set[str] = set()
    for item in asset_plan:
        role = item["role"]
        if not ggen.get(role):
            continue
        any_checked = True
        used_asset_roles.add(role)
        kind = "人物定妆" if role == "character" else "场景"
        name = item.get("name") or ""
        blocks.append(f"【{kind}·{name}】\n{item['prompt']}".strip())

    for role in ("character", "scene", "prop", "still"):
        if not ggen.get(role):
            continue
        if role in used_asset_roles:
            continue
        any_checked = True
        blocks.append(build_role_ref_prompt(timeline, role))
    for i, _seg in enumerate(segs):
        row = groups[i] if i < len(groups) and isinstance(groups[i], dict) else {}
        for role in ("character", "scene", "prop", "still"):
            if row.get(role):
                any_checked = True
                blocks.append(build_shot_role_ref_prompt(timeline, i, role))

    if not any_checked:
        # Default: per-shot stills summary
        blocks.extend(p for _, p in build_shot_image_prompts(timeline))
    return blocks


def rebuild_still_prompts(timeline: dict, *, force: bool = True) -> dict:
    """Rebuild image_director / fl_gen still prompts from current video prompts.

    Called after text/prompt director expands, or when user clicks ①.
    """
    ensure_image_director(timeline)
    from .fl_frame_director import (
        fill_fl_prompts,
        is_fl2v_timeline,
        sync_fl_shot_prompts_from_segments,
    )

    if is_fl2v_timeline(timeline):
        sync_fl_shot_prompts_from_segments(timeline)
        fill_fl_prompts(timeline, force=bool(force))
        return timeline

    sync_empty_segment_prompts_from_global(timeline)
    ggen = timeline["image_director"].get("global_gen") or {}
    if ggen.get("still"):
        timeline["image_director"]["global_ref_prompt"] = build_role_ref_prompt(timeline, "still")
    else:
        timeline["image_director"]["global_ref_prompt"] = build_global_ref_prompt(timeline)
    blocks = build_planned_still_prompt_blocks(timeline)
    timeline["image_director"]["shot_image_prompts"] = "\n\n".join(blocks)
    return timeline


def format_shot_image_prompts(prompts: list[Any]) -> str:
    if not prompts:
        return ""
    if isinstance(prompts[0], tuple):
        return "\n\n".join(str(p) for _, p in prompts)
    return "\n\n".join(str(p) for p in prompts)


def _ref_slot_indices(refs) -> list[int]:
    out: list[int] = []
    for r in refs or []:
        if not isinstance(r, dict) or not r.get("imageFile"):
            continue
        try:
            idx = int(r.get("index", r.get("slot", -1)))
        except (TypeError, ValueError):
            continue
        if idx >= 0:
            out.append(idx)
    return sorted(set(out))


def _missing_picture_prefixes(text: str, slots: list[int]) -> list[str]:
    """Return <Picture N> tags for slots not already mentioned in prompt."""
    raw = text or ""
    lower = raw.lower()
    missing: list[str] = []
    for slot in slots:
        n = int(slot) + 1
        if f"<picture {n}>" in lower:
            continue
        if f"<\u56fe\u7247 {n}>" in raw or f"<\u56fe\u7247{n}>" in raw:
            continue
        missing.append(f"<Picture {n}>")
    return missing


def ensure_picture_tag(prompt: str, *, slot: int = 0) -> str:
    """Prefix <Picture N> when that slot tag is missing (keeps existing tags)."""
    text = (prompt or "").strip()
    if not text:
        return text
    missing = _missing_picture_prefixes(text, [int(slot)])
    if not missing:
        return text
    return f"{' '.join(missing)} {text}"


def ensure_picture_tags_for_refs(prompt: str, refs) -> str:
    """Prefix all missing <Picture N> for filled ref slots."""
    text = (prompt or "").strip()
    if not text:
        return text
    slots = _ref_slot_indices(refs)
    if not slots:
        return text
    missing = _missing_picture_prefixes(text, slots)
    if not missing:
        return text
    return f"{' '.join(missing)} {text}"


def ensure_picture_tags_on_timeline(timeline: dict, *, slot: int = 0) -> dict:
    """Ensure prompts mention every filled ref slot (not only Picture 1)."""
    g = timeline.setdefault("global", {})
    g_refs = list(g.get("refs") or [])
    if g_refs:
        g["prompt"] = ensure_picture_tags_for_refs(str(g.get("prompt") or ""), g_refs)
    else:
        g["prompt"] = ensure_picture_tag(str(g.get("prompt") or ""), slot=slot)
    for seg in timeline.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        s_refs = list(seg.get("refs") or [])
        if s_refs:
            seg["prompt"] = ensure_picture_tags_for_refs(str(seg.get("prompt") or ""), s_refs)
        else:
            seg["prompt"] = ensure_picture_tag(str(seg.get("prompt") or ""), slot=slot)
    return timeline


def save_image_tensor_to_input(image: torch.Tensor, *, prefix: str = "mmh3_global_ref") -> str:
    """Save IMAGE tensor to ComfyUI input/ and return relative path for timeline refs."""
    if image is None:
        raise ValueError("empty image")
    t = image
    if t.ndim == 3:
        t = t.unsqueeze(0)
    frame = t[0].detach().cpu().float().clamp(0, 1).numpy()
    if frame.shape[-1] != 3:
        raise ValueError(f"expected HxWx3 image, got {frame.shape}")
    arr = (frame * 255.0).astype(np.uint8)
    img = Image.fromarray(arr, mode="RGB")

    input_dir = folder_paths.get_input_directory()
    sub = "minimax_director_refs"
    out_dir = os.path.join(input_dir, sub)
    os.makedirs(out_dir, exist_ok=True)
    name = f"{prefix}_{int(time.time() * 1000)}_{os.getpid()}.png"
    path = os.path.join(out_dir, name)
    img.save(path)
    rel = f"{sub}/{name}".replace("\\", "/")
    log.info("Saved ref image \u2192 input/%s", rel)
    return rel


def _set_ref_slot(
    target: dict,
    rel_path: str,
    *,
    slot: int = 0,
    role: str = "",
    role_label: str = "",
    from_global: bool = False,
    from_director: bool = True,
) -> None:
    role_key = str(role or "")
    badge = str(role_label or _ROLE_BADGE.get(role_key, "") or "")
    if role_key == "still" and int(slot) == 0 and not badge:
        badge = "静帧"
    ref = {
        "index": int(slot),
        "imageFile": rel_path,
        "imageB64": "",
        "role": role_key,
        "roleLabel": badge,
        "fromGlobal": bool(from_global),
        "fromDirector": bool(from_director),
    }
    refs = list(target.get("refs") or [])
    refs = [r for r in refs if int(r.get("index", r.get("slot", -1))) != int(slot)]
    refs.insert(0 if slot == 0 else len(refs), ref)
    refs.sort(key=lambda r: int(r.get("index", r.get("slot", 0))))
    target["refs"] = refs
    # Keep genImage mirror for legacy i2i / UI; i2v no longer treats this as first_frame.
    if int(slot) == 0:
        target["genImage"] = {"imageFile": rel_path, "imageB64": ""}
        target["imageFile"] = rel_path


def inject_ref_file(
    timeline: dict,
    rel_path: str,
    *,
    slot: int = 0,
    into_global: bool = True,
    into_groups: bool = False,
    segment_index: int | None = None,
    role: str = "",
    role_label: str = "",
    from_global: bool = False,
) -> dict:
    """Inject image into global/segment refs and i2v genImage slots."""
    ensure_image_director(timeline)
    kw = dict(
        slot=slot,
        role=role,
        role_label=role_label,
        from_global=from_global,
        from_director=True,
    )
    if into_global:
        _set_ref_slot(timeline.setdefault("global", {}), rel_path, **kw)
    segs = timeline.get("segments") or []
    if segment_index is not None:
        if 0 <= int(segment_index) < len(segs) and isinstance(segs[int(segment_index)], dict):
            _set_ref_slot(segs[int(segment_index)], rel_path, **kw)
    elif into_groups:
        for seg in segs:
            if isinstance(seg, dict):
                _set_ref_slot(seg, rel_path, **{**kw, "from_global": True})
    return timeline


def inject_global_ref_file(timeline: dict, rel_path: str, *, into_groups: bool = True) -> dict:
    return inject_ref_file(timeline, rel_path, slot=0, into_global=True, into_groups=into_groups)


def inject_global_ref_tensor(timeline: dict, image: torch.Tensor, *, into_groups: bool = True) -> tuple[dict, str]:
    rel = save_image_tensor_to_input(image, prefix="mmh3_global_ref")
    inject_global_ref_file(timeline, rel, into_groups=into_groups)
    return timeline, rel


def _model_type_hint(model) -> str:
    """Best-effort model family name for clearer errors (SDXL / FLUX / Z-Image …)."""
    try:
        mt = getattr(getattr(model, "model", None), "model_type", None)
        if mt is not None:
            return str(getattr(mt, "name", None) or mt)
    except Exception:
        pass
    try:
        name = type(getattr(model, "model", model)).__name__
        return name
    except Exception:
        return ""


def _model_image_model_key(model) -> str:
    """Read unet_config.image_model when present (flux / lumina2 / …)."""
    try:
        inner = getattr(model, "model", model)
        cfg = getattr(inner, "model_config", None)
        uc = getattr(cfg, "unet_config", None) or {}
        if isinstance(uc, dict):
            return str(uc.get("image_model") or "").strip().lower()
    except Exception:
        pass
    return ""


# Architectures that must never be used for Director still (ref) generation.
_VIDEO_IMAGE_MODELS = frozenset({
    "ltxav", "ltxv", "minimax_h3", "hunyuan_video", "wan2.1", "wan2.2",
    "mochi_preview", "cosmos", "cosmos_predict2", "anima",
})


def is_video_model_for_still(model) -> bool:
    """True if MODEL is a video DiT (H3 / LTX / Wan …) — not a T2I still model."""
    im = _model_image_model_key(model)
    if im in _VIDEO_IMAGE_MODELS or im.startswith("wan"):
        return True
    try:
        cls = type(getattr(model, "model", model)).__name__.upper()
    except Exception:
        cls = ""
    if any(k in cls for k in ("MINIMAX", "LTXAV", "LTXV", "HUNYUANVIDEO", "WANMODEL")):
        return True
    return False


def detect_still_model_family(model) -> str:
    """Return sdxl | flux | z_image | video | unknown from the connected MODEL."""
    if model is not None and is_video_model_for_still(model):
        return "video"
    hint = (_model_type_hint(model) or "").upper()
    try:
        cls = type(getattr(model, "model", model)).__name__.upper()
    except Exception:
        cls = ""
    image_model = _model_image_model_key(model)
    blob = f"{hint} {cls} {image_model}".upper()
    if any(k in blob for k in ("ZIMAGE", "Z_IMAGE", "Z-IMAGE")):
        return "z_image"
    if "LUMINA" in blob or image_model.startswith("lumina"):
        return "z_image"
    # LTX / H3 report ModelType.FLUX but image_model=ltxav — already handled as video.
    if image_model in ("flux", "flux2") or (hint == "FLUX" and image_model in ("", "flux", "flux2")):
        return "flux"
    if "FLUX" in cls and image_model in ("", "flux", "flux2"):
        return "flux"
    if "SDXL" in blob or hint in ("EPS", "V_PREDICTION", "EDM"):
        return "sdxl"
    return "unknown"


# Sampling + wiring hints for switchable local still models.
STILL_MODEL_PROFILES: dict[str, dict] = {
    "auto": {
        "label": "自动检测",
        "wire": "按已连接 MODEL 自动匹配采样；SDXL / FLUX / Z-Image 均可切换。",
    },
    "sdxl": {
        "label": "SDXL / SD1.5",
        "steps": 8,
        "cfg": 2.0,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "width": 1024,
        "height": 576,
        "wire": "CheckpointLoaderSimple（完整包）→ MODEL+CLIP+VAE。换文件名即可换模型。",
    },
    "flux": {
        "label": "FLUX",
        "steps": 20,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "width": 1024,
        "height": 1024,
        "wire": "UNETLoader + DualCLIPLoader + VAELoader → 三线接入（勿用仅 UNET 的 CheckpointLoader）。",
    },
    "z_image_turbo": {
        "label": "Z-Image-Turbo BF16",
        "steps": 8,
        "cfg": 1.0,
        "sampler": "res_multistep",
        "scheduler": "simple",
        "width": 1024,
        "height": 1024,
        "wire": (
            "UNETLoader: diffusion_models/z_image_turbo_bf16.safetensors；"
            "CLIPLoader: text_encoders/qwen_3_4b.safetensors（type 选 lumina2）；"
            "VAELoader: vae/ae.safetensors。三线接到 ref_gen_*。"
        ),
    },
}


def resolve_local_model_profile(timeline: dict, model=None) -> str:
    """Resolve effective local profile key (never returns bare auto if model known)."""
    ensure_image_director(timeline)
    raw = str(timeline["image_director"].get("local_model_profile") or "auto").strip().lower()
    aliases = {
        "z-image": "z_image_turbo",
        "zimage": "z_image_turbo",
        "z_image": "z_image_turbo",
        "z-image-turbo": "z_image_turbo",
        "z_image_turbo_bf16": "z_image_turbo",
        "sdxl_turbo": "sdxl",
        "sd": "sdxl",
        "sd15": "sdxl",
    }
    key = aliases.get(raw, raw)
    if key not in STILL_MODEL_PROFILES:
        key = "auto"
    if key != "auto":
        return key
    fam = detect_still_model_family(model) if model is not None else "unknown"
    if fam == "z_image":
        return "z_image_turbo"
    if fam == "flux":
        return "flux"
    if fam == "sdxl":
        return "sdxl"
    # video / unknown → keep auto (sampling left to UI; validation rejects video)
    return "auto"


def apply_still_profile_sampling(
    *,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    negative: str,
    profile: str,
    model=None,
) -> tuple[int, float, str, str, str]:
    """Soft-adjust sampling for Flux / Z-Image when profile or detection says so."""
    key = profile
    if key == "auto" or key not in STILL_MODEL_PROFILES:
        fam = detect_still_model_family(model) if model is not None else "unknown"
        if fam == "z_image":
            key = "z_image_turbo"
        elif fam == "flux":
            key = "flux"
        else:
            return steps, cfg, sampler_name, scheduler, negative

    use_steps = int(steps)
    use_cfg = float(cfg)
    use_sampler = str(sampler_name or "")
    use_scheduler = str(scheduler or "")
    use_neg = negative

    if key == "z_image_turbo":
        if use_cfg > 1.5:
            use_cfg = 1.0
        if use_sampler in ("euler_ancestral", "dpm_2_ancestral"):
            use_sampler = "res_multistep"
        if use_scheduler == "normal":
            use_scheduler = "simple"
        use_neg = (negative or "").strip()
    elif key == "flux":
        if use_cfg > 1.5:
            use_cfg = 1.0
        if use_sampler in ("euler_ancestral", "dpm_2_ancestral"):
            use_sampler = "euler"
        if use_scheduler == "normal":
            use_scheduler = "simple"
        use_neg = (negative or "").strip()

    return use_steps, use_cfg, use_sampler, use_scheduler, use_neg


def _clip_missing_error(model, *, profile: str = "auto") -> str:
    """Actionable message when ref_gen_clip is missing."""
    fam = detect_still_model_family(model)
    hint = _model_type_hint(model)
    im = _model_image_model_key(model)
    diag = f"（检测: family={fam or 'unknown'} model_type={hint or '?'} image_model={im or '?'}）"

    if fam == "video" or is_video_model_for_still(model):
        return (
            "文生图口接成了【视频模型】（如 LTX / MiniMax H3 / Wan），没有可用 CLIP，不能本地出参考图。"
            "请把「文生图 A」Checkpoint 改回 DreamShaperXL_Turbo_v2_1.safetensors（或其它完整 SDXL），"
            "或在「文生图模型切换」选 B·Z-Image-Turbo / 云端 API。"
            "勿在 CheckpointLoader 里选 ltx-*.safetensors / minimax_h3_*。"
            + diag
        )

    prefer = profile if profile in ("z_image_turbo", "flux", "sdxl") else ""
    if not prefer:
        if fam == "z_image":
            prefer = "z_image_turbo"
        elif fam == "flux":
            prefer = "flux"
        else:
            prefer = "auto"
    if prefer == "z_image_turbo":
        return (
            "本地 Z-Image 需要三条线：UNET + CLIP + VAE，当前缺 CLIP。"
            "请 CLIPLoader 加载 qwen_3_4b.safetensors（type=lumina2）→ ref_gen_clip，"
            "VAELoader 加载 ae.safetensors → ref_gen_vae。"
            + diag
        )
    if prefer == "flux":
        return (
            "本地 FLUX 需要三条线：UNET + DualCLIP + VAE，当前缺 CLIP。"
            "请 DualCLIPLoader → ref_gen_clip（勿只用 CheckpointLoader 加载仅 UNET 的 FLUX 文件）。"
            + diag
        )
    if prefer == "sdxl":
        return (
            "本地 SDXL 请用 CheckpointLoaderSimple 加载【完整包】（同时输出 MODEL+CLIP+VAE）。"
            "当前缺 CLIP：多半选成了视频/仅UNET 文件。请改选 DreamShaperXL_Turbo_v2_1.safetensors。"
            + diag
        )
    return (
        "CLIP 为空，本地生图无法编码提示词。"
        "请确认「文生图模型切换」选 A 且 Checkpoint=DreamShaperXL；"
        "或选 B·Z-Image 并接好三线；或改用云端 API。"
        + diag
    )


def _validate_still_checkpoint(model, clip, vae, *, profile: str = "auto") -> None:
    if model is None or vae is None:
        raise ValueError(
            "请连接文生图的 ref_gen_model / ref_gen_vae。"
            "可切换：SDXL 完整 Checkpoint，或 FLUX / Z-Image-Turbo 的 UNET+文本编码器+VAE。"
        )
    if is_video_model_for_still(model):
        im = _model_image_model_key(model)
        raise ValueError(
            f"ref_gen_model 是视频架构（image_model={im or '?'}），不能用于参考图文生图。"
            "请在「文生图 A」选 DreamShaperXL_Turbo_v2_1.safetensors，"
            "或切换到 B·Z-Image-Turbo / 云端 API。勿选 ltx / minimax_h3 视频权重。"
        )
    if clip is None:
        raise ValueError(_clip_missing_error(model, profile=profile))
    # CheckpointLoader may still emit a CLIP shell when weights are missing —
    # try a cheap tokenize to catch hollow clips early.
    try:
        if hasattr(clip, "tokenize"):
            clip.tokenize("test")
    except Exception as exc:
        raise ValueError(
            "CLIP 无法编码文本（Checkpoint 可能无文本编码器权重）。"
            "请改用完整 SDXL Checkpoint（DreamShaperXL），或 Z-Image / FLUX 三线接入。"
            f"（{exc}）"
        ) from exc


def _latent_space_for_vae(vae, model=None) -> tuple[int, int]:
    """Return (latent_channels, spatial_downscale) for empty-latent creation."""
    channels = 4
    downscale = 8
    try:
        channels = int(getattr(vae, "latent_channels", None) or channels)
    except Exception:
        pass
    try:
        ratio = getattr(vae, "downscale_ratio", None)
        if isinstance(ratio, (int, float)) and int(ratio) > 0:
            downscale = int(ratio)
        elif callable(ratio):
            # some VAEs expose downscale as method — keep default
            pass
    except Exception:
        pass
    try:
        if model is not None and hasattr(model, "get_model_object"):
            lf = model.get_model_object("latent_format")
            if lf is not None:
                channels = int(getattr(lf, "latent_channels", channels) or channels)
    except Exception:
        pass
    return max(1, channels), max(1, downscale)


def _make_empty_latent(model, vae, width: int, height: int, batch_size: int = 1) -> dict:
    """Create empty latent matching the connected VAE/model (SDXL=4ch, Flux=16ch, …)."""
    import comfy.model_management as model_management

    channels, downscale = _latent_space_for_vae(vae, model)
    # Align pixel size to latent grid
    step = max(8, downscale)
    w = max(step, int(width) // step * step)
    h = max(step, int(height) // step * step)
    latent = torch.zeros(
        [batch_size, channels, h // downscale, w // downscale],
        device=model_management.intermediate_device(),
        dtype=model_management.intermediate_dtype(),
    )
    return {"samples": latent, "downscale_ratio_spacial": downscale}


def generate_still_with_checkpoint(
    *,
    model,
    clip,
    vae,
    prompt: str,
    width: int = 1024,
    height: int = 576,
    seed: int = 0,
    steps: int = 8,
    cfg: float = 2.0,
    sampler_name: str = "euler_ancestral",
    scheduler: str = "normal",
    denoise: float = 1.0,
    negative: str = "",
    init_image: torch.Tensor | None = None,
) -> torch.Tensor:
    """Generate a still IMAGE using a connected checkpoint (SD/SDXL etc.), not MiniMax H3."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("参考图提示词为空，无法生图")
    _validate_still_checkpoint(model, clip, vae)

    from nodes import CLIPTextEncode, KSampler, VAEDecode, VAEEncode
    import torch.nn.functional as F

    _, downscale = _latent_space_for_vae(vae, model)
    step = max(8, int(downscale))
    w = max(step, int(width) // step * step)
    h = max(step, int(height) // step * step)
    neg = (negative or "").strip() or default_image_director()["negative"]
    dn = float(denoise)

    try:
        positive = CLIPTextEncode().encode(clip, prompt)[0]
        negative_cond = CLIPTextEncode().encode(clip, neg)[0]
    except Exception as exc:
        raise ValueError(
            f"本地生图 CLIP 编码失败：{exc}。"
            "请确认 ref_gen_clip 来自完整 SD/SDXL Checkpoint（非 MiniMax H3 / 非空 CLIP）。"
        ) from exc

    if init_image is not None:
        # img2img from director guide (character/scene). Auto soft denoise if still at 1.0.
        if dn >= 0.99:
            dn = 0.65
        t = init_image
        if not isinstance(t, torch.Tensor):
            t = torch.tensor(t)
        if t.ndim == 3:
            t = t.unsqueeze(0)
        t = t.detach().float().clamp(0, 1)
        # Resize to target
        x = t.permute(0, 3, 1, 2)
        x = F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False)
        t = x.permute(0, 2, 3, 1)
        try:
            latent = VAEEncode().encode(vae, t)[0]
        except Exception as exc:
            raise ValueError(f"本地生图 VAE 编码失败（img2img）：{exc}") from exc
    else:
        latent = _make_empty_latent(model, vae, w, h, 1)

    try:
        sampled = KSampler().sample(
            model,
            int(seed),
            int(steps),
            float(cfg),
            sampler_name,
            scheduler,
            positive,
            negative_cond,
            latent,
            float(dn),
        )[0]
        images = VAEDecode().decode(vae, sampled)[0]
    except Exception as exc:
        hint = _model_type_hint(model)
        raise ValueError(
            f"本地 Checkpoint 采样失败（{hint or 'unknown'}）：{exc}。"
            "本地生图推荐 SD 1.5 / SDXL；FLUX 请改用云端 API。"
        ) from exc
    if not isinstance(images, torch.Tensor):
        images = torch.tensor(images)
    if images.ndim == 3:
        images = images.unsqueeze(0)
    return images.cpu().float()


def resolve_gen_backend(timeline: dict) -> str:
    from .image_gen_api import merge_gen_api_fields, normalize_gen_backend

    ensure_image_director(timeline)
    merge_gen_api_fields(timeline["image_director"])
    return normalize_gen_backend(timeline["image_director"].get("gen_backend"))


def _cloud_still_ready(timeline: dict) -> bool:
    """True when cloud image API is configured enough to run."""
    from .image_gen_api import merge_gen_api_fields, resolve_api_key

    ensure_image_director(timeline)
    idir = merge_gen_api_fields(timeline["image_director"])
    has_key = bool(resolve_api_key(
        str(idir.get("gen_api_format") or ""),
        str(idir.get("gen_api_key") or ""),
    ))
    return bool(idir.get("gen_api_model")) and has_key


def _is_flux_like(model) -> bool:
    return detect_still_model_family(model) in ("flux", "z_image")


def generate_still(
    timeline: dict,
    *,
    prompt: str,
    ref_gen_model=None,
    ref_gen_clip=None,
    ref_gen_vae=None,
    width: int = 1024,
    height: int = 576,
    seed: int = 0,
    steps: int = 8,
    cfg: float = 2.0,
    sampler_name: str = "euler_ancestral",
    scheduler: str = "normal",
    denoise: float = 1.0,
    negative: str = "",
    init_image: torch.Tensor | None = None,
    force_backend: str | None = None,
) -> torch.Tensor:
    """Dispatch still gen to local checkpoint or cloud image API."""
    from .image_gen_api import generate_still_via_api, merge_gen_api_fields

    ensure_image_director(timeline)
    idir = merge_gen_api_fields(timeline["image_director"])
    backend = (force_backend or resolve_gen_backend(timeline) or "local").lower()
    if backend == "cloud":
        return generate_still_via_api(
            prompt=prompt,
            api_format=str(idir.get("gen_api_format") or ""),
            api_url=str(idir.get("gen_api_url") or ""),
            api_key=str(idir.get("gen_api_key") or ""),
            model=str(idir.get("gen_api_model") or ""),
            width=int(width),
            height=int(height),
        )

    profile = resolve_local_model_profile(timeline, ref_gen_model)
    use_steps, use_cfg, use_sampler, use_scheduler, use_neg = apply_still_profile_sampling(
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        negative=negative,
        profile=profile,
        model=ref_gen_model,
    )
    if profile != "auto":
        log.info("Local still profile=%s family=%s cfg=%s sampler=%s/%s",
                 profile, detect_still_model_family(ref_gen_model), use_cfg, use_sampler, use_scheduler)

    return generate_still_with_checkpoint(
        model=ref_gen_model,
        clip=ref_gen_clip,
        vae=ref_gen_vae,
        prompt=prompt,
        width=width,
        height=height,
        seed=seed,
        steps=use_steps,
        cfg=use_cfg,
        sampler_name=use_sampler,
        scheduler=use_scheduler,
        denoise=denoise,
        negative=use_neg,
        init_image=init_image,
    )


def empty_image_placeholder(width: int = 64, height: int = 64) -> torch.Tensor:
    return torch.zeros((1, max(1, height), max(1, width), 3), dtype=torch.float32)


def push_refs_to_ui(node_id: Any, timeline: dict, *, preview_files: list[str] | None = None) -> None:
    """Push injected refs back so the timeline UI shows thumbnails."""
    if node_id is None:
        return
    try:
        from server import PromptServer

        segs = timeline.get("segments") or []
        mode = str(timeline.get("timelineMode") or "")
        shots = list(timeline.get("shots") or []) if mode == "fl2v" else []
        payload = {
            "node_id": str(node_id),
            "global_refs": list((timeline.get("global") or {}).get("refs") or []),
            "segments": [
                {
                    "refs": list(s.get("refs") or []) if isinstance(s, dict) else [],
                    "prompt": str(s.get("prompt") or "") if isinstance(s, dict) else "",
                    "genImage": dict(s.get("genImage") or {}) if isinstance(s, dict) else {},
                    "endImage": dict(s.get("endImage") or {}) if isinstance(s, dict) and isinstance(s.get("endImage"), dict) else None,
                    "imageFile": str(s.get("imageFile") or "") if isinstance(s, dict) else "",
                }
                for s in segs
            ],
            # Omit empty shots for non-fl2v so UI never treats [] as fl2v sync
            "shots": shots,
            "timelineMode": mode,
            "image_director": dict(timeline.get("image_director") or {}),
            "global_prompt": str((timeline.get("global") or {}).get("prompt") or ""),
            "preview_files": list(preview_files or []),
            "stills_only": bool((timeline.get("image_director") or {}).get("stills_only_done")),
        }
        sid = getattr(PromptServer.instance, "client_id", None)
        sockets = getattr(PromptServer.instance, "sockets", None) or {}
        # Stale/missing sid would silently drop the event; broadcast instead
        if sid and sid not in sockets:
            sid = None
        PromptServer.instance.send_sync("minimax_director_refs", payload, sid)
    except Exception as exc:
        log.debug("push_refs_to_ui skipped: %s", exc)


def _stack_preview_images(images: list[torch.Tensor]) -> torch.Tensor:
    """Stack stills into one IMAGE batch for PreviewImage."""
    cleaned: list[torch.Tensor] = []
    for im in images:
        if im is None:
            continue
        t = im
        if not isinstance(t, torch.Tensor):
            t = torch.tensor(t)
        if t.ndim == 3:
            t = t.unsqueeze(0)
        cleaned.append(t.detach().cpu().float())
    if not cleaned:
        return empty_image_placeholder(64, 64)
    if len(cleaned) == 1:
        return cleaned[0]
    # Match spatial size to first image for cat
    h0, w0 = int(cleaned[0].shape[1]), int(cleaned[0].shape[2])
    aligned = []
    for t in cleaned:
        if int(t.shape[1]) == h0 and int(t.shape[2]) == w0:
            aligned.append(t)
        else:
            # naive center-crop / pad via interpolate
            import torch.nn.functional as F

            x = t.permute(0, 3, 1, 2)
            x = F.interpolate(x, size=(h0, w0), mode="bilinear", align_corners=False)
            aligned.append(x.permute(0, 2, 3, 1))
    return torch.cat(aligned, dim=0)


def run_auto_ref_generation(
    timeline: dict,
    *,
    global_ref_image=None,
    ref_gen_enable: bool = False,
    ref_gen_model=None,
    ref_gen_clip=None,
    ref_gen_vae=None,
    ref_image_prompt: str = "",
    width: int = 864,
    height: int = 480,
    seed: int = 0,
    steps: int = 20,
    cfg: float = 7.0,
    auto_inject: bool = True,
    generate_shot_stills: bool = True,
    node_id: Any = None,
    stills_only: bool = False,
) -> tuple[dict, torch.Tensor, list[str]]:
    """Generate selected refs — fl2v uses first/last frame director; else role/still plan."""
    from .fl_frame_director import is_fl2v_timeline, run_fl_frame_generation

    ensure_image_director(timeline)
    if is_fl2v_timeline(timeline):
        return run_fl_frame_generation(
            timeline,
            ref_gen_enable=ref_gen_enable,
            ref_gen_model=ref_gen_model,
            ref_gen_clip=ref_gen_clip,
            ref_gen_vae=ref_gen_vae,
            width=width,
            height=height,
            seed=seed,
            steps=steps,
            cfg=cfg,
            auto_inject=auto_inject,
            node_id=node_id,
            stills_only=stills_only,
        )

    jobs = expand_gen_jobs(timeline)
    if not generate_shot_stills:
        jobs = [j for j in jobs if not (j.get("scope") == "group" and j.get("role") == "still")]
    log.info("Image director jobs (%d): %s", len(jobs), jobs)

    saved: list[str] = []
    preview_tensors: list[torch.Tensor] = []
    # Prefer already-written UI prompts for generation; do not clobber multi-role text.
    stored_shots = str(timeline["image_director"].get("shot_image_prompts") or "").strip()
    if not stored_shots:
        rebuild_still_prompts(timeline, force=True)
    shots = build_shot_image_prompts(timeline)
    shot_prompt_map = {i: p for i, p in shots}
    if not stored_shots:
        timeline["image_director"]["shot_image_prompts"] = format_shot_image_prompts(shots)

    gp = resolve_still_gen_params(
        timeline,
        fallback_width=int(width or 1024),
        fallback_height=int(height or 576),
        fallback_seed=int(seed or 0),
        fallback_steps=int(steps or 8),
        fallback_cfg=float(cfg if cfg is not None else 2.0),
    )
    log.info(
        "Still gen params: %sx%s steps=%s cfg=%s sampler=%s/%s seed=%s",
        gp["width"], gp["height"], gp["steps"], gp["cfg"],
        gp["sampler"], gp["scheduler"], gp["seed"],
    )

    can_local = (
        ref_gen_model is not None
        and ref_gen_clip is not None
        and ref_gen_vae is not None
    )
    backend = resolve_gen_backend(timeline)
    cloud_ok = _cloud_still_ready(timeline)
    local_profile = resolve_local_model_profile(timeline, ref_gen_model)
    local_err = ""
    if backend == "local" and ref_gen_enable:
        log.info(
            "Local still wires: model=%s clip=%s vae=%s family=%s profile=%s",
            ref_gen_model is not None,
            ref_gen_clip is not None,
            ref_gen_vae is not None,
            detect_still_model_family(ref_gen_model) if ref_gen_model is not None else "none",
            local_profile,
        )
        try:
            _validate_still_checkpoint(
                ref_gen_model, ref_gen_clip, ref_gen_vae, profile=local_profile
            )
        except ValueError as exc:
            can_local = False
            local_err = str(exc)

    if backend == "cloud":
        can_gen = bool(ref_gen_enable) and cloud_ok
    else:
        can_gen = bool(ref_gen_enable) and can_local

    # Local 不可用时，若云端已配置则回退（不静默换模型）。
    effective_backend = backend
    if ref_gen_enable and backend == "local" and not can_local and cloud_ok:
        log.warning(
            "Local still unusable (%s); auto-fallback to cloud API.",
            local_err or "missing MODEL/CLIP/VAE",
        )
        effective_backend = "cloud"
        can_gen = True
        timeline.setdefault("image_director", {})["gen_backend_effective"] = "cloud"
        timeline["image_director"]["last_gen_note"] = (
            "本地文生图接线无效，已改用云端。"
            + (f" {local_err}" if local_err else "")
        )

    if ref_gen_enable and not can_gen and global_ref_image is None:
        if effective_backend == "cloud" or backend == "cloud":
            raise ValueError(
                "已开启参考图生图（云端 API），请填写生图模型与 API Key"
                "（或设置环境变量 ZHIPU_API_KEY / OPENAI_API_KEY）。"
            )
        if local_err:
            raise ValueError(
                f"{local_err} "
                "【快速修复】「文生图 A」Checkpoint 请选 DreamShaperXL_Turbo_v2_1.safetensors"
                "（不要选 ltx-*.safetensors / 视频权重）；切换节点保持「A · SDXL」。"
                "或导演台把生图后端改为「云端 API」。"
            )
        raise ValueError(
            "已开启「Queue 时生成全局参考图」，"
            "但未连接 ref_gen_model / ref_gen_clip / ref_gen_vae。"
            "可切换本地模型：SDXL 完整 Checkpoint，或 Z-Image-Turbo / FLUX 三线接入；"
            "也可将生图后端改为「云端 API」。"
        )

    def _gen_one(prompt: str, *, seed_off: int = 0, init_image=None, prefix: str = "mmh3_ref"):
        img = generate_still(
            timeline,
            prompt=prompt,
            ref_gen_model=ref_gen_model,
            ref_gen_clip=ref_gen_clip,
            ref_gen_vae=ref_gen_vae,
            width=gp["width"],
            height=gp["height"],
            seed=int(gp["seed"]) + int(seed_off),
            steps=gp["steps"],
            cfg=gp["cfg"],
            sampler_name=gp["sampler"],
            scheduler=gp["scheduler"],
            denoise=gp["denoise"],
            negative=gp["negative"],
            init_image=None if effective_backend == "cloud" else init_image,
            force_backend=effective_backend,
        )
        preview_tensors.append(img)
        rel = save_image_tensor_to_input(img, prefix=prefix)
        saved.append(rel)
        return img, rel

    guide_init = pick_guide_init_image(timeline)
    seed_i = 0
    used_external_global = False
    job_errors: list[str] = []

    def _slot_already_filled(scope_name: str, slot_i: int, seg_i=None) -> bool:
        """Skip re-gen when slot already has an image (supports resume after timeout)."""
        if scope_name == "global":
            grefs = (timeline.get("global") or {}).get("refs") or []
            hit = next(
                (
                    r for r in grefs
                    if isinstance(r, dict)
                    and int(r.get("index", r.get("slot", -1))) == int(slot_i)
                    and r.get("imageFile")
                ),
                None,
            )
            return bool(hit)
        if scope_name == "group" and seg_i is not None:
            segs = timeline.get("segments") or []
            if not (0 <= int(seg_i) < len(segs) and isinstance(segs[int(seg_i)], dict)):
                return False
            srefs = segs[int(seg_i)].get("refs") or []
            hit = next(
                (
                    r for r in srefs
                    if isinstance(r, dict)
                    and int(r.get("index", r.get("slot", -1))) == int(slot_i)
                    and r.get("imageFile")
                    and not r.get("fromGlobal")
                ),
                None,
            )
            return bool(hit)
        return False

    for job in jobs:
        scope = job.get("scope")
        role = str(job.get("role") or "still")
        seg_idx = job.get("seg_idx")
        asset_index = job.get("asset_index")
        custom_prompt = str(job.get("prompt") or "").strip()
        custom_label = str(job.get("label") or "").strip()
        if job.get("slot") is not None:
            try:
                slot = int(job["slot"])
            except (TypeError, ValueError):
                slot = int(_ROLE_SLOT.get(role, 0))
        else:
            slot = int(_ROLE_SLOT.get(role, 0))
        badge = custom_label or _ROLE_BADGE.get(role, role)
        seed_i += 1

        # stills_only / 「仅生参考图」必须强制重跑，否则云端已填槽后本地会全部 Skip。
        if (
            can_gen
            and not stills_only
            and _slot_already_filled(str(scope or ""), slot, seg_idx)
        ):
            log.info(
                "Skip %s %s slot %s (%s): already has image",
                scope, role, slot, badge,
            )
            continue

        try:
            if scope == "global":
                # Prefer connected global_ref_image once for global still
                if role == "still" and global_ref_image is not None and not used_external_global:
                    img = global_ref_image
                    preview_tensors.append(img)
                    rel = save_image_tensor_to_input(img, prefix="mmh3_global_still")
                    saved.append(rel)
                    used_external_global = True
                elif can_gen:
                    if custom_prompt:
                        prompt = custom_prompt
                        ai = None if asset_index is None else int(asset_index)
                        prefix = f"mmh3_global_{role}" + (f"_{ai + 1}" if ai is not None else "")
                    elif role == "still":
                        prompt = (ref_image_prompt or "").strip() or build_global_ref_prompt(timeline)
                        prefix = "mmh3_global_still"
                    else:
                        ai = None if asset_index is None else int(asset_index)
                        prompt = build_role_ref_prompt(timeline, role, asset_index=ai)
                        prefix = f"mmh3_global_{role}" + (f"_{ai + 1}" if ai is not None else "")
                    init = _first_image(
                        pick_guide_init_image(
                            timeline,
                            prefer_role=role if role != "still" else "character",
                        ),
                        guide_init,
                    )
                    img, rel = _gen_one(prompt, seed_off=13 * seed_i, init_image=init, prefix=prefix)
                else:
                    continue

                if auto_inject:
                    inject_ref_file(
                        timeline,
                        rel,
                        slot=slot,
                        into_global=True,
                        into_groups=False,
                        role=role,
                        role_label=f"全局·{badge}",
                        from_global=False,
                    )
                    # Sync into empty group slots of the same index (labeled 全局·*)
                    segs = timeline.get("segments") or []
                    for gi, seg in enumerate(segs):
                        if not isinstance(seg, dict):
                            continue
                        srefs = seg.get("refs") or []
                        existing = next(
                            (r for r in srefs if int(r.get("index", r.get("slot", -1))) == slot),
                            None,
                        )
                        if existing and existing.get("imageFile") and not existing.get("fromGlobal"):
                            continue
                        inject_ref_file(
                            timeline,
                            rel,
                            slot=slot,
                            into_global=False,
                            segment_index=gi,
                            role=role,
                            role_label=f"全局·{badge}",
                            from_global=True,
                        )
                    # Do NOT upsert into guide_refs: that slot is user img2img init only.
                    # Generated stills go to timeline picture slots + preview output.
                    if role == "character":
                        guide_init = _first_image(
                            pick_guide_init_image(timeline, prefer_role="character"),
                            guide_init,
                        )
                    log.info("Injected global %s -> slot %s (%s)", role, slot, rel)

            elif scope == "group" and seg_idx is not None and can_gen:
                if role == "still" and seg_idx in shot_prompt_map:
                    prompt = shot_prompt_map[seg_idx]
                else:
                    prompt = build_shot_role_ref_prompt(timeline, int(seg_idx), role)
                init = _first_image(
                    pick_guide_init_image(
                        timeline,
                        prefer_role=role if role != "still" else "character",
                        segment_index=int(seg_idx),
                    ),
                    guide_init,
                )
                img, rel = _gen_one(
                    prompt,
                    seed_off=17 * seed_i + int(seg_idx) * 3,
                    init_image=init,
                    prefix=f"mmh3_g{int(seg_idx)+1}_{role}",
                )
                if auto_inject:
                    inject_ref_file(
                        timeline,
                        rel,
                        slot=slot,
                        into_global=False,
                        segment_index=int(seg_idx),
                        role=role,
                        role_label=badge,
                        from_global=False,
                    )
                    # Do NOT upsert into groups_gen.refs — those are user init refs for director.
                    log.info("Injected group %s %s -> slot %s (%s)", seg_idx + 1, role, slot, rel)
        except Exception as exc:
            label = custom_label or role
            msg = f"{label}({scope}/{role}/slot{slot}): {exc}"
            job_errors.append(msg)
            log.warning("Job %s failed: %s", job, exc)
            # Keep going so later assets can still succeed; raise only after the loop
            # when nothing was produced at all.
            continue

    # Also inject any manually uploaded guide_refs into free global slots (role slots preferred)
    if auto_inject:
        grefs = list((timeline.get("global") or {}).get("refs") or [])
        used_slots = {
            int(r.get("index", r.get("slot", -1)))
            for r in grefs
            if isinstance(r, dict) and r.get("imageFile")
        }
        role_seen: dict[str, int] = {}
        for it in timeline["image_director"].get("guide_refs") or []:
            if not isinstance(it, dict) or not it.get("imageFile"):
                continue
            role = str(it.get("role") or "other")
            if role not in _ROLE_SLOT and it.get("slot") is None:
                continue
            count = role_seen.get(role, 0)
            role_seen[role] = count + 1
            if it.get("slot") is not None:
                try:
                    slot = int(it["slot"])
                except (TypeError, ValueError):
                    slot = None
            else:
                slot = None
            if slot is None:
                preferred = int(_ROLE_SLOT[role]) if role in _ROLE_SLOT and count == 0 else None
                slot = _next_free_slot(used_slots, preferred)
            if slot is None:
                continue
            existing = next(
                (r for r in grefs if int(r.get("index", r.get("slot", -1))) == slot and r.get("imageFile")),
                None,
            )
            if existing and not existing.get("fromDirector"):
                used_slots.add(slot)
                continue
            if existing and existing.get("imageFile") == it["imageFile"]:
                used_slots.add(slot)
                continue
            # Don't overwrite director-generated for same role unless guide is newer user upload
            if existing and existing.get("fromDirector") and it.get("auto_generated"):
                used_slots.add(slot)
                continue
            badge = str(it.get("label") or "").strip() or _ROLE_BADGE.get(role, role)
            inject_ref_file(
                timeline,
                str(it["imageFile"]),
                slot=slot,
                into_global=True,
                into_groups=False,
                role=role,
                role_label=f"全局·{badge}",
            )
            used_slots.add(slot)
        for gi in range(len(timeline.get("segments") or [])):
            inject_group_guide_refs(timeline, gi)

    global_out = _stack_preview_images(preview_tensors)

    if auto_inject and saved:
        ensure_picture_tags_on_timeline(timeline, slot=0)
        if stills_only and not job_errors:
            timeline["image_director"]["stills_only_done"] = True
            timeline["image_director"]["generate_on_queue"] = False
        push_refs_to_ui(node_id, timeline, preview_files=saved)

    if job_errors:
        summary = "；".join(job_errors[:4])
        if len(job_errors) > 4:
            summary += f" …共 {len(job_errors)} 项失败"
        if not saved:
            raise RuntimeError(
                f"参考图导演全部生图失败（{len(job_errors)}/{len(jobs)}）：{summary}"
            )
        # Partial success: keep injected images, surface a clear warning.
        log.error(
            "Image director partial failure (%d ok, %d failed): %s",
            len(saved), len(job_errors), summary,
        )
        if stills_only:
            # Soft-fail: return what we have; user can re-queue to fill missing slots.
            timeline.setdefault("image_director", {})["last_gen_errors"] = job_errors
            log.warning(
                "stills_only: returning %d success(es); re-queue to retry failed slots. Errors: %s",
                len(saved), summary,
            )

    return timeline, global_out, saved
