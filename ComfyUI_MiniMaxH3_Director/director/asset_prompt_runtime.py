# -*- coding: utf-8 -*-
"""Extract character sheet + scene still prompts from story for Image Director."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.asset_prompts")

ASSET_SYSTEM_PATH = Path(__file__).resolve().parent.parent / "prompts" / "h3_asset_extract_system.txt"

_CHAR_MARK = re.compile(r"<<<\s*CHAR[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
_SCENE_MARK = re.compile(r"<<<\s*SCENE[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
# Common cloud-model variants (DeepSeek / markdown / Chinese brackets)
_CHAR_MARK_ALT = re.compile(
    r"(?:"
    r"<<<\s*CHAR[_\s-]*(\d+)\s*>>>"
    r"|【\s*(?:人物|角色|CHAR)\s*[_-]?\s*(\d+)\s*】"
    r"|#{1,3}\s*(?:人物|角色|CHAR)\s*[_-]?\s*(\d+)\b"
    r"|={2,}\s*(?:人物|角色|CHAR)\s*[_-]?\s*(\d+)\s*={0,}"
    r"|(?:^|\n)\s*(?:人物|角色)\s*(\d+)\s*[:：]"
    r")",
    re.IGNORECASE,
)
_SCENE_MARK_ALT = re.compile(
    r"(?:"
    r"<<<\s*SCENE[_\s-]*(\d+)\s*>>>"
    r"|【\s*(?:场景|地点|SCENE)\s*[_-]?\s*(\d+)\s*】"
    r"|#{1,3}\s*(?:场景|地点|SCENE)\s*[_-]?\s*(\d+)\b"
    r"|={2,}\s*(?:场景|地点|SCENE)\s*[_-]?\s*(\d+)\s*={0,}"
    r"|(?:^|\n)\s*(?:场景|地点)\s*(\d+)\s*[:：]"
    r")",
    re.IGNORECASE,
)
_META_LINE = re.compile(
    r"^(name|名称|角色名|场景名|sheet_prompt|三视图提示词|定妆提示词|生图提示词|提示词|prompt|"
    r"image_prompt|场景提示词|appearance|外貌|description|描述)\s*[:：]\s*(.*)$",
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
        raw = line.strip().lstrip("-*• ").strip()
        m = _META_LINE.match(raw)
        if not m:
            if raw:
                body_lines.append(line.rstrip())
            continue
        key = m.group(1).strip().lower()
        val = m.group(2).strip()
        if key in ("name", "名称", "角色名", "场景名"):
            out["name"] = val
        elif key in ("sheet_prompt", "三视图提示词", "定妆提示词", "生图提示词", "提示词", "prompt"):
            out["sheet_prompt"] = val
            out.setdefault("image_prompt", val)
        elif key in ("image_prompt", "场景提示词"):
            out["image_prompt"] = val
        elif key in ("appearance", "外貌", "description", "描述"):
            out["appearance"] = val
    if body_lines:
        blob = "\n".join(body_lines).strip()
        if blob and "sheet_prompt" not in out and "image_prompt" not in out:
            if "三视图" in blob or "大头" in blob or "front" in blob.lower() or "character sheet" in blob.lower():
                out.setdefault("sheet_prompt", blob)
            else:
                out.setdefault("image_prompt", blob)
                out.setdefault("sheet_prompt", blob)
    return out


def _mark_index(match: re.Match) -> int:
    for g in match.groups():
        if g is not None:
            try:
                return int(g)
            except (TypeError, ValueError):
                continue
    return 1


def _items_from_marks(
    text: str,
    mark_re: re.Pattern,
    kind: str,
    other_re: re.Pattern,
) -> list[dict[str, Any]]:
    marks = list(mark_re.finditer(text))
    items: list[dict[str, Any]] = []
    if not marks:
        return items
    by_idx: dict[int, str] = {}
    for i, m in enumerate(marks):
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        chunk = text[start:end]
        other = other_re.search(chunk)
        if other:
            chunk = chunk[: other.start()]
        by_idx[_mark_index(m)] = chunk.strip()
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


def _parse_json_assets(text: str) -> dict[str, list[dict[str, Any]]] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    candidates: list[str] = []
    if raw.startswith("{") or raw.startswith("["):
        candidates.append(raw)
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fence:
        candidates.append(fence.group(1).strip())
    brace = re.search(r"\{[\s\S]*\}", raw)
    if brace:
        candidates.append(brace.group(0))
    for cand in candidates:
        try:
            data = json.loads(cand)
        except Exception:
            continue
        chars_in: list = []
        scenes_in: list = []
        if isinstance(data, dict):
            chars_in = data.get("characters") or data.get("chars") or data.get("人物") or []
            scenes_in = data.get("scenes") or data.get("locations") or data.get("场景") or []
        elif isinstance(data, list):
            for it in data:
                if not isinstance(it, dict):
                    continue
                role = str(it.get("role") or it.get("type") or "").lower()
                if role in {"scene", "location", "场景", "地点"}:
                    scenes_in.append(it)
                else:
                    chars_in.append(it)
        characters: list[dict[str, Any]] = []
        scenes: list[dict[str, Any]] = []
        for c in chars_in:
            if isinstance(c, str) and c.strip():
                characters.append({"name": c.strip()[:40], "appearance": "", "sheet_prompt": c.strip()})
                continue
            if not isinstance(c, dict):
                continue
            name = str(c.get("name") or c.get("label") or c.get("名称") or "").strip()
            prompt = str(
                c.get("sheet_prompt")
                or c.get("prompt")
                or c.get("image_prompt")
                or c.get("提示词")
                or ""
            ).strip()
            if not prompt:
                continue
            characters.append(
                {
                    "name": name or f"人物{len(characters) + 1}",
                    "appearance": str(c.get("appearance") or c.get("外貌") or "").strip(),
                    "sheet_prompt": prompt,
                }
            )
        for s in scenes_in:
            if isinstance(s, str) and s.strip():
                scenes.append({"name": s.strip()[:40], "description": "", "image_prompt": s.strip()})
                continue
            if not isinstance(s, dict):
                continue
            name = str(s.get("name") or s.get("label") or s.get("名称") or "").strip()
            prompt = str(
                s.get("image_prompt")
                or s.get("prompt")
                or s.get("sheet_prompt")
                or s.get("提示词")
                or ""
            ).strip()
            if not prompt:
                continue
            scenes.append(
                {
                    "name": name or f"场景{len(scenes) + 1}",
                    "description": str(s.get("description") or s.get("appearance") or "").strip(),
                    "image_prompt": prompt,
                }
            )
        if characters or scenes:
            return {"characters": characters[:6], "scenes": scenes[:6]}
    return None


def parse_asset_extract_output(text: str) -> dict[str, list[dict[str, Any]]]:
    """Parse <<<CHAR_n>>> / <<<SCENE_n>>> blocks, with cloud-model fallbacks."""
    text = str(text or "").strip()
    # Drop leftover think / analysis wrappers that some APIs leave behind.
    text = re.sub(r"(?is)<think>.*?</think>", "", text)
    text = re.sub(r"(?is)<thinking>.*?</thinking>", "", text)
    text = text.strip()

    characters = _items_from_marks(text, _CHAR_MARK, "char", _SCENE_MARK)
    scenes = _items_from_marks(text, _SCENE_MARK, "scene", _CHAR_MARK)
    if characters or scenes:
        return {"characters": characters[:6], "scenes": scenes[:6]}

    characters = _items_from_marks(text, _CHAR_MARK_ALT, "char", _SCENE_MARK_ALT)
    scenes = _items_from_marks(text, _SCENE_MARK_ALT, "scene", _CHAR_MARK_ALT)
    if characters or scenes:
        log.info("extract_assets: parsed via alternate markers")
        return {"characters": characters[:6], "scenes": scenes[:6]}

    parsed_json = _parse_json_assets(text)
    if parsed_json:
        log.info("extract_assets: parsed via JSON fallback")
        return parsed_json

    return {"characters": [], "scenes": []}


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
        "",
        "【强制输出格式】必须逐字使用下列分隔符（各占一行），禁止改成 markdown/JSON/编号列表：",
        "<<<CHAR_1>>>",
        "name: 角色名",
        "appearance: 外貌短描述",
        "sheet_prompt: 完整中文生图提示词",
        "<<<SCENE_1>>>",
        "name: 场景名",
        "appearance: 环境短描述",
        "image_prompt: 完整中文场景图提示词",
        "不要前言、不要代码围栏、不要解释。",
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
    lines.append("")
    lines.append("再次提醒：输出必须以 <<<CHAR_1>>> 或 <<<SCENE_1>>> 开头的分隔符块，否则无效。")
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
    cleaned = _strip_wrappers(raw or "")
    assets = parse_asset_extract_output(cleaned)
    if not assets.get("characters") and not assets.get("scenes"):
        preview = re.sub(r"\s+", " ", cleaned).strip()[:240]
        log.warning("extract_assets parse miss; raw preview: %s", preview)
        raise RuntimeError(
            "未解析到人物/场景块。请确认模型输出含 <<<CHAR_1>>> / <<<SCENE_1>>>。"
            + (f" 模型原文摘要：{preview}" if preview else "（模型返回为空，可换 deepseek-chat 或提高 max_tokens）")
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
