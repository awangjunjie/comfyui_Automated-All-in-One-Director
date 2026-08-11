# -*- coding: utf-8 -*-
"""Film long-form resume: shot status, tail-frame persistence, continuity handoff."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.film_resume")

# Soft warning thresholds (UI confirms above these; not hard clamps).
SHOT_COUNT_WARN_THRESHOLD = 20
DURATION_SEC_WARN_THRESHOLD = 20.0
# Legacy alias — no longer used as a hard clamp.
LLM_SHOT_HARD_MAX = 512
FILM_CHAPTER_SHOT_CAP = 240
SHOT_STATUSES = ("pending", "done", "failed")


def clamp_shot_range(shot_min: int, shot_max: int) -> tuple[int, int]:
    """Normalize shot range: only enforce lo>=1 and hi>=lo (no hard upper cap)."""
    hi = max(1, int(shot_max or 8))
    lo = max(1, min(hi, int(shot_min or 2)))
    return lo, hi


def clamp_duration_range(
    d_min: float,
    d_max: float,
    *,
    narrative_mode: str = "short_drama",
) -> tuple[float, float]:
    """Normalize duration range: only enforce floor and hi>=lo (no hard upper cap)."""
    floor = 1.0 if narrative_mode == "film" else 0.5
    hi = max(floor, float(d_max or 12.0))
    lo = max(floor, min(hi, float(d_min or 2.0)))
    return lo, hi


def normalize_shot_status(value: Any) -> str:
    raw = str(value or "pending").strip().lower()
    if raw in SHOT_STATUSES:
        return raw
    if raw in {"complete", "completed", "ok", "success"}:
        return "done"
    return "pending"


def ensure_shot_fields(shot: dict[str, Any], index: int) -> dict[str, Any]:
    shot["index"] = int(shot.get("index") if shot.get("index") is not None else index)
    shot.setdefault("label", f"分镜{shot['index'] + 1}")
    shot["status"] = normalize_shot_status(shot.get("status"))
    shot.setdefault("outputFile", shot.get("outputFile") or "")
    shot.setdefault("tailFrameFile", shot.get("tailFrameFile") or "")
    shot.setdefault("error", shot.get("error") or "")
    return shot


def count_shot_progress(shots: list[Any]) -> dict[str, int]:
    total = done = failed = pending = 0
    for s in shots:
        if not isinstance(s, dict):
            continue
        total += 1
        st = normalize_shot_status(s.get("status"))
        if st == "done":
            done += 1
        elif st == "failed":
            failed += 1
        else:
            pending += 1
    return {
        "shotCount": total,
        "shotDoneCount": done,
        "shotFailedCount": failed,
        "shotPendingCount": pending,
    }


def refresh_chapter_status_from_shots(ch: dict[str, Any]) -> str:
    shots = ch.get("shots") if isinstance(ch.get("shots"), list) else []
    prog = count_shot_progress(shots)
    ch["shotCount"] = prog["shotCount"]
    if prog["shotCount"] <= 0:
        return str(ch.get("status") or "pending")
    if prog["shotPendingCount"] == 0 and prog["shotFailedCount"] == 0:
        ch["status"] = "done"
    elif prog["shotDoneCount"] > 0 or prog["shotFailedCount"] > 0:
        ch["status"] = "generating"
    elif str(ch.get("status") or "") in {"", "pending"}:
        ch["status"] = "storyboarded"
    return str(ch.get("status") or "storyboarded")


def load_tail_frame_tensor(path: str | Path) -> torch.Tensor | None:
    """Load a saved tail PNG/JPG as [1,H,W,C] float tensor in 0..1."""
    try:
        p = Path(path)
        if not p.is_file():
            return None
        img = Image.open(p).convert("RGB")
        arr = np.asarray(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception as exc:
        log.warning("load tail frame failed (%s): %s", path, exc)
        return None


def save_tail_frame_png(tensor: torch.Tensor, dest: Path) -> bool:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        frame = tensor[-1] if tensor.ndim == 4 else tensor
        frame = frame.detach().float().cpu().clamp(0, 1)
        arr = (frame.numpy() * 255.0).round().astype(np.uint8)
        Image.fromarray(arr).save(dest, format="PNG")
        return True
    except Exception as exc:
        log.warning("save tail frame failed (%s): %s", dest, exc)
        return False


def hydrate_chapter_shots(project: dict[str, Any], ch: dict[str, Any]) -> list[dict[str, Any]]:
    """Ensure chapter.shots is populated (prefer memory, fall back to shots.json)."""
    from .novel_runtime import _chapter_dir

    shots = ch.get("shots") if isinstance(ch.get("shots"), list) else []
    if shots:
        for i, s in enumerate(shots):
            if isinstance(s, dict):
                ensure_shot_fields(s, i)
        return shots
    pid = str(project.get("projectId") or "")
    if not pid:
        return []
    path = _chapter_dir(pid, ch) / "shots.json"
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    disk_shots = data.get("shots") if isinstance(data, dict) else None
    if not isinstance(disk_shots, list):
        return []
    out = []
    for i, s in enumerate(disk_shots):
        if isinstance(s, dict):
            out.append(ensure_shot_fields(s, i))
    ch["shots"] = out
    if data.get("globalPrompt") and not ch.get("globalPrompt"):
        ch["globalPrompt"] = data.get("globalPrompt")
    return out


def persist_segment_shot_artifacts(
    *,
    project_id: str,
    chapter_id: str,
    shot_index: int,
    chunk: torch.Tensor,
    mark_done: bool = True,
) -> dict[str, Any] | None:
    """After a film/novel segment finishes: write tail PNG + update shot status."""
    from .novel_runtime import (
        _chapter_dir,
        _now_iso,
        _write_json,
        append_history,
        get_chapter,
        load_project,
        save_project,
    )

    if not project_id or not chapter_id or shot_index is None:
        return None
    try:
        project = load_project(project_id)
        ch = get_chapter(project, chapter_id)
        shots = hydrate_chapter_shots(project, ch)
        shot = None
        for s in shots:
            if isinstance(s, dict) and int(s.get("index", -1)) == int(shot_index):
                shot = s
                break
        if shot is None and 0 <= int(shot_index) < len(shots) and isinstance(shots[int(shot_index)], dict):
            shot = shots[int(shot_index)]
        if shot is None:
            log.warning("persist shot: index=%s missing in %s", shot_index, chapter_id)
            return None

        ensure_shot_fields(shot, int(shot_index))
        cdir = _chapter_dir(project_id, ch)
        clips = cdir / "clips"
        clips.mkdir(parents=True, exist_ok=True)
        stem = f"shot_{int(shot_index) + 1:03d}"
        tail_name = f"{stem}_tail.png"
        tail_path = clips / tail_name
        if chunk is not None and getattr(chunk, "ndim", 0) == 4 and int(chunk.shape[0]) >= 1:
            if save_tail_frame_png(chunk, tail_path):
                shot["tailFrameFile"] = f"clips/{tail_name}"
        if mark_done:
            shot["status"] = "done"
            shot["error"] = ""
        shot["updatedAt"] = _now_iso()
        refresh_chapter_status_from_shots(ch)
        ch["updatedAt"] = _now_iso()
        _write_json(
            cdir / "shots.json",
            {
                "globalPrompt": ch.get("globalPrompt") or "",
                "shots": shots,
                "narrativeMode": (project.get("settings") or {}).get("narrativeMode"),
            },
        )
        prog = count_shot_progress(shots)
        append_history(
            project,
            "shot_done",
            f"{ch.get('title')} · 镜{int(shot_index) + 1}/{prog['shotCount']}"
            f"（完成 {prog['shotDoneCount']}）",
        )
        save_project(project)
        return {"shot": shot, "chapter": ch, "project": project}
    except Exception as exc:
        log.warning("persist_segment_shot_artifacts failed: %s", exc)
        return None
