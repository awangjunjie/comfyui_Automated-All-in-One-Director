# -*- coding: utf-8 -*-
"""Optional local GGUF director — reuses ComfyUI-LLM-text-processor when installed."""

from __future__ import annotations

import importlib
import logging
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.local_director")

SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "h3_director_system.txt"
SYSTEM_PROMPT_PRESET = "h3_director_system.txt"
MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "REF2VA"]

_SHOT_SEP = re.compile(r"^===SHOT\s*(\d+)\s*===", re.IGNORECASE | re.MULTILINE)
_BEAT_SEP = re.compile(r"^===BEAT\s*(\d+)\s*===", re.IGNORECASE | re.MULTILINE)
# Primary multi-shot delimiter for one-pass generation + string split
_SHOT_MARK = re.compile(r"<<<\s*SHOT[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
_GLOBAL_MARK = re.compile(r"<<<\s*GLOBAL\s*>>>", re.IGNORECASE)
_RE_EXPANDED = re.compile(r"综合多模?态描述|整体声景|主体定义|详细描述")

# Canonical delimiter template used in prompts / docs
SHOT_DELIMITER_TMPL = "<<<SHOT_{n}>>>"
GLOBAL_DELIMITER = "<<<GLOBAL>>>"

# Reminder appended to multi-shot / single-shot user messages
_DIALOGUE_AND_LOCK_RULES = (
    "硬性规则："
    "① 凡出现说话/对白/画外音，必须标明具体语气（如温柔、急促、带哭腔、冷淡、愤怒等），"
    "禁止仅用「说道」或「语气复杂」模糊带过；"
    "② 有全局布局/连续性/GLOBAL 时，每一组分镜都必须在综合多模态描述或详细描述开头回扣"
    "角色外貌服装、主场景空间布局、画风光线等锁定信息，防止跨镜偏差；"
    "仅允许剧情驱动的姿态/表情/站位/景别变化。"
)


def _normalize_mode(mode: str | None) -> str:
    m = str(mode or "T2VA").strip().upper()
    return m if m in MODES else "T2VA"


def _shot_fields_blurb(mode: str) -> str:
    if _normalize_mode(mode) == "REF2VA":
        return (
            "主体定义：……\n"
            "摘要：……\n"
            "保留分析：……\n"
            "详细描述：[镜头1] 沿用全局锁定……（含空间位置；有说话则写清语气）\n"
            "整体声景：……\n"
            "非叙事配乐：……"
        )
    return (
        "综合多模态描述：[镜头1] 沿用全局锁定……（含空间位置；有说话则写清语气）\n"
        "整体声景：……\n"
        "非叙事配乐：……"
    )


def _fields_instruction(mode: str) -> str:
    if _normalize_mode(mode) == "REF2VA":
        return (
            "输出六段式：主体定义 / 摘要 / 保留分析 / 详细描述 / 整体声景 / 非叙事配乐；"
            "参考标签用 <Picture N> / <Video K> / <Audio J> / <Subject N>。"
        )
    return "综合多模态描述 / 整体声景 / 非叙事配乐 三个字段都要写；"


def director_mode_from_task_key(task_key: str) -> str:
    """Map MiniMaxH3Director task_type key → local director MODE."""
    key = str(task_key or "").strip().lower()
    for sep in (" — ", " —— ", " - ", " – ", " · "):
        if sep in key:
            key = key.split(sep, 1)[0].strip()
            break
    if key == "fl2v":
        return "FL2VA"
    if key == "fl_chain":
        return "FL2VA"
    if key in {"i2v", "i2i"}:
        return "I2VA"
    if key in {"r2v", "r2i", "rv2v", "vi2v", "vrc2v", "v2v", "ads2v", "mv2v"}:
        return "REF2VA"
    return "T2VA"


def local_director_available() -> bool:
    try:
        import nodes as comfy_nodes

        return "LLMTextProcessor" in getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    except Exception:
        return False


def model_choices() -> list[str]:
    try:
        return list(_folder_registry().model_options())
    except Exception:
        return ["（未安装 LLM Text Processor / 无 GGUF）"]


def mmproj_choices() -> list[str]:
    try:
        return list(_folder_registry().mmproj_options())
    except Exception:
        return ["none"]


def _llm_text_processor_class():
    import nodes as comfy_nodes

    cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("LLMTextProcessor")
    if cls is None:
        raise ImportError("未找到 LLMTextProcessor，请安装 ComfyUI-LLM-text-processor")
    return cls


def _llm_pkg() -> str:
    return _llm_text_processor_class().__module__.rsplit(".", 1)[0]


def _llm_dep(name: str):
    key = f"{_llm_pkg()}.{name}"
    if key in sys.modules:
        return sys.modules[key]
    return importlib.import_module(key)


def _folder_registry():
    return _llm_dep("folder_registry")


def _ensure_system_prompt_preset(fr) -> Path:
    if not SYSTEM_PROMPT_PATH.is_file():
        raise FileNotFoundError(f"缺少系统提示词: {SYSTEM_PROMPT_PATH}")
    dest_root = fr.prompt_root()
    dest_root.mkdir(parents=True, exist_ok=True)
    dest = dest_root / SYSTEM_PROMPT_PRESET
    if (not dest.exists()) or dest.read_bytes() != SYSTEM_PROMPT_PATH.read_bytes():
        shutil.copy2(SYSTEM_PROMPT_PATH, dest)
    return SYSTEM_PROMPT_PATH


def _strip_wrappers(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def _append_preserve_blocks(
    lines: list[str],
    *,
    continuity: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    chain_continuity: bool = False,
) -> None:
    """Append must-keep global / continuity / desk context for the LLM."""
    if chain_continuity:
        lines.append("CHAIN_CONTINUITY=1")
        lines.append(
            "链式连贯已开启：第2镜起必须以上一镜末帧为起幅硬锁定；"
            "T2VA 写清 0.00 秒首帧硬锁定并连续过渡；"
            "I2VA/REF2VA 写清「目标视频在 0.00 秒完整参考 <Picture 1>」；"
            "FL2VA 写清首帧硬锁定并连续过渡；禁止跨镜硬切换身份或场景。"
        )
        lines.append("")
    if continuity.strip():
        lines.append("连续性设定（必须保留并写进画面空间：角色外貌、场景地点与方位、道具）：")
        lines.append(continuity.strip())
        lines.append("")
    desk_bits = []
    if desk_style.strip():
        desk_bits.append(f"整体风格：{desk_style.strip()}")
    if desk_soundscape.strip():
        desk_bits.append(f"整体声景：{desk_soundscape.strip()}")
    if desk_music.strip():
        desk_bits.append(f"非叙事配乐：{desk_music.strip()}")
    if desk_bits:
        lines.append("全局声景台设定（必须保留并扩写进声景/配乐/风格，不可丢弃）：")
        lines.extend(desk_bits)
        lines.append("")
    if global_prompt.strip():
        lines.append("已有全局提示词（必须保留其中的角色、场景位置、风格与声音要点，在此基础上扩写润色，不要另起炉灶抹掉）：")
        lines.append(global_prompt.strip())
        lines.append("")


def _build_user_message(
    *,
    brief: str,
    mode: str,
    duration: float,
    ratio: str,
    camera_style: str,
    single_shot: bool = False,
    shot_index: int | None = None,
    shot_total: int | None = None,
    shot_label: str = "",
    continuity: str = "",
    story_context: str = "",
    covered_beats: str = "",
    beat_focus: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    expand_global: bool = False,
    skill_id: str = "none",
    chain_continuity: bool = False,
) -> str:
    mode = _normalize_mode(mode)
    lines = [
        f"MODE={mode}",
        f"TARGET_DURATION_SECONDS={duration:.2f}",
        f"ASPECT_RATIO={ratio}",
    ]
    if camera_style.strip():
        lines.append(f"CAMERA_STYLE={camera_style.strip()}")
    if expand_global:
        lines.append("EXPAND_GLOBAL=1")
    if single_shot:
        lines.append("SINGLE_SHOT=1")
        if shot_index is not None and shot_total is not None:
            lines.append(f"SHOT_INDEX={int(shot_index) + 1}")
            lines.append(f"SHOT_TOTAL={int(shot_total)}")
        if shot_label.strip():
            lines.append(f"SHOT_LABEL={shot_label.strip()}")
    from .skill_presets import skill_user_reminder

    skill_note = skill_user_reminder(skill_id)
    if skill_note:
        lines.append(skill_note)
    lines.append("")
    _append_preserve_blocks(
        lines,
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        chain_continuity=chain_continuity,
    )
    if story_context.strip():
        lines.append("整片故事语境（定位本镜在故事中的位置；全局设定仍须保留）：")
        lines.append(story_context.strip())
        lines.append("")
    if covered_beats.strip():
        lines.append("已覆盖情节（禁止再写这些动作/对白）：")
        lines.append(covered_beats.strip())
        lines.append("")
    if beat_focus.strip():
        lines.append("本镜必须呈现的情节点（只写这一段）：")
        lines.append(beat_focus.strip())
        lines.append("")
    if expand_global:
        lines.append("全局创意简述（请扩写成整片全局提示词）：")
    else:
        lines.append("本镜创意简述：")
    lines.append(brief.strip())
    lines.append("")
    if mode == "I2VA":
        lines.append("图片：有图片1–9（纯参考主体/外观，不锁首帧；锁首尾请用 FL2VA）")
    elif mode == "FL2VA":
        lines.append("图片：有图片1（首帧）与图片2（尾帧）")
    elif mode == "L2VA":
        lines.append("图片：有图片1（对齐目标尾帧）")
    elif mode == "REF2VA":
        lines.append("素材：可能有 <Picture N> / <Video K> / <Audio J>，按全参考六段式组织")
    else:
        lines.append("图片：无")
    lines.append("")
    fields = _fields_instruction(mode)
    if expand_global:
        lines.append(
            "请扩写成「整片全局」MiniMax H3 中文提示词。"
            f"{fields}"
            "必须保留并扩写已有全局提示词、连续性场景位置、风格/声景/配乐；"
            "写清主场景空间布局与角色默认站位，写成后续分镜可回扣的锁定条款；不要只写空泛摘要。"
            f"{_DIALOGUE_AND_LOCK_RULES}"
            "全文中文，只输出最终提示词，不要解释。"
        )
    elif single_shot:
        lines.append(
            "请把上述内容扩写成「单个分镜」的 MiniMax H3 中文导演提示词。"
            "只写 [镜头1]，禁止出现 [镜头2] 及之后切镜；"
            f"{fields}"
            "时长严格落在 TARGET_DURATION_SECONDS 内。"
            "写清本镜空间位置（左中右、前后景、相对参照物）；"
            "开头回扣全局角色/场景/画风锁定；只推进本镜动作，不要整片复述。"
            f"{_DIALOGUE_AND_LOCK_RULES}"
            "全文使用中文，只输出最终提示词，不要解释。"
        )
    else:
        lines.append(
            "请把上述简述扩写成完整的 MiniMax H3 中文导演提示词。"
            f"{fields}"
            "保留全局设定与场景空间位置，细节可看可听。"
            f"{_DIALOGUE_AND_LOCK_RULES}"
            "全文使用中文，只输出最终提示词，不要解释。"
        )
    return "\n".join(lines)


def _build_beat_plan_message(
    *,
    brief: str,
    shot_count: int,
    continuity: str = "",
) -> str:
    lines = [
        f"SHOT_COUNT={int(shot_count)}",
        "OUTPUT=BEAT_PLAN",
        "",
    ]
    if continuity.strip():
        lines.append("连续性设定：")
        lines.append(continuity.strip())
        lines.append("")
    lines.append("整片创意简述：")
    lines.append(brief.strip())
    lines.append("")
    lines.append(
        f"请按故事时间线拆成恰好 {int(shot_count)} 个互不重复的情节点。"
        "只输出 ===BEAT n=== / label / beat，不要写三字段提示词，不要前言。"
        "相邻镜动作必须不同，覆盖开场→推进→收束。"
    )
    return "\n".join(lines)


def _build_story_split_message(
    *,
    brief: str,
    shot_count: int,
    duration_each: float,
    ratio: str,
    camera_style: str,
    mode: str,
    continuity: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    skill_id: str = "none",
    chain_continuity: bool = False,
) -> str:
    n = int(shot_count)
    mode = _normalize_mode(mode)
    delim_lines = "\n".join(
        [GLOBAL_DELIMITER] + [SHOT_DELIMITER_TMPL.format(n=i) for i in range(1, n + 1)]
    )
    lines = [
        f"MODE={mode}",
        f"SHOT_COUNT={n}",
        f"TARGET_DURATION_SECONDS_EACH={float(duration_each):.2f}",
        f"ASPECT_RATIO={ratio}",
        "OUTPUT=MULTI_SHOT_GROUPS",
    ]
    if camera_style.strip():
        lines.append(f"CAMERA_STYLE={camera_style.strip()}")
    from .skill_presets import skill_user_reminder

    skill_note = skill_user_reminder(skill_id) if skill_id else ""
    if skill_note:
        lines.append(skill_note)
    lines.append("")
    _append_preserve_blocks(
        lines,
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        chain_continuity=chain_continuity,
    )
    lines.append("整片创意简述：")
    lines.append(brief.strip())
    lines.append("")
    fields_ex = _shot_fields_blurb(mode)
    lines.append(
        f"请一次写完：先写全局块，再写恰好 {n} 个分镜。"
        "全局块要保留并扩写上述全局/连续性/风格声景，写成可回扣的锁定条款；"
        f"每组分镜开头回扣锁定信息并写清空间位置，情节推进且不重复。{_fields_instruction(mode)}"
        f"{_DIALOGUE_AND_LOCK_RULES}"
        "必须用下面分隔符（各占一行）切开：\n"
        f"{delim_lines}\n"
        "格式示例：\n"
        f"{GLOBAL_DELIMITER}\n"
        "（整片全局设定锁定：风格、角色外貌服装、主场景空间布局、声景/配乐基调）\n"
        f"{SHOT_DELIMITER_TMPL.format(n=1)}\n"
        "label: 开场\n"
        f"duration: {float(duration_each):.1f}\n"
        f"{fields_ex}\n"
        f"{SHOT_DELIMITER_TMPL.format(n=2)}\n"
        "……直到最后一组。"
        "不要前言、不要 markdown、不要解释。"
    )
    return "\n".join(lines)


def _build_groups_batch_message(
    *,
    groups: list[dict[str, Any]],
    story_context: str,
    continuity: str,
    mode: str,
    ratio: str,
    camera_style: str,
    default_duration: float,
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    skill_id: str = "none",
    chain_continuity: bool = False,
) -> str:
    n = len(groups)
    mode = _normalize_mode(mode)
    delim_lines = "\n".join(
        [GLOBAL_DELIMITER] + [SHOT_DELIMITER_TMPL.format(n=i) for i in range(1, n + 1)]
    )
    lines = [
        f"MODE={mode}",
        f"SHOT_COUNT={n}",
        f"ASPECT_RATIO={ratio}",
        "OUTPUT=MULTI_SHOT_GROUPS",
    ]
    if camera_style.strip():
        lines.append(f"CAMERA_STYLE={camera_style.strip()}")
    from .skill_presets import skill_user_reminder

    skill_note = skill_user_reminder(skill_id)
    if skill_note:
        lines.append(skill_note)
    lines.append("")
    _append_preserve_blocks(
        lines,
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        chain_continuity=chain_continuity,
    )
    if story_context.strip():
        lines.append("整片故事语境（各组只写对应一段，但全局设定必须保留）：")
        lines.append(story_context.strip())
        lines.append("")
    lines.append("各组输入（按序号扩写，情节向前推进、空间位置写清）：")
    for i, g in enumerate(groups):
        label = str(g.get("label") or f"分镜{i + 1}").strip()
        dur = float(g.get("duration") or default_duration or 5.0)
        brief = str(g.get("brief") or "").strip() or "（无单独简述：按故事时间线写本镜推进与空间落点）"
        lines.append(f"- 组{i + 1} label={label} duration={dur:.1f} 简述：{brief}")
    lines.append("")
    lines.append(
        f"请一次写完：先 {GLOBAL_DELIMITER} 全局块，再恰好 {n} 组提示词。"
        f"{_fields_instruction(mode)}"
        "必须用下列分隔符（各占一行）切开：\n"
        f"{delim_lines}\n"
        "每组可先写 label: / duration:，再写提示词；每组开头回扣全局锁定并写清空间位置。\n"
        f"{_shot_fields_blurb(mode)}\n"
        f"{_DIALOGUE_AND_LOCK_RULES}"
        "不要前言、不要 markdown。"
    )
    return "\n".join(lines)


def _parse_duration_value(raw: str) -> float | None:
    s = str(raw or "").strip().lower()
    s = re.sub(r"(秒|sec|secs|seconds)\b", "", s).strip()
    if s.endswith("s") and re.match(r"^\d", s):
        s = s[:-1].strip()
    if not s:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    try:
        v = float(m.group(1))
    except Exception:
        return None
    if v <= 0:
        return None
    return max(1.0, min(30.0, v))


def _parse_shot_block(block: str, default_label: str = "") -> dict[str, Any] | None:
    block = (block or "").strip()
    if not block:
        return None
    label = ""
    duration = None
    body_lines: list[str] = []
    for line in block.splitlines():
        low = line.strip()
        low_l = low.lower()
        if low_l.startswith("label:") or low.startswith("标题:") or low.startswith("镜名:"):
            label = low.split(":", 1)[1].strip() if ":" in low else low.split("：", 1)[-1].strip()
            continue
        if (
            low_l.startswith("duration:")
            or low_l.startswith("duration_sec:")
            or low.startswith("时长:")
            or low.startswith("秒数:")
        ):
            part = low.split(":", 1)[1] if ":" in low else low.split("：", 1)[-1]
            duration = _parse_duration_value(part)
            continue
        body_lines.append(line)
    prompt = "\n".join(body_lines).strip()
    if not prompt:
        return None
    return {
        "label": label or default_label,
        "duration": duration,
        "prompt": prompt,
    }


def _parse_global_meta(global_text: str) -> tuple[str, dict[str, Any]]:
    """Pull shot_count / total_duration lines out of GLOBAL block; return (body, meta)."""
    meta: dict[str, Any] = {}
    keep: list[str] = []
    for line in str(global_text or "").splitlines():
        raw = line.strip()
        low = raw.lower()
        if low.startswith("shot_count:") or raw.startswith("分镜数:"):
            part = raw.split(":", 1)[1] if ":" in raw else raw.split("：", 1)[-1]
            try:
                meta["shot_count"] = max(1, min(16, int(float(re.search(r"\d+", part).group(0)))))
            except Exception:
                pass
            continue
        if low.startswith("total_duration:") or raw.startswith("总时长:"):
            part = raw.split(":", 1)[1] if ":" in raw else raw.split("：", 1)[-1]
            dur = _parse_duration_value(part)
            if dur is not None:
                meta["total_duration"] = dur
            continue
        if low.startswith("label:") or low.startswith("duration:"):
            continue
        keep.append(line)
    return "\n".join(keep).strip(), meta


def extract_global_and_shots(
    text: str,
    expected: int | None = None,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Split one-pass output into (global_prompt, shots[], global_meta)."""
    text = _strip_wrappers(text)
    global_prompt = ""
    body = text
    global_meta: dict[str, Any] = {}

    gm = _GLOBAL_MARK.search(text)
    if gm:
        after_global = text[gm.end() :]
        next_shot = _SHOT_MARK.search(after_global)
        if next_shot:
            raw_global = after_global[: next_shot.start()].strip()
            global_prompt, global_meta = _parse_global_meta(raw_global)
            body = after_global[next_shot.start() :]
        else:
            global_prompt, global_meta = _parse_global_meta(after_global.strip())
            body = ""

    shots = parse_multi_shot_output(body if body else text, expected=expected)
    return global_prompt, shots, global_meta


def parse_multi_shot_output(text: str, expected: int | None = None) -> list[dict[str, Any]]:
    """Split one-pass multi-shot text on <<<SHOT_n>>> (fallback: ===SHOT n===)."""
    text = _strip_wrappers(text)
    # If GLOBAL still present, strip it so shot parser sees only shots
    gm = _GLOBAL_MARK.search(text)
    if gm:
        after = text[gm.end() :]
        sm = _SHOT_MARK.search(after)
        text = after[sm.start() :] if sm else after

    shots: list[dict[str, Any]] = []

    marks = list(_SHOT_MARK.finditer(text))
    if marks:
        # Build index -> block via string positions (supports out-of-order marks)
        by_idx: dict[int, str] = {}
        for i, m in enumerate(marks):
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            idx = int(m.group(1)) - 1
            by_idx[idx] = text[start:end].strip()
        max_i = max(by_idx.keys()) if by_idx else -1
        limit = expected if expected else (max_i + 1)
        for i in range(limit):
            block = by_idx.get(i, "")
            parsed = _parse_shot_block(block, default_label=f"分镜{i + 1}")
            if parsed:
                shots.append(parsed)
        if shots:
            return shots[:expected] if expected else shots

    # Legacy ===SHOT n===
    matches = list(_SHOT_SEP.finditer(text))
    if matches:
        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            parsed = _parse_shot_block(text[start:end], default_label=f"分镜{i + 1}")
            if parsed:
                shots.append(parsed)
        if expected and len(shots) > expected:
            shots = shots[:expected]
        return shots

    # Last resort: split on blank-line + 综合多模态描述 repeats
    parts = re.split(r"(?=\n综合多模?态描述\s*[:：])", text)
    parts = [p.strip() for p in parts if p and p.strip()]
    if len(parts) >= 2:
        for i, part in enumerate(parts):
            shots.append({"label": f"分镜{i + 1}", "duration": None, "prompt": part})
        if expected and len(shots) > expected:
            shots = shots[:expected]
        return shots

    if text.strip():
        shots.append({"label": "", "duration": None, "prompt": text.strip()})
    return shots


def parse_beat_plan(text: str, expected: int | None = None) -> list[dict[str, Any]]:
    """Parse ===BEAT n=== blocks into [{label, beat}] (legacy helper)."""
    text = _strip_wrappers(text)
    matches = list(_BEAT_SEP.finditer(text))
    beats: list[dict[str, Any]] = []
    if not matches:
        return beats
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        label = ""
        beat = ""
        body_lines: list[str] = []
        for line in block.splitlines():
            low = line.strip()
            low_l = low.lower()
            if low_l.startswith("label:"):
                label = low.split(":", 1)[1].strip()
                continue
            if low_l.startswith("beat:") or low.startswith("情节点:") or low.startswith("简述:"):
                beat = low.split(":", 1)[1].strip()
                continue
            body_lines.append(line)
        if not beat:
            beat = "\n".join(body_lines).strip()
        if beat:
            beats.append({"label": label or f"分镜{i + 1}", "beat": beat})
    if expected and len(beats) > expected:
        beats = beats[:expected]
    return beats


def _looks_expanded_prompt(text: str) -> bool:
    return bool(_RE_EXPANDED.search(str(text or "")))


def _normalize_brief_text(text: str) -> str:
    t = re.sub(r"\s+", "", str(text or ""))
    return t[:240]


def _briefs_are_near_duplicates(briefs: list[str]) -> bool:
    cleaned = [_normalize_brief_text(b) for b in briefs if str(b or "").strip()]
    if len(cleaned) < 2:
        return False
    first = cleaned[0]
    if len(first) < 24:
        return False
    same = sum(1 for b in cleaned[1:] if b == first or (first in b) or (b in first))
    return same >= max(1, len(cleaned) - 1)


def _prompt_similarity(a: str, b: str) -> float:
    """Rough overlap of character bigrams for duplicate detection."""
    def grams(s: str) -> set[str]:
        s = re.sub(r"\s+", "", s or "")
        if len(s) < 2:
            return {s} if s else set()
        return {s[i : i + 2] for i in range(len(s) - 1)}

    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return 0.0
    inter = len(ga & gb)
    return inter / max(1, min(len(ga), len(gb)))


def _shots_too_similar(shots: list[dict[str, Any]], threshold: float = 0.72) -> bool:
    prompts = [str(s.get("prompt") or "") for s in shots if str(s.get("prompt") or "").strip()]
    if len(prompts) < 2:
        return False
    hits = 0
    pairs = 0
    for i in range(len(prompts)):
        for j in range(i + 1, len(prompts)):
            pairs += 1
            if _prompt_similarity(prompts[i], prompts[j]) >= threshold:
                hits += 1
    return hits >= max(1, pairs // 2)


def _llm_kwargs(kwargs: dict, *, include_sampling: bool = True) -> dict:
    keys = [
        "backend", "llm_url", "api_format", "api_key",
        "mmproj", "max_tokens", "temperature", "seed", "timeout_seconds",
        "thinking", "skill_id", "system_prompt", "system_prompt_path",
    ]
    if include_sampling:
        keys.extend([
            "top_p", "top_k", "repeat_penalty", "ctx_size", "memory_mode",
            "n_gpu_layers", "n_cpu_moe_layers", "reasoning",
        ])
    return {k: kwargs[k] for k in keys if k in kwargs}


def plan_story_beats(
    *,
    model: str,
    brief: str,
    shot_count: int,
    continuity: str = "",
    **kwargs,
) -> list[dict[str, Any]]:
    """Ask LLM for N distinct story beats before expanding prompts."""
    brief = (brief or "").strip()
    if not brief:
        raise ValueError("提示词导演：创意简述为空")
    shot_count = max(1, min(16, int(shot_count or 2)))
    user_msg = _build_beat_plan_message(
        brief=brief,
        shot_count=shot_count,
        continuity=continuity,
    )
    kw = dict(kwargs)
    kw.setdefault("max_tokens", max(800, 120 * shot_count))
    kw.setdefault("temperature", 0.4)
    kw.setdefault("repeat_penalty", 1.12)
    raw = _run_director_llm(model=model, user_msg=user_msg, **_llm_kwargs(kw))
    beats = parse_beat_plan(raw, expected=shot_count)
    if len(beats) < shot_count:
        # Soft fallback: evenly slice the brief sentences
        parts = [p.strip() for p in re.split(r"[。！？\n]+", brief) if p.strip()]
        while len(beats) < shot_count:
            i = len(beats)
            if parts:
                piece = parts[min(i, len(parts) - 1)]
            else:
                piece = f"推进故事第 {i + 1} 段关键动作"
            beats.append({"label": f"分镜{i + 1}", "beat": piece})
    return beats[:shot_count]


def _expand_beat_to_shot(
    *,
    model: str,
    beat: dict[str, Any],
    shot_index: int,
    shot_total: int,
    duration: float,
    mode: str,
    ratio: str,
    camera_style: str,
    continuity: str,
    story_context: str,
    covered_beats: list[str],
    **kwargs,
) -> dict[str, Any]:
    label = str(beat.get("label") or f"分镜{shot_index + 1}").strip()
    focus = str(beat.get("beat") or beat.get("brief") or "").strip()
    brief = focus or f"第{shot_index + 1}/{shot_total}镜：只写本段新推进，不要复述前后镜。"
    covered = ""
    if covered_beats:
        covered = "\n".join(f"- {c}" for c in covered_beats if c)
    prompt = expand_brief(
        model=model,
        brief=brief,
        mode=mode,
        duration=duration,
        ratio=ratio,
        camera_style=camera_style,
        single_shot=True,
        shot_index=shot_index,
        shot_total=shot_total,
        shot_label=label,
        continuity=continuity,
        story_context=story_context,
        covered_beats=covered,
        beat_focus=focus,
        **_llm_kwargs(kwargs),
    )
    return {
        "index": shot_index,
        "label": label,
        "duration": duration,
        "prompt": prompt,
        "beat": focus,
    }

def normalize_director_backend(value: str | None) -> str:
    """Return ``local`` or ``cloud``."""
    v = str(value or "").strip().lower()
    if v in ("cloud", "api", "remote", "云端", "云端api", "云端 api"):
        return "cloud"
    return "local"


def _load_system_prompt() -> str:
    if not SYSTEM_PROMPT_PATH.is_file():
        raise FileNotFoundError(f"缺少系统提示词: {SYSTEM_PROMPT_PATH}")
    return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


def _run_llama(
    *,
    model: str,
    user_msg: str,
    mmproj: str = "none",
    max_tokens: int = 2048,
    temperature: float = 0.6,
    top_p: float = 0.9,
    top_k: int = 40,
    repeat_penalty: float = 1.05,
    ctx_size: int = 8192,
    memory_mode: str = "auto",
    n_gpu_layers: int = 99,
    n_cpu_moe_layers: int = 1,
    seed: int = 1,
    timeout_seconds: int = 300,
    reasoning: str = "off",
    system_prompt_path: Path | None = None,
    system_prompt: str | None = None,
) -> str:
    if not local_director_available():
        raise ImportError("请安装并启用 ComfyUI-LLM-text-processor 后重启 ComfyUI")

    import tempfile

    fr = _folder_registry()
    llama = _llm_dep("llama_cli")
    temp_sys: Path | None = None
    try:
        if system_prompt_path is not None:
            system_path = Path(system_prompt_path)
            if not system_path.is_file():
                raise FileNotFoundError(f"缺少系统提示词: {system_path}")
        elif system_prompt is not None and str(system_prompt).strip():
            fd, tmp_name = tempfile.mkstemp(prefix="mmh3_sys_", suffix=".txt")
            os.close(fd)
            temp_sys = Path(tmp_name)
            temp_sys.write_text(str(system_prompt), encoding="utf-8")
            system_path = temp_sys
        else:
            system_path = _ensure_system_prompt_preset(fr)
        no_mmproj = getattr(fr, "NO_MMPROJ", "none")

        command, cleanup_paths = llama.build_command(
            model_path=fr.full_model_path(model),
            mmproj_path=fr.full_mmproj_path(mmproj or no_mmproj),
            system_prompt_path=system_path,
            image=None,
            prompt=user_msg,
            max_tokens=int(max_tokens),
            temperature=float(temperature),
            top_p=float(top_p),
            top_k=int(top_k),
            repeat_penalty=float(repeat_penalty),
            ctx_size=int(ctx_size),
            memory_mode=str(memory_mode or "auto"),
            n_gpu_layers=int(n_gpu_layers),
            n_cpu_moe_layers=int(n_cpu_moe_layers),
            seed=int(seed),
            reasoning=str(reasoning or "off"),
            extra_args=llama.split_extra_args(""),
        )
        response, _reasoning_text, _perf = llama.run_llama_cli(
            command=command,
            timeout_seconds=int(timeout_seconds),
            cleanup_paths=cleanup_paths,
        )
        return _strip_wrappers(response)
    finally:
        if temp_sys is not None:
            try:
                temp_sys.unlink(missing_ok=True)
            except Exception:
                pass


def _run_cloud(
    *,
    model: str,
    user_msg: str,
    llm_url: str = "",
    api_format: str = "Ollama",
    api_key: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.6,
    timeout_seconds: int = 300,
    thinking: str = "disabled",
    system_prompt: str | None = None,
) -> str:
    from ..lib.prompt_enhancer import (
        DEFAULT_API_FORMAT,
        default_url_for_format,
        infer_api_format,
        llm_chat_text_sync,
    )

    fmt = infer_api_format(llm_url or "", api_format or DEFAULT_API_FORMAT)
    sys_text = str(system_prompt).strip() if system_prompt is not None else ""
    if not sys_text:
        sys_text = _load_system_prompt()
    text, err = llm_chat_text_sync(
        system_prompt=sys_text,
        user_prompt=user_msg,
        url=llm_url or default_url_for_format(fmt),
        model=model,
        api_format=fmt,
        api_key=api_key or "",
        max_tokens=int(max_tokens),
        temperature=float(temperature),
        timeout=int(timeout_seconds),
        thinking=str(thinking or "disabled"),
    )
    if err:
        raise RuntimeError(err)
    return _strip_wrappers(text or "")


def _run_director_llm(
    *,
    backend: str = "local",
    model: str,
    user_msg: str,
    **kwargs,
) -> str:
    backend = normalize_director_backend(backend)
    skill_id = kwargs.pop("skill_id", None)
    from .skill_presets import append_skill_to_system

    if "system_prompt" not in kwargs and "system_prompt_path" not in kwargs:
        kwargs["system_prompt"] = append_skill_to_system(_load_system_prompt(), skill_id)
    elif skill_id and kwargs.get("system_prompt"):
        kwargs["system_prompt"] = append_skill_to_system(str(kwargs["system_prompt"]), skill_id)
    if backend == "cloud":
        cloud_keys = (
            "llm_url", "api_format", "api_key", "max_tokens", "temperature",
            "timeout_seconds", "thinking", "system_prompt",
        )
        return _run_cloud(
            model=model,
            user_msg=user_msg,
            **{k: kwargs[k] for k in cloud_keys if k in kwargs},
        )
    llama_keys = (
        "mmproj", "max_tokens", "temperature", "top_p", "top_k", "repeat_penalty",
        "ctx_size", "memory_mode", "n_gpu_layers", "n_cpu_moe_layers", "seed",
        "timeout_seconds", "reasoning", "system_prompt", "system_prompt_path",
    )
    return _run_llama(
        model=model,
        user_msg=user_msg,
        **{k: kwargs[k] for k in llama_keys if k in kwargs},
    )


def expand_brief(
    *,
    model: str,
    brief: str,
    mode: str = "T2VA",
    duration: float = 5.0,
    ratio: str = "16:9",
    camera_style: str = "电影感，动机明确的运镜，清晰的镜头切换",
    mmproj: str = "none",
    max_tokens: int = 2048,
    temperature: float = 0.6,
    top_p: float = 0.9,
    top_k: int = 40,
    repeat_penalty: float = 1.05,
    ctx_size: int = 8192,
    memory_mode: str = "auto",
    n_gpu_layers: int = 99,
    n_cpu_moe_layers: int = 1,
    seed: int = 1,
    timeout_seconds: int = 300,
    reasoning: str = "off",
    thinking: str = "disabled",
    single_shot: bool = False,
    shot_index: int | None = None,
    shot_total: int | None = None,
    shot_label: str = "",
    continuity: str = "",
    story_context: str = "",
    covered_beats: str = "",
    beat_focus: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    expand_global: bool = False,
    backend: str = "local",
    llm_url: str = "",
    api_format: str = "Ollama",
    api_key: str = "",
    skill_id: str = "none",
    chain_continuity: bool = False,
) -> str:
    """Run local GGUF or cloud API director; raises on failure."""
    brief = (brief or "").strip()
    if not brief and not (beat_focus or "").strip() and not (global_prompt or "").strip():
        raise ValueError("提示词导演：创意简述为空")
    if not brief:
        brief = (beat_focus or global_prompt or "").strip()

    mode_n = _normalize_mode(mode)
    user_msg = _build_user_message(
        brief=brief,
        mode=mode_n,
        duration=float(duration),
        ratio=str(ratio or "16:9"),
        camera_style=str(camera_style or ""),
        single_shot=bool(single_shot) and not expand_global,
        shot_index=shot_index,
        shot_total=shot_total,
        shot_label=shot_label,
        continuity=continuity,
        story_context=story_context,
        covered_beats=covered_beats,
        beat_focus=beat_focus,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        expand_global=bool(expand_global),
        skill_id=skill_id,
        chain_continuity=bool(chain_continuity),
    )
    # Slightly higher repeat penalty when writing one beat in a multi-shot arc
    rp = float(repeat_penalty)
    if single_shot and (story_context or covered_beats or beat_focus):
        rp = max(rp, 1.12)
    return _run_director_llm(
        backend=backend,
        model=model,
        user_msg=user_msg,
        mmproj=mmproj,
        max_tokens=max_tokens,
        temperature=temperature,
        top_p=top_p,
        top_k=top_k,
        repeat_penalty=rp,
        ctx_size=ctx_size,
        memory_mode=memory_mode,
        n_gpu_layers=n_gpu_layers,
        n_cpu_moe_layers=n_cpu_moe_layers,
        seed=seed,
        timeout_seconds=timeout_seconds,
        reasoning=reasoning,
        thinking=thinking,
        llm_url=llm_url,
        api_format=api_format,
        api_key=api_key,
        skill_id=skill_id,
    )


def expand_prompt_groups(
    *,
    model: str,
    groups: list[dict[str, Any]],
    mode: str = "T2VA",
    ratio: str = "16:9",
    camera_style: str = "电影感，动机明确的运镜，清晰的镜头切换",
    story_context: str = "",
    continuity: str = "",
    default_duration: float = 5.0,
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    **kwargs,
) -> dict[str, Any]:
    """One LLM pass → <<<GLOBAL>>> + <<<SHOT_n>>> split → sync groups + global.

    Groups whose prompt already looks fully expanded are kept as-is (not re-sent to LLM).
    """
    if not groups:
        raise ValueError("没有提示词组可扩写")

    story = (story_context or "").strip()
    kept: list[dict[str, Any]] = []
    to_expand: list[dict[str, Any]] = []
    for i, g in enumerate(groups):
        idx = int(g.get("index", i))
        label = str(g.get("label") or f"分镜{idx + 1}").strip()
        duration = float(g.get("duration") or default_duration or 5.0)
        source = str(g.get("prompt") or g.get("brief") or "").strip()
        brief_only = str(g.get("brief") or "").strip()
        if _looks_expanded_prompt(source):
            kept.append({
                "index": idx,
                "prompt": source,
                "label": label,
                "duration": duration,
            })
            continue
        brief = ""
        if brief_only and not _looks_expanded_prompt(brief_only):
            brief = brief_only
        elif source and not _looks_expanded_prompt(source):
            brief = source
        to_expand.append({
            **g,
            "brief": brief,
            "index": idx,
            "label": label,
            "duration": duration,
        })

    if not to_expand:
        if kept:
            return {
                "shots": kept,
                "global_prompt": (global_prompt or "").strip(),
                "message": "各组已是完整提示词，已跳过扩写",
            }
        raise ValueError("请先在各组填写简述，或提供整片故事语境")

    if not story and all(not str(g.get("brief") or "").strip() for g in to_expand):
        raise ValueError("请先在各组填写简述，或提供整片故事语境")

    total = len(to_expand)
    kw = dict(kwargs)
    chain_continuity = bool(kw.pop("chain_continuity", False))
    user_msg = _build_groups_batch_message(
        groups=to_expand,
        story_context=story,
        continuity=continuity,
        mode=_normalize_mode(mode),
        ratio=ratio,
        camera_style=camera_style,
        default_duration=float(default_duration or 5.0),
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        skill_id=str(kw.get("skill_id") or "none"),
        chain_continuity=chain_continuity,
    )
    kw.setdefault("max_tokens", max(2048, 1000 * total + 800))
    kw.setdefault("repeat_penalty", 1.12)
    raw = _run_director_llm(model=model, user_msg=user_msg, **_llm_kwargs(kw))
    g_prompt, parsed, _meta = extract_global_and_shots(raw, expected=total)
    log.info(
        "expand_prompt_groups: global=%s shots=%d/%d kept=%d",
        bool(g_prompt), len(parsed), total, len(kept),
    )

    out: list[dict[str, Any]] = list(kept)
    for i, g in enumerate(to_expand):
        duration = float(g.get("duration") or default_duration or 5.0)
        label = str(g.get("label") or f"分镜{i + 1}").strip()
        if i < len(parsed) and str(parsed[i].get("prompt") or "").strip():
            p = parsed[i]
            out.append({
                "index": int(g.get("index", i)),
                "prompt": p["prompt"],
                "label": str(p.get("label") or label).strip() or label,
                "duration": float(p.get("duration") or duration),
            })
            continue
        log.warning("group %d missing from one-pass split; expanding alone", i + 1)
        brief = str(g.get("brief") or "").strip() or (
            f"第{i + 1}/{total}镜：只写本段新推进与空间落点，保留全局场景。"
        )
        prompt = expand_brief(
            model=model,
            brief=brief,
            mode=mode,
            duration=duration,
            ratio=ratio,
            camera_style=camera_style,
            single_shot=True,
            shot_index=int(g.get("index", i)),
            shot_total=max(int(g.get("index", i)) + 1, total + len(kept)),
            shot_label=label,
            continuity=continuity,
            story_context=story,
            global_prompt=global_prompt or g_prompt,
            desk_style=desk_style,
            desk_soundscape=desk_soundscape,
            desk_music=desk_music,
            **_llm_kwargs(kw),
        )
        out.append({
            "index": int(g.get("index", i)),
            "prompt": prompt,
            "label": label,
            "duration": duration,
        })

    if not g_prompt.strip():
        # Fallback: expand a global bible from story + preserve fields
        try:
            g_prompt = expand_brief(
                model=model,
                brief=story or (global_prompt or "整片全局设定"),
                mode=mode,
                duration=float(default_duration or 5.0),
                ratio=ratio,
                camera_style=camera_style,
                expand_global=True,
                continuity=continuity,
                global_prompt=global_prompt,
                desk_style=desk_style,
                desk_soundscape=desk_soundscape,
                desk_music=desk_music,
                **_llm_kwargs(kw),
            )
        except Exception as exc:
            log.warning("global expand fallback failed: %s", exc)
            g_prompt = global_prompt or ""

    out.sort(key=lambda s: int(s.get("index", 0)))
    return {"shots": out, "global_prompt": g_prompt}


def expand_story_to_shots(
    *,
    model: str,
    brief: str,
    shot_count: int = 2,
    duration_each: float = 5.0,
    mode: str = "T2VA",
    ratio: str = "16:9",
    camera_style: str = "电影感，动机明确的运镜，清晰的镜头切换",
    continuity: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    **kwargs,
) -> dict[str, Any]:
    """One pass: <<<GLOBAL>>> + <<<SHOT_n>>> → split and sync."""
    brief = (brief or "").strip()
    if not brief:
        raise ValueError("提示词导演：创意简述为空")
    shot_count = max(1, min(16, int(shot_count or 2)))
    kw = dict(kwargs)
    chain_continuity = bool(kw.pop("chain_continuity", False))
    kw.setdefault("max_tokens", max(2048, 1000 * shot_count + 800))
    kw.setdefault("repeat_penalty", 1.12)
    kw.setdefault("temperature", 0.55)

    user_msg = _build_story_split_message(
        brief=brief,
        shot_count=shot_count,
        duration_each=float(duration_each),
        ratio=str(ratio or "16:9"),
        camera_style=str(camera_style or ""),
        mode=_normalize_mode(mode),
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        skill_id=str(kw.get("skill_id") or "none"),
        chain_continuity=chain_continuity,
    )
    raw = _run_director_llm(model=model, user_msg=user_msg, **_llm_kwargs(kw))
    g_prompt, shots, _meta = extract_global_and_shots(raw, expected=shot_count)
    log.info("story_split: global=%s shots=%d/%d", bool(g_prompt), len(shots), shot_count)

    if len(shots) < shot_count:
        log.warning("story_split incomplete (%d/%d); filling remainder", len(shots), shot_count)
        while len(shots) < shot_count:
            i = len(shots)
            prompt = expand_brief(
                model=model,
                brief=f"第{i + 1}/{shot_count}镜：根据故事时间线只写本段新推进与空间落点。",
                mode=mode,
                duration=duration_each,
                ratio=ratio,
                camera_style=camera_style,
                single_shot=True,
                shot_index=i,
                shot_total=shot_count,
                shot_label=f"分镜{i + 1}",
                continuity=continuity,
                story_context=brief,
                global_prompt=global_prompt or g_prompt,
                desk_style=desk_style,
                desk_soundscape=desk_soundscape,
                desk_music=desk_music,
                covered_beats="\n".join(
                    f"- 已有第{j + 1}镜：{(s.get('prompt') or '')[:80]}"
                    for j, s in enumerate(shots)
                ),
                **_llm_kwargs(kw),
            )
            shots.append({"label": f"分镜{i + 1}", "duration": duration_each, "prompt": prompt})

    if not g_prompt.strip():
        try:
            g_prompt = expand_brief(
                model=model,
                brief=brief,
                mode=mode,
                duration=float(duration_each),
                ratio=ratio,
                camera_style=camera_style,
                expand_global=True,
                continuity=continuity,
                global_prompt=global_prompt,
                desk_style=desk_style,
                desk_soundscape=desk_soundscape,
                desk_music=desk_music,
                **_llm_kwargs(kw),
            )
        except Exception as exc:
            log.warning("story_split global fallback failed: %s", exc)
            g_prompt = global_prompt or ""

    for i, s in enumerate(shots):
        s.setdefault("label", f"分镜{i + 1}")
        if not s.get("duration"):
            s["duration"] = duration_each
        s["index"] = i
    return {"shots": shots[:shot_count], "global_prompt": g_prompt}


def _build_story_auto_message(
    *,
    brief: str,
    shot_min: int,
    shot_max: int,
    duration_min: float,
    duration_max: float,
    duration_hint: float,
    ratio: str,
    camera_style: str,
    mode: str,
    continuity: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    total_duration_hint: float | None = None,
    skill_id: str = "none",
    chain_continuity: bool = False,
) -> str:
    lo = max(1, min(16, int(shot_min)))
    hi = max(lo, min(16, int(shot_max)))
    d_lo = max(1.0, min(30.0, float(duration_min)))
    d_hi = max(d_lo, min(30.0, float(duration_max)))
    mode = _normalize_mode(mode)
    lines = [
        f"MODE={mode}",
        f"SHOT_COUNT_MIN={lo}",
        f"SHOT_COUNT_MAX={hi}",
        f"DURATION_MIN_SECONDS={d_lo:.1f}",
        f"DURATION_MAX_SECONDS={d_hi:.1f}",
        f"DURATION_HINT_SECONDS={float(duration_hint):.1f}",
        f"ASPECT_RATIO={ratio}",
        "OUTPUT=MULTI_SHOT_AUTO",
    ]
    if total_duration_hint and float(total_duration_hint) > 0:
        lines.append(f"TOTAL_DURATION_HINT={float(total_duration_hint):.1f}")
    if camera_style.strip():
        lines.append(f"CAMERA_STYLE={camera_style.strip()}")
    from .skill_presets import skill_user_reminder

    skill_note = skill_user_reminder(skill_id)
    if skill_note:
        lines.append(skill_note)
    lines.append("")
    _append_preserve_blocks(
        lines,
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        chain_continuity=chain_continuity,
    )
    lines.append("整片创意简述：")
    lines.append(brief.strip())
    lines.append("")
    mid = (d_lo + d_hi) / 2.0
    fields_ex = _shot_fields_blurb(mode)
    lines.append(
        f"请根据故事剧情，自行决定分镜数量 N（{lo}～{hi}）以及每一镜的时长（可不同，"
        f"但每镜必须落在 {d_lo:.1f}～{d_hi:.1f} 秒）。"
        f"{_fields_instruction(mode)}"
        "一次写完：先全局块，再 N 个分镜。必须用分隔符（各占一行）：\n"
        f"{GLOBAL_DELIMITER}\n"
        "shot_count: N\n"
        "total_duration: 各镜时长之和\n"
        "（整片全局设定锁定：风格、角色外貌服装、主场景空间布局、声景/配乐基调）\n"
        f"{SHOT_DELIMITER_TMPL.format(n=1)}\n"
        "label: 开场\n"
        f"duration: {mid:.1f}\n"
        f"{fields_ex}\n"
        f"{SHOT_DELIMITER_TMPL.format(n=2)}\n"
        "label: ……\n"
        f"duration: {min(d_hi, mid + 1.0):.1f}\n"
        "……直到 <<<SHOT_N>>>。\n"
        f"节奏服务剧情：开场/推进/转折/收束；单镜时长严格 {d_lo:.1f}～{d_hi:.1f} 秒；"
        f"{_DIALOGUE_AND_LOCK_RULES}"
        "不要前言、不要 markdown、不要解释。"
    )
    return "\n".join(lines)


def expand_story_auto(
    *,
    model: str,
    brief: str,
    shot_min: int = 2,
    shot_max: int = 8,
    duration_min: float = 2.0,
    duration_max: float = 12.0,
    duration_hint: float = 5.0,
    total_duration_hint: float | None = None,
    mode: str = "T2VA",
    ratio: str = "16:9",
    camera_style: str = "电影感，动机明确的运镜，清晰的镜头切换",
    continuity: str = "",
    global_prompt: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    **kwargs,
) -> dict[str, Any]:
    """LLM chooses shot count + per-shot duration; <<<GLOBAL>>>/<<<SHOT_n>>> split."""
    brief = (brief or "").strip()
    if not brief:
        raise ValueError("提示词导演：创意简述为空")
    lo = max(1, min(16, int(shot_min or 2)))
    hi = max(lo, min(16, int(shot_max or 8)))
    d_lo = max(1.0, min(30.0, float(duration_min or 2.0)))
    d_hi = max(d_lo, min(30.0, float(duration_max or 12.0)))
    hint = float(duration_hint or ((d_lo + d_hi) / 2.0))
    hint = max(d_lo, min(d_hi, hint))
    kw = dict(kwargs)
    chain_continuity = bool(kw.pop("chain_continuity", False))
    # Budget for variable N up to hi
    kw.setdefault("max_tokens", max(4096, 1100 * hi + 1200))
    kw.setdefault("repeat_penalty", 1.12)
    kw.setdefault("temperature", 0.55)

    user_msg = _build_story_auto_message(
        brief=brief,
        shot_min=lo,
        shot_max=hi,
        duration_min=d_lo,
        duration_max=d_hi,
        duration_hint=hint,
        total_duration_hint=total_duration_hint,
        ratio=str(ratio or "16:9"),
        camera_style=str(camera_style or ""),
        mode=_normalize_mode(mode),
        continuity=continuity,
        global_prompt=global_prompt,
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        skill_id=str(kw.get("skill_id") or "none"),
        chain_continuity=chain_continuity,
    )
    raw = _run_director_llm(model=model, user_msg=user_msg, **_llm_kwargs(kw))
    g_prompt, shots, meta = extract_global_and_shots(raw, expected=None)
    # Keep only non-empty; clamp count
    shots = [s for s in shots if (s.get("prompt") or "").strip()][:hi]
    if len(shots) < lo and shots:
        log.warning("story_auto: got %d shots (< min %d); keeping as-is", len(shots), lo)
    if not shots:
        raise RuntimeError(
            "自动分镜未解析到任何 <<<SHOT_n>>> 块。请重试或改用「故事 → N 组分镜」。"
        )

    for i, s in enumerate(shots):
        s.setdefault("label", f"分镜{i + 1}")
        try:
            dur = float(s.get("duration") or hint)
        except Exception:
            dur = hint
        s["duration"] = max(d_lo, min(d_hi, dur))
        s["index"] = i
        s.pop("_global_meta", None)

    if not g_prompt.strip():
        try:
            g_prompt = expand_brief(
                model=model,
                brief=brief,
                mode=mode,
                duration=float(sum(float(s.get("duration") or hint) for s in shots)),
                ratio=ratio,
                camera_style=camera_style,
                expand_global=True,
                continuity=continuity,
                global_prompt=global_prompt,
                desk_style=desk_style,
                desk_soundscape=desk_soundscape,
                desk_music=desk_music,
                **_llm_kwargs(kw),
            )
        except Exception as exc:
            log.warning("story_auto global fallback failed: %s", exc)
            g_prompt = global_prompt or ""

    total_dur = sum(float(s.get("duration") or 0) for s in shots)
    log.info(
        "story_auto: shots=%d meta_count=%s total_duration=%.1f dur_range=%.1f-%.1f",
        len(shots),
        meta.get("shot_count"),
        total_dur,
        d_lo,
        d_hi,
    )
    return {
        "shots": shots,
        "global_prompt": g_prompt,
        "shot_count": len(shots),
        "total_duration": total_dur,
        "meta": meta,
    }
