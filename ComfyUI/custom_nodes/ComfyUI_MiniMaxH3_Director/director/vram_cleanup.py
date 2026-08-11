"""Release GPU memory between MiniMax H3 Director segment runs / decode phases."""

from __future__ import annotations

import gc
import logging

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.vram")

# Prefer tiled VAE when free VRAM is under this many bytes (~3.5 GiB).
TILED_DECODE_FREE_BYTES = int(3.5 * 1024**3)


def cleanup_segment_vram(*, enabled: bool = True, unload_models: bool = True) -> None:
    """Release segment GPU memory: gc, optional unload of ComfyUI models, empty CUDA cache."""
    if not enabled:
        return
    gc.collect()
    try:
        import comfy.model_management as mm

        mm.cleanup_models_gc()
        if unload_models:
            mm.unload_all_models()
            mm.cleanup_models()
        mm.soft_empty_cache()
    except Exception as exc:
        log.warning("Segment VRAM cleanup failed: %s", exc)
        return
    if unload_models:
        log.debug("MiniMax H3 Director: segment VRAM cleanup (models unloaded, cache cleared)")
    else:
        log.debug("MiniMax H3 Director: segment VRAM cleanup (cache cleared, models kept loaded)")


def free_vram_bytes() -> int | None:
    """Best-effort free VRAM on the Comfy compute device."""
    try:
        import comfy.model_management as mm

        return int(mm.get_free_memory())
    except Exception:
        return None


def should_use_tiled_vae_decode(*, free_bytes: int | None = None) -> bool:
    """True when free VRAM is low enough that full-clip VAE decode often stalls/OOMs."""
    free = free_bytes if free_bytes is not None else free_vram_bytes()
    if free is None:
        return False
    return free < TILED_DECODE_FREE_BYTES


def prepare_vram_for_decode(*, enabled: bool = True) -> bool:
    """Unload diffusion models and clear cache so VAE decode can own the GPU.

    Sampling leaves the UNET resident; on small GPUs that peak (UNET+VAE) is what
    freezes the machine right before/during AV decode. Returns whether tiled decode
    is recommended afterward.
    """
    if not enabled:
        return should_use_tiled_vae_decode()
    gc.collect()
    tiled = False
    try:
        import comfy.model_management as mm

        mm.cleanup_models_gc()
        mm.unload_all_models()
        mm.cleanup_models()
        mm.soft_empty_cache(True)
        free = free_vram_bytes()
        tiled = should_use_tiled_vae_decode(free_bytes=free)
        log.info(
            "MiniMax H3 Director: freed VRAM before AV decode (free≈%s, tiled=%s)",
            f"{free / 1024**3:.2f}GiB" if free is not None else "?",
            tiled,
        )
    except Exception as exc:
        log.warning("prepare_vram_for_decode failed: %s", exc)
        tiled = should_use_tiled_vae_decode()
    return tiled


def cleanup_after_decode(*, enabled: bool = True) -> None:
    """Light cleanup after pixels are on CPU — avoid thrashing mid multi-seg run."""
    if not enabled:
        return
    gc.collect()
    try:
        import comfy.model_management as mm

        mm.soft_empty_cache()
    except Exception as exc:
        log.debug("cleanup_after_decode skipped: %s", exc)
