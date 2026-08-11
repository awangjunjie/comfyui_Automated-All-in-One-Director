/**
 * MiniMax H3 — still model switch: sync Director timeline profile on one-click change.
 */
import { app } from "../../../scripts/app.js";

const PROFILE_BY_SOURCE = {
    "A · SDXL": "sdxl",
    "B · Z-Image-Turbo": "z_image_turbo",
    "C · 自定义": "auto",
};

const PRESETS = {
    sdxl: {
        use_video_size: false, width: 1024, height: 576,
        steps: 8, cfg: 2.0, sampler: "euler_ancestral", scheduler: "normal", denoise: 1.0,
    },
    z_image_turbo: {
        use_video_size: false, width: 1024, height: 1024,
        steps: 8, cfg: 1.0, sampler: "res_multistep", scheduler: "simple", denoise: 1.0,
    },
};

function parseTimeline(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === "object" ? o : null;
    } catch {
        return null;
    }
}

function findDirectorNear(switchNode) {
    const graph = switchNode.graph || app.graph;
    if (!graph?._nodes) return null;
    // Prefer a director that receives this switch's outputs
    for (const linkId of Object.values(switchNode.outputs?.[0]?.links || {})) {
        // litegraph may store links as array on output.links
    }
    const outLinks = switchNode.outputs?.[0]?.links;
    const linkIds = Array.isArray(outLinks) ? outLinks : outLinks ? Object.values(outLinks) : [];
    for (const lid of linkIds) {
        const link = graph.links?.[lid];
        if (!link) continue;
        const target = graph.getNodeById?.(link.target_id) || graph._nodes_by_id?.[link.target_id];
        if (target && (target.type === "MiniMaxH3Director" || target.type === "ComfyMiniMaxH3Director")) {
            return target;
        }
    }
    // Fallback: first director on canvas
    return graph._nodes.find(
        (n) => n.type === "MiniMaxH3Director" || n.type === "ComfyMiniMaxH3Director"
    ) || null;
}

function syncDirectorProfile(switchNode, sourceLabel) {
    const profile = PROFILE_BY_SOURCE[sourceLabel] || "auto";
    const director = findDirectorNear(switchNode);
    if (!director) return;

    const tw = director.widgets?.find((w) => w.name === "timeline_data");
    if (!tw) return;
    const tl = parseTimeline(tw.value) || {};
    if (!tl.image_director || typeof tl.image_director !== "object") {
        tl.image_director = {};
    }
    const idir = tl.image_director;
    idir.local_model_profile = profile;
    idir.gen_backend = idir.gen_backend || "local";
    const preset = PRESETS[profile];
    if (preset) {
        Object.assign(idir, preset);
    }
    tw.value = JSON.stringify(tl);
    if (typeof tw.callback === "function") {
        try { tw.callback(tw.value); } catch { /* ignore */ }
    }
    director.setDirtyCanvas?.(true, true);

    // Mirror steps/cfg widgets on director if present
    if (preset) {
        const stepsW = director.widgets?.find((w) => w.name === "ref_gen_steps");
        const cfgW = director.widgets?.find((w) => w.name === "ref_gen_cfg");
        if (stepsW) stepsW.value = preset.steps;
        if (cfgW) cfgW.value = preset.cfg;
    }
}

app.registerExtension({
    name: "ComfyUI.MiniMaxH3Director.StillModelSwitch",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "MiniMaxH3StillModelSwitch") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const sourceW = this.widgets?.find((w) => w.name === "source");
            if (sourceW) {
                const prev = sourceW.callback;
                sourceW.callback = (v) => {
                    prev?.call(this, v);
                    syncDirectorProfile(this, String(v || ""));
                };
            }
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure?.apply(this, arguments);
            // After load, sync once so timeline matches switch
            const sourceW = this.widgets?.find((w) => w.name === "source");
            if (sourceW) {
                setTimeout(() => syncDirectorProfile(this, String(sourceW.value || "")), 0);
            }
            return r;
        };
    },
});
