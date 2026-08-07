"""Single-stage sampling for MiniMax H3 (SigmaShift + KSampler)."""

from __future__ import annotations

import logging
from typing import Callable

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.core_sampling")

PhaseCallback = Callable[[str, float], None]


def _unpack_node_output(out):
    if hasattr(out, "args"):
        args = out.args
        if args:
            return args
    if isinstance(out, (tuple, list)):
        return out
    raise RuntimeError(f"Unexpected node output type: {type(out)!r}")


def sample_single_stage(
    *,
    model,
    positive,
    negative,
    latent,
    seed: int,
    cfg: float,
    steps: int,
    sampler_name: str,
    scheduler: str,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    on_phase: PhaseCallback | None = None,
):
    from comfy_extras.nodes_minimax_h3 import MiniMaxH3SigmaShift
    from nodes import KSampler

    def notify(phase: str, value: float) -> None:
        if on_phase:
            on_phase(phase, value)

    notify("sample", 0)
    shifted = MiniMaxH3SigmaShift.execute(model, float(shift_video), float(shift_audio))
    model_shifted = _unpack_node_output(shifted)[0]

    neg = negative if negative else []
    sampler = KSampler()
    samples, = sampler.sample(
        model_shifted,
        int(seed),
        int(steps),
        float(cfg),
        sampler_name,
        scheduler,
        positive,
        neg,
        latent,
        denoise=1.0,
    )
    notify("sample", 1)
    return samples
