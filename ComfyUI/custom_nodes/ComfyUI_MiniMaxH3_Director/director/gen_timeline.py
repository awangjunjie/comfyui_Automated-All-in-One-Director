"""MiniMax H3 Director 鈥?generation timeline (t2i / t2v / i2i / i2v) plan building."""

from __future__ import annotations

import logging

import torch

from ..lib.image_prep import fit_canvas, fit_video_long_edge, cat_frames_variable_size, resolve_output_dimensions
from ..lib.task_prompts import is_r2v_like, resolve_task_key

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.gen")

GEN_BLANK_KEYS = frozenset({"t2v", "r2v", "novel", "film", "m2v", "i2v"})
GEN_IMAGE_KEYS = frozenset()  # legacy i2v first-frame canvas removed; fl2v owns keyframes
FL2V_KEYS = frozenset({"fl2v"})
GEN_TASK_KEYS = GEN_BLANK_KEYS | GEN_IMAGE_KEYS | FL2V_KEYS
PROMPT_BATCH_KEYS = frozenset({"t2v", "i2v", "r2v", "novel", "film", "m2v", "fl2v", "fl_chain"})
VIDEO_BATCH_KEYS = frozenset({"t2v", "i2v", "r2v", "novel", "film", "m2v", "fl2v", "fl_chain"})
IMAGE_BATCH_KEYS = frozenset()

MIN_GEN_FRAMES = 1
MIN_GEN_VIDEO_FRAMES = 4


def is_gen_task_key(task_key: str) -> bool:
    return task_key in GEN_TASK_KEYS


def is_gen_timeline(timeline: dict, task_key: str) -> bool:
    mode = str(timeline.get("timelineMode") or "").lower()
    key = resolve_task_key(task_key) if task_key else ""
    if mode in ("gen_blank", "gen_image", "image_batch", "prompt_batch", "fl2v"):
        return True
    # m2v/t2v/i2v/r2v are generation tasks even if UI left timelineMode="video"
    # (m2v reuses the media track as motion source — must NOT use the v2v edit plan).
    if key in GEN_BLANK_KEYS:
        return True
    if mode == "video":
        return False
    return is_gen_task_key(key)


def is_prompt_batch_timeline(timeline: dict, task_key: str) -> bool:
    mode = str(timeline.get("timelineMode") or "").lower()
    if mode in ("image_batch", "prompt_batch"):
        return True
    # fl2v / fl_chain use a separate strip UI but still export like a video prompt-batch.
    if mode == "fl2v" or task_key in {"fl2v", "fl_chain"}:
        return True
    return task_key in PROMPT_BATCH_KEYS


def is_image_batch_timeline(timeline: dict, task_key: str) -> bool:
    return is_prompt_batch_timeline(timeline, task_key)


def is_video_batch_task_key(task_key: str) -> bool:
    return task_key in VIDEO_BATCH_KEYS


def gen_submode(timeline: dict, task_key: str) -> str:
    mode = str(timeline.get("timelineMode") or "").lower()
    if mode == "gen_image" or task_key in GEN_IMAGE_KEYS:
        return "gen_image"
    if mode == "gen_blank" or task_key in GEN_BLANK_KEYS:
        return "gen_blank"
    return "gen_blank"


def _min_frames_for_task(task_key: str) -> int:
    if task_key in IMAGE_BATCH_KEYS or task_key in ("t2i", "i2i"):
        return MIN_GEN_FRAMES
    if task_key in ("t2v", "i2v", "r2v", "novel", "film", "m2v"):
        return MIN_GEN_VIDEO_FRAMES
    return MIN_GEN_VIDEO_FRAMES


def _timeline_has_motion_video(timeline: dict) -> bool:
    video = timeline.get("video") or {}
    if str(video.get("videoFile") or video.get("fileName") or "").strip():
        return True
    for clip in timeline.get("videoClips") or []:
        if isinstance(clip, dict) and str(clip.get("videoFile") or clip.get("fileName") or "").strip():
            return True
    return False


def _motion_track_frame_count(timeline: dict) -> int:
    """Media-track length for m2v — prefer source/frameMap over gen totalFrames."""
    from ..lib.video_io import (
        deleted_source_ranges,
        logical_frame_map,
        video_clips_from_timeline,
    )

    frame_map = logical_frame_map(timeline)
    if frame_map:
        return len(frame_map)

    video = timeline.get("video") or {}
    source_count = int(video.get("sourceFrameCount") or 0)
    if source_count > 0:
        removed = sum(end - start for start, end in deleted_source_ranges(timeline))
        return max(0, source_count - removed)

    clips = video_clips_from_timeline(timeline)
    if clips:
        total = sum(int(c.get("sourceFrameCount") or 0) for c in clips if isinstance(c, dict))
        if total > 0:
            return total

    return int(timeline.get("totalFrames") or 0)


def _fit_ref_video_frames(clip: torch.Tensor, num_frames: int) -> torch.Tensor:
    """Trim or pad (repeat last frame) to the generation length."""
    target = max(1, int(num_frames))
    n = int(clip.shape[0]) if clip is not None and clip.ndim >= 1 else 0
    if n <= 0:
        raise ValueError("动作迁移参考视频没有可解码帧。")
    if n >= target:
        return clip[:target]
    pad = clip[-1:].repeat(target - n, *([1] * (clip.ndim - 1)))
    return torch.cat([clip, pad], dim=0)


def _load_m2v_motion_videos(
    timeline: dict,
    seg_data: dict,
    *,
    plan_start: int,
    plan_end: int,
    load_ref_videos,
) -> list:
    """Motion source for m2v: prefer media-track segment, fall back to card refVideos."""
    from .plan import SegmentRefVideo
    from ..lib.video_io import load_timeline_segment

    num_frames = max(5, int(plan_end) - int(plan_start))
    if _timeline_has_motion_video(timeline):
        src_start = int(seg_data.get("start", plan_start) or plan_start)
        src_len = int(seg_data.get("length") or 0)
        if src_len <= 0:
            src_len = num_frames
        src_end = max(src_start + 1, src_start + src_len)
        # Override gen-sum totalFrames so load_timeline_segment can reach the full motion clip.
        track_total = _motion_track_frame_count(timeline)
        load_tl = timeline
        if track_total > 0 and int(timeline.get("totalFrames") or 0) != track_total:
            load_tl = dict(timeline)
            load_tl["totalFrames"] = track_total
        try:
            clip = load_timeline_segment(load_tl, src_start, src_end)
        except Exception as exc:
            raise ValueError(
                f"动作迁移无法从媒体轨加载动作视频 [{src_start}:{src_end}]：{exc}"
            ) from exc
        clip = _fit_ref_video_frames(clip, num_frames)
        video = timeline.get("video") or {}
        rel = str(video.get("videoFile") or video.get("fileName") or "").strip()
        return [
            SegmentRefVideo(
                index=0,
                tensor=clip,
                video_file=rel,
                meta={
                    "source": "media_track",
                    "start": src_start,
                    "end": src_end,
                    "videoFile": rel,
                },
            )
        ]

    # Legacy / fallback: card 视频1–3
    raw_vids = seg_data.get("refVideos") or seg_data.get("ref_videos") or []
    legacy = seg_data.get("referenceVideo") or seg_data.get("reference_video") or {}
    if isinstance(legacy, dict) and (legacy.get("videoFile") or legacy.get("fileName")):
        if not any(int(v.get("index", v.get("slot", -1))) == 0 for v in raw_vids if isinstance(v, dict)):
            raw_vids = [{"index": 0, **legacy}, *list(raw_vids or [])]
    return load_ref_videos(raw_vids, timeline, num_frames)


def _segment_frame_count(raw: dict, *, default: int, task_key: str) -> int:
    fc = int(raw.get("frameCount") or raw.get("frame_count") or raw.get("length") or default)
    return max(_min_frames_for_task(task_key), fc)


def _gen_segment_ranges(
    segments: list[dict],
    *,
    default_frame_count: int,
    task_key: str,
) -> list[tuple[int, int, dict]]:
    ranges: list[tuple[int, int, dict]] = []
    start = 0
    for raw in segments:
        fc = _segment_frame_count(raw, default=default_frame_count, task_key=task_key)
        ranges.append((start, start + fc, raw))
        start += fc
    if not ranges:
        fc = max(_min_frames_for_task(task_key), default_frame_count)
        ranges.append((0, fc, {}))
    return ranges


def _first_ref_image(block: dict | None) -> dict | None:
    """Fallback: use refs Picture-1 (index 0) as i2v/gen source image."""
    if not isinstance(block, dict):
        return None
    for item in block.get("refs") or []:
        if not isinstance(item, dict):
            continue
        idx = int(item.get("index", item.get("slot", -1)))
        if idx != 0:
            continue
        if item.get("imageFile") or item.get("imageB64"):
            return {
                "imageFile": item.get("imageFile") or "",
                "imageB64": item.get("imageB64") or "",
            }
    # any first ref with an image
    for item in block.get("refs") or []:
        if isinstance(item, dict) and (item.get("imageFile") or item.get("imageB64")):
            return {
                "imageFile": item.get("imageFile") or "",
                "imageB64": item.get("imageB64") or "",
            }
    return None


def _resolve_gen_image_ref(
    seg_data: dict,
    *,
    edit_mode: str,
    global_block: dict,
) -> dict | None:
    if edit_mode == "segment":
        img = seg_data.get("genImage") or {}
        if img.get("imageFile") or img.get("imageB64"):
            return img
        if seg_data.get("imageFile"):
            return {"imageFile": seg_data["imageFile"]}
        # Image Director injects into refs[图片1] — reuse for i2v / gen_image
        ref = _first_ref_image(seg_data) or _first_ref_image(global_block)
        if ref:
            return ref
        return None
    img = global_block.get("genImage") or {}
    if img.get("imageFile") or img.get("imageB64"):
        return img
    if global_block.get("imageFile"):
        return {"imageFile": global_block["imageFile"]}
    return _first_ref_image(global_block)


def _load_gen_image_tensor(ref: dict) -> torch.Tensor:
    from .plan import load_reference_tensor

    tensor = load_reference_tensor(ref)
    if tensor is None:
        raise ValueError("Generation segment image could not be loaded.")
    return tensor


def _build_i2v_source_clip(
    img: torch.Tensor,
    _frame_count: int,
    *,
    width: int,
    height: int,
    output_mode: str,
    ref_max_size: int,
) -> torch.Tensor:
    """Use the source image as a one-frame source-video context."""
    if img.ndim == 3:
        img = img.unsqueeze(0)
    if output_mode == "fixed":
        return fit_canvas(img, width, height)
    return fit_video_long_edge(img, ref_max_size)


def _resolve_gen_image_source_dims(
    segment_ranges: list[tuple[int, int, dict]],
    global_block: dict,
    output_block: dict,
) -> tuple[int, int]:
    sw = int(global_block.get("sourceWidth") or output_block.get("sourceWidth") or 0)
    sh = int(global_block.get("sourceHeight") or output_block.get("sourceHeight") or 0)
    if sw > 0 and sh > 0:
        return sw, sh
    for _start, _end, seg_data in segment_ranges:
        gi = seg_data.get("genImage") or {}
        sw = int(gi.get("width") or 0)
        sh = int(gi.get("height") or 0)
        if sw > 0 and sh > 0:
            return sw, sh
    return 0, 0


def _build_gen_source_clips(
    ranges: list[tuple[int, int, dict]],
    *,
    task_key: str,
    submode: str,
    edit_mode: str,
    global_block: dict,
    height: int,
    width: int,
    output_mode: str,
    ref_max_size: int,
) -> list[torch.Tensor]:
    chunks: list[torch.Tensor] = []
    for _start, end, seg_data in ranges:
        frame_count = end - _start
        if frame_count <= 0:
            continue
        if submode == "gen_blank":
            clip = torch.full((frame_count, height, width, 3), 0.5, dtype=torch.float32)
        else:
            ref = _resolve_gen_image_ref(seg_data, edit_mode=edit_mode, global_block=global_block)
            if ref is None:
                seg_idx = len(chunks) + 1
                raise ValueError(
                    f"Segment #{seg_idx} has no source image. "
                    "Upload an image in the generation timeline (global or per-segment)."
                )
            img = _load_gen_image_tensor(ref)
            if task_key == "i2v":
                clip = _build_i2v_source_clip(
                    img,
                    frame_count,
                    width=width,
                    height=height,
                    output_mode=output_mode,
                    ref_max_size=ref_max_size,
                )
            else:
                clip = img.repeat(frame_count, 1, 1, 1)
                if output_mode == "fixed":
                    clip = fit_canvas(clip, width, height)
                else:
                    clip = fit_video_long_edge(clip, ref_max_size)
        chunks.append(clip)
    if not chunks:
        raise ValueError("Generation timeline has no frames.")
    return chunks


def _build_gen_source_video(
    ranges: list[tuple[int, int, dict]],
    *,
    task_key: str,
    submode: str,
    edit_mode: str,
    global_block: dict,
    height: int,
    width: int,
    output_mode: str,
    ref_max_size: int,
) -> torch.Tensor:
    return cat_frames_variable_size(
        _build_gen_source_clips(
            ranges,
            task_key=task_key,
            submode=submode,
            edit_mode=edit_mode,
            global_block=global_block,
            height=height,
            width=width,
            output_mode=output_mode,
            ref_max_size=ref_max_size,
        )
    )


def build_gen_director_plan(
    timeline: dict,
    *,
    global_task_type: str,
    global_prompt: str,
    total_frames: int,
    frame_rate: float,
    width: int,
    height: int,
    ref_max_size: int,
):
    """Build DirectorPlan for generation timeline modes (lazy import avoids cycles)."""
    from .plan import (
        DirectorPlan,
        SegmentPlan,
        _load_ref_audios,
        _load_ref_videos,
        _load_refs,
        _parse_run_selection,
        _resolve_export_mode,
        segment_ref_audios_for_context,
        segment_refs_for_context,
    )

    global_block = timeline.get("global") or {}
    edit_mode = timeline.get("editMode") or timeline.get("edit_mode") or "global"
    if is_prompt_batch_timeline(timeline, resolve_task_key(global_block.get("taskType") or global_task_type or "")):
        edit_mode = "segment"
    elif edit_mode not in ("global", "segment"):
        edit_mode = "global"

    task_type = global_block.get("taskType") or global_task_type or "t2v 鈥?鏂囩敓瑙嗛(Text to Video)"
    task_key = resolve_task_key(task_type)
    if not is_gen_task_key(task_key):
        raise ValueError(f"Task {task_key} is not supported on the generation timeline.")

    submode = gen_submode(timeline, task_key)
    prompt = global_block.get("prompt") or global_prompt or ""
    global_refs = _load_refs(global_block.get("refs") or [])

    output_block = timeline.get("output") or {}
    gen_block = timeline.get("gen") or {}
    default_fc = int(gen_block.get("defaultFrameCount") or total_frames or 81)

    segment_ranges = _gen_segment_ranges(
        timeline.get("segments") or [],
        default_frame_count=default_fc,
        task_key=task_key,
    )

    if submode == "gen_blank":
        out_mode = "fixed"
        fw = int(output_block.get("width") or timeline.get("width") or width or 0)
        fh = int(output_block.get("height") or timeline.get("height") or height or 0)
        if fw < 16 or fh < 16:
            raise ValueError(
                "t2i / t2v / r2i / r2v require fixed output width and height (鈮?6, multiples of 16). "
                "Set width and height in the generation timeline output panel."
            )
        out_w, out_h, ref_max, _ = resolve_output_dimensions(
            fw,
            fh,
            mode="fixed",
            long_edge=ref_max_size,
            fixed_width=fw,
            fixed_height=fh,
        )
    else:
        out_mode = str(output_block.get("mode") or "long_edge").lower()
        if out_mode not in ("fixed", "long_edge"):
            out_mode = "long_edge"
        src_w, src_h = _resolve_gen_image_source_dims(segment_ranges, global_block, output_block)
        out_w, out_h, ref_max, out_mode = resolve_output_dimensions(
            src_w or int(width or 832),
            src_h or int(height or 480),
            mode=out_mode,
            long_edge=int(output_block.get("longEdge") or output_block.get("long_edge") or ref_max_size or 848),
            fixed_width=int(output_block.get("width") or timeline.get("width") or width),
            fixed_height=int(output_block.get("height") or timeline.get("height") or height),
        )

    export_mode = _resolve_export_mode(output_block)
    # Image prompt-batch (t2i/i2i/r2i) always merges to images list; video batch (t2v/i2v/r2v) respects export mode.
    if is_prompt_batch_timeline(timeline, task_key) and not is_video_batch_task_key(task_key):
        export_mode = "all"

    source_clips = _build_gen_source_clips(
        segment_ranges,
        task_key=task_key,
        submode=submode,
        edit_mode=edit_mode,
        global_block=global_block,
        height=out_h,
        width=out_w,
        output_mode=out_mode,
        ref_max_size=ref_max,
    )
    attach_source_clips = is_prompt_batch_timeline(timeline, task_key) and task_key in ("i2i",)
    if attach_source_clips:
        # Placeholder timeline index only 鈥?spatial data comes from each segment's source_clip.
        source_video = torch.full((len(source_clips), 16, 16, 3), 0.5, dtype=torch.float32)
    else:
        source_video = cat_frames_variable_size(source_clips)

    segments: list[SegmentPlan] = []
    for idx, (start, end, seg_data) in enumerate(segment_ranges):
        if edit_mode == "global":
            seg_prompt = prompt
            seg_task = task_type
            seg_refs = list(global_refs)
            use_global = True
            seg_negative = ""
        else:
            use_global = False
            seg_prompt = (seg_data.get("prompt") or "").strip()
            # Prompt groups must use their own text — never silently fall back to global
            # (that made every group generate the same video as the global story).
            if not seg_prompt:
                if is_prompt_batch_timeline(timeline, task_key) and len(segment_ranges) > 1:
                    raise ValueError(
                        f"提示词组 {idx + 1} 的提示词为空。"
                        f"请为每个提示词组填写提示词后再运行（不要依赖全局提示词）。"
                    )
                seg_prompt = prompt
            seg_task = seg_data.get("taskType") or seg_data.get("task_type") or task_type
            # Segment / batch mode: only this group's refs — never inherit global.refs.
            seg_refs = _load_refs(seg_data.get("refs") or [])
            seg_negative = (
                (seg_data.get("negativePrompt") or seg_data.get("negative_prompt") or "").strip()
            )

        seg_task_key = resolve_task_key(seg_task)
        if seg_task_key == "m2v":
            from .plan import FIXED_M2V_PROMPT

            seg_prompt = FIXED_M2V_PROMPT
        if not seg_prompt:
            log.warning("gen segment #%d has empty prompt", idx + 1)
        else:
            log.info(
                "gen segment #%d prompt[:80]=%r",
                idx + 1,
                seg_prompt[:80],
            )
        if seg_task_key == "i2v" and not seg_refs:
            log.warning(
                "i2v segment #%d has no reference images — will behave like t2v. "
                "Upload 图片1–9 as pure reference (首尾帧锁定请用 fl2v)。",
                idx + 1,
            )
        seg_refs = segment_refs_for_context(seg_task_key, seg_refs)
        seg_ref_audios = []
        seg_ref_videos = []
        if edit_mode == "global":
            seg_ref_audios = segment_ref_audios_for_context(
                seg_task_key,
                _load_ref_audios(global_block.get("refAudios") or global_block.get("ref_audios") or []),
            )
            # 整局仍可能带组级参考音频（素材卡片）
            if not seg_ref_audios:
                seg_ref_audios = segment_ref_audios_for_context(
                    seg_task_key,
                    _load_ref_audios(seg_data.get("refAudios") or seg_data.get("ref_audios") or []),
                )
        else:
            seg_ref_audios = segment_ref_audios_for_context(
                seg_task_key,
                _load_ref_audios(seg_data.get("refAudios") or seg_data.get("ref_audios") or []),
            )
            if is_r2v_like(seg_task_key) and seg_task_key != "m2v":
                seg_len = max(5, int(end) - int(start))
                raw_vids = seg_data.get("refVideos") or seg_data.get("ref_videos") or []
                # Backward compat: single referenceVideo → slot 0
                legacy = seg_data.get("referenceVideo") or seg_data.get("reference_video") or {}
                if isinstance(legacy, dict) and (legacy.get("videoFile") or legacy.get("fileName")):
                    if not any(int(v.get("index", v.get("slot", -1))) == 0 for v in raw_vids if isinstance(v, dict)):
                        raw_vids = [{"index": 0, **legacy}, *list(raw_vids or [])]
                seg_ref_videos = _load_ref_videos(raw_vids, timeline, seg_len)
        if seg_task_key == "m2v":
            # 动作源：媒体轨分段（可裁切）；生成帧数仍用本段 frameCount/秒数
            seg_ref_videos = _load_m2v_motion_videos(
                timeline,
                seg_data,
                plan_start=start,
                plan_end=end,
                load_ref_videos=_load_ref_videos,
            )
            if not seg_ref_videos:
                raise ValueError(
                    f"动作迁移 (m2v) 第 {idx + 1} 组缺少动作视频："
                    "请在媒体轨上传单路动作/运镜视频（可预览、裁切、均分）。"
                )
            # 均分后部分卡未贴图：继承前面已有人物/场景参考
            if not seg_refs:
                for prev_start, prev_end, prev_data in reversed(segment_ranges[:idx]):
                    del prev_start, prev_end
                    inherited = _load_refs(prev_data.get("refs") or [])
                    if inherited:
                        seg_refs = inherited
                        log.info(
                            "m2v segment #%d: inherited %d ref image(s) from an earlier card",
                            idx + 1,
                            len(seg_refs),
                        )
                        break
            if not seg_refs and global_refs:
                seg_refs = list(global_refs)
            if not seg_refs:
                raise ValueError(
                    f"动作迁移 (m2v) 第 {idx + 1} 组缺少参考图：请上传图片1（角色/外观）。"
                )
            gen_len = max(5, int(end) - int(start))
            if gen_len > 160:
                log.warning(
                    "m2v segment #%d is %d frames (≈%.1fs) — long single chunks often "
                    "drift back to the motion-video identity after a few seconds. "
                    "Prefer ~124-frame (≈5s) equal-split segments.",
                    idx + 1,
                    gen_len,
                    gen_len / 24.0,
                )
        elif (is_r2v_like(seg_task_key) or seg_task_key in ("r2i", "i2v")) and not seg_refs and not seg_ref_videos and not seg_ref_audios:
            log.warning(
                "gen segment #%d task=%s has no reference media — will behave like "
                "t2v/t2i. Upload 图片/音频/视频 on this material card.",
                idx + 1,
                seg_task_key,
            )
        seg_source = source_clips[idx].clone() if idx < len(source_clips) else None

        segments.append(
            SegmentPlan(
                index=idx,
                start_frame=start,
                end_frame=end,
                prompt=seg_prompt,
                task_type=seg_task,
                task_key=seg_task_key,
                use_global=use_global,
                refs=seg_refs,
                ref_audios=seg_ref_audios,
                ref_videos=seg_ref_videos,
                negative_prompt=seg_negative,
                source_clip=seg_source,
            )
        )

    total = int(segment_ranges[-1][1]) if segment_ranges else int(source_video.shape[0])
    if is_prompt_batch_timeline(timeline, task_key):
        timeline_mode = "prompt_batch"
    else:
        timeline_mode = "gen_image" if submode == "gen_image" else "gen_blank"

    raw = dict(timeline)
    raw["timelineMode"] = timeline_mode
    src_w, src_h = _resolve_gen_image_source_dims(segment_ranges, global_block, output_block)

    from .segment_continuity import (
        CONTINUITY_TASK_KEYS,
        resolve_continuity_settings,
        resolve_seam_dedupe_settings,
    )

    continuity_enabled, continuity_overlap = resolve_continuity_settings(
        timeline, segment_count=max(1, len(segments))
    )
    if task_key not in CONTINUITY_TASK_KEYS:
        continuity_enabled, continuity_overlap = False, 0
    seam_dedupe_enabled, seam_judge_frames = resolve_seam_dedupe_settings(
        timeline, segment_count=max(1, len(segments))
    )
    # 与链式连贯同一任务范围
    if task_key not in CONTINUITY_TASK_KEYS:
        seam_dedupe_enabled = False
    if continuity_enabled:
        raw.setdefault("output", {})
        if isinstance(raw["output"], dict):
            raw["output"]["continuityEnabled"] = True
    if seam_dedupe_enabled:
        raw.setdefault("output", {})
        if isinstance(raw["output"], dict):
            raw["output"]["seamDedupeEnabled"] = True
            raw["output"]["seamJudgeFrames"] = int(seam_judge_frames)

    return DirectorPlan(
        frame_rate=float(timeline.get("frameRate") or frame_rate or 24),
        total_frames=total,
        width=out_w,
        height=out_h,
        ref_max_size=ref_max,
        output_mode=out_mode,
        source_width=int(src_w or out_w),
        source_height=int(src_h or out_h),
        global_task_type=task_type,
        global_task_key=task_key,
        global_prompt=prompt,
        global_refs=global_refs,
        source_video=source_video,
        segments=segments,
        edit_mode=edit_mode,
        raw=raw,
        export_mode=export_mode,
        run_indices=_parse_run_selection(timeline, len(segments)),
        continuity_enabled=bool(continuity_enabled),
        continuity_overlap_frames=int(continuity_overlap or 0),
        seam_dedupe_enabled=bool(seam_dedupe_enabled),
        seam_judge_frames=int(seam_judge_frames),
    )
