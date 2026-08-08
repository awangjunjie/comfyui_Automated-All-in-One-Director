# -*- coding: utf-8 -*-
"""Extract continuity + global soundscape (desk) fields from story for Studio Desk."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from .studio_enrich import default_continuity, default_desk, ensure_studio_fields

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.studio_bible")

BIBLE_SYSTEM_PATH = Path(__file__).resolve().parent.parent / "prompts" / "h3_studio_bible_system.txt"

_CONT_MARK = re.compile(r"<<<\s*CONTINUITY\s*>>>", re.IGNORECASE)
_SOUND_MARK = re.compile(r"<<<\s*SOUNDSCAPE\s*>>>", re.IGNORECASE)

# Strip common LLM decorations before key matching
_LINE_PREFIX = re.compile(
    r"^(?:[-*•]+\s+|\d+[\.\)、]\s*|#{1,6}\s*|\*\*|__)*",
)
_LINE_KEY_WRAP = re.compile(r"^[\*`【\[]*(.+?)[\*`】\]]*$")

_KEY_ALIASES = {
    # continuity
    "characters": "characters",
    "character": "characters",
    "角色": "characters",
    "角色设定": "characters",
    "人物": "characters",
    "人物设定": "characters",
    "出场角色": "characters",
    "主要角色": "characters",
    "主体角色": "characters",
    "locations": "locations",
    "location": "locations",
    "场景": "locations",
    "场景设定": "locations",
    "地点": "locations",
    "地点设定": "locations",
    "场景地点": "locations",
    "主场景": "locations",
    "props": "props",
    "prop": "props",
    "道具": "props",
    "道具设定": "props",
    "关键道具": "props",
    "物件": "props",
    "载具": "props",
    # desk
    "style": "style",
    "整体风格": "style",
    "画风": "style",
    "视觉风格": "style",
    "画面风格": "style",
    "soundscape": "soundscape",
    "整体声景": "soundscape",
    "声景": "soundscape",
    "环境声": "soundscape",
    "music": "music",
    "配乐": "music",
    "非叙事配乐": "music",
    "背景音乐": "music",
    "bgm": "music",
}

_CONT_KEYS = ("characters", "locations", "props")
_DESK_KEYS = ("style", "soundscape", "music")

# key: value  — allow optional wraps / bullets already stripped
_KV_LINE = re.compile(
    r"^("
    + "|".join(re.escape(k) for k in sorted(_KEY_ALIASES.keys(), key=len, reverse=True))
    + r")\s*[:：]\s*(.*)$",
    re.IGNORECASE,
)

# Bare section title line (no colon), value on following lines
_BARE_SECTION = re.compile(
    r"^("
    + "|".join(re.escape(k) for k in sorted(_KEY_ALIASES.keys(), key=len, reverse=True))
    + r")\s*$",
    re.IGNORECASE,
)

# 【角色设定】value  or 【角色设定】\n value
_BRACKET_KV = re.compile(
    r"^[【\[]\s*("
    + "|".join(re.escape(k) for k in sorted(_KEY_ALIASES.keys(), key=len, reverse=True))
    + r")\s*[】\]]\s*[:：]?\s*(.*)$",
    re.IGNORECASE,
)


def _load_bible_system_prompt() -> str:
    if BIBLE_SYSTEM_PATH.is_file():
        return BIBLE_SYSTEM_PATH.read_text(encoding="utf-8")
    return (
        "你是影视连续性与声景设定助手。从故事提取角色/场景/道具与整体风格/声景/配乐。"
        "只用 <<<CONTINUITY>>> / <<<SOUNDSCAPE>>> 与键值行输出，不要解释。"
    )


def _normalize_key(raw: str) -> str | None:
    k = (raw or "").strip()
    if not k:
        return None
    # unwrap residual markdown / brackets
    m = _LINE_KEY_WRAP.match(k)
    if m:
        k = m.group(1).strip()
    k_lower = k.lower()
    if k_lower in _KEY_ALIASES:
        return _KEY_ALIASES[k_lower]
    if k in _KEY_ALIASES:
        return _KEY_ALIASES[k]
    return _KEY_ALIASES.get(k_lower) or _KEY_ALIASES.get(k)


def _prep_line(line: str) -> str:
    s = (line or "").strip()
    if not s:
        return ""
    # drop trailing markdown bold markers like **characters**:
    s = s.replace("**", "").replace("__", "").replace("`", "")
    s = _LINE_PREFIX.sub("", s).strip()
    return s


def _parse_kv_section(block: str) -> dict[str, str]:
    """Parse key: value lines; allow multi-line values until next known key."""
    out: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []

    def _flush() -> None:
        nonlocal current, buf
        if current is None:
            return
        text = "\n".join(buf).strip()
        if text:
            out[current] = text
        current = None
        buf = []

    for raw_line in str(block or "").splitlines():
        line = _prep_line(raw_line)
        if not line:
            if current is not None:
                buf.append("")
            continue

        m = _KV_LINE.match(line)
        if not m:
            m = _BRACKET_KV.match(line)
        if m:
            key = _normalize_key(m.group(1))
            if key:
                _flush()
                current = key
                first = (m.group(2) or "").strip()
                buf = [first] if first else []
                continue

        bare = _BARE_SECTION.match(line)
        if bare:
            key = _normalize_key(bare.group(1))
            if key:
                _flush()
                current = key
                buf = []
                continue

        if current is not None:
            buf.append(raw_line.rstrip())
    _flush()
    return out


def _pick_keys(kv: dict[str, str], keys: tuple[str, ...]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in keys:
        val = str(kv.get(key) or "").strip()
        if val:
            out[key] = val
    return out


def parse_studio_bible_output(text: str) -> dict[str, dict[str, str]]:
    """Parse <<<CONTINUITY>>> / <<<SOUNDSCAPE>>> blocks into field dicts."""
    text = str(text or "").strip()
    continuity: dict[str, str] = {}
    desk: dict[str, str] = {}

    cont_m = _CONT_MARK.search(text)
    sound_m = _SOUND_MARK.search(text)

    if cont_m:
        start = cont_m.end()
        end = sound_m.start() if sound_m and sound_m.start() > start else len(text)
        continuity = _pick_keys(_parse_kv_section(text[start:end]), _CONT_KEYS)

    if sound_m:
        start = sound_m.end()
        end = len(text)
        if cont_m and cont_m.start() > sound_m.start():
            end = cont_m.start()
        desk = _pick_keys(_parse_kv_section(text[start:end]), _DESK_KEYS)

    # Always fill missing keys from the whole text (handles missing markers /
    # numbered lists / Chinese aliases). Previously this only ran when BOTH
    # continuity and desk were empty, so a good SOUNDSCAPE block would block
    # recovery of CONTINUITY → "已填充连续性 0 项、全局声景 3 项".
    if len(continuity) < len(_CONT_KEYS) or len(desk) < len(_DESK_KEYS):
        kv_all = _parse_kv_section(text)
        for key in _CONT_KEYS:
            if key not in continuity and kv_all.get(key):
                continuity[key] = kv_all[key]
        for key in _DESK_KEYS:
            if key not in desk and kv_all.get(key):
                desk[key] = kv_all[key]

    return {"continuity": continuity, "desk": desk}


def apply_studio_bible_to_timeline(
    timeline: dict,
    bible: dict[str, Any],
    *,
    overwrite: bool = True,
) -> dict[str, Any]:
    """Write continuity + desk fields from bible into timeline."""
    ensure_studio_fields(timeline)
    cont = timeline.setdefault("continuity", default_continuity())
    desk = timeline.setdefault("desk", default_desk())
    src_c = (bible.get("continuity") or {}) if isinstance(bible, dict) else {}
    src_d = (bible.get("desk") or {}) if isinstance(bible, dict) else {}

    applied = {"continuity": {}, "desk": {}}
    for key in _CONT_KEYS:
        val = str(src_c.get(key) or "").strip()
        if not val:
            continue
        if overwrite or not str(cont.get(key) or "").strip():
            cont[key] = val
            applied["continuity"][key] = val
    cont.setdefault("inject", True)

    for key in _DESK_KEYS:
        val = str(src_d.get(key) or "").strip()
        if not val:
            continue
        if overwrite or not str(desk.get(key) or "").strip():
            desk[key] = val
            applied["desk"][key] = val

    return applied


def _resolve_story(timeline: dict, brief: str = "") -> str:
    story = (brief or "").strip()
    if not story and isinstance(timeline.get("desk"), dict):
        story = str((timeline["desk"].get("text_director") or {}).get("brief") or "").strip()
    if not story:
        story = str((timeline.get("global") or {}).get("prompt") or "").strip()
    if not story:
        segs = timeline.get("segments") or []
        parts = [str(s.get("prompt") or "").strip() for s in segs if isinstance(s, dict)]
        story = "\n".join(p for p in parts if p)[:4000]
    return story


def _build_bible_user_message(*, brief: str, global_prompt: str = "") -> str:
    lines = [
        "OUTPUT=STUDIO_BIBLE",
        "请根据下列故事，输出 <<<CONTINUITY>>> 与 <<<SOUNDSCAPE>>> 块。",
        "连续性三键必须写成：characters: / locations: / props:（不要编号、不要列表符）。",
        "声景三键必须写成：style: / soundscape: / music:。",
        "",
        "【故事 / 创意简述】",
        brief.strip(),
    ]
    gp = (global_prompt or "").strip()
    if gp and gp != brief.strip():
        lines.extend(["", "【已有全局提示词（可参考，不要照抄成动作分镜）】", gp[:3000]])
    return "\n".join(lines)


def extract_studio_bible(
    timeline: dict,
    *,
    brief: str = "",
    model: str,
    backend: str = "local",
    overwrite: bool = True,
    **llm_kwargs,
) -> dict[str, Any]:
    """LLM extract → parse → apply continuity + desk. Returns summary dict."""
    from .local_director_runtime import _run_director_llm, _strip_wrappers

    story = _resolve_story(timeline, brief)
    if not story:
        raise ValueError("请先填写故事 / 创意简述（或全局提示词），再填充连续性与全局声景")

    global_prompt = str((timeline.get("global") or {}).get("prompt") or "")
    user_msg = _build_bible_user_message(brief=story, global_prompt=global_prompt)
    kw = dict(llm_kwargs)
    kw.setdefault("max_tokens", 2048)
    kw.setdefault("temperature", 0.45)
    allow = (
        "llm_url", "api_format", "api_key", "max_tokens", "temperature",
        "timeout_seconds", "thinking", "mmproj", "top_p", "top_k",
        "repeat_penalty", "ctx_size", "memory_mode", "n_gpu_layers",
        "n_cpu_moe_layers", "seed", "reasoning",
    )
    raw = _run_director_llm(
        backend=backend,
        model=model,
        user_msg=user_msg,
        system_prompt=_load_bible_system_prompt(),
        system_prompt_path=BIBLE_SYSTEM_PATH if BIBLE_SYSTEM_PATH.is_file() else None,
        **{k: kw[k] for k in allow if k in kw},
    )
    stripped = _strip_wrappers(raw or "")
    bible = parse_studio_bible_output(stripped)
    if not bible.get("continuity") and not bible.get("desk"):
        preview = stripped[:500].replace("\n", "\\n")
        raise RuntimeError(
            "未解析到连续性/声景字段。请确认模型输出含 <<<CONTINUITY>>> / <<<SOUNDSCAPE>>> "
            f"与 characters/locations/props、style/soundscape/music。"
            f" 输出预览: {preview}"
        )
    if not bible.get("continuity"):
        log.warning(
            "extract_studio_bible: continuity empty after parse; raw preview=%s",
            stripped[:400].replace("\n", "\\n"),
        )
    applied = apply_studio_bible_to_timeline(timeline, bible, overwrite=overwrite)
    log.info(
        "extract_studio_bible: continuity keys=%s desk keys=%s",
        list(applied.get("continuity") or {}),
        list(applied.get("desk") or {}),
    )
    return {
        "continuity": timeline.get("continuity"),
        "desk": {
            "style": (timeline.get("desk") or {}).get("style") or "",
            "soundscape": (timeline.get("desk") or {}).get("soundscape") or "",
            "music": (timeline.get("desk") or {}).get("music") or "",
        },
        "applied": applied,
        "bible": bible,
    }
