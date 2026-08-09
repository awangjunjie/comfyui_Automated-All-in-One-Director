"""HTTP routes for MiniMax H3 Director (chunked video upload)."""

from __future__ import annotations

import logging
import os
import re
import shutil

import folder_paths
from aiohttp import web
from server import PromptServer

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director")

CHUNK_ROOT = os.path.join(folder_paths.get_temp_directory(), "minimax_upload_chunks")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-()\u4e00-\u9fff]+")
_ROUTES_REGISTERED = False


def _safe_basename(name: str) -> str:
    base = os.path.basename(str(name or "video.mp4").replace("\\", "/"))
    base = _SAFE_NAME.sub("_", base).strip("._")
    return base or "video.mp4"


async def minimax_upload_video_chunk(request):
    try:
        post = await request.post()
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid upload: {exc}")

    upload_id = str(post.get("upload_id") or "").strip()
    filename = _safe_basename(post.get("filename"))
    chunk_field = post.get("chunk")
    if not upload_id or chunk_field is None:
        return web.Response(status=400, text="Missing upload_id or chunk.")

    if ".." in upload_id or "/" in upload_id or "\\" in upload_id:
        return web.Response(status=400, text="Invalid upload_id.")

    try:
        chunk_index = int(post.get("chunk_index", 0))
        total_chunks = int(post.get("total_chunks", 1))
    except (TypeError, ValueError):
        return web.Response(status=400, text="Invalid chunk index.")

    if total_chunks < 1 or chunk_index < 0 or chunk_index >= total_chunks:
        return web.Response(status=400, text="Chunk index out of range.")

    session_dir = os.path.join(CHUNK_ROOT, upload_id)
    os.makedirs(session_dir, exist_ok=True)
    part_path = os.path.join(session_dir, f"{chunk_index:06d}.part")

    with open(part_path, "wb") as out:
        while True:
            block = chunk_field.file.read(1024 * 1024)
            if not block:
                break
            out.write(block)

    if chunk_index + 1 < total_chunks:
        return web.json_response({"status": "ok", "chunk_index": chunk_index})

    input_dir = folder_paths.get_input_directory()
    out_path = os.path.join(input_dir, filename)
    if os.path.exists(out_path):
        stem, ext = os.path.splitext(filename)
        for n in range(1, 1000):
            candidate = f"{stem}_{n}{ext}"
            candidate_path = os.path.join(input_dir, candidate)
            if not os.path.exists(candidate_path):
                out_path = candidate_path
                filename = candidate
                break

    with open(out_path, "wb") as out:
        for i in range(total_chunks):
            part = os.path.join(session_dir, f"{i:06d}.part")
            if not os.path.isfile(part):
                shutil.rmtree(session_dir, ignore_errors=True)
                return web.Response(status=400, text=f"Missing chunk {i}.")
            with open(part, "rb") as src:
                shutil.copyfileobj(src, out)

    shutil.rmtree(session_dir, ignore_errors=True)
    log.info("MiniMax H3 Director uploaded video to input/: %s", filename)
    return web.json_response({"name": filename, "subfolder": "", "type": "input"})


async def minimax_probe_video(request):
    try:
        if request.can_read_body and request.content_type == "application/json":
            body = await request.json()
        else:
            body = dict(request.query)
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid request: {exc}")

    video_file = str(body.get("videoFile") or body.get("video_file") or "").strip()
    if not video_file:
        return web.Response(status=400, text="Missing videoFile.")

    from ..lib.video_io import probe_video_clip

    clip = {
        "videoFile": video_file,
        "fileName": os.path.basename(video_file),
        "subfolder": str(body.get("subfolder") or "").strip(),
        "type": str(body.get("type") or "input").strip() or "input",
    }
    try:
        info = probe_video_clip(clip)
    except Exception as exc:
        log.warning("MiniMax H3 Director video probe failed: %s", exc)
        return web.Response(status=400, text=str(exc))
    return web.json_response(info)


async def minimax_seam_dedupe(request):
    """Compare adjacent segment seams; return head-frame trims for near-duplicate junctions."""
    try:
        body = await request.json()
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid JSON: {exc}")

    timeline = body.get("timeline")
    if not isinstance(timeline, dict):
        # Allow flat payload: video/segments/frameRate at top level
        timeline = body if isinstance(body.get("segments"), list) else None
    if not isinstance(timeline, dict):
        return web.Response(status=400, text="Missing timeline object.")

    segs = timeline.get("segments") or []
    if not isinstance(segs, list) or len(segs) < 2:
        return web.json_response(
            {"trims": [], "totalDropped": 0, "judgeFrames": 0, "madThreshold": 0, "message": "需要至少 2 个分镜"}
        )

    try:
        judge_frames = int(body.get("judgeFrames") or body.get("judge_frames") or 8)
    except (TypeError, ValueError):
        judge_frames = 8
    try:
        mad_threshold = float(body.get("madThreshold") or body.get("mad_threshold") or 8.0)
    except (TypeError, ValueError):
        mad_threshold = 8.0
    try:
        min_segment_frames = int(body.get("minSegmentFrames") or body.get("min_segment_frames") or 5)
    except (TypeError, ValueError):
        min_segment_frames = 5

    from ..lib.seam_dedupe import compute_seam_trims

    try:
        result = compute_seam_trims(
            timeline,
            judge_frames=judge_frames,
            mad_threshold=mad_threshold,
            min_segment_frames=min_segment_frames,
        )
    except Exception as exc:
        log.warning("MiniMax H3 Director seam_dedupe failed: %s", exc)
        return web.Response(status=400, text=str(exc))
    return web.json_response(result)


async def minimax_detect_shots(request):
    """Detect shot boundaries with PySceneDetect; return logical cut frames."""
    try:
        body = await request.json()
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid JSON: {exc}")

    from ..lib.shot_detect import (
        detect_timeline_shot_cuts,
        scenedetect_available,
        scenedetect_install_hint,
    )

    if not scenedetect_available():
        return web.Response(
            status=400,
            text=(
                "PySceneDetect is not installed in ComfyUI's Python "
                f"({__import__('sys').executable}). "
                f"Run: {scenedetect_install_hint()}"
            ),
        )

    try:
        frame_rate = float(body.get("frameRate") or body.get("frame_rate") or 24)
    except (TypeError, ValueError):
        frame_rate = 24.0
    try:
        total_frames = int(body.get("totalFrames") or body.get("total_frames") or 0)
    except (TypeError, ValueError):
        return web.Response(status=400, text="Invalid totalFrames.")

    sensitivity = str(body.get("sensitivity") or "medium").strip().lower()
    try:
        min_shot_frames = int(body.get("minShotFrames") or body.get("min_shot_frames") or 12)
    except (TypeError, ValueError):
        min_shot_frames = 12

    clips_in = body.get("clips")
    clips: list[dict] = []
    if isinstance(clips_in, list) and clips_in:
        for item in clips_in:
            if not isinstance(item, dict):
                continue
            video_file = str(item.get("videoFile") or item.get("video_file") or "").strip()
            if not video_file:
                continue
            clips.append(
                {
                    "videoFile": video_file,
                    "fileName": os.path.basename(video_file),
                    "subfolder": str(item.get("subfolder") or "").strip(),
                    "type": str(item.get("type") or "input").strip() or "input",
                    "logicalStart": item.get("logicalStart", item.get("logical_start", 0)),
                    "logicalEnd": item.get("logicalEnd", item.get("logical_end", total_frames)),
                    "nativeFps": item.get("nativeFps", item.get("native_fps")),
                }
            )
    else:
        video_file = str(body.get("videoFile") or body.get("video_file") or "").strip()
        if not video_file:
            return web.Response(status=400, text="Missing clips[] or videoFile.")
        clips.append(
            {
                "videoFile": video_file,
                "fileName": os.path.basename(video_file),
                "subfolder": str(body.get("subfolder") or "").strip(),
                "type": str(body.get("type") or "input").strip() or "input",
                "logicalStart": 0,
                "logicalEnd": total_frames,
                "nativeFps": body.get("nativeFps", body.get("native_fps")),
            }
        )

    if total_frames <= 0:
        return web.Response(status=400, text="totalFrames must be > 0.")

    try:
        result = detect_timeline_shot_cuts(
            clips,
            frame_rate=frame_rate,
            total_frames=total_frames,
            sensitivity=sensitivity,
            min_shot_frames=min_shot_frames,
        )
    except ImportError as exc:
        return web.Response(status=400, text=str(exc))
    except Exception as exc:
        log.warning("MiniMax H3 Director shot detect failed: %s", exc)
        return web.Response(status=400, text=str(exc))

    return web.json_response(result)


def _register_route(routes, method: str, path: str, handler) -> None:
    method_u = str(method or "POST").upper()
    # ComfyUI PromptServer.routes is aiohttp RouteTableDef (has .post/.get, NOT .add_route)
    if method_u == "POST" and hasattr(routes, "post"):
        routes.post(path)(handler)
    elif method_u == "GET" and hasattr(routes, "get"):
        routes.get(path)(handler)
    elif hasattr(routes, "route"):
        routes.route(method_u, path)(handler)
    elif hasattr(routes, "add_route"):
        routes.add_route(method_u, path, handler)
    else:
        raise AttributeError("Unsupported ComfyUI route table API")


def register_routes() -> bool:
    """Register MiniMax H3 Director HTTP routes on the ComfyUI PromptServer."""
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True

    server = PromptServer.instance
    if server is None:
        log.warning("MiniMax H3 Director: PromptServer not ready, HTTP routes not registered")
        return False

    routes = server.routes
    _register_route(routes, "POST", "/minimax/director/upload_chunk", minimax_upload_video_chunk)
    _register_route(routes, "POST", "/minimax/director/probe_video", minimax_probe_video)
    _register_route(routes, "GET", "/minimax/director/probe_video", minimax_probe_video)
    _register_route(routes, "POST", "/minimax/director/detect_shots", minimax_detect_shots)
    _register_route(routes, "POST", "/minimax/director/seam_dedupe", minimax_seam_dedupe)
    _register_route(routes, "POST", "/minimax/director/local_expand", minimax_local_expand)
    _register_route(routes, "GET", "/minimax/director/local_models", minimax_local_models)
    _register_route(routes, "POST", "/minimax/director/shot_list", minimax_shot_list)
    _register_route(routes, "POST", "/minimax/director/image_prompts", minimax_image_prompts)
    _register_route(routes, "POST", "/minimax/director/extract_assets", minimax_extract_assets)
    _register_route(routes, "POST", "/minimax/director/extract_studio_bible", minimax_extract_studio_bible)
    _register_route(routes, "POST", "/minimax/director/extract_fl_prompts", minimax_extract_fl_prompts)

    # 提示词增强相关路由（此前漏挂载 → 前端 POST 会落到静态资源并返回 405）
    from .prompt_enhance_routes import register_prompt_enhance_routes

    register_prompt_enhance_routes(routes, _register_route)

    _ROUTES_REGISTERED = True
    log.info("MiniMax H3 Director HTTP routes registered")
    return True


async def minimax_local_models(_request):
    from .local_director_runtime import local_director_available, model_choices, mmproj_choices
    from .skill_presets import list_skills

    return web.json_response(
        {
            "available": local_director_available(),
            "models": model_choices(),
            "mmproj": mmproj_choices(),
            "skills": list_skills(),
        }
    )


def _normalize_thinking(*values) -> str:
    """Map UI/API values to 智谱 official thinking.type: enabled | disabled."""
    for raw in values:
        if raw is None or raw is False or raw == "":
            continue
        if raw is True:
            return "enabled"
        s = str(raw).strip().lower()
        if s in ("1", "true", "yes", "on", "enabled"):
            return "enabled"
        if s in ("0", "false", "no", "off", "disabled"):
            return "disabled"
    return "disabled"


async def minimax_local_expand(request):
    try:
        data = await request.json()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"请求 JSON 无效: {exc}"}, status=400)

    from .local_director_runtime import (
        director_mode_from_task_key,
        expand_brief,
        expand_prompt_groups,
        expand_story_auto,
        expand_story_to_shots,
    )

    expand_mode = str(data.get("expand_mode") or data.get("scope") or "single").strip().lower()
    task_type = str(data.get("task_type") or data.get("taskType") or "")
    mode = str(data.get("mode") or "").strip().upper()
    if task_type:
        mode = director_mode_from_task_key(task_type)
    if mode not in ("T2VA", "I2VA", "FL2VA", "L2VA", "REF2VA"):
        mode = "T2VA"
    from .skill_presets import skill_id_from_value

    skill_id = skill_id_from_value(data.get("skill_id") or data.get("skill") or data.get("style_skill"))
    common = dict(
        model=str(data.get("model") or ""),
        mode=mode,
        ratio=str(data.get("ratio") or "16:9"),
        camera_style=str(data.get("camera_style") or "电影感，动机明确的运镜，清晰的镜头切换"),
        mmproj=str(data.get("mmproj") or "none"),
        max_tokens=int(data.get("max_tokens") or 2048),
        temperature=float(data.get("temperature") or 0.6),
        seed=int(data.get("seed") or 1),
        timeout_seconds=int(data.get("timeout_seconds") or 300),
        backend=str(data.get("backend") or data.get("director_backend") or "local"),
        llm_url=str(data.get("llm_url") or data.get("api_url") or ""),
        api_format=str(data.get("api_format") or data.get("llm_api_format") or "Ollama"),
        api_key=str(data.get("api_key") or data.get("llm_api_key") or ""),
        thinking=_normalize_thinking(data.get("thinking"), data.get("zhipu_thinking")),
        skill_id=skill_id,
    )
    continuity = str(data.get("continuity") or "")
    chain_continuity = bool(
        data.get("chain_continuity")
        or data.get("chainContinuity")
        or data.get("continuity_enabled")
        or data.get("continuityEnabled")
    )
    preserve = dict(
        global_prompt=str(data.get("global_prompt") or ""),
        desk_style=str(data.get("desk_style") or data.get("style") or ""),
        desk_soundscape=str(data.get("desk_soundscape") or data.get("soundscape") or ""),
        desk_music=str(data.get("desk_music") or data.get("music") or ""),
        chain_continuity=chain_continuity,
    )

    try:
        if expand_mode in ("groups", "per_group", "batch"):
            groups = data.get("groups") or []
            if not isinstance(groups, list) or not groups:
                return web.json_response({"ok": False, "error": "groups 为空"}, status=400)
            result = expand_prompt_groups(
                groups=groups,
                story_context=str(data.get("brief") or data.get("story_context") or ""),
                continuity=continuity,
                default_duration=float(data.get("duration") or 5.0),
                **preserve,
                **common,
            )
            return web.json_response({
                "ok": True,
                "expand_mode": "groups",
                "shots": result.get("shots") or [],
                "global_prompt": result.get("global_prompt") or "",
            })

        if expand_mode in ("story_auto", "auto", "auto_plan", "auto_shots"):
            dur_min = float(data.get("duration_min") or data.get("min_duration") or 2.0)
            dur_max = float(data.get("duration_max") or data.get("max_duration") or 12.0)
            result = expand_story_auto(
                brief=str(data.get("brief") or ""),
                shot_min=int(data.get("shot_min") or data.get("min_shots") or 2),
                shot_max=int(data.get("shot_max") or data.get("max_shots") or data.get("shot_count") or 8),
                duration_min=dur_min,
                duration_max=dur_max,
                duration_hint=float(
                    data.get("duration")
                    or data.get("duration_hint")
                    or ((dur_min + dur_max) / 2.0)
                ),
                total_duration_hint=(
                    float(data["total_duration_hint"])
                    if data.get("total_duration_hint") not in (None, "")
                    else None
                ),
                continuity=continuity,
                **preserve,
                **common,
            )
            return web.json_response({
                "ok": True,
                "expand_mode": "story_auto",
                "shots": result.get("shots") or [],
                "global_prompt": result.get("global_prompt") or "",
                "shot_count": result.get("shot_count") or len(result.get("shots") or []),
                "total_duration": result.get("total_duration") or 0,
            })

        if expand_mode in ("story_split", "story", "split"):
            result = expand_story_to_shots(
                brief=str(data.get("brief") or ""),
                shot_count=int(data.get("shot_count") or data.get("group_count") or 2),
                duration_each=float(data.get("duration") or data.get("duration_each") or 5.0),
                continuity=continuity,
                **preserve,
                **common,
            )
            return web.json_response({
                "ok": True,
                "expand_mode": "story_split",
                "shots": result.get("shots") or [],
                "global_prompt": result.get("global_prompt") or "",
            })

        # single / shot / global
        expand_global = bool(
            data.get("expand_global")
            or expand_mode in ("global", "global_prompt")
        )
        text = expand_brief(
            brief=str(data.get("brief") or ""),
            duration=float(data.get("duration") or 5.0),
            single_shot=bool(data.get("single_shot") or expand_mode == "shot") and not expand_global,
            expand_global=expand_global,
            shot_index=data.get("shot_index"),
            shot_total=data.get("shot_total"),
            shot_label=str(data.get("shot_label") or ""),
            continuity=continuity,
            story_context=str(data.get("story_context") or ""),
            **preserve,
            **common,
        )
    except Exception as exc:
        log.warning("local_expand failed: %s", exc)
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

    return web.json_response({
        "ok": True,
        "expand_mode": "global" if expand_global else "single",
        "prompt": text,
        "global_prompt": text if expand_global else "",
    })


async def minimax_shot_list(request):
    try:
        data = await request.json()
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid JSON: {exc}")

    import json as _json

    from .studio_enrich import export_shot_list_markdown, ensure_studio_fields

    raw = data.get("timeline") or data.get("timeline_data") or {}
    if isinstance(raw, str):
        try:
            timeline = _json.loads(raw)
        except Exception as exc:
            return web.Response(status=400, text=f"Invalid timeline: {exc}")
    elif isinstance(raw, dict):
        timeline = raw
    else:
        return web.Response(status=400, text="timeline required")

    ensure_studio_fields(timeline)
    return web.json_response({"ok": True, "markdown": export_shot_list_markdown(timeline)})


async def minimax_image_prompts(request):
    """Build global + per-shot still prompts for Image Director."""
    try:
        data = await request.json()
    except Exception as exc:
        return web.Response(status=400, text=f"Invalid JSON: {exc}")

    import json as _json

    from .image_director import (
        ensure_image_director,
        rebuild_still_prompts,
        sync_empty_segment_prompts_from_global,
    )
    from .fl_frame_director import is_fl2v_timeline

    raw = data.get("timeline") or data.get("timeline_data") or {}
    if isinstance(raw, str):
        try:
            timeline = _json.loads(raw)
        except Exception as exc:
            return web.Response(status=400, text=f"Invalid timeline: {exc}")
    elif isinstance(raw, dict):
        timeline = raw
    else:
        return web.Response(status=400, text="timeline required")

    ensure_image_director(timeline)
    if data.get("unified_ref_note") is not None:
        timeline["image_director"]["unified_ref_note"] = str(data.get("unified_ref_note") or "")
    if data.get("style_suffix") is not None:
        timeline["image_director"]["style_suffix"] = str(data.get("style_suffix") or "")
    timeline["image_director"]["enabled"] = True
    force = bool(data.get("force", True))

    filled = 0
    if not is_fl2v_timeline(timeline):
        filled = sync_empty_segment_prompts_from_global(timeline)
    rebuild_still_prompts(timeline, force=force)
    idir = timeline["image_director"]
    global_prompt = str(idir.get("global_ref_prompt") or "")
    shot_text = str(idir.get("shot_image_prompts") or "")

    if is_fl2v_timeline(timeline):
        fl_shots = []
        for i, shot in enumerate(timeline.get("shots") or []):
            if not isinstance(shot, dict):
                continue
            fg = shot.get("fl_gen") or {}
            fl_shots.append(
                {
                    "index": i,
                    "start_prompt": str(fg.get("start_prompt") or ""),
                    "end_prompt": str(fg.get("end_prompt") or ""),
                    "gen_start": bool(fg.get("gen_start", True)),
                    "gen_end": bool(fg.get("gen_end", True)),
                }
            )
        return web.json_response(
            {
                "ok": True,
                "mode": "fl2v",
                "global_ref_prompt": global_prompt,
                "shot_image_prompts": shot_text,
                "shots": timeline.get("shots") or [],
                "fl_shots": fl_shots,
                "filled_groups": 0,
                "segments": [],
                "image_director": idir,
            }
        )

    shot_strings = [b for b in shot_text.split("\n\n") if b.strip()] if shot_text else []
    return web.json_response(
        {
            "ok": True,
            "mode": "refs",
            "global_ref_prompt": global_prompt,
            "shot_image_prompts": shot_text,
            "shots": shot_strings,
            "filled_groups": filled,
            "segments": [
                {
                    "prompt": str(s.get("prompt") or ""),
                    "label": str(s.get("label") or ""),
                }
                for s in (timeline.get("segments") or [])
                if isinstance(s, dict)
            ],
            "image_director": idir,
        }
    )


async def minimax_extract_studio_bible(request):
    """Prompt Director: fill continuity + global soundscape from story."""
    try:
        data = await request.json()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"请求 JSON 无效: {exc}"}, status=400)

    import json as _json

    from .studio_bible_runtime import extract_studio_bible
    from .studio_enrich import ensure_studio_fields

    raw = data.get("timeline") or data.get("timeline_data") or {}
    if isinstance(raw, str):
        try:
            timeline = _json.loads(raw)
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"Invalid timeline: {exc}"}, status=400)
    elif isinstance(raw, dict):
        timeline = raw
    else:
        timeline = {}

    ensure_studio_fields(timeline)

    model = str(data.get("model") or "").strip()
    if not model or model.startswith("（"):
        return web.json_response({"ok": False, "error": "请选择提示词导演模型"}, status=400)

    try:
        result = extract_studio_bible(
            timeline,
            brief=str(data.get("brief") or data.get("story") or ""),
            model=model,
            backend=str(data.get("backend") or data.get("director_backend") or "local"),
            overwrite=bool(data.get("overwrite", True)),
            llm_url=str(data.get("llm_url") or data.get("api_url") or ""),
            api_format=str(data.get("api_format") or data.get("llm_api_format") or "Ollama"),
            api_key=str(data.get("api_key") or data.get("llm_api_key") or ""),
            max_tokens=int(data.get("max_tokens") or 2048),
            temperature=float(data.get("temperature") or 0.45),
            timeout_seconds=int(data.get("timeout_seconds") or 300),
            thinking=_normalize_thinking(data.get("thinking"), data.get("zhipu_thinking")),
            mmproj=str(data.get("mmproj") or "none"),
            seed=int(data.get("seed") or 1),
        )
    except Exception as exc:
        log.exception("extract_studio_bible failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    applied = result.get("applied") or {}
    n_c = len(applied.get("continuity") or {})
    n_d = len(applied.get("desk") or {})
    return web.json_response(
        {
            "ok": True,
            "continuity": result.get("continuity") or timeline.get("continuity"),
            "desk": result.get("desk") or {},
            "applied": applied,
            "timeline": timeline,
            "message": f"已填充连续性 {n_c} 项、全局声景 {n_d} 项",
        }
    )


async def minimax_extract_assets(request):
    """Prompt Director: extract character sheets + scene prompts → Image Director."""
    try:
        data = await request.json()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"请求 JSON 无效: {exc}"}, status=400)

    import json as _json

    from .asset_prompt_runtime import extract_and_import_assets
    from .image_director import ensure_image_director
    from .studio_enrich import ensure_studio_fields

    raw = data.get("timeline") or data.get("timeline_data") or {}
    if isinstance(raw, str):
        try:
            timeline = _json.loads(raw)
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"Invalid timeline: {exc}"}, status=400)
    elif isinstance(raw, dict):
        timeline = raw
    else:
        timeline = {}

    ensure_studio_fields(timeline)
    ensure_image_director(timeline)

    model = str(data.get("model") or "").strip()
    if not model or model.startswith("（"):
        return web.json_response({"ok": False, "error": "请选择提示词导演模型"}, status=400)

    try:
        result = extract_and_import_assets(
            timeline,
            brief=str(data.get("brief") or data.get("story") or ""),
            model=model,
            backend=str(data.get("backend") or data.get("director_backend") or "local"),
            enable_gen=bool(data.get("enable_gen", True)),
            llm_url=str(data.get("llm_url") or data.get("api_url") or ""),
            api_format=str(data.get("api_format") or data.get("llm_api_format") or "Ollama"),
            api_key=str(data.get("api_key") or data.get("llm_api_key") or ""),
            max_tokens=int(data.get("max_tokens") or 4096),
            temperature=float(data.get("temperature") or 0.55),
            timeout_seconds=int(data.get("timeout_seconds") or 300),
            thinking=_normalize_thinking(data.get("thinking"), data.get("zhipu_thinking")),
            mmproj=str(data.get("mmproj") or "none"),
            seed=int(data.get("seed") or 1),
        )
    except Exception as exc:
        log.exception("extract_assets failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    idir = timeline.get("image_director") or {}
    n_char = len(result.get("characters") or [])
    n_scene = len(result.get("scenes") or [])
    return web.json_response(
        {
            "ok": True,
            "characters": result.get("characters") or [],
            "scenes": result.get("scenes") or [],
            "character_count": n_char,
            "scene_count": n_scene,
            "continuity": timeline.get("continuity"),
            "image_director": idir,
            "shot_image_prompts": str(idir.get("shot_image_prompts") or ""),
            "global_ref_prompt": str(idir.get("global_ref_prompt") or ""),
            "timeline": timeline,
            "message": f"已提取 {n_char} 个人物定妆 + {n_scene} 个场景，并导入参考图导演",
        }
    )


async def minimax_extract_fl_prompts(request):
    """Prompt Director: LLM first/last frame prompts → FL Frame Director."""
    try:
        data = await request.json()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"请求 JSON 无效: {exc}"}, status=400)

    import json as _json

    from .fl_prompt_runtime import extract_and_import_fl_prompts
    from .image_director import ensure_image_director
    from .studio_enrich import ensure_studio_fields

    raw = data.get("timeline") or data.get("timeline_data") or {}
    if isinstance(raw, str):
        try:
            timeline = _json.loads(raw)
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"Invalid timeline: {exc}"}, status=400)
    elif isinstance(raw, dict):
        timeline = raw
    else:
        timeline = {}

    ensure_studio_fields(timeline)
    ensure_image_director(timeline)
    timeline["timelineMode"] = "fl2v"

    model = str(data.get("model") or "").strip()
    if not model or model.startswith("（"):
        return web.json_response({"ok": False, "error": "请选择提示词导演模型"}, status=400)

    try:
        result = extract_and_import_fl_prompts(
            timeline,
            brief=str(data.get("brief") or data.get("story") or ""),
            model=model,
            backend=str(data.get("backend") or data.get("director_backend") or "local"),
            enable_gen=bool(data.get("enable_gen", True)),
            llm_url=str(data.get("llm_url") or data.get("api_url") or ""),
            api_format=str(data.get("api_format") or data.get("llm_api_format") or "Ollama"),
            api_key=str(data.get("api_key") or data.get("llm_api_key") or ""),
            max_tokens=int(data.get("max_tokens") or 4096),
            temperature=float(data.get("temperature") or 0.55),
            timeout_seconds=int(data.get("timeout_seconds") or 300),
            thinking=_normalize_thinking(data.get("thinking"), data.get("zhipu_thinking")),
            mmproj=str(data.get("mmproj") or "none"),
            seed=int(data.get("seed") or 1),
        )
    except Exception as exc:
        log.exception("extract_fl_prompts failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    n = int(result.get("shot_count") or len(result.get("shots") or []))
    return web.json_response(
        {
            "ok": True,
            "mode": "fl2v",
            "shots": timeline.get("shots") or [],
            "fl_shots": result.get("shots") or [],
            "shot_count": n,
            "image_director": timeline.get("image_director"),
            "shot_image_prompts": result.get("shot_image_prompts") or "",
            "global_ref_prompt": result.get("global_ref_prompt") or "",
            "timeline": timeline,
            "message": f"已为 {n} 组分镜生成首/尾帧提示词，并同步到首尾帧导演",
        }
    )
