"""Single-stage sampling for MiniMax H3 (SigmaShift + KSampler / ManualSigmas)."""

from __future__ import annotations

import logging
from typing import Callable, Sequence

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
    manual_sigmas: Sequence[float] | None = None,
    on_phase: PhaseCallback | None = None,
):
    from comfy_extras.nodes_minimax_h3 import MiniMaxH3SigmaShift

    def notify(phase: str, value: float) -> None:
        if on_phase:
            on_phase(phase, value)

    notify("sample", 0)
    shifted = MiniMaxH3SigmaShift.execute(model, float(shift_video), float(shift_audio))
    model_shifted = _unpack_node_output(shifted)[0]
    neg = negative if negative else []

    if manual_sigmas:
        samples = _sample_with_manual_sigmas(
            model=model_shifted,
            positive=positive,
            negative=neg,
            latent=latent,
            seed=int(seed),
            cfg=float(cfg),
            sampler_name=str(sampler_name or "euler"),
            manual_sigmas=manual_sigmas,
        )
    else:
        from nodes import KSampler

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


def _sample_with_manual_sigmas(
    *,
    model,
    positive,
    negative,
    latent,
    seed: int,
    cfg: float,
    sampler_name: str,
    manual_sigmas: Sequence[float],
):
    """Euler + fixed ManualSigmas via Comfy native custom sampler nodes (Tutu 8-NFE)."""
    from comfy_extras.nodes_custom_sampler import KSamplerSelect, ManualSigmas, SamplerCustom

    sigma_csv = ", ".join(f"{float(x):.17g}" for x in manual_sigmas)
    sampler_out = KSamplerSelect.execute(str(sampler_name or "euler"))
    sampler_obj = _unpack_node_output(sampler_out)[0]
    sigmas_out = ManualSigmas.execute(sigma_csv)
    sigmas = _unpack_node_output(sigmas_out)[0]
    custom_out = SamplerCustom.execute(
        model,
        True,  # add_noise
        int(seed),
        float(cfg),
        positive,
        negative,
        sampler_obj,
        sigmas,
        latent,
    )
    samples = _unpack_node_output(custom_out)[0]
    log.info(
        "NFE accel sampling: sampler=%s steps=%d (manual_sigmas=%d values)",
        sampler_name,
        max(0, len(list(manual_sigmas)) - 1),
        len(list(manual_sigmas)),
    )
    return samples
