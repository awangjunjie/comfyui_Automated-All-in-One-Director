"""Run MiniMax H3 Director segments through the official ComfyUI core pipeline."""

from __future__ import annotations

import logging
from typing import Any

import torch

from ..lib.image_prep import fit_canvas, fit_video_long_edge
from ..lib.task_modes import SUPPORTED_TASK_KEYS
from ..nodes.conditioning import run_minimax_conditioning
from .core_sampling import sample_single_stage
from .frame_align import minimax_align_frame_count, pad_or_trim_frames
from .audio_export import (
    AUDIO_MODE_GENERATE,
    AUDIO_MODE_MUTE,
    AUDIO_MODE_SOURCE,
    empty_audio_dict,
    resolve_audio_mode,
)
from .segment_runtime import (
    frames_label,
    resolve_segment_raw_clip,
    segment_passthrough_chunk,
    tensor_frame_to_jpeg_b64,
)
from .plan import (
    DirectorPlan,
    plan_summary,
    prepare_segment_clip,
    ref_audios_to_dict,
    ref_videos_to_dict,
    reference_video_for_segment,
    refs_to_kwargs_for_context,
    reinforce_r2v_prompt,
    reinforce_rv2v_prompt,
    reinforce_v2v_prompt,
)
from .progress import report_director_finish, report_director_progress, report_director_segment_preview
from .segment_cache import load_segment_cache, save_segment_cache
from .segment_continuity import (
    concat_continuous_chunks,
    is_continuity_active,
    lock_chain_opening_frame,
    resolve_prev_segment_output,
)
from .vram_cleanup import (
    cleanup_after_decode,
    cleanup_segment_vram,
    prepare_vram_for_decode,
)

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.core")


def _unpack_node_output(out):
    if hasattr(out, "args"):
        args = out.args
        if args:
            return args
    if isinstance(out, (tuple, list)):
        return out
    raise RuntimeError(f"Unexpected node output: {type(out)!r}")


def _decode_av_latent(
    samples,
    vae,
    audio_vae,
    *,
    decode_audio: bool = True,
    use_tiled: bool = False,
):
    from comfy_extras.nodes_lt import LTXVSeparateAVLatent
    from nodes import VAEDecode, VAEDecodeTiled

    sep = LTXVSeparateAVLatent.execute(samples)
    video_latent, audio_latent = _unpack_node_output(sep)[:2]

    if use_tiled:
        # Smaller temporal windows: less peak VRAM on MiniMax / LTX-style video VAEs.
        log.info("AV decode: tiled VAE (tile=512, temporal=32) for low VRAM")
        images, = VAEDecodeTiled().decode(
            vae,
            video_latent,
            tile_size=512,
            overlap=64,
            temporal_size=32,
            temporal_overlap=8,
        )
    else:
        images, = VAEDecode().decode(vae, video_latent)

    if not decode_audio or audio_vae is None:
        return images, empty_audio_dict()
    try:
        from comfy_extras.nodes_audio import VAEDecodeAudio
    except ImportError:
        from comfy_extras.nodes_lt import VAEDecodeAudio  # type: ignore

    audio_out = VAEDecodeAudio.execute(audio_vae, audio_latent)
    audio = _unpack_node_output(audio_out)[0]
    return images, audio


def _preview_frame_indices(frame_count: int, max_frames: int = 24) -> list[int]:
    """Evenly sample preview frames (always include first/last). Caps CPU stall after decode."""
    n = max(0, int(frame_count))
    if n <= 0:
        return []
    limit = max(1, int(max_frames))
    if n <= limit:
        return list(range(n))
    idxs = {0, n - 1}
    for i in range(1, limit - 1):
        idxs.add(int(round(i * (n - 1) / (limit - 1))))
    return sorted(idxs)


def _ref_tensor_from_seg_refs(refs, index: int) -> torch.Tensor | None:
    for ref in refs or []:
        if int(getattr(ref, "index", -1)) == index and ref.tensor is not None:
            t = ref.tensor
            if t.shape[0] > 0:
                return t[:1]
    return None


def _build_minimax_inputs(
    plan: DirectorPlan,
    seg,
    *,
    clip_frames: torch.Tensor | None,
    ctx_w: int,
    ctx_h: int,
    prev_tail: torch.Tensor | None,
):
    """Map segment task + refs to MiniMax ImageToVideo / ReferenceToVideo inputs."""
    task_key = seg.task_key
    first_frame = None
    last_frame = None
    ref_images = None
    ref_videos = None
    ref_audios = None

    if task_key in {"fl2v", "fl_chain"}:
        if clip_frames is not None and clip_frames.shape[0] >= 1:
            first_frame = clip_frames[:1]
        if clip_frames is not None and clip_frames.shape[0] >= 2:
            last_frame = clip_frames[-1:].clone()
        if first_frame is None:
            first_frame = _ref_tensor_from_seg_refs(seg.refs, 0)
        if last_frame is None:
            last_frame = _ref_tensor_from_seg_refs(seg.refs, 1)
        # Chain continuity: previous shot's last decoded frame → this shot's first_frame
        if (
            prev_tail is not None
            and getattr(prev_tail, "ndim", 0) == 4
            and prev_tail.shape[0] >= 1
        ):
            try:
                first_frame = fit_canvas(prev_tail[-1:].clone(), ctx_w, ctx_h)
                log.info(
                    "%s seg#%d: injected prev last-frame as first_frame (%dx%d)",
                    task_key,
                    int(getattr(seg, "index", 0)) + 1,
                    ctx_w,
                    ctx_h,
                )
            except Exception as exc:
                log.warning("%s prev_tail inject failed: %s", task_key, exc)
    elif task_key == "t2v":
        # Pure text-to-video; with chain continuity, later shots lock prev last-frame as first_frame.
        if (
            prev_tail is not None
            and getattr(prev_tail, "ndim", 0) == 4
            and prev_tail.shape[0] >= 1
        ):
            try:
                first_frame = fit_canvas(prev_tail[-1:].clone(), ctx_w, ctx_h)
                log.info(
                    "t2v seg#%d: injected prev last-frame as first_frame (%dx%d)",
                    int(getattr(seg, "index", 0)) + 1,
                    ctx_w,
                    ctx_h,
                )
            except Exception as exc:
                log.warning("t2v prev_tail inject failed: %s", exc)
    elif task_key in {"i2v", "r2v"}:
        # i2v: soft refs via ReferenceToVideo; with chain → hard first_frame (ImageToVideo).
        # r2v: soft <Picture N>; chain reserves Picture 1 + post-decode pixel lock.
        ref_kwargs = refs_to_kwargs_for_context(task_key, seg.refs)
        ref_images = {}
        for key, tensor in ref_kwargs.items():
            if tensor is None:
                continue
            idx = key.removeprefix("reference_image_")
            ref_images[f"ref_image_{idx}"] = tensor[:1] if tensor.ndim == 4 else tensor
        if (
            prev_tail is not None
            and getattr(prev_tail, "ndim", 0) == 4
            and prev_tail.shape[0] >= 1
        ):
            try:
                chain_frame = fit_canvas(prev_tail[-1:].clone(), ctx_w, ctx_h)
                # Drop any user image in slot 0 — reserved for chain handoff.
                ref_images = {
                    k: v
                    for k, v in (ref_images or {}).items()
                    if k != "ref_image_0"
                }
                if task_key == "i2v":
                    # Hard keyframe on fl2va path — soft Picture alone cannot pin frame0.
                    first_frame = chain_frame
                    if not ref_images:
                        ref_images = None
                    log.info(
                        "i2v seg#%d: injected prev last-frame as first_frame hard lock",
                        int(getattr(seg, "index", 0)) + 1,
                    )
                else:
                    ref_images = {"ref_image_0": chain_frame, **ref_images}
                    log.info(
                        "%s seg#%d: injected prev last-frame as <Picture 1> / ref_image_0",
                        task_key,
                        int(getattr(seg, "index", 0)) + 1,
                    )
            except Exception as exc:
                log.warning("%s prev_tail inject failed: %s", task_key, exc)
        if not ref_images:
            ref_images = None
        if task_key == "r2v":
            # Prefer multi-slot ref_videos (r2v batch cards); fall back to legacy single meta.
            ref_videos = ref_videos_to_dict(getattr(seg, "ref_videos", None) or [])
            if not ref_videos:
                nframes = max(5, int(getattr(seg, "frame_count", 0) or plan.total_frames or 124))
                ref_video = reference_video_for_segment(plan, seg, num_frames=nframes)
                if ref_video is not None and ref_video.shape[0] > 0:
                    ref_videos = {"ref_video_0": ref_video}
            ref_audios = ref_audios_to_dict(getattr(seg, "ref_audios", None) or [])
    elif task_key in {"v2v", "rv2v"}:
        # Bernini-style video edit: each timeline segment's source clip → <Video 1>.
        # rv2v additionally injects 图片1–9 / 音频1–3 as <Picture N> / <Audio J>.
        if clip_frames is None or clip_frames.shape[0] <= 0:
            raise ValueError(
                f"{task_key} segment #{seg.index + 1} has no source frames. "
                "Upload a video in the Director timeline before running."
            )
        ref_videos = {"ref_video_0": clip_frames}
        if task_key == "rv2v":
            # Refs are optional per segment: with refs → <Video 1>+<Picture N>;
            # without refs → same as v2v (source edit only).
            ref_kwargs = refs_to_kwargs_for_context(task_key, seg.refs)
            ref_images = {}
            for key, tensor in ref_kwargs.items():
                if tensor is None:
                    continue
                idx = key.removeprefix("reference_image_")
                ref_images[f"ref_image_{idx}"] = tensor[:1] if tensor.ndim == 4 else tensor
            if not ref_images:
                ref_images = None
            ref_audios = ref_audios_to_dict(getattr(seg, "ref_audios", None) or [])

    return first_frame, last_frame, ref_images, ref_videos, ref_audios


def execute_director_plan_core(
    plan: DirectorPlan,
    *,
    node_id: str | None = None,
    model,
    vae,
    audio_vae,
    clip,
    cfg: float = 1.0,
    seed: int = 0,
    steps: int = 25,
    sampler: str = "res_multistep",
    scheduler: str = "simple",
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    clear_vram_between_segments: bool = True,
) -> tuple[torch.Tensor, list[torch.Tensor], list[dict[str, Any]], str]:
    """Process every segment with MiniMax H3 conditioning + single-stage sampling."""
    audio_mode = resolve_audio_mode(plan)
    decode_audio = audio_mode == AUDIO_MODE_GENERATE

    all_segments = plan.segments
    # Strictly honor「选择运行」— never force-sample unselected segments.
    run_indices = plan.run_indices if plan.run_indices is not None else frozenset(range(len(all_segments)))

    run_list = sorted(run_indices)
    seg_total = len(run_list)
    progress_pos = {idx: pos for pos, idx in enumerate(run_list)}
    passthrough_indices: list[int] = []

    output_chunks: list[torch.Tensor] = []
    segment_outputs: list[torch.Tensor] = []
    segment_audios: list[dict[str, Any]] = []
    reports: list[str] = [plan_summary(plan), "", "Execution path: ComfyUI official MiniMax H3"]
    if clear_vram_between_segments:
        reports.append("VRAM: 段间清理显存已开启。")
    if audio_mode == AUDIO_MODE_MUTE:
        reports.append("Audio: muted — skip audio VAE decode, silent AUDIO output.")
    elif audio_mode == AUDIO_MODE_SOURCE:
        reports.append("Audio: source — skip audio VAE decode, use original timeline audio.")
    else:
        reports.append("Audio: generate — decode MiniMax H3 AV latent audio.")
    if plan.run_indices is not None:
        skipped = [i + 1 for i in range(len(all_segments)) if i not in run_indices]
        reports.append(
            f"Run selection: {len(run_list)}/{len(all_segments)} segment(s) "
            f"(indices {[i + 1 for i in run_list]}; skipped {skipped or 'none'})"
        )

    if plan.continuity_enabled:
        reports.append(
            "Segment continuity: ON — prev last-frame → next first_frame "
            "(ImageToVideo keyframe + post-decode pixel lock)."
        )
    else:
        reports.append("Segment continuity: OFF — per-segment generation only.")

    completed_outputs: dict[int, torch.Tensor] = {}

    def _run_one_segment(seg, *, progress_index: int) -> tuple[torch.Tensor, dict[str, Any] | None]:
        if seg.task_key not in SUPPORTED_TASK_KEYS:
            raise ValueError(
                f"Task '{seg.task_key}' is not supported on MiniMax H3 Director. "
                f"Supported: {', '.join(sorted(SUPPORTED_TASK_KEYS))}."
            )

        meta = {
            "frames_label": frames_label(seg),
            "task_key": seg.task_key,
            "timeline_segment_index": seg.index,
            "timeline_segment_total": len(all_segments),
        }

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="prepare", phase_value=0, phase_max=1, **meta,
        )

        target_len = max(1, int(seg.frame_count or plan.total_frames or 124))
        raw_clip = resolve_segment_raw_clip(plan, seg)

        if seg.source_clip is not None:
            body_raw = seg.source_clip
            target_len = max(target_len, int(body_raw.shape[0]))
        else:
            body_raw = raw_clip[:target_len] if int(raw_clip.shape[0]) > target_len else raw_clip

        if body_raw is not None and body_raw.shape[0] > 0:
            if plan.output_mode == "fixed":
                clip_frames = fit_canvas(body_raw, plan.width, plan.height)
            else:
                clip_frames = fit_video_long_edge(body_raw, plan.ref_max_size)
        else:
            clip_frames = None

        num_frames = minimax_align_frame_count(target_len)
        if clip_frames is not None:
            clip_frames, _ = prepare_segment_clip(clip_frames, num_frames)

        prev_tail = None
        if is_continuity_active(plan, seg):
            prev_tail = resolve_prev_segment_output(
                plan, all_segments, seg.index, completed_outputs, node_id
            )

        ctx_w = plan.width
        ctx_h = plan.height
        if clip_frames is not None and clip_frames.shape[0] > 0:
            ctx_h, ctx_w = int(clip_frames.shape[1]), int(clip_frames.shape[2])

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="prepare", phase_value=1, phase_max=1, **meta,
        )

        positive_prompt = seg.prompt

        if seg.task_key in {"fl2v", "fl_chain"}:
            from .fl2v_timeline import reinforce_fl2v_prompt, reinforce_fl_chain_prompt

            has_end = any(getattr(r, "index", None) == 1 for r in (seg.refs or []))
            if not has_end and seg.refs:
                has_end = len(seg.refs) >= 2
            chained = bool(plan.continuity_enabled and int(getattr(seg, "index", 0)) > 0)
            use_chain_prompt = seg.task_key == "fl_chain" or chained
            if use_chain_prompt:
                positive_prompt = reinforce_fl_chain_prompt(
                    positive_prompt,
                    has_end_frame=has_end,
                    chained=chained or (seg.task_key == "fl_chain" and int(getattr(seg, "index", 0)) > 0),
                )
            else:
                positive_prompt = reinforce_fl2v_prompt(positive_prompt, has_end_frame=has_end)
        elif seg.task_key == "t2v":
            # Chain-on later shots: same first-frame hard lock language as fl2v-i2v path.
            if is_continuity_active(plan, seg):
                from .fl2v_timeline import reinforce_fl_chain_prompt

                positive_prompt = reinforce_fl_chain_prompt(
                    positive_prompt,
                    has_end_frame=False,
                    chained=True,
                )
        elif seg.task_key in {"r2v", "i2v"}:
            from .fl2v_timeline import reinforce_fl_chain_prompt, reinforce_ref_chain_prompt

            # i2v + chain uses ImageToVideo first_frame hard lock → fl_chain prompt language.
            if seg.task_key == "i2v" and is_continuity_active(plan, seg):
                positive_prompt = reinforce_fl_chain_prompt(
                    positive_prompt,
                    has_end_frame=False,
                    chained=True,
                )
            else:
                ref_idxs = [int(getattr(r, "index", 0)) for r in (seg.refs or []) if r is not None]
                vid_idxs = (
                    [int(getattr(v, "index", 0)) for v in (getattr(seg, "ref_videos", None) or []) if v is not None]
                    if seg.task_key == "r2v"
                    else []
                )
                audio_idxs = (
                    [int(getattr(a, "index", 0)) for a in (seg.ref_audios or []) if a is not None]
                    if seg.task_key == "r2v"
                    else []
                )
                positive_prompt = reinforce_ref_chain_prompt(
                    positive_prompt,
                    chained=is_continuity_active(plan, seg),
                    ref_indices=ref_idxs,
                    video_indices=vid_idxs,
                    audio_indices=audio_idxs,
                )
        elif seg.task_key == "v2v":
            positive_prompt = reinforce_v2v_prompt(positive_prompt)
        elif seg.task_key == "rv2v":
            ref_idxs = [int(getattr(r, "index", 0)) for r in (seg.refs or []) if r is not None]
            audio_idxs = [int(getattr(a, "index", 0)) for a in (seg.ref_audios or []) if a is not None]
            positive_prompt = reinforce_rv2v_prompt(
                positive_prompt, ref_indices=ref_idxs, audio_indices=audio_idxs,
            )

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="context_encode", phase_value=0, phase_max=1, **meta,
        )

        first_frame, last_frame, ref_images, ref_videos, ref_audios = _build_minimax_inputs(
            plan, seg, clip_frames=clip_frames, ctx_w=ctx_w, ctx_h=ctx_h, prev_tail=prev_tail,
        )

        if seg.task_key in {"i2v", "r2v", "v2v", "rv2v"} and (ref_images or ref_videos or ref_audios) and audio_vae is None:
            raise ValueError("i2v/r2v/v2v/rv2v / reference conditioning requires audio_vae input.")

        positive, negative, latent, task_hint = run_minimax_conditioning(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=positive_prompt,
            width=ctx_w,
            height=ctx_h,
            length=num_frames,
            task_key=seg.task_key,
            first_frame=first_frame,
            last_frame=last_frame,
            ref_images=ref_images,
            ref_videos=ref_videos,
            ref_audios=ref_audios,
        )

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="context_encode", phase_value=1, phase_max=1, **meta,
        )

        if clear_vram_between_segments:
            cleanup_segment_vram(enabled=True, unload_models=seg_total > 1)

        def _report_sample_phase(phase: str, value: float) -> None:
            report_director_progress(
                node_id, segment_index=progress_index, segment_total=seg_total,
                phase=phase, phase_value=value, phase_max=1, **meta,
            )

        samples = sample_single_stage(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            cfg=cfg,
            steps=steps,
            sampler_name=sampler,
            scheduler=scheduler,
            shift_video=shift_video,
            shift_audio=shift_audio,
            on_phase=_report_sample_phase,
        )

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="decode", phase_value=0, phase_max=1, **meta,
        )
        # Always free UNET before VAE decode (low-VRAM freeze fix); segment flag only
        # controls aggressive mid-run unload elsewhere.
        use_tiled = prepare_vram_for_decode(enabled=True)
        try:
            decoded, audio_dict = _decode_av_latent(
                samples,
                vae,
                audio_vae,
                decode_audio=decode_audio,
                use_tiled=use_tiled,
            )
        finally:
            # Release sample latents ASAP so decode pixels + preview fit in RAM/VRAM.
            del samples

        report_director_progress(
            node_id, segment_index=progress_index, segment_total=seg_total,
            phase="decode", phase_value=1, phase_max=1, **meta,
        )

        if decoded.shape[0] > target_len:
            decoded = decoded[:target_len]

        # MiniMax keyframes only condition — pin opening pixels to prev last frame.
        if prev_tail is not None and is_continuity_active(plan, seg):
            decoded = lock_chain_opening_frame(
                decoded,
                prev_tail,
                width=ctx_w,
                height=ctx_h,
            )

        chunk = decoded.cpu().float().contiguous()
        try:
            del decoded
        except Exception:
            pass
        cleanup_after_decode(enabled=True)

        save_segment_cache(node_id, seg, plan, chunk)
        completed_outputs[seg.index] = chunk

        if seg.task_key in {"t2v", "i2v", "r2v", "fl2v", "v2v", "rv2v"} and chunk.shape[0] >= 1:
            try:
                # Cap JPEG preview count — encoding every frame stalls after decode on weak CPUs.
                idxs = _preview_frame_indices(int(chunk.shape[0]), max_frames=24)
                frames_b64 = [tensor_frame_to_jpeg_b64(chunk[i]) for i in idxs]
                h, w = int(chunk.shape[1]), int(chunk.shape[2])
                src_fps = float(plan.frame_rate or 24)
                duration_sec = max(1e-3, int(chunk.shape[0]) / max(src_fps, 1e-3))
                preview_fps = max(1.0, len(frames_b64) / duration_sec)
                report_director_segment_preview(
                    node_id,
                    segment_index=seg.index,
                    image_b64=frames_b64[0],
                    width=w,
                    height=h,
                    frames=frames_b64,
                    fps=preview_fps,
                )
            except Exception as exc:
                log.debug("Segment video preview skipped: %s", exc)

        if clear_vram_between_segments:
            cleanup_segment_vram(enabled=True)

        reports.append(
            f"Segment {seg.index + 1}/{len(all_segments)}: {task_hint} "
            f"({target_len} frames, seed={seed}"
            f"{', tiled VAE' if use_tiled else ''})"
        )
        log.info(
            "MiniMax H3 Director segment %d/%d done (%d frames, task=%s)",
            seg.index + 1, len(all_segments), target_len, seg.task_key,
        )
        return chunk, audio_dict

    for seg in all_segments:
        if seg.index in run_indices:
            if clear_vram_between_segments and segment_outputs:
                cleanup_segment_vram(enabled=True)
            chunk, audio_dict = _run_one_segment(seg, progress_index=progress_pos[seg.index])
            segment_outputs.append(chunk)
            segment_audios.append(audio_dict or {})
            if plan.export_mode == "all":
                output_chunks.append(chunk)
            continue

        if plan.export_mode != "all":
            continue

        cached = load_segment_cache(node_id, seg, plan)
        if cached is not None:
            cached = cached.float()
            completed_outputs[seg.index] = cached
            reports.append(
                f"Segment {seg.index + 1}/{len(all_segments)}: loaded from cache ({cached.shape[0]} frames)"
            )
            output_chunks.append(cached)
            continue

        # Not selected + no cache: keep full-timeline export by passthrough (do NOT sample).
        fill = segment_passthrough_chunk(plan, seg)
        if fill is None:
            raise ValueError(
                f"Segment {seg.index + 1} is not selected and has no valid cache or source "
                "frames to passthrough. Include it in「选择运行」, or switch export to「分段导出」."
            )
        completed_outputs[seg.index] = fill
        passthrough_indices.append(seg.index)
        reports.append(
            f"Segment {seg.index + 1}/{len(all_segments)}: source passthrough "
            f"({fill.shape[0]} frames, not sampled — outside run selection)"
        )
        output_chunks.append(fill)

    if passthrough_indices:
        reports.append(
            "Passthrough (not sampled) segment(s) "
            f"{[i + 1 for i in passthrough_indices]} — run selection is honored; "
            "unselected gaps filled from cache/source for「全部导出」."
        )

    if not output_chunks and not segment_outputs:
        raise ValueError("Director plan produced no segments.")

    report_director_finish(node_id, seg_total)
    export_chunks = output_chunks if output_chunks else segment_outputs
    export_segments = all_segments if output_chunks else [all_segments[i] for i in sorted(run_indices)]
    combined = concat_continuous_chunks(export_chunks, export_segments, plan)
    return combined, segment_outputs, segment_audios, "\n".join(reports)
