"""HTTP routes for novel chapter video mode."""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import web

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.novel.routes")


async def _json_body(request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def register_novel_routes(routes, register_route) -> None:
    register_route(routes, "GET", "/minimax/director/novel/projects", novel_list_projects)
    register_route(routes, "POST", "/minimax/director/novel/projects", novel_project_action)
    register_route(routes, "POST", "/minimax/director/novel/import", novel_import)
    register_route(routes, "POST", "/minimax/director/novel/split_acts", novel_split_acts)
    register_route(routes, "POST", "/minimax/director/novel/split_segments", novel_split_segments)
    register_route(routes, "POST", "/minimax/director/novel/chapter/storyboard", novel_chapter_storyboard)
    register_route(routes, "POST", "/minimax/director/novel/assets/extract", novel_assets_extract)
    register_route(routes, "POST", "/minimax/director/novel/assets/upload", novel_assets_upload)
    register_route(routes, "POST", "/minimax/director/novel/assets/delete", novel_assets_delete)
    register_route(routes, "POST", "/minimax/director/novel/assets/bind", novel_assets_bind)
    register_route(routes, "POST", "/minimax/director/novel/assets/sync", novel_assets_sync)
    register_route(routes, "POST", "/minimax/director/novel/assets/stage", novel_assets_stage)
    register_route(routes, "GET", "/minimax/director/novel/image", novel_asset_image)
    register_route(routes, "POST", "/minimax/director/novel/chapter/prepare", novel_chapter_prepare)
    register_route(routes, "POST", "/minimax/director/novel/chapter/save_output", novel_chapter_save_output)
    register_route(routes, "POST", "/minimax/director/novel/progress", novel_progress)
    register_route(routes, "POST", "/minimax/director/novel/clear_global_cache", novel_clear_global_cache)


async def novel_list_projects(request):
    from .novel_runtime import list_projects

    q = request.rel_url.query
    product = str(q.get("productTask") or q.get("product") or q.get("task") or "novel")
    return web.json_response({"ok": True, "projects": list_projects(product), "productTask": product})


async def novel_project_action(request):
    from .novel_runtime import (
        delete_project,
        load_project,
        save_project,
        timeline_novel_patch,
    )

    data = await _json_body(request)
    action = str(data.get("action") or "load").strip().lower()
    project_id = str(data.get("projectId") or "").strip()
    try:
        if action == "list":
            from .novel_runtime import list_projects

            product = str(data.get("productTask") or data.get("product") or data.get("taskType") or "novel")
            return web.json_response(
                {"ok": True, "projects": list_projects(product), "productTask": product}
            )
        if action == "delete":
            ok = delete_project(project_id)
            return web.json_response({"ok": ok})
        if action == "save":
            project = data.get("project")
            if not isinstance(project, dict):
                raise ValueError("缺少 project")
            saved = save_project(project)
            return web.json_response({"ok": True, "project": saved, "novel": timeline_novel_patch(saved)})
        # load
        project = load_project(project_id, stage_assets=True)
        return web.json_response({"ok": True, "project": project, "novel": timeline_novel_patch(project)})
    except Exception as exc:
        log.exception("novel project action failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_stage(request):
    from .novel_runtime import load_project, stage_project_assets_to_input, timeline_novel_patch

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        result = stage_project_assets_to_input(project)
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {"ok": True, **result, "project": project, "novel": timeline_novel_patch(project)}
        )
    except Exception as exc:
        log.exception("novel assets stage failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_asset_image(request):
    from .novel_runtime import resolve_project_asset_file

    q = request.rel_url.query
    path = resolve_project_asset_file(
        str(q.get("projectId") or ""),
        rel_path=str(q.get("rel") or q.get("imagePath") or ""),
        input_file=str(q.get("input") or q.get("inputFile") or ""),
    )
    if path is None:
        return web.Response(status=404, text="image not found")
    return web.FileResponse(path)


async def novel_import(request):
    from .novel_runtime import import_novel, timeline_novel_patch

    data = await _json_body(request)
    try:
        split_raw = data.get("splitChapters")
        if split_raw is None:
            split_raw = data.get("split_chapters")
        split_flag = None if split_raw is None else bool(split_raw)
        project = import_novel(
            text=str(data.get("text") or ""),
            filename=str(data.get("filename") or ""),
            file_b64=str(data.get("fileB64") or data.get("file_b64") or ""),
            title=str(data.get("title") or ""),
            project_id=str(data.get("projectId") or ""),
            product_task=str(data.get("productTask") or data.get("product_task") or data.get("taskType") or ""),
            split_chapters_flag=split_flag,
        )
        return web.json_response({"ok": True, "project": project, "novel": timeline_novel_patch(project)})
    except Exception as exc:
        log.exception("novel import failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_split_acts(request):
    from .novel_runtime import load_project, split_acts_via_llm, timeline_novel_patch

    data = await _json_body(request)
    try:
        project_id = str(data.get("projectId") or "").strip()
        model = str(data.get("model") or "").strip()
        if not project_id:
            raise ValueError("缺少 projectId")
        if not model:
            raise ValueError("请选择提示词导演模型")
        project = load_project(project_id)
        result = split_acts_via_llm(
            project,
            model=model,
            backend=str(data.get("backend") or "local"),
            force=bool(data.get("force")),
            llm_url=data.get("llm_url"),
            api_format=data.get("api_format"),
            api_key=data.get("api_key"),
            n_gpu_layers=data.get("n_gpu_layers"),
            temperature=data.get("temperature"),
            mmproj=data.get("mmproj"),
            max_tokens=data.get("max_tokens") or data.get("maxTokens"),
            timeout_seconds=data.get("timeout_seconds") or data.get("timeoutSeconds"),
            ctx_size=data.get("ctx_size") or data.get("n_ctx") or data.get("ctxSize"),
        )
        project = result.get("project") or load_project(project_id)
        return web.json_response(
            {
                "ok": True,
                **{k: v for k, v in result.items() if k != "project"},
                "project": project,
                "novel": timeline_novel_patch(project),
            }
        )
    except Exception as exc:
        log.exception("novel split_acts failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_split_segments(request):
    from .novel_runtime import load_project, split_act_into_segments, timeline_novel_patch

    data = await _json_body(request)
    try:
        project_id = str(data.get("projectId") or "").strip()
        chapter_id = str(data.get("chapterId") or data.get("actId") or "").strip()
        if not project_id:
            raise ValueError("缺少 projectId")
        if not chapter_id:
            raise ValueError("请先选择要切分的幕")
        project = load_project(project_id)
        settings = data.get("settings")
        if isinstance(settings, dict):
            project.setdefault("settings", {}).update(settings)
        max_raw = data.get("segmentMaxMinutes")
        if max_raw is None:
            max_raw = data.get("maxMinutes")
        result = split_act_into_segments(
            project,
            chapter_id,
            max_minutes=float(max_raw) if max_raw is not None and str(max_raw).strip() != "" else None,
            model=str(data.get("model") or "").strip(),
            backend=str(data.get("backend") or "local"),
            use_llm=bool(data.get("useLlm", True)),
            llm_url=data.get("llm_url"),
            api_format=data.get("api_format"),
            api_key=data.get("api_key"),
            n_gpu_layers=data.get("n_gpu_layers"),
            temperature=data.get("temperature"),
            mmproj=data.get("mmproj"),
            max_tokens=data.get("max_tokens") or data.get("maxTokens"),
            timeout_seconds=data.get("timeout_seconds") or data.get("timeoutSeconds"),
            ctx_size=data.get("ctx_size") or data.get("n_ctx") or data.get("ctxSize"),
        )
        project = result.get("project") or load_project(project_id)
        return web.json_response(
            {
                "ok": True,
                **{k: v for k, v in result.items() if k != "project"},
                "project": project,
                "novel": timeline_novel_patch(project),
            }
        )
    except Exception as exc:
        log.exception("novel split_segments failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_chapter_storyboard(request):
    from .novel_runtime import load_project, save_project, storyboard_chapter, timeline_novel_patch

    data = await _json_body(request)
    try:
        project_id = str(data.get("projectId") or "").strip()
        chapter_id = str(data.get("chapterId") or "").strip()
        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("请选择提示词导演模型")
        project = load_project(project_id)
        # optional settings override
        settings = data.get("settings")
        if isinstance(settings, dict):
            project.setdefault("settings", {}).update(settings)
            save_project(project)
        result = storyboard_chapter(
            project,
            chapter_id,
            model=model,
            backend=str(data.get("backend") or "local"),
            continuity=str(data.get("continuity") or ""),
            desk_style=str(data.get("deskStyle") or data.get("desk_style") or ""),
            desk_soundscape=str(data.get("deskSoundscape") or ""),
            desk_music=str(data.get("deskMusic") or ""),
            skill_id=str(data.get("skill_id") or data.get("skill") or ""),
            append=bool(data.get("append") or data.get("appendShots")),
            llm_url=data.get("llm_url"),
            api_format=data.get("api_format"),
            api_key=data.get("api_key"),
            n_gpu_layers=data.get("n_gpu_layers"),
            n_ctx=data.get("n_ctx"),
            temperature=data.get("temperature"),
            mmproj=data.get("mmproj"),
        )
        project = load_project(project_id)
        return web.json_response(
            {
                "ok": True,
                **result,
                "project": project,
                "novel": timeline_novel_patch(project),
            }
        )
    except Exception as exc:
        log.exception("novel storyboard failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_extract(request):
    """Extract character/scene prompts from novel (or selected chapters) into asset library."""
    from .asset_prompt_runtime import extract_and_import_assets
    from .novel_runtime import (
        load_project,
        merge_extracted_assets,
        timeline_novel_patch,
    )

    data = await _json_body(request)
    try:
        project_id = str(data.get("projectId") or "").strip()
        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("请选择提示词导演模型")
        project = load_project(project_id)
        chapters = project.get("chapters") or []
        # Use first N chapters / whole book truncated for bible extract
        parts = []
        for ch in chapters[:8]:
            if not isinstance(ch, dict):
                continue
            parts.append(f"## {ch.get('title')}\n{(ch.get('text') or '')[:1500]}")
        brief = "\n\n".join(parts)[:6000] or str(project.get("title") or "")
        timeline = data.get("timeline") if isinstance(data.get("timeline"), dict) else {}
        result = extract_and_import_assets(
            timeline,
            brief=brief,
            model=model,
            backend=str(data.get("backend") or "local"),
            enable_gen=bool(data.get("enableGen", False)),
            llm_url=data.get("llm_url"),
            api_format=data.get("api_format"),
            api_key=data.get("api_key"),
            n_gpu_layers=data.get("n_gpu_layers"),
            n_ctx=data.get("n_ctx"),
            temperature=data.get("temperature"),
            mmproj=data.get("mmproj"),
        )
        merged = merge_extracted_assets(project, result if isinstance(result, dict) else {})
        # also merge from timeline asset_prompts if present
        if isinstance(timeline, dict):
            idir = timeline.get("image_director") or {}
            if isinstance(idir, dict) and idir.get("asset_prompts"):
                merge_extracted_assets(project, {"asset_prompts": idir.get("asset_prompts")})
        project = load_project(project_id)
        return web.json_response(
            {
                "ok": True,
                "extract": result,
                "merged": merged,
                "timeline": timeline,
                "project": project,
                "novel": timeline_novel_patch(project),
            }
        )
    except Exception as exc:
        log.exception("novel assets extract failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_upload(request):
    from .novel_runtime import load_project, timeline_novel_patch, upsert_asset

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        item = upsert_asset(
            project,
            kind=str(data.get("kind") or "characters"),
            name=str(data.get("name") or ""),
            prompt=str(data.get("prompt") or ""),
            aliases=list(data.get("aliases") or []) if isinstance(data.get("aliases"), list) else None,
            image_path=str(data.get("imagePath") or data.get("image_path") or ""),
            image_b64=str(data.get("imageB64") or data.get("image_b64") or ""),
            media_path=str(
                data.get("mediaPath")
                or data.get("media_path")
                or data.get("inputFile")
                or data.get("audioFile")
                or data.get("videoFile")
                or ""
            ),
            media_b64=str(data.get("mediaB64") or data.get("media_b64") or data.get("fileB64") or ""),
            filename=str(data.get("filename") or data.get("fileName") or ""),
            bind_character=str(data.get("bindCharacter") or data.get("character") or ""),
        )
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {"ok": True, "asset": item, "project": project, "novel": timeline_novel_patch(project)}
        )
    except Exception as exc:
        log.exception("novel asset upload failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_delete(request):
    from .novel_runtime import delete_asset, load_project, timeline_novel_patch

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        result = delete_asset(
            project,
            kind=str(data.get("kind") or "characters"),
            asset_id=str(data.get("assetId") or data.get("id") or ""),
            name=str(data.get("name") or ""),
            delete_files=data.get("deleteFiles", True) is not False,
        )
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {"ok": True, **result, "project": project, "novel": timeline_novel_patch(project)}
        )
    except Exception as exc:
        log.exception("novel asset delete failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_bind(request):
    from .novel_runtime import bind_chapter_refs, load_project, timeline_novel_patch

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        result = bind_chapter_refs(project, str(data.get("chapterId") or ""))
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {"ok": True, **result, "project": project, "novel": timeline_novel_patch(project)}
        )
    except Exception as exc:
        log.exception("novel assets bind failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_assets_sync(request):
    from .novel_runtime import load_project, sync_assets_from_timeline, timeline_novel_patch

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        timeline = data.get("timeline") if isinstance(data.get("timeline"), dict) else {}
        result = sync_assets_from_timeline(project, timeline)
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {"ok": True, **result, "project": project, "novel": timeline_novel_patch(project)}
        )
    except Exception as exc:
        log.exception("novel assets sync failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_chapter_prepare(request):
    from .novel_runtime import load_project, prepare_chapter_timeline, timeline_novel_patch

    data = await _json_body(request)
    try:
        project = load_project(str(data.get("projectId") or ""))
        timeline = data.get("timeline") if isinstance(data.get("timeline"), dict) else {}
        result = prepare_chapter_timeline(
            project,
            str(data.get("chapterId") or ""),
            timeline=timeline,
            product_task=str(data.get("productTask") or data.get("taskType") or data.get("task_type") or ""),
            resume=bool(data.get("resume", True)),
            batch_limit=data.get("batchLimit", data.get("batch_limit")),
        )
        project = load_project(str(project.get("projectId") or ""))
        return web.json_response(
            {
                "ok": True,
                **result,
                "project": project,
                "novel": timeline_novel_patch(project),
            }
        )
    except Exception as exc:
        log.exception("novel prepare failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_chapter_save_output(request):
    """Copy newest / specified Comfy output video into chapter folder as「章名.mp4」."""
    from .novel_runtime import save_chapter_output_video, timeline_novel_patch

    data = await _json_body(request)
    try:
        since = data.get("sinceTs", data.get("since_ts"))
        since_ts = float(since) if since is not None and str(since).strip() != "" else None
        result = save_chapter_output_video(
            str(data.get("projectId") or ""),
            str(data.get("chapterId") or ""),
            source_path=str(data.get("sourcePath") or data.get("source_path") or ""),
            filename=str(data.get("filename") or ""),
            subfolder=str(data.get("subfolder") or ""),
            file_type=str(data.get("type") or data.get("fileType") or "output"),
            since_ts=since_ts,
            mark_done=bool(data.get("markDone", True)),
        )
        return web.json_response(
            {
                "ok": True,
                **result,
                "novel": timeline_novel_patch(result["project"]),
            }
        )
    except Exception as exc:
        log.exception("novel save_output failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_progress(request):
    from .novel_runtime import timeline_novel_patch, update_chapter_progress

    data = await _json_body(request)
    try:
        result = update_chapter_progress(
            str(data.get("projectId") or ""),
            str(data.get("chapterId") or ""),
            status=str(data.get("status") or "done"),
            output_path=str(data.get("outputPath") or data.get("output_path") or ""),
            error=str(data.get("error") or ""),
        )
        return web.json_response(
            {
                "ok": True,
                **result,
                "novel": timeline_novel_patch(result["project"]),
            }
        )
    except Exception as exc:
        log.exception("novel progress failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def novel_clear_global_cache(request):
    """Clear sticky chapter globalPrompt cache for a fresh creative run."""
    from .novel_runtime import clear_global_prompt_cache

    data = await _json_body(request)
    project_id = str(data.get("projectId") or "").strip()
    if not project_id:
        return web.json_response({"ok": False, "error": "缺少 projectId"}, status=400)
    try:
        all_chapters = data.get("allChapters")
        if all_chapters is None:
            all_chapters = data.get("clearAllChapters", True)
        result = clear_global_prompt_cache(
            project_id,
            chapter_id=str(data.get("chapterId") or ""),
            clear_all_chapters=bool(all_chapters),
        )
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        log.exception("novel clear_global_cache failed")
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
