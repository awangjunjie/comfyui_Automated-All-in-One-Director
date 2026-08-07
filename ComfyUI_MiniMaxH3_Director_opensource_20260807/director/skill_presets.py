# -*- coding: utf-8 -*-
"""Official MiniMax-H3 style skill presets (condensed Chinese directives)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

SKILLS_DIR = Path(__file__).resolve().parent.parent / "prompts" / "skills"

# id -> display name (UI)
SKILL_CHOICES: tuple[tuple[str, str], ...] = (
    ("none", "通用（官方 H3 规范）"),
    ("minimalist-product-ad", "极简产品广告"),
    ("3d-animation-short", "3D 动画短片"),
    ("papercraft-stop-motion", "剪纸定格解说"),
    ("brand-promo", "品牌宣传片"),
    ("mv-subtitle", "MV / 歌词排版"),
    ("co-op-game-intro", "双人合作游戏开场"),
    ("paper-collage", "纸拼贴解说"),
    ("handdrawn-live", "手绘+实拍混搭"),
)

_SKILL_CACHE: dict[str, str] = {}


def skill_option_labels() -> list[str]:
    return [f"{sid} — {label}" for sid, label in SKILL_CHOICES]


def skill_id_from_value(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw or raw in {"none", "通用", "通用（官方 H3 规范）"}:
        return "none"
    for sid, label in SKILL_CHOICES:
        if raw == sid or raw.startswith(f"{sid} —") or raw == label:
            return sid
    # tolerate display-only
    for sid, label in SKILL_CHOICES:
        if label in raw:
            return sid
    return "none"


def list_skills() -> list[dict[str, str]]:
    return [{"id": sid, "label": label} for sid, label in SKILL_CHOICES]


def load_skill_directive(skill_id: str | None) -> str:
    sid = skill_id_from_value(skill_id)
    if sid == "none":
        return ""
    if sid in _SKILL_CACHE:
        return _SKILL_CACHE[sid]
    path = SKILLS_DIR / f"{sid}.txt"
    text = ""
    if path.is_file():
        text = path.read_text(encoding="utf-8").strip()
    _SKILL_CACHE[sid] = text
    return text


def append_skill_to_system(system_prompt: str, skill_id: str | None) -> str:
    base = str(system_prompt or "").rstrip()
    directive = load_skill_directive(skill_id)
    if not directive:
        return base
    sid = skill_id_from_value(skill_id)
    label = next((lb for i, lb in SKILL_CHOICES if i == sid), sid)
    block = (
        f"\n\n## 风格 Skill 附加指令（{label}）\n"
        "在遵守上方字段名、MODE、分隔符与对白规则的前提下，优先满足下列风格约束：\n\n"
        f"{directive}\n"
    )
    return base + block


def skill_user_reminder(skill_id: str | None) -> str:
    sid = skill_id_from_value(skill_id)
    if sid == "none":
        return ""
    label = next((lb for i, lb in SKILL_CHOICES if i == sid), sid)
    return f"STYLE_SKILL={sid}（{label}）：扩写时落实该风格的视觉、叙事与声音约束。"
