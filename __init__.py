"""ComfyUI MiniMax H3 Director — timeline plugin for MiniMax-H3 AV generation.

Based on ComfyUI official MiniMax H3 support (PR #15224 / #15228).
Licensed under the Apache License, Version 2.0. See LICENSE.
"""

from .nodes.conditioning import (
    MiniMaxH3DirectorConditioning,
    MiniMaxH3DirectorPlannerConditioning,
)
from .nodes.director import MiniMaxH3Director
from .nodes.still_model_switch import MiniMaxH3StillCheckpointLoader, MiniMaxH3StillModelSwitch

NODE_CLASS_MAPPINGS = {
    "MiniMaxH3Director": MiniMaxH3Director,
    # Legacy type id kept so older workflows still load.
    "ComfyMiniMaxH3Director": MiniMaxH3Director,
    "MiniMaxH3DirectorConditioning": MiniMaxH3DirectorConditioning,
    "MiniMaxH3DirectorPlannerConditioning": MiniMaxH3DirectorPlannerConditioning,
    "MiniMaxH3StillModelSwitch": MiniMaxH3StillModelSwitch,
    "MiniMaxH3StillCheckpointLoader": MiniMaxH3StillCheckpointLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3Director": "MiniMax H3 导演台（完整版）",
    "ComfyMiniMaxH3Director": "MiniMax H3 导演台（完整版）",
    "MiniMaxH3DirectorConditioning": "MiniMax H3 Director Conditioning",
    "MiniMaxH3DirectorPlannerConditioning": "MiniMax H3 Director Planner Conditioning",
    "MiniMaxH3StillModelSwitch": "文生图模型切换（一键）",
    "MiniMaxH3StillCheckpointLoader": "文生图 Checkpoint（仅SDXL）",
}

WEB_DIRECTORY = "./web/js"

import logging

_log = logging.getLogger("ComfyUI-MiniMaxH3-Director")

try:
    from .director.http_routes import register_routes as _register_director_routes

    if not _register_director_routes():
        _log.warning(
            "MiniMax H3 Director HTTP routes deferred (PromptServer not ready). "
            "Restart ComfyUI if /minimax/director/* returns 404."
        )
except Exception as _director_routes_exc:
    _log.warning("MiniMax H3 Director HTTP routes failed to load: %s", _director_routes_exc)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
