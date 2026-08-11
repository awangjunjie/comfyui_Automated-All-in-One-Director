# -*- coding: utf-8 -*-
"""LLM: expand story/shot content into first/last frame still prompts for FL director."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.fl_prompts")

FL_SYSTEM_PATH = Path(__file__).resolve().parent.parent / "prompts" / "h3_fl_extract_system.txt"

_SHOT_MARK = re.compile(r"<<<\s*SHOT[_\s-]*(\d+)\s*>>>", re.IGNORECASE)
_META_LINE = re.compile(
    r"^(label|名称|镜号|start_prompt|首帧提示词|end_prompt|尾帧提示词)\s*[:：]\s*(.*)$",
    re.IGNORECASE,
)


def _load_fl_system_prompt() -> str:
    if FL_SYSTEM_PATH.is_file():
        return FL_SYSTEM_PATH.read_text(encoding="utf-8")
    return (
        "你是影视分镜首尾帧设定助手。为每组分镜写出首帧与尾帧的中文文生图提示词。"
        "只用 <<<SHOT_n>>> 分隔，不要解释。"
    )


def _parse_kv_block(block: str) -> dict[str, str]:
    out: dict[str, str] = {}
    body: list[str] = []
    for line in str(block or "").splitlines():
        m = _META_LINE.match(line.strip())
        if not m:
            if line.strip():
                body.append(line.rstrip())
            continue
        key = m.group(1).strip().lower()
        val = m.group(2).strip()
        if key in ("label", "名称", "镜号"):
            out["label"] = val
        elif key in ("start_prompt", "首帧提示词"):
            out["start_prompt"] = val
        elif key in ("end_prompt", "尾帧提示词"):
            out["end_prompt"] = val
    if body and ("start_prompt" not in out or "end_prompt" not in out):
        # Heuristic: first half / second half if unlabeled blob
        blob = "\n".join(body).strip()
        if blob and "start_prompt" not in out:
            out["start_prompt"] = blob
        if blob and "end_prompt" not in out:
            out["end_prompt"] = blob
    return out


def parse_fl_extract_output(text: str) -> list[dict[str, Any]]:
    """Parse <<<SHOT_n>>> blocks with start_prompt / end_prompt."""
    text = str(text or "").strip()
    marks = list(_SHOT_MARK.finditer(text))
    by_idx: dict[int, str] = {}
    for i, m in enumerate(marks):
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        by_idx[int(m.group(1))] = text[start:end].strip()
    out: list[dict[str, Any]] = []
    for idx in sorted(by_idx.keys()):
        kv = _parse_kv_block(by_idx[idx])
        sp = (kv.get("start_prompt") or "").strip()
        ep = (kv.get("end_prompt") or "").strip()
        if not sp and not ep:
            continue
        out.append(
            {
                "index": idx,
                "label": (kv.get("label") or f"分镜{idx}").strip(),
                "start_prompt": sp,
                "end_prompt": ep or sp,
            }
        )
    return out


def ensure_shots_from_content(timeline: dict) -> list[dict]:
    """Ensure timeline.shots exists; seed from segments / global if needed."""
    from .fl_frame_director import default_fl_gen, ensure_fl_director

    ensure_fl_director(timeline)
    shots = timeline.get("shots")
    if not isinstance(shots, list):
        shots = []
        timeline["shots"] = shots

    segs = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    if not shots and segs:
        for i, seg in enumerate(segs):
            shots.append(
                {
                    "id": f"fl_shot_{i + 1}",
                    "prompt": str(seg.get("prompt") or ""),
                    "label": str(seg.get("label") or f"分镜{i + 1}"),
                    "durationSec": float(seg.get("durationSec") or 5.0),
                    "fl_gen": default_fl_gen(),
                    "startImage": None,
                    "endImage": None,
                }
            )
    elif shots and segs:
        # Sync prompts from segments when shot prompt empty
        for i, shot in enumerate(shots):
            if not isinstance(shot, dict):
                continue
            if i >= len(segs):
                break
            if not str(shot.get("prompt") or "").strip() and str(segs[i].get("prompt") or "").strip():
                shot["prompt"] = segs[i]["prompt"]
            if not str(shot.get("label") or "").strip() and segs[i].get("label"):
                shot["label"] = segs[i]["label"]

    if not shots:
        gprompt = str((timeline.get("global") or {}).get("prompt") or "").strip()
        if gprompt:
            shots.append(
                {
                    "id": "fl_shot_1",
                    "prompt": gprompt,
                    "label": "分镜1",
                    "durationSec": 5.0,
                    "fl_gen": default_fl_gen(),
                    "startImage": None,
                    "endImage": None,
                }
            )
    timeline["timelineMode"] = "fl2v"
    return [s for s in shots if isinstance(s, dict)]


def _build_fl_user_message(
    *,
    shots: list[dict],
    brief: str = "",
    global_prompt: str = "",
    style: str = "",
    continuity: str = "",
) -> str:
    lines = [
        "OUTPUT=FL_FRAME_PROMPTS",
        "",
        "请为下列每组分镜各写「首帧」与「尾帧」中文文生图提示词（适合文生图，静止画面）。",
        "首帧=运动开始前/刚开始的定格；尾帧=运动完成后的落点定格。",
        "同一组首尾帧：角色外貌服装、场景、画风必须一致，仅姿态/构图/光影随剧情推进变化。",
        "分隔符各占一行：<<<SHOT_1>>> …",
        "每个块内写：",
        "label: …",
        "start_prompt: …",
        "end_prompt: …",
        "不要前言、不要 markdown、不要【】标题。",
        "",
    ]
    if style.strip():
        lines.append(f"整体画风：{style.strip()}")
        lines.append("")
    if continuity.strip():
        lines.append("连续性设定：")
        lines.append(continuity.strip()[:1500])
        lines.append("")
    if brief.strip():
        lines.append("整片故事 / 创意简述：")
        lines.append(brief.strip()[:2500])
        lines.append("")
    if global_prompt.strip():
        lines.append("全局提示词：")
        lines.append(global_prompt.strip()[:2000])
        lines.append("")
    lines.append(f"共 {len(shots)} 组分镜：")
    for i, shot in enumerate(shots):
        label = str(shot.get("label") or f"分镜{i + 1}")
        body = str(shot.get("prompt") or "").strip() or "(无分镜正文，请根据故事推断)"
        dur = shot.get("durationSec")
        dur_s = f"，约 {dur}s" if dur not in (None, "") else ""
        lines.append(f"—— 第 {i + 1} 组「{label}」{dur_s} ——")
        lines.append(body[:1200])
        lines.append("")
    return "\n".join(lines)


def apply_fl_prompts_to_timeline(
    timeline: dict,
    items: list[dict[str, Any]],
    *,
    enable_gen: bool = True,
) -> dict:
    """Write LLM start/end prompts onto shots[].fl_gen and pack UI text fields."""
    from .fl_frame_director import default_fl_gen, ensure_fl_director, fill_fl_prompts

    shots = ensure_shots_from_content(timeline)
    ensure_fl_director(timeline)

    by_one_based = {int(it["index"]): it for it in items if it.get("index") is not None}
    # Also allow 0-based if model used 0
    applied = 0
    for i, shot in enumerate(shots):
        it = by_one_based.get(i + 1) or by_one_based.get(i)
        if not it:
            continue
        fg = shot.get("fl_gen")
        if not isinstance(fg, dict):
            fg = default_fl_gen()
            shot["fl_gen"] = fg
        sp = str(it.get("start_prompt") or "").strip()
        ep = str(it.get("end_prompt") or "").strip()
        if sp:
            fg["start_prompt"] = sp
        if ep:
            fg["end_prompt"] = ep
        elif sp:
            fg["end_prompt"] = sp
        fg["gen_start"] = True
        fg["gen_end"] = True
        fg["source"] = "prompt_director"
        if it.get("label") and not str(shot.get("label") or "").strip():
            shot["label"] = it["label"]
        applied += 1

    idir = timeline["image_director"]
    idir["enabled"] = True
    if enable_gen:
        idir["generate_on_queue"] = idir.get("generate_on_queue", False)

    # Refresh packed summary from written fl_gen (force=False keeps LLM text)
    fill_fl_prompts(timeline, force=False)
    log.info("apply_fl_prompts: wrote %d / %d shot(s)", applied, len(shots))
    return timeline


def extract_and_import_fl_prompts(
    timeline: dict,
    *,
    brief: str = "",
    model: str,
    backend: str = "local",
    enable_gen: bool = True,
    **llm_kwargs,
) -> dict[str, Any]:
    """LLM → parse → apply to FL director. Returns summary."""
    from .local_director_runtime import _run_director_llm, _strip_wrappers
    from .studio_enrich import continuity_prefix

    shots = ensure_shots_from_content(timeline)
    if not shots:
        raise ValueError("请先添加分镜组，或用「故事 → 自动分镜 / N 组分镜」生成内容")

    story = (brief or "").strip()
    if not story and isinstance(timeline.get("desk"), dict):
        td = timeline["desk"].get("text_director") or {}
        if isinstance(td, dict):
            story = str(td.get("brief") or "").strip()
    global_prompt = str((timeline.get("global") or {}).get("prompt") or "")
    style = str((timeline.get("desk") or {}).get("style") or "")
    cont = continuity_prefix(timeline)

    user_msg = _build_fl_user_message(
        shots=shots,
        brief=story,
        global_prompt=global_prompt,
        style=style,
        continuity=cont,
    )
    kw = dict(llm_kwargs)
    kw.setdefault("max_tokens", 4096)
    kw.setdefault("temperature", 0.55)
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
        system_prompt=_load_fl_system_prompt(),
        system_prompt_path=FL_SYSTEM_PATH if FL_SYSTEM_PATH.is_file() else None,
        **{k: kw[k] for k in allow if k in kw},
    )
    items = parse_fl_extract_output(_strip_wrappers(raw or ""))
    if not items:
        raise RuntimeError(
            "未解析到首尾帧提示词。请确认模型输出含 <<<SHOT_1>>> 与 start_prompt / end_prompt。"
        )
    apply_fl_prompts_to_timeline(timeline, items, enable_gen=enable_gen)
    idir = timeline.get("image_director") or {}
    return {
        "shots": [
            {
                "index": i,
                "label": str(s.get("label") or f"分镜{i + 1}"),
                "start_prompt": str((s.get("fl_gen") or {}).get("start_prompt") or ""),
                "end_prompt": str((s.get("fl_gen") or {}).get("end_prompt") or ""),
                "gen_start": bool((s.get("fl_gen") or {}).get("gen_start", True)),
                "gen_end": bool((s.get("fl_gen") or {}).get("gen_end", True)),
            }
            for i, s in enumerate(timeline.get("shots") or [])
            if isinstance(s, dict)
        ],
        "shot_count": len(timeline.get("shots") or []),
        "image_director": idir,
        "shot_image_prompts": str(idir.get("shot_image_prompts") or ""),
        "global_ref_prompt": str(idir.get("global_ref_prompt") or ""),
        "timeline": timeline,
    }
