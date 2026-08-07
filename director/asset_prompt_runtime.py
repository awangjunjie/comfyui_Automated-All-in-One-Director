# -*- coding: utf-8 -*-
"""Extract character sheet + scene still prompts from story for Image Director."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.asset_prompts")

ASSET_SYSTEM_PATH = Path(__file__).resolve().parent.parent / "prompts" / "h3_asset_extract_system.txt"

_CHAR_MARK = re.compile(r"<<<\s*CHAR[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
_SCENE_MARK = re.compile(r"<<<\s*SCENE[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
_META_LINE = re.compile(
    r"^(name|名称|sheet_prompt|三视图提示词|定妆提示词|image_prompt|场景提示词|appearance|外貌|description|描述)\s*[:：]\s*(.*)$",
    re.IGNORECASE,
)


def _load_asset_system_prompt() -> str:
    if ASSET_SYSTEM_PATH.is_file():
        return ASSET_SYSTEM_PATH.read_text(encoding="utf-8")
    return (
        "你是影视美术设定助手。从故事中提取主要人物与场景，"
        "为每人写「大头照+三视图集合单图」生图提示词，为每场景写场景图提示词。"
        "只用分隔符输出，不要解释。"
    )


def _parse_kv_block(block: str) -> dict[str, str]:
    out: dict[str, str] = {}
    body_lines: list[str] = []
    for line in str(block or "").splitlines():
        m = _META_LINE.match(line.strip())
        if not m:
            if line.strip():
                body_lines.append(line.rstrip())
            continue
        key = m.group(1).strip().lower()
        val = m.group(2).strip()
        if key in ("name", "名称"):
            out["name"] = val
        elif key in ("sheet_prompt", "三视图提示词", "定妆提示词"):
            out["sheet_prompt"] = val
        elif key in ("image_prompt", "场景提示词"):
            out["image_prompt"] = val
        elif key in ("appearance", "外貌", "description", "描述"):
            out["appearance"] = val
    if body_lines:
        blob = "\n".join(body_lines).strip()
        if blob and "sheet_prompt" not in out and "image_prompt" not in out:
            if "三视图" in blob or "大头" in blob or "front" in blob.lower():
                out.setdefault("sheet_prompt", blob)
            else:
                out.setdefault("image_prompt", blob)
                out.setdefault("sheet_prompt", blob)
    return out


def parse_asset_extract_output(text: str) -> dict[str, list[dict[str, Any]]]:
    """Parse <<<CHAR_n>>> / <<<SCENE_n>>> blocks."""
    text = str(text or "").strip()

    def _split(mark_re: re.Pattern, kind: str) -> list[dict[str, Any]]:
        marks = list(mark_re.finditer(text))
        items: list[dict[str, Any]] = []
        if not marks:
            return items
        by_idx: dict[int, str] = {}
        for i, m in enumerate(marks):
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            chunk = text[start:end]
            other = (_SCENE_MARK if kind == "char" else _CHAR_MARK).search(chunk)
            if other:
                chunk = chunk[: other.start()]
            by_idx[int(m.group(1))] = chunk.strip()
        for idx in sorted(by_idx.keys()):
            kv = _parse_kv_block(by_idx[idx])
            name = (kv.get("name") or f"{'人物' if kind == 'char' else '场景'}{idx}").strip()
            if kind == "char":
                prompt = (kv.get("sheet_prompt") or kv.get("image_prompt") or "").strip()
                if not prompt:
                    continue
                items.append(
                    {
                        "name": name,
                        "appearance": (kv.get("appearance") or "").strip(),
                        "sheet_prompt": prompt,
                    }
                )
            else:
                prompt = (kv.get("image_prompt") or kv.get("sheet_prompt") or "").strip()
                if not prompt:
                    continue
                items.append(
                    {
                        "name": name,
                        "description": (kv.get("appearance") or "").strip(),
                        "image_prompt": prompt,
                    }
                )
        return items

    characters = _split(_CHAR_MARK, "char")
    scenes = _split(_SCENE_MARK, "scene")
    return {"characters": characters[:6], "scenes": scenes[:6]}


def _build_extract_user_message(
    *,
    brief: str,
    global_prompt: str = "",
    style: str = "",
) -> str:
    lines = [
        "OUTPUT=ASSET_EXTRACT",
        "",
        "请从下列故事中提取主要人物与关键场景。",
        "每个人物输出一张「大头照 + 正面/侧面/背面三视图」集合单图的中文生图提示词（适合文生图）。",
        "每个场景输出一张空镜/环境场景图的中文生图提示词。",
        "分隔符各占一行：<<<CHAR_1>>> … <<<SCENE_1>>> …",
        "每个块内写：",
        "name: …",
        "appearance: …（人物）或 description: …（场景，可写在 appearance 行）",
        "sheet_prompt: …（人物集合单图）或 image_prompt: …（场景图）",
        "不要前言、不要 markdown。",
        "",
    ]
    if style.strip():
        lines.append(f"整体画风参考：{style.strip()}")
        lines.append("")
    if global_prompt.strip():
        lines.append("已有全局提示词：")
        lines.append(global_prompt.strip()[:2000])
        lines.append("")
    lines.append("故事 / 创意简述：")
    lines.append((brief or "").strip()[:4000])
    return "\n".join(lines)


def apply_assets_to_timeline(
    timeline: dict,
    assets: dict[str, Any],
    *,
    enable_gen: bool = True,
    clear_still_gen: bool = True,
) -> dict:
    """Write asset prompts into image director; only fill empty continuity fields."""
    from .image_director import ensure_image_director, rebuild_still_prompts

    ensure_image_director(timeline)
    chars = [c for c in (assets.get("characters") or []) if isinstance(c, dict)]
    scenes = [s for s in (assets.get("scenes") or []) if isinstance(s, dict)]

    cont = timeline.setdefault("continuity", {})
    if not isinstance(cont, dict):
        cont = {}
        timeline["continuity"] = cont
    # Only fill empty continuity fields — never overwrite bible / manual edits
    if chars and not str(cont.get("characters") or "").strip():
        cont["characters"] = "；".join(
            f"{c.get('name') or '角色'}：{(c.get('appearance') or c.get('sheet_prompt') or '')[:120]}"
            for c in chars
        )
    if scenes and not str(cont.get("locations") or "").strip():
        cont["locations"] = "；".join(
            f"{s.get('name') or '场景'}：{(s.get('description') or s.get('image_prompt') or '')[:120]}"
            for s in scenes
        )

    idir = timeline["image_director"]
    idir["asset_prompts"] = {
        "characters": chars,
        "scenes": scenes,
    }
    idir["enabled"] = True
    if enable_gen:
        ggen = idir.setdefault("global_gen", {})
        if chars:
            ggen["character"] = True
        if scenes:
            ggen["scene"] = True
        if clear_still_gen and (chars or scenes):
            ggen["still"] = False
        idir["gen_targets"] = idir.get("gen_targets") or {}
        idir["gen_targets"]["character"] = bool(ggen.get("character"))
        idir["gen_targets"]["scene"] = bool(ggen.get("scene"))
        idir["gen_targets"]["global"] = bool(ggen.get("still"))

    # Prefill empty guide cards so Image Director panel shows one card per asset
    guides = idir.setdefault("guide_refs", [])
    if not isinstance(guides, list):
        guides = []
        idir["guide_refs"] = guides

    def _ensure_card(role: str, label: str) -> None:
        label = (label or "").strip()
        for it in guides:
            if not isinstance(it, dict):
                continue
            if it.get("role") == role and str(it.get("label") or "").strip() == label:
                return
        guides.append(
            {
                "id": f"asset_{role}_{len(guides)}_{int(__import__('time').time() * 1000)}",
                "role": role,
                "label": label,
                "imageFile": "",
                "from_asset_extract": True,
            }
        )

    for c in chars:
        _ensure_card("character", str(c.get("name") or ""))
    for s in scenes:
        _ensure_card("scene", str(s.get("name") or ""))

    rebuild_still_prompts(timeline, force=True)
    return timeline


def extract_and_import_assets(
    timeline: dict,
    *,
    brief: str = "",
    model: str,
    backend: str = "local",
    enable_gen: bool = True,
    **llm_kwargs,
) -> dict[str, Any]:
    """LLM extract → parse → apply to image director. Returns summary dict."""
    from .local_director_runtime import _run_director_llm, _strip_wrappers

    story = (brief or "").strip()
    if not story:
        story = str((timeline.get("global") or {}).get("prompt") or "").strip()
    if not story:
        segs = timeline.get("segments") or []
        parts = [str(s.get("prompt") or "").strip() for s in segs if isinstance(s, dict)]
        story = "\n".join(p for p in parts if p)[:4000]
    if not story:
        raise ValueError("请先填写故事或完成分镜扩写，再提取人物/场景")

    global_prompt = str((timeline.get("global") or {}).get("prompt") or "")
    style = str((timeline.get("desk") or {}).get("style") or "")
    user_msg = _build_extract_user_message(
        brief=story,
        global_prompt=global_prompt,
        style=style,
    )
    kw = dict(llm_kwargs)
    kw.setdefault("max_tokens", 4096)
    kw.setdefault("temperature", 0.55)
    allow = (
        "llm_url", "api_format", "api_key", "max_tokens", "temperature",
        "timeout_seconds", "thinking", "mmproj", "top_p", "top_k",
        "repeat_penalty", "ctx_size", "memory_mode", "n_gpu_layers",
        "n_cpu_moe_layers", "seed", "reasoning", "system_prompt", "system_prompt_path",
    )
    raw = _run_director_llm(
        backend=backend,
        model=model,
        user_msg=user_msg,
        system_prompt=_load_asset_system_prompt(),
        system_prompt_path=ASSET_SYSTEM_PATH if ASSET_SYSTEM_PATH.is_file() else None,
        **{k: kw[k] for k in allow if k in kw and k not in ("system_prompt", "system_prompt_path")},
    )
    assets = parse_asset_extract_output(_strip_wrappers(raw or ""))
    if not assets.get("characters") and not assets.get("scenes"):
        raise RuntimeError(
            "未解析到人物/场景块。请确认模型输出含 <<<CHAR_1>>> / <<<SCENE_1>>>。"
        )
    apply_assets_to_timeline(timeline, assets, enable_gen=enable_gen)
    log.info(
        "extract_assets: %d character(s), %d scene(s)",
        len(assets.get("characters") or []),
        len(assets.get("scenes") or []),
    )
    return {
        "characters": assets.get("characters") or [],
        "scenes": assets.get("scenes") or [],
        "image_director": timeline.get("image_director"),
        "continuity": timeline.get("continuity"),
    }
