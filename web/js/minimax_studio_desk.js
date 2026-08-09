/** Director desk panel embedded into H3 timeline workbench. */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    newBatchSegment,
    defaultDurationSec,
    taskUsesImageDirector,
    taskUsesPromptDirector,
    directorModeFromTaskKey,
    taskUsesPromptGroups,
    resolveTaskKey,
} from "./minimax_gen_timeline.js";
import { normalizeImageBatchSegments } from "./minimax_image_batch.js";
import { syncFl2vFromShots, updateFl2vDetailUI, newFl2vShot } from "./minimax_fl2v.js";
import { ensureH3dTheme } from "./h3d_theme.js";
import { applyBinderShell } from "./h3d_binder.js";

function setNodeWidget(node, name, value) {
    const w = node?.widgets?.find((x) => x.name === name);
    if (!w) return false;
    w.value = value;
    w.callback?.(value);
    return true;
}

function _looksGgufPath(v) {
    return typeof v === "string" && /\.gguf$/i.test(String(v).replace(/\\/g, "/"));
}

function _looksDirectorMode(v) {
    return v === "T2VA" || v === "I2VA" || v === "FL2VA" || v === "L2VA";
}

/** Fix shifted studio widgets (e.g. GGUF path in temperature after ref_gen_only insert). */
export function repairDirectorStudioWidgets(node) {
    if (!node?.widgets?.length) return false;
    const byName = (name) => node.widgets.find((w) => w.name === name);
    const allVals = node.widgets.map((w) => w.value);

    let gguf = null;
    let modeVal = null;
    let tokens = null;
    let temp = null;
    let steps = null;
    let cfg = null;
    for (const v of allVals) {
        if (_looksGgufPath(v)) gguf = v;
        if (_looksDirectorMode(v)) modeVal = v;
        if (typeof v === "number" && Number.isFinite(v)) {
            if (Number.isInteger(v) && v >= 256 && v <= 8192) tokens = v;
            else if (v > 0 && v <= 2.0001) temp = v;
            if (Number.isInteger(v) && v >= 1 && v <= 100) steps = steps ?? v;
            if (!Number.isInteger(v) && v > 0 && v <= 30) cfg = cfg ?? v;
        }
    }

    let fixed = false;
    const set = (name, value) => {
        const w = byName(name);
        if (!w || w.value === value) return;
        w.value = value;
        try { w.callback?.(value); } catch (_) { /* ignore */ }
        fixed = true;
    };

    const tempW = byName("local_director_temperature");
    const tokW = byName("local_director_max_tokens");
    const tempBroken = tempW && (_looksGgufPath(tempW.value) || _looksDirectorMode(tempW.value) || typeof tempW.value === "boolean");
    const tokBroken = tokW && (
        typeof tokW.value !== "number"
        || !Number.isFinite(tokW.value)
        || _looksDirectorMode(tokW.value)
        || _looksGgufPath(tokW.value)
    );

    if (tempBroken || tokBroken) {
        if (gguf) set("local_director_model", gguf);
        if (modeVal) set("local_director_mode", modeVal);
        set("local_director_max_tokens", tokens ?? 2048);
        set("local_director_temperature", temp ?? 0.6);
    } else {
        if (tokW && (typeof tokW.value !== "number" || !Number.isFinite(+tokW.value))) {
            set("local_director_max_tokens", tokens ?? 2048);
        }
        if (tempW && (typeof tempW.value !== "number" || !Number.isFinite(+tempW.value))) {
            set("local_director_temperature", temp ?? 0.6);
        }
    }

    for (const name of [
        "local_director_enable",
        "image_director_enable",
        "image_director_auto_inject",
        "ref_gen_enable",
        "ref_gen_only",
    ]) {
        const w = byName(name);
        if (w && typeof w.value !== "boolean") set(name, !!w.value);
    }

    const stepsW = byName("ref_gen_steps");
    if (stepsW && (typeof stepsW.value !== "number" || !Number.isInteger(+stepsW.value))) {
        const n = parseInt(stepsW.value, 10);
        set("ref_gen_steps", Number.isFinite(n) ? n : (steps ?? 12));
    }
    const cfgW = byName("ref_gen_cfg");
    if (cfgW && (typeof cfgW.value !== "number" || !Number.isFinite(+cfgW.value))) {
        const n = parseFloat(cfgW.value);
        set("ref_gen_cfg", Number.isFinite(n) ? n : (cfg ?? 2.0));
    }

    if (fixed) {
        console.warn("[MiniMax H3Director] repaired misaligned studio widgets");
        node.setDirtyCanvas?.(true, true);
    }
    return fixed;
}

function refPreviewUrl(imageFile) {
    const norm = String(imageFile || "").replace(/\\/g, "/");
    if (!norm) return "";
    const slash = norm.lastIndexOf("/");
    const filename = slash >= 0 ? norm.slice(slash + 1) : norm;
    const subfolder = slash >= 0 ? norm.slice(0, slash) : "";
    const params = new URLSearchParams({ filename, type: "input" });
    if (subfolder) params.set("subfolder", subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

export function renderIdirPreview(desk, files, labels) {
    const box = desk?.querySelector?.('[data-r="idir-preview"]');
    if (!box) return;
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) {
        box.innerHTML = "";
        return;
    }
    box.innerHTML = list.map((f, i) => {
        const lab = (labels && labels[i]) || (i === 0 ? "全局" : `分镜${i}`);
        const url = refPreviewUrl(f);
        return `<div style="width:88px;text-align:center">
          <div style="width:88px;height:56px;border:1px solid #333;border-radius:4px;overflow:hidden;background:#0d0f14">
            <img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover" />
          </div>
          <div style="font-size:10px;color:#8b93a7;margin-top:2px">${lab}</div>
        </div>`;
    }).join("");
}

export const CAMERA_PRESETS = [
    "固定机位",
    "小幅度缓慢推近",
    "缓慢拉远",
    "左摇",
    "右摇",
    "跟随",
    "过肩",
    "特写",
    "剧烈抖动",
    "航拍俯冲",
];

export const TRANSITIONS = ["cut", "dissolve", "flash", "whip", "none"];

const REF_SAMPLERS = [
    "euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral",
    "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep", "ddim", "uni_pc",
];
const REF_SCHEDULERS = [
    "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta",
];
const REF_NEG_DEFAULT =
    "blurry, lowres, low quality, worst quality, jpeg artifacts, watermark, text, logo, deformed, bad anatomy, extra limbs, mutated hands, poorly drawn face, duplicate";

/** Local still-model profiles — swap wiring + sampling together. */
const LOCAL_MODEL_PROFILES = {
    auto: {
        label: "自动检测",
        wire: "按已连接 MODEL 自动匹配；SDXL / FLUX / Z-Image-Turbo 均可切换。",
    },
    sdxl: {
        label: "SDXL / SD1.5",
        use_video_size: false, width: 1024, height: 576,
        steps: 8, cfg: 2.0, sampler: "euler_ancestral", scheduler: "normal", denoise: 1.0,
        wire: "CheckpointLoaderSimple（完整包）→ MODEL+CLIP+VAE，换文件名即可换模型。",
    },
    flux: {
        label: "FLUX",
        use_video_size: false, width: 1024, height: 1024,
        steps: 20, cfg: 1.0, sampler: "euler", scheduler: "simple", denoise: 1.0,
        wire: "UNETLoader + DualCLIPLoader + VAELoader → ref_gen_*（勿用仅 UNET 的 Checkpoint）。",
    },
    z_image_turbo: {
        label: "Z-Image-Turbo BF16",
        use_video_size: false, width: 1024, height: 1024,
        steps: 8, cfg: 1.0, sampler: "res_multistep", scheduler: "simple", denoise: 1.0,
        wire: "UNETLoader: z_image_turbo_bf16；CLIPLoader: qwen_3_4b（type=lumina2）；VAELoader: ae.safetensors。",
    },
};

function defaultRoleGen() {
    return { character: false, scene: false, prop: false, still: true, refs: [] };
}

function defaultImageDirector() {
    return {
        enabled: false,
        unified_ref_note: "统一角色外貌、服装、年龄与画风，全身或半身清晰可见，干净背景",
        style_suffix: "电影静帧，高细节，写实光影，16:9 构图，无文字水印",
        global_ref_prompt: "",
        shot_image_prompts: "",
        prompt_draft: { global: "", shots: "" },
        auto_inject: true,
        generate_on_queue: false,
        generate_shot_stills: true,
        use_video_size: false,
        width: 1024,
        height: 576,
        steps: 8,
        cfg: 2.0,
        sampler: "euler_ancestral",
        scheduler: "normal",
        denoise: 1.0,
        seed: -1,
        negative: REF_NEG_DEFAULT,
        guide_refs: [],
        fl_global_refs: [],
        // Global: independent character / scene / prop / still
        global_gen: defaultRoleGen(),
        // Per prompt-group: same keys, one entry per segment
        groups_gen: [],
        // legacy (migrated)
        gen_targets: {
            global: true,
            character: false,
            scene: false,
            prop: false,
            shot_stills: true,
        },
        gen_scope: "all",
        gen_group_indices: [],
        gen_backend: "local",
        local_model_profile: "auto",
        gen_api_format: "智谱 GLM",
        gen_api_url: "https://open.bigmodel.cn/api/paas/v4",
        gen_api_key: "",
        gen_api_model: "cogview-3-flash",
        asset_prompts: { characters: [], scenes: [] },
    };
}

const GUIDE_ROLES = [
    { value: "character", label: "人物" },
    { value: "scene", label: "场景" },
    { value: "prop", label: "道具" },
    { value: "style", label: "画风" },
    { value: "other", label: "其他" },
];

const GEN_ROLE_KEYS = [
    { key: "character", label: "人物" },
    { key: "scene", label: "场景" },
    { key: "prop", label: "道具" },
    { key: "still", label: "静帧" },
];

function uidGuide() {
    return `gref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function guideViewUrl(imageFile) {
    if (!imageFile) return "";
    const name = String(imageFile).replace(/\\/g, "/");
    const parts = name.split("/");
    const file = encodeURIComponent(parts.pop());
    const subfolder = encodeURIComponent(parts.join("/"));
    return `/view?filename=${file}&type=input&subfolder=${subfolder}`;
}

async function uploadGuideImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error(await resp.text() || `Upload failed (${resp.status})`);
    const data = await resp.json();
    const name = data.name || data.filename || file.name;
    const sub = (data.subfolder || "").replace(/\\/g, "/");
    return sub ? `${sub}/${name}` : name;
}

function fillIdirPromptDraft(editor, { globalPrompt = "", shotPrompts = "", autoApplyIfEmpty = true } = {}) {
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    if (!idir.prompt_draft || typeof idir.prompt_draft !== "object") {
        idir.prompt_draft = { global: "", shots: "" };
    }
    idir.prompt_draft.global = String(globalPrompt || "");
    idir.prompt_draft.shots = String(shotPrompts || "");
    const desk = editor.studioDesk;
    const dG = desk?.querySelector?.('[data-r="idir-draft-global"]');
    const dS = desk?.querySelector?.('[data-r="idir-draft-shots"]');
    if (dG) dG.value = idir.prompt_draft.global;
    if (dS) dS.value = idir.prompt_draft.shots;
    const workingEmpty = !String(idir.global_ref_prompt || "").trim()
        && !String(idir.shot_image_prompts || "").trim();
    if (autoApplyIfEmpty && workingEmpty) {
        applyIdirPromptDraft(editor, { silent: true });
    }
}

function applyIdirPromptDraft(editor, { silent = false } = {}) {
    ensureTimelineStudio(editor.timeline);
    const desk = editor.studioDesk;
    const dG = desk?.querySelector?.('[data-r="idir-draft-global"]');
    const dS = desk?.querySelector?.('[data-r="idir-draft-shots"]');
    const idir = editor.timeline.image_director;
    if (!idir.prompt_draft || typeof idir.prompt_draft !== "object") {
        idir.prompt_draft = { global: "", shots: "" };
    }
    // Prefer live textarea edits for debugging
    if (dG) idir.prompt_draft.global = dG.value || "";
    if (dS) idir.prompt_draft.shots = dS.value || "";
    idir.global_ref_prompt = idir.prompt_draft.global || "";
    idir.shot_image_prompts = idir.prompt_draft.shots || "";
    const gEl = desk?.querySelector?.('[data-r="idir-global-prompt"]');
    const sEl = desk?.querySelector?.('[data-r="idir-shot-prompts"]');
    if (gEl) gEl.value = idir.global_ref_prompt;
    if (sEl) sEl.value = idir.shot_image_prompts;
    editor.commit?.(false, { syncTimeline: true });
    if (!silent) {
        const st = desk?.querySelector?.('[data-r="idir-status"]');
        if (st) {
            st.textContent = "已将草稿应用到正式生图提示词槽";
            st.classList.remove("err");
            st.classList.add("ok");
        }
    }
}

function clearIdirPromptDraft(editor) {
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    idir.prompt_draft = { global: "", shots: "" };
    const desk = editor.studioDesk;
    const dG = desk?.querySelector?.('[data-r="idir-draft-global"]');
    const dS = desk?.querySelector?.('[data-r="idir-draft-shots"]');
    if (dG) dG.value = "";
    if (dS) dS.value = "";
    editor.commit?.(false, { syncTimeline: true });
}

function renderGuideRefs(editor) {
    const desk = editor.studioDesk;
    const box = desk?.querySelector?.('[data-r="idir-guide-refs"]');
    if (!box) return;
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    if (!Array.isArray(idir.guide_refs)) idir.guide_refs = [];
    // Strip legacy auto-generated pollution from the user-init guide slot
    const before = idir.guide_refs.length;
    idir.guide_refs = idir.guide_refs.filter((it) => {
        if (!it || typeof it !== "object") return false;
        if (it.auto_generated && it.imageFile) {
            // Keep empty labeled cards from asset extract; drop generated image fill
            it.imageFile = "";
            delete it.auto_generated;
        }
        return true;
    });
    if (idir.guide_refs.length !== before) {
        editor.commit?.(false, { syncTimeline: true });
    }
    box.innerHTML = "";
    idir.guide_refs.forEach((item, idx) => {
        const card = document.createElement("div");
        card.className = "h3d-guide-card";
        const thumb = document.createElement("div");
        thumb.className = "h3d-guide-thumb";
        if (item.imageFile) {
            const img = document.createElement("img");
            img.src = guideViewUrl(item.imageFile);
            thumb.appendChild(img);
        } else {
            thumb.textContent = "上传底图";
        }
        thumb.onclick = (e) => {
            if (e.target?.closest?.("[data-a]")) return;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                    item.imageFile = await uploadGuideImage(file);
                    delete item.auto_generated;
                    renderGuideRefs(editor);
                    editor.commit?.(false, { syncTimeline: true });
                } catch (err) {
                    console.error("[MiniMax H3Director] guide upload failed:", err);
                }
            };
            input.click();
        };
        const role = document.createElement("select");
        for (const r of GUIDE_ROLES) {
            const opt = document.createElement("option");
            opt.value = r.value;
            opt.textContent = r.label;
            role.appendChild(opt);
        }
        role.value = item.role || "character";
        role.onchange = () => {
            item.role = role.value;
            editor.commit?.(false, { syncTimeline: true });
        };
        const label = document.createElement("input");
        label.type = "text";
        label.placeholder = "备注名";
        label.value = item.label || "";
        label.onchange = () => {
            item.label = label.value;
            editor.commit?.(false, { syncTimeline: true });
        };
        const actions = document.createElement("div");
        actions.className = "h3d-guide-actions";
        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "h3d-btn";
        clearBtn.textContent = "清图";
        clearBtn.title = "清除图片，保留卡片";
        clearBtn.disabled = !item.imageFile;
        clearBtn.onclick = (e) => {
            e.stopPropagation();
            item.imageFile = "";
            renderGuideRefs(editor);
            editor.commit?.(false, { syncTimeline: true });
        };
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "h3d-btn h3d-guide-del";
        delBtn.textContent = "删除";
        delBtn.title = "删除此参考卡片";
        delBtn.onclick = (e) => {
            e.stopPropagation();
            idir.guide_refs.splice(idx, 1);
            renderGuideRefs(editor);
            editor.commit?.(false, { syncTimeline: true });
        };
        actions.appendChild(clearBtn);
        actions.appendChild(delBtn);
        card.appendChild(thumb);
        card.appendChild(role);
        card.appendChild(label);
        card.appendChild(actions);
        box.appendChild(card);
    });
    if (!idir.guide_refs.length) {
        const empty = document.createElement("div");
        empty.className = "h3d-meta";
        empty.style.cssText = "font-size:11px;color:#8b93a7";
        empty.textContent = "暂无导演参考图。可点「+ 人物/场景」添加，或勾选下方「生成人物/场景参考」由导演自动出图。";
        box.appendChild(empty);
    }
}

function addGuideRef(editor, role = "character", label = "") {
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    if (!Array.isArray(idir.guide_refs)) idir.guide_refs = [];
    idir.guide_refs.push({
        id: uidGuide(),
        role: role || "character",
        label: label || "",
        imageFile: "",
    });
    renderGuideRefs(editor);
    editor.commit?.(false, { syncTimeline: true });
}

function clearAllGuideRefs(editor) {
    ensureTimelineStudio(editor.timeline);
    editor.timeline.image_director.guide_refs = [];
    renderGuideRefs(editor);
    editor.commit?.(false, { syncTimeline: true });
}

function ensureGenPlan(idir, segments) {
    const base = defaultRoleGen();
    if (!idir.global_gen || typeof idir.global_gen !== "object") {
        // Migrate from legacy gen_targets once
        const legacy = idir.gen_targets || {};
        idir.global_gen = {
            character: !!legacy.character,
            scene: !!legacy.scene,
            prop: !!legacy.prop,
            still: legacy.global !== false || legacy.shot_stills !== false,
        };
        // If only shot_stills was intended for groups, don't force global still from shot_stills alone
        if (legacy.global === false && !legacy.character && !legacy.scene && !legacy.prop) {
            idir.global_gen.still = false;
        }
        if (legacy.global !== false && !legacy.character && !legacy.scene && !legacy.prop) {
            idir.global_gen.still = true;
        }
    } else {
        for (const [k, v] of Object.entries(base)) {
            if (idir.global_gen[k] == null) idir.global_gen[k] = v;
        }
    }
    const segs = Array.isArray(segments) ? segments : [];
    if (!Array.isArray(idir.groups_gen)) idir.groups_gen = [];
    while (idir.groups_gen.length < segs.length) {
        const legacy = idir.gen_targets || {};
        const scope = idir.gen_scope || "all";
        const idx = idir.groups_gen.length;
        const inScope =
            scope === "all" ||
            (scope === "selected" && (idir.gen_group_indices || []).map(Number).includes(idx));
        const row = { ...defaultRoleGen(), still: false, refs: [] };
        if (inScope && legacy.shot_stills !== false && scope !== "global_only") {
            row.still = true;
        }
        idir.groups_gen.push(row);
    }
    if (idir.groups_gen.length > segs.length) {
        idir.groups_gen.length = segs.length;
    }
    idir.groups_gen.forEach((row) => {
        if (!row || typeof row !== "object") return;
        for (const [k, v] of Object.entries(base)) {
            if (k === "refs") continue;
            if (row[k] == null) row[k] = v;
        }
        if (!Array.isArray(row.refs)) row.refs = [];
    });
    // Keep legacy flags roughly in sync for older backend paths
    const anyGroupStill = idir.groups_gen.some((r) => r?.still);
    idir.generate_shot_stills = anyGroupStill;
    if (!idir.gen_targets || typeof idir.gen_targets !== "object") idir.gen_targets = {};
    idir.gen_targets.character = !!idir.global_gen.character;
    idir.gen_targets.scene = !!idir.global_gen.scene;
    idir.gen_targets.prop = !!idir.global_gen.prop;
    idir.gen_targets.global = !!idir.global_gen.still;
    idir.gen_targets.shot_stills = anyGroupStill;
}

function makeRoleChecks(row, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "h3d-idir-targets";
    GEN_ROLE_KEYS.forEach(({ key, label }) => {
        const lab = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!row[key];
        cb.onchange = () => {
            row[key] = !!cb.checked;
            onChange?.();
        };
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(label));
        wrap.appendChild(lab);
    });
    return wrap;
}

function renderGenPlanUI(editor) {
    const desk = editor.studioDesk;
    const box = desk?.querySelector?.('[data-r="idir-gen-plan"]');
    if (!box) return;
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    const segs = editor.timeline.segments || [];
    ensureGenPlan(idir, segs);
    box.innerHTML = "";

    const globalHead = document.createElement("div");
    globalHead.className = "h3d-studio-row";
    globalHead.style.cssText = "justify-content:space-between;margin-bottom:2px";
    globalHead.innerHTML = `<b style="font-size:12px;color:#c8d0e0">全局参考</b>
      <span class="h3d-meta" style="font-size:10px;color:#8b93a7">写入全局图片槽并标注</span>`;
    box.appendChild(globalHead);
    box.appendChild(makeRoleChecks(idir.global_gen, () => {
        ensureGenPlan(idir, segs);
        editor.commit?.(false, { syncTimeline: true });
    }));

    const groupHead = document.createElement("div");
    groupHead.className = "h3d-studio-row";
    groupHead.style.cssText = "justify-content:space-between;margin:8px 0 2px;flex-wrap:wrap;gap:4px";
    const title = document.createElement("b");
    title.style.cssText = "font-size:12px;color:#c8d0e0";
    title.textContent = "各提示词组（可分别勾选）";
    const actions = document.createElement("span");
    actions.className = "h3d-studio-row";
    actions.style.gap = "4px";
    const btnAll = document.createElement("button");
    btnAll.type = "button";
    btnAll.className = "h3d-btn";
    btnAll.textContent = "全组勾静帧";
    btnAll.onclick = () => {
        idir.groups_gen.forEach((r) => { if (r) r.still = true; });
        renderGenPlanUI(editor);
        editor.commit?.(false, { syncTimeline: true });
    };
    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "h3d-btn";
    btnCopy.textContent = "复制全局到全组";
    btnCopy.onclick = () => {
        const g = idir.global_gen;
        idir.groups_gen.forEach((r) => {
            if (!r) return;
            r.character = !!g.character;
            r.scene = !!g.scene;
            r.prop = !!g.prop;
            r.still = !!g.still;
        });
        renderGenPlanUI(editor);
        editor.commit?.(false, { syncTimeline: true });
    };
    const btnClear = document.createElement("button");
    btnClear.type = "button";
    btnClear.className = "h3d-btn";
    btnClear.textContent = "清空各组";
    btnClear.onclick = () => {
        idir.groups_gen.forEach((r) => {
            if (!r) return;
            r.character = false;
            r.scene = false;
            r.prop = false;
            r.still = false;
        });
        renderGenPlanUI(editor);
        editor.commit?.(false, { syncTimeline: true });
    };
    actions.appendChild(btnAll);
    actions.appendChild(btnCopy);
    actions.appendChild(btnClear);
    groupHead.appendChild(title);
    groupHead.appendChild(actions);
    box.appendChild(groupHead);

    if (!segs.length) {
        const empty = document.createElement("div");
        empty.className = "h3d-meta";
        empty.style.cssText = "font-size:11px;color:#8b93a7";
        empty.textContent = "暂无提示词组。添加分镜后可在此为每组勾选生成内容，并上传本组独立参考图。";
        box.appendChild(empty);
        return;
    }

    const list = document.createElement("div");
    list.className = "h3d-idir-group-plan";
    segs.forEach((seg, i) => {
        const row = idir.groups_gen[i] || defaultRoleGen();
        if (!Array.isArray(row.refs)) row.refs = [];
        idir.groups_gen[i] = row;
        const card = document.createElement("div");
        card.className = "h3d-idir-group-card";
        const top = document.createElement("div");
        top.className = "h3d-idir-group-row";
        const name = document.createElement("span");
        name.className = "h3d-idir-group-name";
        name.textContent = seg.label || `分镜${i + 1}`;
        top.appendChild(name);
        top.appendChild(makeRoleChecks(row, () => {
            ensureGenPlan(idir, segs);
            editor.commit?.(false, { syncTimeline: true });
        }));
        card.appendChild(top);
        const refLab = document.createElement("div");
        refLab.style.cssText = "font-size:10px;color:#8b93a7;margin:4px 0 2px";
        refLab.textContent = "本组独立参考图（优先于全局）";
        card.appendChild(refLab);
        const strip = document.createElement("div");
        strip.className = "h3d-fl-mini-refs";
        card.appendChild(strip);
        renderMiniRefStrip(strip, row.refs, () => {
            renderGenPlanUI(editor);
            editor.commit?.(false, { syncTimeline: true });
        }, { withRole: true });
        list.appendChild(card);
    });
    box.appendChild(list);
}

function ensureFlGlobalRefs(idir) {
    if (!Array.isArray(idir.fl_global_refs)) idir.fl_global_refs = [];
}

function ensureShotFlGen(shot) {
    if (!shot.fl_gen || typeof shot.fl_gen !== "object") {
        shot.fl_gen = {
            gen_start: true,
            gen_end: true,
            start_prompt: "",
            end_prompt: "",
            start_refs: [],
            end_refs: [],
        };
    } else {
        const f = shot.fl_gen;
        if (f.gen_start == null) f.gen_start = true;
        if (f.gen_end == null) f.gen_end = true;
        if (f.start_prompt == null) f.start_prompt = "";
        if (f.end_prompt == null) f.end_prompt = "";
        if (!Array.isArray(f.start_refs)) f.start_refs = [];
        if (!Array.isArray(f.end_refs)) f.end_refs = [];
    }
    return shot.fl_gen;
}

function renderMiniRefStrip(container, refs, onChange, opts = {}) {
    if (!container) return;
    const withRole = !!opts.withRole;
    container.innerHTML = "";
    (refs || []).forEach((item, idx) => {
        const card = document.createElement("div");
        card.className = "h3d-fl-mini-ref" + (withRole ? " with-role" : "");
        if (item?.imageFile) {
            const img = document.createElement("img");
            img.src = guideViewUrl(item.imageFile);
            card.appendChild(img);
            const x = document.createElement("span");
            x.className = "x";
            x.textContent = "×";
            x.onclick = (e) => {
                e.stopPropagation();
                refs.splice(idx, 1);
                onChange?.();
            };
            card.appendChild(x);
        } else {
            card.textContent = "空";
        }
        if (withRole) {
            const role = document.createElement("select");
            role.className = "h3d-fl-mini-role";
            for (const r of GUIDE_ROLES) {
                const opt = document.createElement("option");
                opt.value = r.value;
                opt.textContent = r.label;
                role.appendChild(opt);
            }
            role.value = item.role || "character";
            role.onclick = (e) => e.stopPropagation();
            role.onchange = (e) => {
                e.stopPropagation();
                item.role = role.value;
                onChange?.();
            };
            card.appendChild(role);
        }
        card.onclick = (e) => {
            if (e.target?.classList?.contains("x") || e.target?.tagName === "SELECT") return;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                    item.imageFile = await uploadGuideImage(file);
                    if (!item.role) item.role = "character";
                    onChange?.();
                } catch (err) {
                    console.error("[MiniMax H3Director] ref upload failed:", err);
                }
            };
            input.click();
        };
        container.appendChild(card);
    });
    const add = document.createElement("div");
    add.className = "h3d-fl-mini-ref";
    add.textContent = "+";
    add.title = "添加参考图";
    add.onclick = async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const path = await uploadGuideImage(file);
                refs.push({ imageFile: path, label: "", role: "character" });
                onChange?.();
            } catch (err) {
                console.error("[MiniMax H3Director] ref upload failed:", err);
            }
        };
        input.click();
    };
    container.appendChild(add);
}

function renderFlGlobalRefs(editor) {
    const desk = editor.studioDesk;
    const box = desk?.querySelector?.('[data-r="fl-global-refs"]');
    if (!box) return;
    ensureTimelineStudio(editor.timeline);
    const idir = editor.timeline.image_director;
    ensureFlGlobalRefs(idir);
    renderMiniRefStrip(box, idir.fl_global_refs, () => {
        renderFlGlobalRefs(editor);
        editor.commit?.(false, { syncTimeline: true });
    });
}

function renderFlShotsPlan(editor) {
    const desk = editor.studioDesk;
    const box = desk?.querySelector?.('[data-r="fl-shots-plan"]');
    if (!box) return;
    ensureTimelineStudio(editor.timeline);
    const shots = editor.timeline.shots || [];
    box.innerHTML = "";
    if (!shots.length) {
        const empty = document.createElement("div");
        empty.className = "h3d-meta";
        empty.style.cssText = "font-size:11px;color:#8b93a7";
        empty.textContent = "暂无首尾帧组。请先在时间线点「添加一组」。";
        box.appendChild(empty);
        return;
    }
    const commit = () => editor.commit?.(false, { syncTimeline: true });
    shots.forEach((shot, i) => {
        const fg = ensureShotFlGen(shot);
        const card = document.createElement("div");
        card.className = "h3d-fl-shot-card";
        const head = document.createElement("div");
        head.className = "h3d-studio-row";
        head.style.cssText = "justify-content:space-between;flex-wrap:wrap;gap:6px";
        head.innerHTML = `<b>第 ${i + 1} 组</b>`;
        const checks = document.createElement("span");
        checks.className = "h3d-idir-targets";
        checks.style.margin = "0";
        [["gen_start", "生成首帧"], ["gen_end", "生成尾帧"]].forEach(([key, lab]) => {
            const label = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!fg[key];
            cb.onchange = () => { fg[key] = !!cb.checked; commit(); };
            label.appendChild(cb);
            label.appendChild(document.createTextNode(lab));
            checks.appendChild(label);
        });
        head.appendChild(checks);
        card.appendChild(head);

        const makeFrame = (kind, title) => {
            const block = document.createElement("div");
            block.className = "h3d-fl-frame-block";
            const promptKey = kind === "start" ? "start_prompt" : "end_prompt";
            const refsKey = kind === "start" ? "start_refs" : "end_refs";
            block.innerHTML = `<div style="font-size:11px;color:#9aa3b5;margin-bottom:4px">${title}</div>`;
            const ta = document.createElement("textarea");
            ta.placeholder = `${title}提示词（可点①自动生成）`;
            ta.style.cssText = "min-height:88px;font-size:11px;width:100%;box-sizing:border-box";
            ta.value = fg[promptKey] || "";
            ta.dataset.flPrompt = `${i}:${kind}`;
            const writePrompt = () => { fg[promptKey] = ta.value; };
            ta.oninput = writePrompt;
            ta.onchange = () => { writePrompt(); commit(); };
            const field = document.createElement("div");
            field.className = "h3d-studio-field";
            field.appendChild(ta);
            block.appendChild(field);
            const refLab = document.createElement("div");
            refLab.style.cssText = "font-size:10px;color:#8b93a7;margin:6px 0 2px";
            refLab.textContent = `${title}独立参考图`;
            block.appendChild(refLab);
            const strip = document.createElement("div");
            strip.className = "h3d-fl-mini-refs";
            block.appendChild(strip);
            renderMiniRefStrip(strip, fg[refsKey], () => {
                renderFlShotsPlan(editor);
                commit();
            });
            return block;
        };
        const frames = document.createElement("div");
        frames.className = "h3d-fl-shot-frames";
        frames.appendChild(makeFrame("start", "首帧"));
        frames.appendChild(makeFrame("end", "尾帧"));
        card.appendChild(frames);
        box.appendChild(card);
    });
}

function harvestFlDirectorFields(editor) {
    const desk = editor?.studioDesk;
    if (!desk) return;
    ensureTimelineStudio(editor.timeline);
    const shots = editor.timeline.shots || [];
    desk.querySelectorAll("[data-fl-prompt]").forEach((ta) => {
        const key = ta.dataset.flPrompt || "";
        const [idxStr, kind] = key.split(":");
        const idx = parseInt(idxStr, 10);
        if (!Number.isFinite(idx) || !shots[idx]) return;
        const fg = ensureShotFlGen(shots[idx]);
        const promptKey = kind === "end" ? "end_prompt" : "start_prompt";
        fg[promptKey] = ta.value || "";
    });
}

function renderFlDirectorUI(editor) {
    renderFlGlobalRefs(editor);
    renderFlShotsPlan(editor);
}

function isEditorFl2v(editor) {
    const key = String(editor?.getTaskKey?.() || "").toLowerCase();
    if (key.includes("fl2v") || key.includes("fl_chain") || key === "fl2v" || key === "fl_chain") return true;
    return editor?.isFl2vMode?.() || editor?.timeline?.timelineMode === "fl2v";
}

const DESK_STYLES = `
/* Legacy workbench helpers; shell-v2 layout lives in h3d_theme.js */
.h3d-workbench:not(.h3d-shell-v2){display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;gap:8px;width:100%;min-height:0;flex:1 1 auto;box-sizing:border-box}
.h3d-workbench:not(.h3d-shell-v2) > .h3d-main{flex:1 1 360px;min-width:280px;max-width:100%;min-height:0}
.h3d-workbench.h3d-shell-v2.is-side > .h3d-main > .h3d-batch,
.h3d-workbench.h3d-shell-v2.is-side > .h3d-main > .h3d-fl2v-detail-wrap{
  flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;
}
.h3d-workbench.h3d-shell-v2.is-side > .h3d-main > .h3d-fl2v-detail-wrap.hidden{display:none!important}
.h3d-workbench.h3d-shell-v2.is-side > .h3d-main .h3d-batch-list,
.h3d-workbench.h3d-shell-v2.is-side > .h3d-main .h3d-fl2v-shots{
  flex:1 1 auto;min-height:0;max-height:none!important;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;
}
.h3d-workbench.h3d-shell-v2.is-side > .h3d-studio-desk.open .h3d-studio-desk-body{
  flex:1 1 auto;min-height:0;max-height:none!important;overflow-x:hidden;overflow-y:auto;
}
.h3d-studio-page{display:none;flex-direction:column;gap:12px;min-height:0;width:100%;box-sizing:border-box}
.h3d-studio-page.active{display:flex}
.h3d-studio-field{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 auto}
.h3d-studio-field label{font-size:11px;color:var(--h3d-muted);letter-spacing:.02em}
.h3d-studio-field textarea,.h3d-studio-field input,.h3d-studio-field select{
  font-size:12px;background:var(--h3d-bg);color:var(--h3d-text);border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-ctl);padding:8px 10px;width:100%;box-sizing:border-box;font-family:inherit
}
.h3d-studio-field textarea{min-height:72px;resize:vertical;line-height:1.45}
.h3d-studio-grid{display:grid;gap:12px 14px;width:100%;align-items:stretch}
.h3d-studio-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.h3d-studio-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.h3d-studio-grid > .h3d-studio-field{width:auto}
.h3d-studio-grid > .h3d-studio-field textarea{min-height:120px}
.h3d-studio-grid-tall > .h3d-studio-field textarea{min-height:148px}
@media(max-width:820px){
  .h3d-studio-grid-3{grid-template-columns:1fr}
  .h3d-studio-grid-2{grid-template-columns:1fr}
}
.h3d-studio-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.h3d-studio-row label{font-size:11px;color:var(--h3d-text);display:flex;gap:4px;align-items:center}
.h3d-studio-status{font-size:11px;color:var(--h3d-muted);min-height:16px}
.h3d-studio-status.err{color:var(--h3d-danger)}
.h3d-studio-status.ok{color:var(--h3d-secondary)}
.h3d-seg-retake.run-on{outline:1px solid var(--h3d-accent)}
.h3d-guide-refs{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.h3d-guide-card{width:118px;border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-panel);background:var(--h3d-bg);padding:6px;display:flex;flex-direction:column;gap:4px}
.h3d-guide-thumb{width:100%;aspect-ratio:1;border:1px dashed var(--h3d-border);border-radius:var(--h3d-radius-ctl);background:var(--h3d-surface);display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;font-size:10px;color:var(--h3d-muted);position:relative}
.h3d-guide-thumb img{width:100%;height:100%;object-fit:cover}
.h3d-guide-thumb .x{position:absolute;top:2px;right:4px;color:var(--h3d-danger);font-size:12px;cursor:pointer}
.h3d-guide-card select,.h3d-guide-card input{font-size:10px;background:var(--h3d-surface);color:var(--h3d-text);border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-ctl);padding:3px 4px;width:100%;box-sizing:border-box}
.h3d-guide-actions{display:flex;gap:4px}
.h3d-guide-actions .h3d-btn{flex:1;padding:2px 4px;font-size:10px}
.h3d-guide-del{color:var(--h3d-danger)!important;border-color:#533!important}
.h3d-idir-targets{display:flex;flex-wrap:wrap;gap:8px 12px;margin:4px 0 6px}
.h3d-idir-targets label{font-size:12px;color:var(--h3d-text);display:inline-flex;align-items:center;gap:4px;margin:0}
.h3d-idir-group-plan{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:4px 0 8px;max-height:min(42vh,360px);overflow-y:auto;padding:8px;border:1px dashed var(--h3d-border);border-radius:var(--h3d-radius-panel)}
.h3d-idir-group-card{border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-panel);padding:10px;background:var(--h3d-bg);min-width:0}
.h3d-idir-group-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 0}
.h3d-idir-group-row:last-child{border-bottom:none}
.h3d-idir-group-name{min-width:64px;font-size:12px;color:var(--h3d-text);font-weight:600}
.h3d-idir-group-row .h3d-idir-targets{margin:0}
.h3d-fl-mini-ref.with-role{height:auto;min-height:64px;flex-direction:column;gap:2px;padding-bottom:2px}
.h3d-fl-mini-role{width:100%;font-size:9px;background:var(--h3d-surface);color:var(--h3d-text);border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-ctl);padding:1px 2px;box-sizing:border-box}
.h3d-fl-shot-card{border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-panel);padding:12px;margin:8px 0;background:var(--h3d-bg)}
.h3d-fl-shot-card b{font-size:12px;color:var(--h3d-text)}
.h3d-fl-shot-frames{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:8px}
@media(max-width:720px){.h3d-fl-shot-frames{grid-template-columns:1fr}}
.h3d-fl-frame-block{margin-top:0;padding:8px;border:1px dashed var(--h3d-border);border-radius:var(--h3d-radius-ctl);background:rgba(0,0,0,.12)}
.h3d-fl-frame-block .h3d-studio-field{margin-top:4px}
.h3d-fl-frame-block textarea{min-height:88px!important}
.h3d-fl-mini-refs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
.h3d-fl-mini-ref{width:64px;height:64px;border:1px dashed var(--h3d-border);border-radius:var(--h3d-radius-ctl);background:var(--h3d-surface);position:relative;overflow:hidden;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--h3d-muted)}
.h3d-fl-mini-ref img{width:100%;height:100%;object-fit:cover}
.h3d-fl-mini-ref .x{position:absolute;top:0;right:2px;color:var(--h3d-danger);font-size:11px;z-index:2}
.h3d-fl-block.hidden,.h3d-i2v-block.hidden,[data-r="ld-local-panel"].hidden,[data-r="ld-cloud-panel"].hidden,[data-r="idir-cloud-gen-panel"].hidden,[data-r="idir-local-gen-only"].hidden{display:none!important}
[data-r="fl-shots-plan"]{max-height:min(42vh,420px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}
`;

function ensureDeskStyles() {
    ensureH3dTheme();
    const css = DESK_STYLES;
    let style = document.getElementById("h3d-studio-desk-styles");
    if (!style) {
        style = document.createElement("style");
        style.id = "h3d-studio-desk-styles";
        document.head.appendChild(style);
    }
    style.textContent = css;
}

function defaultTextDirector() {
    return {
        enabled: false,
        scope: "none",
        backend: "local",
        brief: "",
        skill_id: "none",
        llm_api_format: "Ollama",
        llm_url: "http://127.0.0.1:11434",
        llm_model: "qwen3.5",
        llm_api_key: "",
        zhipu_thinking: false,
    };
}

function normalizeTextDirector(td) {
    const base = defaultTextDirector();
    if (!td || typeof td !== "object") return { ...base };
    const out = { ...base, ...td };
    out.enabled = !!out.enabled;
    const scope = String(out.scope || "none");
    out.scope = ["none", "segment", "all"].includes(scope) ? scope : "none";
    out.backend = String(out.backend || "local").toLowerCase() === "cloud" ? "cloud" : "local";
    out.brief = String(out.brief || "");
    out.skill_id = String(out.skill_id || "none");
    out.llm_api_format = String(out.llm_api_format || base.llm_api_format);
    out.llm_url = String(out.llm_url || base.llm_url);
    out.llm_model = String(out.llm_model || base.llm_model);
    out.llm_api_key = String(out.llm_api_key || "");
    out.zhipu_thinking = !!out.zhipu_thinking;
    return out;
}

function ensureTimelineStudio(timeline) {
    if (!timeline || typeof timeline !== "object") return timeline;
    if (!timeline.continuity || typeof timeline.continuity !== "object") {
        timeline.continuity = { characters: "", locations: "", props: "", inject: true };
    } else {
        const c = timeline.continuity;
        if (c.characters == null) c.characters = "";
        if (c.locations == null) c.locations = "";
        if (c.props == null) c.props = "";
        if (c.inject == null) c.inject = true;
    }
    if (!timeline.desk || typeof timeline.desk !== "object") {
        timeline.desk = {
            style: "写实，电影感，景深层次清晰，光影克制",
            soundscape: "",
            music: "",
            image_director_note: "",
            text_director: defaultTextDirector(),
        };
    } else {
        const d = timeline.desk;
        if (d.style == null) d.style = "写实，电影感，景深层次清晰，光影克制";
        if (d.soundscape == null) d.soundscape = "";
        if (d.music == null) d.music = "";
        if (d.image_director_note == null) d.image_director_note = "";
        d.text_director = normalizeTextDirector(d.text_director);
    }
    const idBase = defaultImageDirector();
    if (!timeline.image_director || typeof timeline.image_director !== "object") {
        timeline.image_director = { ...idBase };
    } else {
        const id = timeline.image_director;
        for (const [k, v] of Object.entries(idBase)) {
            if (id[k] == null) id[k] = typeof v === "object" && v && !Array.isArray(v)
                ? { ...v }
                : Array.isArray(v) ? [...v] : v;
        }
        ensureGenPlan(id, timeline.segments || []);
    }
    if (!timeline.run_scope) timeline.run_scope = "all";
    for (const seg of timeline.segments || []) {
        if (!seg || typeof seg !== "object") continue;
        if (seg.label == null) seg.label = "";
        if (seg.camera == null) seg.camera = "";
        if (seg.transition == null) seg.transition = "cut";
        if (seg.retake == null) seg.retake = false;
        if (seg.retake_note == null) seg.retake_note = "";
        if (seg.run_selected == null) seg.run_selected = true;
    }
    return timeline;
}

function setStatus(el, text, kind = "") {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("err", "ok");
    if (kind) el.classList.add(kind);
}

/**
 * Mount studio desk into the H3 director editor instance.
 */
export function mountStudioDesk(editor) {
    if (!editor?.root || editor._studioDeskMounted) return;
    editor._studioDeskMounted = true;
    ensureDeskStyles();
    ensureTimelineStudio(editor.timeline);

    // Toolbar extras
    const actions = editor.root.querySelector(".h3d-actions");
    if (actions && !actions.querySelector('[data-a="run-retake-only"]')) {
        const btnRetake = document.createElement("button");
        btnRetake.type = "button";
        btnRetake.className = "h3d-btn";
        btnRetake.dataset.a = "run-retake-only";
        btnRetake.title = "只运行标记了 Retake 的片段（开启选择运行）";
        btnRetake.textContent = "仅 Retake";
        const toggle = actions.querySelector('[data-a="run-select-toggle"]');
        if (toggle?.nextSibling) actions.insertBefore(btnRetake, toggle.nextSibling);
        else actions.appendChild(btnRetake);

        const scope = document.createElement("select");
        scope.className = "h3d-select";
        scope.dataset.r = "run-scope";
        scope.title = "运行范围：全部 / 勾选段 / 仅 Retake";
        scope.innerHTML = `
            <option value="all">运行：全部</option>
            <option value="selected">运行：已勾选</option>
            <option value="retake">运行：仅 Retake</option>`;
        actions.insertBefore(scope, btnRetake);
        editor.runScopeSelect = scope;
    }

    // Segment panel extras (camera / retake / label)
    const segPanel = editor.segmentPanel || editor.root.querySelector('[data-r="segment-panel"]');
    if (segPanel && !segPanel.querySelector('[data-r="seg-studio-row"]')) {
        const row = document.createElement("div");
        row.className = "h3d-studio-row";
        row.dataset.r = "seg-studio-row";
        row.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #2a3140";
        row.innerHTML = `
            <div class="h3d-studio-field" style="flex:1;min-width:100px">
              <label>标签</label>
              <input type="text" data-r="seg-label-input" placeholder="开场 / 高潮…">
            </div>
            <div class="h3d-studio-field" style="flex:1;min-width:120px">
              <label>运镜预设</label>
              <select data-r="seg-camera">${CAMERA_PRESETS.map((c) => `<option value="${c}">${c}</option>`).join("")}
                <option value="__custom__">自定义…</option>
              </select>
            </div>
            <div class="h3d-studio-field" style="flex:1;min-width:100px">
              <label>转场</label>
              <select data-r="seg-transition">${TRANSITIONS.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
            </div>
            <label><input type="checkbox" data-r="seg-retake">需重拍 Retake</label>
            <div class="h3d-studio-field" style="flex:2;min-width:140px">
              <label>重拍备注</label>
              <input type="text" data-r="seg-retake-note" placeholder="可选">
            </div>`;
        segPanel.appendChild(row);
        editor.segLabelInput = row.querySelector('[data-r="seg-label-input"]');
        editor.segCamera = row.querySelector('[data-r="seg-camera"]');
        editor.segTransition = row.querySelector('[data-r="seg-transition"]');
        editor.segRetake = row.querySelector('[data-r="seg-retake"]');
        editor.segRetakeNote = row.querySelector('[data-r="seg-retake-note"]');
    }

    // Desk panel under main body
    const desk = document.createElement("div");
    desk.className = "h3d-studio-desk open";
    desk.innerHTML = `
      <nav class="h3d-desk-nav" data-r="desk-tabs" aria-label="导演工台分区">
        <div class="h3d-desk-brand">工台</div>
        <button type="button" class="active" data-tab="continuity" title="连续性">连续</button>
        <button type="button" data-tab="global" title="全局声景">声景</button>
        <button type="button" data-tab="director" title="提示词导演">提示词</button>
        <button type="button" data-tab="imagedir" title="参考图导演">参考图</button>
        <button type="button" data-tab="export" title="分镜导出">导出</button>
      </nav>
      <div class="h3d-desk-main">
      <div class="h3d-studio-desk-head" data-r="desk-toggle">
        <b data-r="desk-title">H3 导演工台 · 连续性 / 声景 / 提示词</b>
        <span class="h3d-meta">点击折叠</span>
      </div>
      <div class="h3d-studio-desk-body">
        <div class="h3d-studio-page active" data-page="continuity">
          <label class="h3d-studio-row"><input type="checkbox" data-r="cont-inject" checked>运行时注入到提示词</label>
          <div class="h3d-studio-grid h3d-studio-grid-3 h3d-studio-grid-tall">
            <div class="h3d-studio-field"><label>角色设定</label><textarea data-r="cont-characters" placeholder="女舰长：短发，深色制服…"></textarea></div>
            <div class="h3d-studio-field"><label>场景设定</label><textarea data-r="cont-locations" placeholder="旗舰舰桥，巨大观察窗"></textarea></div>
            <div class="h3d-studio-field"><label>道具设定</label><textarea data-r="cont-props" placeholder="舰队、跃迁引擎光"></textarea></div>
          </div>
        </div>
        <div class="h3d-studio-page" data-page="global">
          <div class="h3d-studio-grid h3d-studio-grid-3 h3d-studio-grid-tall">
            <div class="h3d-studio-field"><label>整体风格</label><textarea data-r="desk-style"></textarea></div>
            <div class="h3d-studio-field"><label>整体声景</label><textarea data-r="desk-soundscape"></textarea></div>
            <div class="h3d-studio-field"><label>非叙事配乐</label><textarea data-r="desk-music"></textarea></div>
          </div>
        </div>
        <div class="h3d-studio-page" data-page="imagedir">
          <label class="h3d-studio-row"><input type="checkbox" data-r="idir-enable"><span data-r="idir-enable-label">启用参考图导演</span></label>
          <label class="h3d-studio-row"><input type="checkbox" data-r="idir-auto-inject" checked><span data-r="idir-inject-label">自动注入到时间线</span></label>

          <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px">
            <div class="h3d-studio-row">
              <div class="h3d-studio-field" style="width:160px"><label>生图后端</label>
                <select data-r="idir-gen-backend" title="本地：可切换 SDXL / FLUX / Z-Image-Turbo（接线方式不同）。云端：智谱等 API。">
                  <option value="local">本地模型（可切换）</option>
                  <option value="cloud">云端 API（更强/推荐）</option>
                </select>
              </div>
              <div class="h3d-meta" data-r="idir-gen-backend-hint" style="flex:1;font-size:11px;color:#8b93a7;align-self:center">
                换模型：选下方「本地模型族」并按接线说明接 ref_gen_*。
              </div>
            </div>
            <div class="h3d-studio-row" data-r="idir-local-gen-only">
              <div class="h3d-studio-field" style="width:200px"><label>本地模型族</label>
                <select data-r="idir-local-profile" title="切换文生图模型族：自动套用推荐采样，并显示接线说明">
                  <option value="auto">自动检测</option>
                  <option value="sdxl">SDXL / SD1.5</option>
                  <option value="flux">FLUX</option>
                  <option value="z_image_turbo">Z-Image-Turbo BF16</option>
                </select>
              </div>
              <div class="h3d-meta" data-r="idir-local-profile-hint" style="flex:1;font-size:11px;color:#8b93a7;align-self:center;line-height:1.35">
                按已连接 MODEL 自动匹配采样。
              </div>
            </div>
            <div data-r="idir-cloud-gen-panel" class="hidden">
              <div class="h3d-studio-row">
                <div class="h3d-studio-field" style="flex:1;min-width:120px"><label>API 格式</label>
                  <select data-r="idir-gen-api-format">
                    <option value="智谱 GLM">智谱 GLM</option>
                    <option value="OpenAI Compatible">OpenAI Compatible</option>
                  </select>
                </div>
                <div class="h3d-studio-field" style="flex:2"><label>API URL</label>
                  <input type="text" data-r="idir-gen-api-url" placeholder="https://open.bigmodel.cn/api/paas/v4">
                </div>
              </div>
              <div class="h3d-studio-row">
                <div class="h3d-studio-field" style="flex:1.5"><label>生图模型</label>
                  <input type="text" data-r="idir-gen-api-model" placeholder="cogview-3-flash / dall-e-3">
                </div>
                <div class="h3d-studio-field" style="flex:1.5"><label>API Key</label>
                  <input type="password" data-r="idir-gen-api-key" placeholder="智谱/OpenAI Key" autocomplete="off">
                </div>
              </div>
            </div>
          </div>

          <div class="h3d-studio-grid h3d-studio-grid-2">
            <div class="h3d-studio-field"><label>统一外貌备注</label><textarea data-r="idir-unified" placeholder="统一角色外貌、服装与画风…"></textarea></div>
            <div class="h3d-studio-field"><label>静帧风格后缀</label><textarea data-r="idir-suffix" placeholder="电影静帧，高细节…"></textarea></div>
          </div>

          <div class="h3d-i2v-block" data-r="idir-i2v-block">
            <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px">
              <b style="font-size:12px;color:#e8ecf4">② 生成内容（全局 / 各分镜独立勾选）</b>
              <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin:4px 0 6px;line-height:1.4">
                全局与每个提示词组可分别勾选人物、场景、道具、静帧；每组还可上传独立参考图。生图时：本组参考 → 全局参考。
              </div>
              <div data-r="idir-gen-plan"></div>
            </div>
            <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px">
              <div class="h3d-studio-row" style="justify-content:space-between;flex-wrap:wrap;gap:4px">
                <b style="font-size:12px;color:#e8ecf4">全局参考图（给参考图导演 · 用户底图）</b>
                <span class="h3d-studio-row" style="gap:4px;flex-wrap:wrap">
                  <button type="button" class="h3d-btn" data-a="idir-add-char">+ 人物</button>
                  <button type="button" class="h3d-btn" data-a="idir-add-scene">+ 场景</button>
                  <button type="button" class="h3d-btn" data-a="idir-add-prop">+ 道具</button>
                  <button type="button" class="h3d-btn" data-a="idir-add-guide">+ 其他</button>
                  <button type="button" class="h3d-btn h3d-guide-del" data-a="idir-clear-guides">清空</button>
                </span>
              </div>
              <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin-bottom:4px">
                仅作导演生图的图生图底图（Denoise&lt;1）。生成结果会进时间线「图片1–9」与下方预览，<b>不会</b>回写到此槽。
              </div>
              <div class="h3d-guide-refs" data-r="idir-guide-refs"></div>
            </div>
          </div>

          <div class="h3d-fl-block hidden" data-r="idir-fl-block">
            <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px">
              <div class="h3d-studio-row" style="justify-content:space-between;flex-wrap:wrap;gap:4px">
                <b style="font-size:12px;color:#e8ecf4">全局参考图（给首尾帧导演）</b>
                <span class="h3d-studio-row" style="gap:4px">
                  <button type="button" class="h3d-btn" data-a="fl-add-global-ref">+ 添加</button>
                  <button type="button" class="h3d-btn h3d-guide-del" data-a="fl-clear-global-refs">清空</button>
                </span>
              </div>
              <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin:4px 0">
                所有组生首/尾帧时可用；图生图优先用本组独立参考，其次用全局参考。
              </div>
              <div class="h3d-fl-mini-refs" data-r="fl-global-refs"></div>
            </div>
            <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px">
              <b style="font-size:12px;color:#e8ecf4">各组首尾帧（提示词 + 独立参考）</b>
              <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin:4px 0 6px;line-height:1.4">
                每组可勾选生成首帧/尾帧，编辑提示词，并上传该帧自己的参考图。
              </div>
              <div data-r="fl-shots-plan"></div>
            </div>
          </div>

          <div style="border-top:1px solid #2a3140;padding-top:8px;margin-top:4px" data-r="idir-gen-params">
            <div class="h3d-studio-row" style="justify-content:space-between">
              <b style="font-size:12px;color:#e8ecf4" data-r="idir-gen-params-title">文生图参数</b>
              <span class="h3d-studio-row" style="gap:4px" data-r="idir-local-gen-only">
                <button type="button" class="h3d-btn" data-a="idir-preset-zimage" title="Z-Image-Turbo BF16 推荐">Z-Image</button>
                <button type="button" class="h3d-btn" data-a="idir-preset-flux" title="FLUX 推荐">FLUX</button>
                <button type="button" class="h3d-btn" data-a="idir-preset-turbo" title="DreamShaperXL Turbo 等">SDXL Turbo</button>
                <button type="button" class="h3d-btn" data-a="idir-preset-quality" title="常规 SDXL 质量档">SDXL 质量</button>
              </span>
            </div>
            <label class="h3d-studio-row" data-r="idir-local-gen-only"><input type="checkbox" data-r="idir-use-video-size">使用视频宽高（默认用下方独立分辨率，更适合 SDXL）</label>
            <div class="h3d-studio-row">
              <div class="h3d-studio-field" style="width:90px"><label>宽</label><input type="number" data-r="idir-width" min="256" max="2048" step="64" value="1024"></div>
              <div class="h3d-studio-field" style="width:90px"><label>高</label><input type="number" data-r="idir-height" min="256" max="2048" step="64" value="576"></div>
              <div class="h3d-studio-field" style="width:80px" data-r="idir-local-gen-only"><label>Steps</label><input type="number" data-r="idir-steps" min="1" max="100" step="1" value="8"></div>
              <div class="h3d-studio-field" style="width:80px" data-r="idir-local-gen-only"><label>CFG</label><input type="number" data-r="idir-cfg" min="0" max="30" step="0.1" value="2"></div>
              <div class="h3d-studio-field" style="width:80px" data-r="idir-local-gen-only"><label>Denoise</label><input type="number" data-r="idir-denoise" min="0" max="1" step="0.05" value="1"></div>
              <div class="h3d-studio-field" style="width:100px" data-r="idir-local-gen-only"><label>Seed(-1=主种子)</label><input type="number" data-r="idir-seed" step="1" value="-1"></div>
            </div>
            <div class="h3d-studio-row" data-r="idir-local-gen-only">
              <div class="h3d-studio-field" style="flex:1;min-width:140px"><label>Sampler</label>
                <select data-r="idir-sampler">${REF_SAMPLERS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
              </div>
              <div class="h3d-studio-field" style="flex:1;min-width:140px"><label>Scheduler</label>
                <select data-r="idir-scheduler">${REF_SCHEDULERS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
              </div>
            </div>
            <div class="h3d-studio-field" data-r="idir-local-gen-only"><label>反向提示词 Negative</label>
              <textarea data-r="idir-negative" style="min-height:52px;font-size:11px"></textarea>
            </div>
          </div>

          <div class="h3d-studio-row">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="idir-build" data-r="idir-build-label">① 生成生图提示词</button>
            <button type="button" class="h3d-btn" data-a="idir-copy-global">复制全局提示词</button>
          </div>
          <div data-r="idir-prompt-draft" style="border:1px solid #3a4558;border-radius:8px;padding:8px;margin:6px 0;background:#1a1f2a">
            <div class="h3d-studio-row" style="justify-content:space-between;flex-wrap:wrap;gap:4px;margin-bottom:4px">
              <b style="font-size:12px;color:#e8ecf4">生图提示词 · 预览 / 调试</b>
              <span class="h3d-studio-row" style="gap:4px">
                <button type="button" class="h3d-btn h3d-btn-primary" data-a="idir-apply-draft" title="把下方草稿写入正式生图提示词槽">应用到生图槽</button>
                <button type="button" class="h3d-btn" data-a="idir-clear-draft" title="清空草稿预览">清空草稿</button>
              </span>
            </div>
            <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin-bottom:6px;line-height:1.4">
              提示词导演 / ① 生成的结果先落在这里，可改词调试；确认后再点「应用到生图槽」。② 仅生参考图使用下方正式槽。
            </div>
            <div class="h3d-studio-grid h3d-studio-grid-2">
              <div class="h3d-studio-field"><label>草稿 · 全局参考图提示词</label>
                <textarea data-r="idir-draft-global" style="min-height:96px;font-size:11px" placeholder="① 或「人物/场景→参考图导演」后在此预览"></textarea>
              </div>
              <div class="h3d-studio-field"><label>草稿 · 各组生图提示词</label>
                <textarea data-r="idir-draft-shots" style="min-height:96px;font-size:11px" placeholder="每组一段【生图-…】"></textarea>
              </div>
            </div>
          </div>
          <div class="h3d-studio-grid h3d-studio-grid-2">
            <div class="h3d-studio-field" data-r="idir-global-prompt-wrap"><label data-r="idir-global-prompt-label">正式 · 全局参考图提示词（②生图用）</label>
              <textarea data-r="idir-global-prompt" style="min-height:110px" placeholder="从上方草稿「应用到生图槽」，或手动编辑"></textarea>
            </div>
            <div class="h3d-studio-field" data-r="idir-shot-prompts-wrap"><label data-r="idir-shot-prompts-label">正式 · 各组生图提示词（②生图用）</label>
              <textarea data-r="idir-shot-prompts" style="min-height:110px;font-size:11px" placeholder="每组一段【生图-…】"></textarea>
            </div>
          </div>
          <div class="h3d-studio-row" style="margin-top:6px">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="idir-queue-stills" data-r="idir-queue-label">② 仅生参考图并预览</button>
            <button type="button" class="h3d-btn" data-a="idir-ready-video" data-r="idir-ready-label">③ 确认图 → 准备出片</button>
          </div>
          <div class="h3d-idir-preview" data-r="idir-preview" style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;min-height:0"></div>
          <div class="h3d-studio-status" data-r="idir-status"></div>
          <div class="h3d-meta" style="font-size:11px;color:#8b93a7;line-height:1.4" data-r="idir-hint">
            本地可切换多种文生图：SDXL（Checkpoint）、Z-Image-Turbo BF16、FLUX（均接 ref_gen_*）。选「本地模型族」会套用推荐采样并显示接线。云端可用更强 API。点②预览；确认后③再 Queue 出片。
          </div>
        </div>
        <div class="h3d-studio-page" data-page="director">
          <div class="h3d-studio-row">
            <div class="h3d-studio-field" style="width:160px"><label>推理后端</label>
              <select data-r="ld-backend">
                <option value="local">本地 GGUF</option>
                <option value="cloud">云端 API</option>
              </select>
            </div>
            <div class="h3d-meta" data-r="ld-backend-hint" style="flex:1;font-size:11px;color:#8b93a7;align-self:center">
              本地需 LLM Text Processor + GGUF；云端支持 Ollama / 智谱 / OpenAI Compatible
            </div>
          </div>
          <div class="h3d-studio-grid h3d-studio-grid-2 h3d-studio-grid-tall">
            <div class="h3d-studio-field"><label>整片故事 / 创意简述</label>
              <textarea data-r="ld-brief" placeholder="短故事或创意梗概。拆分镜 / 按组扩写时用作剧情推进依据。" style="min-height:140px"></textarea>
            </div>
            <div class="h3d-studio-field">
              <div class="h3d-studio-row" style="justify-content:space-between;align-items:center;gap:6px;margin-bottom:0">
                <label style="margin:0">全局提示词</label>
                <span class="h3d-studio-row" style="gap:4px;flex-wrap:wrap">
                  <button type="button" class="h3d-btn" data-a="ld-global-from-tl" title="从时间线主全局提示词读入">← 时间线</button>
                  <button type="button" class="h3d-btn" data-a="ld-global-to-tl" title="把本框内容写回时间线全局提示词">→ 时间线</button>
                  <button type="button" class="h3d-btn" data-a="ld-global-clear" title="清空本框">清空</button>
                </span>
              </div>
              <textarea data-r="ld-global-prompt" style="min-height:140px" placeholder="在此填写要保留/扩写的全局内容：风格、角色外貌、主场景空间、贯穿声景与配乐等。扩写分镜时会作为必须保留的全局信息传入；也可点「→ 全局」单独扩写本框。"></textarea>
              <div class="h3d-meta" style="font-size:11px;color:#8b93a7;margin-top:4px;line-height:1.4">
                扩写各组时会带上本框内容；结果里的 <<<GLOBAL>>> 也会写回这里与时间线。
              </div>
            </div>
          </div>
          <div data-r="ld-local-panel">
            <div class="h3d-studio-field"><label>GGUF 模型</label><select data-r="ld-model"><option value="">加载中…</option></select></div>
          </div>
          <div data-r="ld-cloud-panel" class="hidden">
            <div class="h3d-studio-row">
              <div class="h3d-studio-field" style="flex:1;min-width:120px"><label>API 格式</label>
                <select data-r="ld-api-format">
                  <option value="Ollama">Ollama</option>
                  <option value="智谱 GLM">智谱 GLM</option>
                  <option value="OpenAI Compatible">OpenAI Compatible</option>
                </select>
              </div>
              <div class="h3d-studio-field" style="flex:2"><label>API URL</label>
                <input type="text" data-r="ld-api-url" placeholder="http://127.0.0.1:11434">
              </div>
            </div>
            <div class="h3d-studio-row">
              <div class="h3d-studio-field" style="flex:2"><label>云端模型</label>
                <input type="text" data-r="ld-api-model" list="ld-api-model-list" placeholder="glm-5.2 / glm-4-flash…">
                <datalist id="ld-api-model-list" data-r="ld-api-model-list"></datalist>
              </div>
              <div class="h3d-studio-field" style="flex:1.2" data-r="ld-api-key-wrap"><label>API Key</label>
                <input type="password" data-r="ld-api-key" placeholder="智谱必填；其它可选" autocomplete="off">
              </div>
              <button type="button" class="h3d-btn" data-a="ld-fetch-models" style="align-self:flex-end;margin-bottom:2px">刷新模型</button>
            </div>
          </div>
          <div class="h3d-studio-row">
            <div class="h3d-studio-field" style="flex:1"><label>模式（随任务自动）</label>
              <select data-r="ld-mode"><option>T2VA</option><option>I2VA</option><option>FL2VA</option><option>L2VA</option><option>REF2VA</option></select>
            </div>
            <div class="h3d-studio-field" style="flex:1.4"><label>风格 Skill</label>
              <select data-r="ld-skill" title="H3 风格技能精简版，扩写时注入">
                <option value="none">通用（H3 规范）</option>
                <option value="minimalist-product-ad">极简产品广告</option>
                <option value="3d-animation-short">3D 动画短片</option>
                <option value="papercraft-stop-motion">剪纸定格解说</option>
                <option value="brand-promo">品牌宣传片</option>
                <option value="mv-subtitle">MV / 歌词排版</option>
                <option value="co-op-game-intro">双人合作游戏开场</option>
                <option value="paper-collage">纸拼贴解说</option>
                <option value="handdrawn-live">手绘+实拍混搭</option>
              </select>
            </div>
            <div class="h3d-studio-field" data-r="ld-shot-count-wrap" style="width:88px"><label>拆分镜数</label>
              <input type="number" data-r="ld-shot-count" min="1" max="16" step="1" value="2" title="「故事 → N 组分镜」的固定组数">
            </div>
            <label class="h3d-studio-row" style="align-self:flex-end;margin-bottom:4px" title="智谱 GLM-5.x：开启后会带 thinking 参数（更慢更贵，质量可能更好）">
              <input type="checkbox" data-r="ld-zhipu-thinking">智谱深度思考
            </label>
          </div>
          <div class="h3d-studio-row" data-r="ld-shot-range-row" title="仅「故事 → 自动分镜」使用：镜数与单镜时长上下限">
            <div class="h3d-studio-field" style="width:76px"><label>镜数下限</label>
              <input type="number" data-r="ld-shot-min" min="1" max="16" step="1" value="2">
            </div>
            <div class="h3d-studio-field" style="width:76px"><label>镜数上限</label>
              <input type="number" data-r="ld-shot-max" min="1" max="16" step="1" value="8">
            </div>
            <div class="h3d-studio-field" style="width:88px"><label>单镜秒下限</label>
              <input type="number" data-r="ld-dur-min" min="1" max="30" step="0.5" value="2">
            </div>
            <div class="h3d-studio-field" style="width:88px"><label>单镜秒上限</label>
              <input type="number" data-r="ld-dur-max" min="1" max="30" step="0.5" value="12">
            </div>
          </div>
          <div class="h3d-meta" data-r="ld-mode-hint" style="font-size:11px;color:#8b93a7;margin:-2px 0 4px"></div>
          <div class="h3d-meta" data-r="ld-flow-hint" style="font-size:11px;color:#8b93a7;margin:0 0 6px;line-height:1.45">
            流程：故事分镜 →（可选）连续性/声景 →（可选）参考图或首尾帧；已有各组简述时用「按组扩写」。各按钮只做一步，不会自动连锁其它步骤。
          </div>
          <div class="h3d-studio-row">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="ld-expand-groups" title="只扩写尚未完整的组简述；已是完整提示词的组会跳过，不会重跑分镜/连续性/参考图">按提示词组扩写并同步</button>
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="ld-story-auto" data-r="ld-shot-split-action" title="只按剧情写出分镜组与全局提示词；不会自动填连续性/声景或参考图">故事 → 自动分镜</button>
            <button type="button" class="h3d-btn" data-a="ld-story-split" data-r="ld-shot-split-action" title="只把故事拆成固定 N 组分镜；不会自动填连续性/声景或参考图">故事 → N 组分镜</button>
            <button type="button" class="h3d-btn" data-a="ld-fill-bible" title="只填充「连续性」角色/场景/道具与「全局声景」风格/声景/配乐；不改分镜提示词">故事 → 连续性/声景</button>
            <button type="button" class="h3d-btn" data-a="ld-extract-assets" title="只写入参考图导演的人物/场景生图提示词；已有连续性字段不会被覆盖">人物/场景 → 参考图导演</button>
            <button type="button" class="h3d-btn hidden" data-a="ld-extract-fl" title="只生成各组首帧/尾帧文生图提示词到首尾帧导演；不改分镜正文">内容 → 首尾帧导演</button>
            <button type="button" class="h3d-btn" data-a="ld-expand-seg" data-r="ld-seg-only-action" title="只扩写当前选中的提示词组">仅当前组</button>
            <button type="button" class="h3d-btn" data-a="ld-expand" title="只扩写并写入全局提示词">→ 全局</button>
          </div>
          <div class="h3d-studio-status" data-r="ld-status"></div>
        </div>
        <div class="h3d-studio-page" data-page="export">
          <div class="h3d-studio-row">
            <button type="button" class="h3d-btn" data-a="export-shots">导出分镜表 Markdown</button>
            <button type="button" class="h3d-btn" data-a="copy-shots">复制到剪贴板</button>
          </div>
          <div class="h3d-studio-field"><label>分镜表预览</label><textarea data-r="shot-preview" readonly style="min-height:120px;font-family:ui-monospace,monospace;font-size:11px"></textarea></div>
        </div>
      </div>
      </div>`;
    // Shell: media column | vertical-nav desk (not vendor stacked panel)
    let workbench = editor.root.querySelector(".h3d-workbench");
    if (!workbench) {
        workbench = document.createElement("div");
        workbench.className = "h3d-workbench h3d-shell-v2";
        const main = editor.mainBody;
        if (main?.parentNode === editor.root) {
            editor.root.insertBefore(workbench, main);
            workbench.appendChild(main);
        } else if (main?.parentNode) {
            main.parentNode.insertBefore(workbench, main);
            workbench.appendChild(main);
        } else {
            editor.root.appendChild(workbench);
        }
    }
    workbench.classList.add("h3d-shell-v2");
    workbench.appendChild(desk);
    editor.studioDesk = desk;
    editor.workbench = workbench;
    // Height after layout so right column can stretch to left
    requestAnimationFrame(() => editor.updateDomWidgetHeight?.());

    // Keep wheel scrolling inside desk (don't zoom/pan Comfy canvas)
    const deskBody = desk.querySelector(".h3d-studio-desk-body");
    if (deskBody) {
        deskBody.addEventListener(
            "wheel",
            (e) => {
                e.stopPropagation();
            },
            { passive: true },
        );
    }

    const q = (sel) => desk.querySelector(sel);
    const bindField = (sel, get, set) => {
        const el = q(sel);
        if (!el) return;
        el.oninput = () => {
            ensureTimelineStudio(editor.timeline);
            set(el);
            editor.commit?.(false, { syncTimeline: true });
        };
        // initial
        ensureTimelineStudio(editor.timeline);
        get(el);
    };

    desk.querySelector('[data-r="desk-toggle"]').onclick = () => {
        desk.classList.toggle("open");
        const meta = desk.querySelector(".h3d-studio-desk-head .h3d-meta");
        if (meta) meta.textContent = desk.classList.contains("open") ? "点击折叠" : "点击展开";
        editor.updateDomWidgetHeight?.();
        editor._markNodeDirtyLight?.();
        editor.scheduleRender?.();
    };

    desk.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.onclick = () => {
            desk.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === btn));
            desk.querySelectorAll("[data-page]").forEach((p) => {
                p.classList.toggle("active", p.dataset.page === btn.dataset.tab);
            });
        };
    });

    bindField('[data-r="cont-inject"]', (el) => {
        el.checked = !!editor.timeline.continuity.inject;
    }, (el) => {
        editor.timeline.continuity.inject = !!el.checked;
    });
    bindField('[data-r="cont-characters"]', (el) => {
        el.value = editor.timeline.continuity.characters || "";
    }, (el) => {
        editor.timeline.continuity.characters = el.value;
    });
    bindField('[data-r="cont-locations"]', (el) => {
        el.value = editor.timeline.continuity.locations || "";
    }, (el) => {
        editor.timeline.continuity.locations = el.value;
    });
    bindField('[data-r="cont-props"]', (el) => {
        el.value = editor.timeline.continuity.props || "";
    }, (el) => {
        editor.timeline.continuity.props = el.value;
    });
    bindField('[data-r="desk-style"]', (el) => {
        el.value = editor.timeline.desk.style || "";
    }, (el) => {
        editor.timeline.desk.style = el.value;
    });
    bindField('[data-r="desk-soundscape"]', (el) => {
        el.value = editor.timeline.desk.soundscape || "";
    }, (el) => {
        editor.timeline.desk.soundscape = el.value;
    });
    bindField('[data-r="desk-music"]', (el) => {
        el.value = editor.timeline.desk.music || "";
    }, (el) => {
        editor.timeline.desk.music = el.value;
    });

    // Image director fields
    bindField('[data-r="idir-enable"]', (el) => {
        el.checked = !!editor.timeline.image_director.enabled;
    }, (el) => {
        editor.timeline.image_director.enabled = !!el.checked;
    });
    bindField('[data-r="idir-auto-inject"]', (el) => {
        el.checked = editor.timeline.image_director.auto_inject !== false;
    }, (el) => {
        editor.timeline.image_director.auto_inject = !!el.checked;
    });

    const IDIR_API_DEFAULTS = {
        "智谱 GLM": { url: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash" },
        "OpenAI Compatible": { url: "http://127.0.0.1:8080/v1", model: "dall-e-3" },
    };
    const normalizeGenBackend = (v) => {
        const s = String(v || "").trim().toLowerCase();
        if (["cloud", "api", "remote", "云端", "云端api", "云端 api"].includes(s)) return "cloud";
        return "local";
    };
    const updateIdirGenBackendUI = () => {
        ensureTimelineStudio(editor.timeline);
        const idir = editor.timeline.image_director;
        const backend = normalizeGenBackend(idir.gen_backend);
        idir.gen_backend = backend;
        const cloudPanel = q('[data-r="idir-cloud-gen-panel"]');
        cloudPanel?.classList.toggle("hidden", backend !== "cloud");
        desk.querySelectorAll('[data-r="idir-local-gen-only"]').forEach((el) => {
            el.classList.toggle("hidden", backend === "cloud");
        });
        const title = q('[data-r="idir-gen-params-title"]');
        if (title) title.textContent = backend === "cloud" ? "云端生图尺寸" : "文生图参数（本地可切换模型）";
        const hint = q('[data-r="idir-gen-backend-hint"]');
        if (hint) {
            hint.textContent = backend === "cloud"
                ? "云端：调用 images/generations（智谱 CogView / OpenAI Compatible），无需连接 Checkpoint"
                : "本地：选模型族并接好 ref_gen_model / clip / vae（SDXL / Z-Image / FLUX）";
        }
        updateIdirLocalProfileUI();
        const fmt = q('[data-r="idir-gen-api-format"]')?.value || "智谱 GLM";
        const keyEl = q('[data-r="idir-gen-api-key"]');
        if (keyEl) keyEl.placeholder = fmt === "智谱 GLM" ? "智谱 API Key" : "OpenAI / 兼容服务 API Key";
    };
    const updateIdirLocalProfileUI = () => {
        ensureTimelineStudio(editor.timeline);
        const idir = editor.timeline.image_director;
        let key = String(idir.local_model_profile || "auto").trim().toLowerCase();
        if (!LOCAL_MODEL_PROFILES[key]) key = "auto";
        idir.local_model_profile = key;
        const sel = q('[data-r="idir-local-profile"]');
        if (sel) sel.value = key;
        const ph = q('[data-r="idir-local-profile-hint"]');
        if (ph) ph.textContent = (LOCAL_MODEL_PROFILES[key] || LOCAL_MODEL_PROFILES.auto).wire;
    };
    const persistIdirGenApi = () => {
        ensureTimelineStudio(editor.timeline);
        const idir = editor.timeline.image_director;
        idir.gen_backend = normalizeGenBackend(q('[data-r="idir-gen-backend"]')?.value);
        idir.local_model_profile = q('[data-r="idir-local-profile"]')?.value || "auto";
        idir.gen_api_format = q('[data-r="idir-gen-api-format"]')?.value || "智谱 GLM";
        idir.gen_api_url = q('[data-r="idir-gen-api-url"]')?.value?.trim() || "";
        idir.gen_api_model = q('[data-r="idir-gen-api-model"]')?.value?.trim() || "";
        idir.gen_api_key = q('[data-r="idir-gen-api-key"]')?.value || "";
        editor.commit?.(false, { syncTimeline: true });
    };
    // init gen backend UI
    {
        const idir = editor.timeline.image_director;
        idir.gen_backend = normalizeGenBackend(idir.gen_backend);
        if (!LOCAL_MODEL_PROFILES[idir.local_model_profile]) idir.local_model_profile = "auto";
        const be = q('[data-r="idir-gen-backend"]');
        if (be) be.value = idir.gen_backend;
        const lp = q('[data-r="idir-local-profile"]');
        if (lp) lp.value = idir.local_model_profile || "auto";
        const fmt = q('[data-r="idir-gen-api-format"]');
        if (fmt) fmt.value = idir.gen_api_format || "智谱 GLM";
        const url = q('[data-r="idir-gen-api-url"]');
        if (url) url.value = idir.gen_api_url || IDIR_API_DEFAULTS["智谱 GLM"].url;
        const model = q('[data-r="idir-gen-api-model"]');
        if (model) model.value = idir.gen_api_model || IDIR_API_DEFAULTS["智谱 GLM"].model;
        const key = q('[data-r="idir-gen-api-key"]');
        if (key) key.value = idir.gen_api_key || "";
        updateIdirGenBackendUI();
    }
    const beEl = q('[data-r="idir-gen-backend"]');
    if (beEl) {
        beEl.onchange = () => {
            persistIdirGenApi();
            updateIdirGenBackendUI();
        };
    }
    const lpEl = q('[data-r="idir-local-profile"]');
    if (lpEl) {
        lpEl.onchange = () => {
            const key = q('[data-r="idir-local-profile"]')?.value || "auto";
            ensureTimelineStudio(editor.timeline);
            editor.timeline.image_director.local_model_profile = key;
            if (key !== "auto" && LOCAL_MODEL_PROFILES[key]?.steps != null) {
                applyIdirPreset(key);
            } else {
                persistIdirGenApi();
                updateIdirLocalProfileUI();
            }
        };
    }
    const fmtEl = q('[data-r="idir-gen-api-format"]');
    if (fmtEl) {
        fmtEl.onchange = () => {
            const fmt = q('[data-r="idir-gen-api-format"]')?.value || "智谱 GLM";
            const defs = IDIR_API_DEFAULTS[fmt] || IDIR_API_DEFAULTS["智谱 GLM"];
            const urlEl = q('[data-r="idir-gen-api-url"]');
            const modelEl = q('[data-r="idir-gen-api-model"]');
            if (urlEl && (!urlEl.value.trim() || Object.values(IDIR_API_DEFAULTS).some((d) => d.url === urlEl.value.trim()))) {
                urlEl.value = defs.url;
            }
            if (modelEl && (!modelEl.value.trim() || Object.values(IDIR_API_DEFAULTS).some((d) => d.model === modelEl.value.trim()))) {
                modelEl.value = defs.model;
            }
            persistIdirGenApi();
            updateIdirGenBackendUI();
        };
    }
    for (const sel of ['[data-r="idir-gen-api-url"]', '[data-r="idir-gen-api-model"]', '[data-r="idir-gen-api-key"]']) {
        const el = q(sel);
        if (el) el.oninput = () => persistIdirGenApi();
    }

    // Expose for build/queue hooks
    editor._persistIdirGenApi = persistIdirGenApi;
    editor._harvestFlDirectorFields = () => harvestFlDirectorFields(editor);

    bindField('[data-r="idir-unified"]', (el) => {
        el.value = editor.timeline.image_director.unified_ref_note || "";
    }, (el) => {
        editor.timeline.image_director.unified_ref_note = el.value;
        editor.timeline.desk.image_director_note = el.value;
    });
    bindField('[data-r="idir-suffix"]', (el) => {
        el.value = editor.timeline.image_director.style_suffix || "";
    }, (el) => {
        editor.timeline.image_director.style_suffix = el.value;
    });
    bindField('[data-r="idir-global-prompt"]', (el) => {
        el.value = editor.timeline.image_director.global_ref_prompt || "";
    }, (el) => {
        editor.timeline.image_director.global_ref_prompt = el.value;
    });
    bindField('[data-r="idir-shot-prompts"]', (el) => {
        el.value = editor.timeline.image_director.shot_image_prompts || "";
    }, (el) => {
        editor.timeline.image_director.shot_image_prompts = el.value;
    });

    // Still-gen params (stored in timeline.image_director)
    const syncGenNum = (key, el, asInt = false) => {
        const n = asInt ? parseInt(el.value, 10) : parseFloat(el.value);
        if (Number.isFinite(n)) editor.timeline.image_director[key] = n;
    };
    bindField('[data-r="idir-use-video-size"]', (el) => {
        el.checked = !!editor.timeline.image_director.use_video_size;
    }, (el) => {
        editor.timeline.image_director.use_video_size = !!el.checked;
    });
    bindField('[data-r="idir-width"]', (el) => {
        el.value = editor.timeline.image_director.width ?? 1024;
    }, (el) => syncGenNum("width", el, true));
    bindField('[data-r="idir-height"]', (el) => {
        el.value = editor.timeline.image_director.height ?? 576;
    }, (el) => syncGenNum("height", el, true));
    bindField('[data-r="idir-steps"]', (el) => {
        el.value = editor.timeline.image_director.steps ?? 8;
    }, (el) => {
        syncGenNum("steps", el, true);
        setNodeWidget(editor.node, "ref_gen_steps", editor.timeline.image_director.steps);
    });
    bindField('[data-r="idir-cfg"]', (el) => {
        el.value = editor.timeline.image_director.cfg ?? 2;
    }, (el) => {
        syncGenNum("cfg", el, false);
        setNodeWidget(editor.node, "ref_gen_cfg", editor.timeline.image_director.cfg);
    });
    bindField('[data-r="idir-denoise"]', (el) => {
        el.value = editor.timeline.image_director.denoise ?? 1;
    }, (el) => syncGenNum("denoise", el, false));
    bindField('[data-r="idir-seed"]', (el) => {
        el.value = editor.timeline.image_director.seed ?? -1;
    }, (el) => syncGenNum("seed", el, true));
    bindField('[data-r="idir-sampler"]', (el) => {
        el.value = editor.timeline.image_director.sampler || "euler_ancestral";
    }, (el) => {
        editor.timeline.image_director.sampler = el.value;
    });
    bindField('[data-r="idir-scheduler"]', (el) => {
        el.value = editor.timeline.image_director.scheduler || "normal";
    }, (el) => {
        editor.timeline.image_director.scheduler = el.value;
    });
    bindField('[data-r="idir-negative"]', (el) => {
        el.value = editor.timeline.image_director.negative || REF_NEG_DEFAULT;
    }, (el) => {
        editor.timeline.image_director.negative = el.value;
    });

    const applyIdirPreset = (preset) => {
        ensureTimelineStudio(editor.timeline);
        const id = editor.timeline.image_director;
        const profileKey = {
            turbo: "sdxl",
            quality: "sdxl",
            zimage: "z_image_turbo",
            z_image_turbo: "z_image_turbo",
            flux: "flux",
            sdxl: "sdxl",
        }[preset] || (LOCAL_MODEL_PROFILES[preset] ? preset : null);

        if (preset === "quality") {
            Object.assign(id, {
                local_model_profile: "sdxl",
                use_video_size: false, width: 1024, height: 576,
                steps: 28, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", denoise: 1.0,
            });
        } else if (preset === "turbo") {
            Object.assign(id, {
                local_model_profile: "sdxl",
                use_video_size: false, width: 1024, height: 576,
                steps: 8, cfg: 2.0, sampler: "euler_ancestral", scheduler: "normal", denoise: 1.0,
            });
        } else if (profileKey && LOCAL_MODEL_PROFILES[profileKey]?.steps != null) {
            const p = LOCAL_MODEL_PROFILES[profileKey];
            Object.assign(id, {
                local_model_profile: profileKey,
                use_video_size: !!p.use_video_size,
                width: p.width, height: p.height,
                steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler, denoise: p.denoise,
            });
        }
        setNodeWidget(editor.node, "ref_gen_steps", id.steps);
        setNodeWidget(editor.node, "ref_gen_cfg", id.cfg);
        const map = {
            "idir-use-video-size": id.use_video_size,
            "idir-width": id.width,
            "idir-height": id.height,
            "idir-steps": id.steps,
            "idir-cfg": id.cfg,
            "idir-denoise": id.denoise,
            "idir-sampler": id.sampler,
            "idir-scheduler": id.scheduler,
            "idir-local-profile": id.local_model_profile,
        };
        for (const [k, v] of Object.entries(map)) {
            const el = q(`[data-r="${k}"]`);
            if (!el) continue;
            if (el.type === "checkbox") el.checked = !!v;
            else el.value = v;
        }
        updateIdirLocalProfileUI();
        editor.commit?.(false, { syncTimeline: true });
        const labels = {
            turbo: "已应用 SDXL Turbo 推荐参数",
            quality: "已应用 SDXL 质量参数",
            zimage: "已应用 Z-Image-Turbo 推荐参数",
            z_image_turbo: "已应用 Z-Image-Turbo 推荐参数",
            flux: "已应用 FLUX 推荐参数",
            sdxl: "已应用 SDXL 推荐参数",
        };
        setStatus(idirStatus, labels[preset] || `已应用 ${LOCAL_MODEL_PROFILES[profileKey]?.label || preset} 参数`, "ok");
    };

    const idirStatus = q('[data-r="idir-status"]');
    q('[data-a="idir-preset-turbo"]').onclick = () => applyIdirPreset("turbo");
    q('[data-a="idir-preset-quality"]').onclick = () => applyIdirPreset("quality");
    q('[data-a="idir-preset-zimage"]').onclick = () => applyIdirPreset("z_image_turbo");
    q('[data-a="idir-preset-flux"]').onclick = () => applyIdirPreset("flux");
    q('[data-a="idir-add-guide"]').onclick = () => addGuideRef(editor, "other");
    q('[data-a="idir-add-char"]').onclick = () => addGuideRef(editor, "character");
    q('[data-a="idir-add-scene"]').onclick = () => addGuideRef(editor, "scene");
    q('[data-a="idir-add-prop"]').onclick = () => addGuideRef(editor, "prop");
    q('[data-a="idir-clear-guides"]').onclick = () => {
        if (!confirm("清空全部导演参考图卡片？")) return;
        clearAllGuideRefs(editor);
    };
    q('[data-a="fl-add-global-ref"]').onclick = async () => {
        ensureTimelineStudio(editor.timeline);
        ensureFlGlobalRefs(editor.timeline.image_director);
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const path = await uploadGuideImage(file);
                editor.timeline.image_director.fl_global_refs.push({ imageFile: path, label: "" });
                renderFlGlobalRefs(editor);
                editor.commit?.(false, { syncTimeline: true });
            } catch (err) {
                setStatus(idirStatus, String(err?.message || err), "err");
            }
        };
        input.click();
    };
    q('[data-a="fl-clear-global-refs"]').onclick = () => {
        if (!confirm("清空全部全局参考图？")) return;
        ensureTimelineStudio(editor.timeline);
        editor.timeline.image_director.fl_global_refs = [];
        renderFlGlobalRefs(editor);
        editor.commit?.(false, { syncTimeline: true });
    };
    renderGuideRefs(editor);
    renderGenPlanUI(editor);
    renderFlDirectorUI(editor);
    updateImageDirectorVisibility(editor);

    q('[data-a="idir-build"]').onclick = async () => {
        ensureTimelineStudio(editor.timeline);
        editor._persistIdirGenApi?.();
        harvestFlDirectorFields(editor);
        editor.harvestBatchPrompts?.();
        editor.flushTimelineSync?.();
        const isFl = isEditorFl2v(editor);
        setStatus(idirStatus, isFl ? "正在生成首尾帧提示词…" : "正在生成参考图提示词…");
        try {
            const res = await api.fetchApi("/minimax/director/image_prompts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    timeline: editor.timeline,
                    unified_ref_note: editor.timeline.image_director.unified_ref_note,
                    style_suffix: editor.timeline.image_director.style_suffix,
                    force: true,
                }),
            });
            const data = await res.json();
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            editor.timeline.image_director.enabled = true;
            // Write to draft preview first — apply to working slots via「应用到生图槽」
            fillIdirPromptDraft(editor, {
                globalPrompt: data.global_ref_prompt || "",
                shotPrompts: data.shot_image_prompts || "",
                autoApplyIfEmpty: true,
            });

            if (data.mode === "fl2v" && Array.isArray(data.shots)) {
                // Merge fl_gen from server while keeping local shot ids/images when possible
                editor.timeline.shots = data.shots.map((s, i) => {
                    const prev = editor.timeline.shots?.[i];
                    return {
                        ...(prev || {}),
                        ...s,
                        fl_gen: {
                            ...(prev?.fl_gen || {}),
                            ...(s?.fl_gen || {}),
                        },
                        startImage: s.startImage || prev?.startImage || null,
                        endImage: s.endImage || prev?.endImage || null,
                    };
                });
                syncFl2vFromShots(editor);
                updateFl2vDetailUI(editor);
                renderFlDirectorUI(editor);
                editor.scheduleRender?.();
            } else if (Array.isArray(data.segments) && editor.timeline.segments) {
                data.segments.forEach((s, i) => {
                    const seg = editor.timeline.segments[i];
                    if (!seg || !s) return;
                    if (s.prompt && !String(seg.prompt || "").trim()) seg.prompt = s.prompt;
                    if (s.label && !String(seg.label || "").trim()) seg.label = s.label;
                });
                editor.renderImageBatchGroups?.();
            }
            const en = q('[data-r="idir-enable"]');
            if (en) en.checked = true;
            editor.commit?.(false, { syncTimeline: true });
            if (data.mode === "fl2v") {
                const n = (editor.timeline.shots || []).length;
                setStatus(idirStatus, `已生成 ${n} 组首帧/尾帧提示词（见预览草稿；确认后「应用到生图槽」）`, "ok");
            } else {
                const n = (data.shots || []).length;
                const filled = data.filled_groups || 0;
                const extra = filled ? `（已从全局提示词拆入 ${filled} 个空组）` : "";
                setStatus(idirStatus, `已写入预览草稿：全局 + ${n} 组分镜生图提示词${extra}。确认后点「应用到生图槽」`, "ok");
            }
        } catch (err) {
            setStatus(idirStatus, String(err?.message || err), "err");
        }
    };
    q('[data-a="idir-copy-global"]').onclick = async () => {
        const text = q('[data-r="idir-global-prompt"]')?.value || "";
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setStatus(idirStatus, "已复制", "ok");
        } catch {
            setStatus(idirStatus, "复制失败", "err");
        }
    };
    q('[data-a="idir-apply-draft"]').onclick = (e) => {
        e.stopPropagation();
        applyIdirPromptDraft(editor);
    };
    q('[data-a="idir-clear-draft"]').onclick = (e) => {
        e.stopPropagation();
        clearIdirPromptDraft(editor);
        setStatus(idirStatus, "已清空生图提示词草稿", "ok");
    };
    for (const sel of ['[data-r="idir-draft-global"]', '[data-r="idir-draft-shots"]']) {
        const el = q(sel);
        if (!el) continue;
        el.oninput = () => {
            ensureTimelineStudio(editor.timeline);
            const idir = editor.timeline.image_director;
            if (!idir.prompt_draft || typeof idir.prompt_draft !== "object") {
                idir.prompt_draft = { global: "", shots: "" };
            }
            idir.prompt_draft.global = q('[data-r="idir-draft-global"]')?.value || "";
            idir.prompt_draft.shots = q('[data-r="idir-draft-shots"]')?.value || "";
            editor.scheduleTimelineSync?.();
        };
    }

    q('[data-a="idir-queue-stills"]').onclick = async () => {
        ensureTimelineStudio(editor.timeline);
        editor._persistIdirGenApi?.();
        harvestFlDirectorFields(editor);
        editor.harvestBatchPrompts?.();
        editor.flushTimelineSync?.();
        const node = editor.node;
        if (!node) return;
        const isFl = isEditorFl2v(editor);

        repairDirectorStudioWidgets(node);

        const hasShotText = !!(editor.timeline.image_director?.shot_image_prompts || "").trim();
        const hasFlPrompt = (editor.timeline.shots || []).some((s) => {
            const f = s?.fl_gen || {};
            return (f.start_prompt || "").trim() || (f.end_prompt || "").trim();
        });
        if (!hasShotText && !hasFlPrompt) {
            setStatus(idirStatus, isFl ? "请先点「① 生成首尾帧提示词」" : "请先点「① 生成生图提示词」", "err");
            return;
        }
        if (isFl) {
            const want = (editor.timeline.shots || []).some((s) => {
                const f = s?.fl_gen || {};
                return f.gen_start !== false || f.gen_end !== false;
            });
            if (!want) {
                setStatus(idirStatus, "请至少勾选一组「生成首帧」或「生成尾帧」", "err");
                return;
            }
        } else {
            const idir = editor.timeline.image_director || {};
            const g = idir.global_gen || {};
            const rows = idir.groups_gen || [];
            const any = ["character", "scene", "prop", "still"].some((k) => g[k])
                || rows.some((r) => r && ["character", "scene", "prop", "still"].some((k) => r[k]));
            if (!any) {
                setStatus(idirStatus, "请在「② 生成内容」中至少勾选一项（全局或某组）", "err");
                return;
            }
            const backend = String(idir.gen_backend || "local").toLowerCase();
            if (backend === "cloud" || backend === "api" || backend.includes("云端")) {
                if (!(idir.gen_api_model || "").trim()) {
                    setStatus(idirStatus, "云端生图请填写生图模型", "err");
                    return;
                }
            }
        }
        setNodeWidget(node, "image_director_enable", true);
        setNodeWidget(node, "image_director_auto_inject", true);
        setNodeWidget(node, "ref_gen_enable", true);
        setNodeWidget(node, "ref_gen_only", true);
        const tok = node.widgets?.find((w) => w.name === "local_director_max_tokens");
        const temper = node.widgets?.find((w) => w.name === "local_director_temperature");
        if (tok && (typeof tok.value !== "number" || !Number.isFinite(+tok.value))) tok.value = 2048;
        if (temper && (typeof temper.value !== "number" || !Number.isFinite(+temper.value))) temper.value = 0.6;
        repairDirectorStudioWidgets(node);

        editor.timeline.image_director.enabled = true;
        editor.timeline.image_director.auto_inject = true;
        editor.commit?.(false, { syncTimeline: true });
        editor.flushTimelineSync?.();
        setStatus(idirStatus, isFl ? "正在仅生成首尾帧（跳过视频）…请稍候" : "正在仅生成参考图（跳过视频）…请稍候");
        try {
            await app.queuePrompt(0);
            setStatus(
                idirStatus,
                isFl
                    ? "已提交：仅生首尾帧。完成后看下方预览 / 各组首尾帧槽 / PreviewImage"
                    : "已提交：仅生参考图。完成后看下方预览 / 时间线图片1 / PreviewImage",
                "ok",
            );
        } catch (err) {
            setStatus(idirStatus, String(err?.message || err), "err");
            setNodeWidget(node, "ref_gen_only", false);
        }
    };

    q('[data-a="idir-ready-video"]').onclick = () => {
        const node = editor.node;
        setNodeWidget(node, "ref_gen_only", false);
        setNodeWidget(node, "ref_gen_enable", false);
        setNodeWidget(node, "image_director_enable", true);
        setNodeWidget(node, "image_director_auto_inject", true);

        ensureTimelineStudio(editor.timeline);
        const isFl = isEditorFl2v(editor);
        if (isFl) {
            // Sync shots → segments for fl2v canvas
            for (const shot of editor.timeline.shots || []) {
                if (!shot || typeof shot !== "object") continue;
                const start = shot.startImage?.imageFile || "";
                if (start) {
                    shot.genImage = { ...(shot.genImage || {}), imageFile: start };
                    shot.imageFile = start;
                }
            }
            syncFl2vFromShots(editor);
            updateFl2vDetailUI(editor);
        } else {
            const syncGen = (block) => {
                if (!block || typeof block !== "object") return;
                const ref0 = (block.refs || []).find((r) => Number(r?.index ?? r?.slot) === 0 && r?.imageFile);
                const path = ref0?.imageFile || block.genImage?.imageFile || "";
                if (path) {
                    block.genImage = { ...(block.genImage || {}), imageFile: path };
                    block.imageFile = path;
                }
            };
            syncGen(editor.timeline.global);
            for (const seg of editor.timeline.segments || []) syncGen(seg);
            editor.renderImageBatchGroups?.();
        }
        editor.commit?.(false, { syncTimeline: true });
        editor.flushTimelineSync?.();
        editor.updateSelectionUI?.();
        editor.scheduleRender?.();

        setStatus(
            idirStatus,
            isFl
                ? "已准备出片：首尾帧已写入各组。现在 Queue 完整工作流生成视频。"
                : "已准备出片：参考图已同步（纯参考，不锁首帧）。锁首尾请用「首尾帧」。现在 Queue 完整工作流。",
            "ok",
        );
        editor._markNodeDirtyLight?.();
    };

    // Expose preview / director-panel refresh helpers for websocket handler
    editor.renderIdirPreview = (files, labels) => renderIdirPreview(desk, files, labels);
    editor.refreshIdirDirectorUI = () => {
        try {
            renderGuideRefs(editor);
            renderGenPlanUI(editor);
            renderFlGlobalRefs(editor);
            renderFlShotsPlan(editor);
        } catch (err) {
            console.warn("[MiniMax H3Director] refreshIdirDirectorUI failed:", err);
        }
    };

    // Segment field bindings
    const onSegMeta = (key, value) => {
        const seg = editor.timeline.segments?.[editor.selectedIndex];
        if (!seg) return;
        seg[key] = value;
        editor.commit?.(false, { syncTimeline: true });
    };
    if (editor.segLabelInput) {
        editor.segLabelInput.oninput = () => onSegMeta("label", editor.segLabelInput.value);
    }
    if (editor.segCamera) {
        editor.segCamera.onchange = () => {
            const v = editor.segCamera.value;
            if (v === "__custom__") {
                const custom = prompt("自定义运镜描述", editor.timeline.segments?.[editor.selectedIndex]?.camera || "");
                if (custom != null) onSegMeta("camera", custom);
                syncSegStudioFields(editor);
                return;
            }
            onSegMeta("camera", v);
        };
    }
    if (editor.segTransition) {
        editor.segTransition.onchange = () => onSegMeta("transition", editor.segTransition.value);
    }
    if (editor.segRetake) {
        editor.segRetake.onchange = () => onSegMeta("retake", !!editor.segRetake.checked);
    }
    if (editor.segRetakeNote) {
        editor.segRetakeNote.oninput = () => onSegMeta("retake_note", editor.segRetakeNote.value);
    }

    // Run scope
    if (editor.runScopeSelect) {
        editor.runScopeSelect.value = editor.timeline.run_scope || "all";
        editor.runScopeSelect.onchange = () => {
            applyRunScope(editor, editor.runScopeSelect.value);
        };
    }
    const retakeBtn = editor.root.querySelector('[data-a="run-retake-only"]');
    if (retakeBtn) {
        retakeBtn.onclick = (e) => {
            e?.stopPropagation?.();
            applyRunScope(editor, "retake");
            if (editor.runScopeSelect) editor.runScopeSelect.value = "retake";
        };
    }

    // Prompt director (local GGUF / cloud API)
    const statusEl = q('[data-r="ld-status"]');
    const modelSel = q('[data-r="ld-model"]');
    void loadLocalModels(modelSel, statusEl);

    const LD_API_DEFAULTS = {
        Ollama: { url: "http://127.0.0.1:11434", model: "qwen3.5" },
        "智谱 GLM": { url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2" },
        "OpenAI Compatible": { url: "http://127.0.0.1:8080/v1", model: "qwen3.5" },
    };

    const ensureTextDirector = () => {
        ensureTimelineStudio(editor.timeline);
        editor.timeline.desk.text_director = normalizeTextDirector(editor.timeline.desk.text_director);
        return editor.timeline.desk.text_director;
    };

    const getDirectorBackend = () => {
        const el = q('[data-r="ld-backend"]');
        return el?.value === "cloud" ? "cloud" : "local";
    };

    const updateDirectorBackendUI = () => {
        const backend = getDirectorBackend();
        const localPanel = q('[data-r="ld-local-panel"]');
        const cloudPanel = q('[data-r="ld-cloud-panel"]');
        localPanel?.classList.toggle("hidden", backend !== "local");
        cloudPanel?.classList.toggle("hidden", backend !== "cloud");
        const fmt = q('[data-r="ld-api-format"]')?.value || "Ollama";
        const keyWrap = q('[data-r="ld-api-key-wrap"]');
        if (keyWrap) keyWrap.style.display = (fmt === "智谱 GLM" || fmt === "OpenAI Compatible") ? "" : "none";
        const hint = q('[data-r="ld-backend-hint"]');
        if (hint) {
            hint.textContent = backend === "cloud"
                ? "云端：Ollama / 智谱 GLM / OpenAI Compatible。智谱请填 Key，模型可用 glm-5.2"
                : "本地：需 ComfyUI-LLM-text-processor + models/LLM 下的 GGUF";
        }
        const thinkRow = q('[data-r="ld-zhipu-thinking"]')?.closest("label");
        if (thinkRow) {
            thinkRow.style.display = (backend === "cloud" && fmt === "智谱 GLM") ? "" : "none";
        }
        const td = ensureTextDirector();
        td.backend = backend;
    };

    const persistTextDirectorFromUI = () => {
        const td = ensureTextDirector();
        td.backend = getDirectorBackend();
        td.brief = q('[data-r="ld-brief"]')?.value || "";
        td.skill_id = q('[data-r="ld-skill"]')?.value || "none";
        td.zhipu_thinking = !!q('[data-r="ld-zhipu-thinking"]')?.checked;
        td.llm_api_format = q('[data-r="ld-api-format"]')?.value || "Ollama";
        td.llm_url = q('[data-r="ld-api-url"]')?.value?.trim() || LD_API_DEFAULTS.Ollama.url;
        td.llm_model = q('[data-r="ld-api-model"]')?.value?.trim() || "";
        td.llm_api_key = q('[data-r="ld-api-key"]')?.value || "";
        setNodeWidget(editor.node, "local_director_brief", td.brief);
        setNodeWidget(editor.node, "local_director_skill", td.skill_id || "none");
        if (td.backend === "local" && modelSel?.value && !String(modelSel.value).startsWith("（")) {
            setNodeWidget(editor.node, "local_director_model", modelSel.value);
        }
        editor.commit?.(false, { syncTimeline: true });
    };

    const syncTextDirectorToUI = () => {
        const td = ensureTextDirector();
        const setVal = (sel, val, isCheck = false) => {
            const el = q(sel);
            if (!el) return;
            if (isCheck) el.checked = !!val;
            else if (document.activeElement !== el) el.value = val ?? "";
        };
        setVal('[data-r="ld-backend"]', td.backend === "cloud" ? "cloud" : "local");
        setVal('[data-r="ld-brief"]', td.brief || "");
        setVal('[data-r="ld-skill"]', td.skill_id || "none");
        setVal('[data-r="ld-global-prompt"]', editor.timeline.global?.prompt || "");
        setVal('[data-r="ld-zhipu-thinking"]', !!td.zhipu_thinking, true);
        setVal('[data-r="ld-api-format"]', td.llm_api_format || "Ollama");
        setVal('[data-r="ld-api-url"]', td.llm_url || LD_API_DEFAULTS.Ollama.url);
        setVal('[data-r="ld-api-model"]', td.llm_model || "");
        setVal('[data-r="ld-api-key"]', td.llm_api_key || "");
        updateDirectorBackendUI();
    };

    const continuityText = () => {
        ensureTimelineStudio(editor.timeline);
        const c = editor.timeline.continuity || {};
        const parts = [];
        if (c.characters) parts.push(`角色：${c.characters}`);
        if (c.locations) parts.push(`场景：${c.locations}`);
        if (c.props) parts.push(`道具：${c.props}`);
        return parts.join("；");
    };

    const deskPreserveFields = () => {
        ensureTimelineStudio(editor.timeline);
        const desk = editor.timeline.desk || {};
        // Prefer director-panel global window; fall back to timeline global
        const fromUi = String(q('[data-r="ld-global-prompt"]')?.value || "").trim();
        const fromTl = String(editor.timeline.global?.prompt || "").trim();
        return {
            global_prompt: fromUi || fromTl,
            desk_style: String(desk.style || "").trim(),
            desk_soundscape: String(desk.soundscape || "").trim(),
            desk_music: String(desk.music || "").trim(),
        };
    };

    const syncLdGlobalToUI = (text) => {
        const el = q('[data-r="ld-global-prompt"]');
        if (el && document.activeElement !== el) el.value = text ?? "";
    };

    const harvestLdGlobalPrompt = () => {
        const el = q('[data-r="ld-global-prompt"]');
        return String(el?.value || "").trim();
    };

    const applyGlobalPrompt = (text, { skipEmpty = true } = {}) => {
        const t = String(text || "").trim();
        if (!t && skipEmpty) return false;
        ensureTimelineStudio(editor.timeline);
        editor.timeline.global = editor.timeline.global || {};
        editor.timeline.global.prompt = t;
        if (editor.globalPrompt) editor.globalPrompt.value = t;
        if (editor.globalPromptWidget) editor.globalPromptWidget.value = t;
        syncLdGlobalToUI(t);
        return true;
    };

    const requireModel = () => {
        persistTextDirectorFromUI();
        const backend = getDirectorBackend();
        if (backend === "cloud") {
            const model = q('[data-r="ld-api-model"]')?.value?.trim() || "";
            if (!model) {
                setStatus(statusEl, "请填写云端模型名（可点「刷新模型」拉取列表）", "err");
                return null;
            }
            const fmt = q('[data-r="ld-api-format"]')?.value || "Ollama";
            if (fmt === "智谱 GLM" && !(q('[data-r="ld-api-key"]')?.value || "").trim()) {
                setStatus(statusEl, "智谱 GLM 需要填写 API Key（或设置环境变量 ZHIPU_API_KEY）", "err");
                return null;
            }
            return model;
        }
        const model = modelSel?.value || "";
        if (!model || model.startsWith("（")) {
            setStatus(statusEl, "未找到 GGUF 模型，请安装 LLM Text Processor 并放入 models/LLM，或改用云端 API", "err");
            return null;
        }
        return model;
    };

    const commonBody = (extra = {}) => {
        syncLocalDirectorForTask(editor);
        persistTextDirectorFromUI();
        const taskKey = editor.getTaskKey?.() || "t2v";
        const mode = directorModeFromTaskKey(taskKey);
        const modeEl = q('[data-r="ld-mode"]');
        if (modeEl) modeEl.value = mode;
        const backend = getDirectorBackend();
        const td = ensureTextDirector();
        const body = {
            model: requireModel(),
            mode,
            task_type: taskKey,
            ratio: "16:9",
            continuity: continuityText(),
            chain_continuity: !!(
                editor.timeline?.output?.continuityEnabled
                || editor.timeline?.output?.continuity_enabled
                || resolveTaskKey(taskKey) === "fl_chain"
            ),
            group_count: Math.max(1, (editor.timeline?.segments || []).length || 1),
            backend,
            skill_id: td.skill_id || q('[data-r="ld-skill"]')?.value || "none",
            ...deskPreserveFields(),
            ...extra,
        };
        if (backend === "cloud") {
            body.llm_url = td.llm_url;
            body.api_format = td.llm_api_format;
            body.api_key = td.llm_api_key;
            body.model = td.llm_model || body.model;
            body.thinking = td.zhipu_thinking ? "enabled" : "disabled";
            // 智谱多分镜需要更大输出预算
            if (td.llm_api_format === "智谱 GLM" && !extra.max_tokens) {
                body.max_tokens = td.zhipu_thinking ? 16384 : 8192;
            }
        }
        return body;
    };

    const readApiJson = async (res) => {
        const raw = await res.text();
        if (!raw || !String(raw).trim()) {
            throw new Error(`空响应 (HTTP ${res.status})`);
        }
        try {
            return JSON.parse(raw);
        } catch (parseErr) {
            const preview = String(raw).replace(/\s+/g, " ").slice(0, 160);
            if (res.status === 405) {
                throw new Error(
                    "接口 405 Method Not Allowed：导演台路由未挂载或方法不匹配。"
                    + "请完全重启 ComfyUI 后再试（仅刷新前端不够）。"
                    + ` 响应: ${preview}`,
                );
            }
            throw new Error(
                `接口返回非 JSON (HTTP ${res.status}): ${preview}`
                + (parseErr?.message ? ` — ${parseErr.message}` : ""),
            );
        }
    };

    const fetchCloudModels = async (silent = false) => {
        persistTextDirectorFromUI();
        const td = ensureTextDirector();
        try {
            if (!silent) setStatus(statusEl, "正在拉取云端模型列表…");
            const res = await api.fetchApi("/minimax/director/enhance_models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    llm_url: td.llm_url,
                    api_format: td.llm_api_format,
                    api_key: td.llm_api_key,
                }),
            });
            const data = await readApiJson(res);
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const list = q('[data-r="ld-api-model-list"]');
            if (list) {
                list.innerHTML = "";
                for (const name of data.models || []) {
                    const opt = document.createElement("option");
                    opt.value = name;
                    list.appendChild(opt);
                }
            }
            if (!(q('[data-r="ld-api-model"]')?.value || "").trim()) {
                const fallback = LD_API_DEFAULTS[td.llm_api_format]?.model || "qwen3.5";
                const first = (data.models || [])[0] || fallback;
                const modelEl = q('[data-r="ld-api-model"]');
                if (modelEl) modelEl.value = first;
                persistTextDirectorFromUI();
            }
            if (!silent) setStatus(statusEl, `已加载 ${(data.models || []).length} 个云端模型`, "ok");
        } catch (err) {
            if (!silent) setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    // Bind prompt-director fields
    syncTextDirectorToUI();
    q('[data-r="ld-backend"]').onchange = () => {
        updateDirectorBackendUI();
        persistTextDirectorFromUI();
        if (getDirectorBackend() === "cloud") void fetchCloudModels(true);
    };
    q('[data-r="ld-api-format"]').onchange = () => {
        const fmt = q('[data-r="ld-api-format"]')?.value || "Ollama";
        const defs = LD_API_DEFAULTS[fmt] || LD_API_DEFAULTS.Ollama;
        const urlEl = q('[data-r="ld-api-url"]');
        const modelEl = q('[data-r="ld-api-model"]');
        if (urlEl && (!urlEl.value.trim() || Object.values(LD_API_DEFAULTS).some((d) => d.url === urlEl.value.trim()))) {
            urlEl.value = defs.url;
        }
        if (modelEl && !modelEl.value.trim()) modelEl.value = defs.model;
        updateDirectorBackendUI();
        persistTextDirectorFromUI();
    };
    const thinkEl = q('[data-r="ld-zhipu-thinking"]');
    if (thinkEl) thinkEl.onchange = () => persistTextDirectorFromUI();
    const skillEl = q('[data-r="ld-skill"]');
    if (skillEl) skillEl.onchange = () => persistTextDirectorFromUI();
    for (const sel of ["[data-r=\"ld-brief\"]", "[data-r=\"ld-global-prompt\"]", "[data-r=\"ld-api-url\"]", "[data-r=\"ld-api-model\"]", "[data-r=\"ld-api-key\"]"]) {
        const el = q(sel);
        if (!el) continue;
        el.oninput = () => {
            if (sel.includes("ld-global-prompt")) {
                // Keep timeline global in sync while typing in director window
                const t = el.value || "";
                ensureTimelineStudio(editor.timeline);
                editor.timeline.global = editor.timeline.global || {};
                editor.timeline.global.prompt = t;
                if (editor.globalPrompt && document.activeElement !== editor.globalPrompt) {
                    editor.globalPrompt.value = t;
                }
                if (editor.globalPromptWidget) editor.globalPromptWidget.value = t;
                editor.commit?.(false, { syncTimeline: true });
            } else {
                persistTextDirectorFromUI();
            }
        };
    }

    q('[data-a="ld-global-from-tl"]').onclick = () => {
        const t = String(editor.timeline.global?.prompt || editor.globalPrompt?.value || "").trim();
        const el = q('[data-r="ld-global-prompt"]');
        if (el) el.value = t;
        setStatus(statusEl, t ? "已从时间线读入全局提示词" : "时间线全局提示词为空", t ? "ok" : "err");
    };
    q('[data-a="ld-global-to-tl"]').onclick = () => {
        const t = harvestLdGlobalPrompt();
        applyGlobalPrompt(t, { skipEmpty: false });
        editor.commit?.(false, { syncTimeline: true });
        setStatus(statusEl, t ? "已写回时间线全局提示词" : "已清空时间线全局提示词", "ok");
    };
    q('[data-a="ld-global-clear"]').onclick = () => {
        const el = q('[data-r="ld-global-prompt"]');
        if (el) el.value = "";
        setStatus(statusEl, "已清空导演台全局提示词框（未改时间线，点「→ 时间线」可同步清空）", "ok");
    };
    if (modelSel) {
        modelSel.onchange = () => persistTextDirectorFromUI();
    }
    q('[data-a="ld-fetch-models"]').onclick = () => { void fetchCloudModels(false); };

    /** Write expanded single-shot prompts into prompt groups (segments). */
    const applyShotsToGroups = (shots, { keepScope = false } = {}) => {
        if (!Array.isArray(shots) || !shots.length) return 0;
        ensureTimelineStudio(editor.timeline);
        // 拆分镜结果进入分镜模式；整局单组扩写则保留整局
        if (!keepScope) editor.timeline.editMode = "segment";
        if (!Array.isArray(editor.timeline.segments)) editor.timeline.segments = [];

        const taskKey = editor.getTaskKey?.() || "t2v";
        const defSec = defaultDurationSec(taskKey);

        while (editor.timeline.segments.length < shots.length) {
            editor.timeline.segments.push(newBatchSegment({
                durationSec: defSec,
                taskType: editor.timeline.global?.taskType || "",
            }));
        }

        let n = 0;
        for (const shot of shots) {
            const idx = Math.max(0, parseInt(shot.index, 10) || n);
            const seg = editor.timeline.segments[idx];
            if (!seg) continue;
            seg.prompt = shot.prompt || "";
            if (shot.label) seg.label = shot.label;
            if (shot.duration != null && Number.isFinite(Number(shot.duration))) {
                const sec = Math.max(1, Number(shot.duration));
                seg.durationSec = sec;
            }
            n += 1;
        }

        if (editor.isImageBatch?.() || editor.getDirectorMode?.() === "prompt_batch") {
            normalizeImageBatchSegments(editor);
            editor.renderImageBatchGroups?.();
        } else if (editor.isFl2vMode?.()) {
            editor.updateSelectionUI?.();
            editor.scheduleRender?.();
        }
        // Also refresh classic segment prompt if visible
        const cur = editor.timeline.segments?.[editor.selectedIndex];
        if (cur && editor.segPrompt) editor.segPrompt.value = cur.prompt || "";
        if (editor.globalPromptWidget && editor.timeline.global) {
            // Keep global as story brief / first shot summary for reference
            const story = q('[data-r="ld-brief"]')?.value?.trim();
            if (story) {
                editor.timeline.global.prompt = story;
                if (editor.globalPrompt) editor.globalPrompt.value = story;
                if (editor.globalPromptWidget) editor.globalPromptWidget.value = story;
            }
        }
        editor.harvestBatchPrompts?.();
        editor.commit?.(false, { syncTimeline: true });
        editor.flushTimelineSync?.();
        editor.updateDomWidgetHeight?.();
        editor.updateVideoNameLabel?.();
        syncLocalDirectorForTask(editor);
        return n;
    };

    const looksExpandedPrompt = (p) =>
        /综合多模态描述|整体声景|主体定义|详细描述/.test(String(p || ""));

    const doExpandGroups = async () => {
        if (!requireModel()) return;
        editor.harvestBatchPrompts?.();
        syncLocalDirectorForTask(editor);
        const globalScope = (editor.timeline?.editMode || "global") === "global"
            || editor.isGlobalMode?.();
        const segs = editor.timeline.segments || [];
        if (!segs.length) {
            setStatus(
                statusEl,
                globalScope
                    ? "没有成片提示词槽。请先在整局内容里填写简述，或用「→ 全局」"
                    : "没有提示词组。请先「添加提示词组」或用「故事 → N 组分镜」",
                "err",
            );
            return;
        }
        const taskKey = editor.getTaskKey?.() || "t2v";
        const mode = directorModeFromTaskKey(taskKey);
        const story = q('[data-r="ld-brief"]')?.value?.trim() || "";
        const pending = [];
        let skipped = 0;
        const indices = globalScope ? [0] : segs.map((_, i) => i);
        indices.forEach((i) => {
            const seg = segs[i];
            if (!seg) return;
            const raw = String(seg.prompt || "").trim();
            if (raw && looksExpandedPrompt(raw)) {
                skipped += 1;
                return;
            }
            // Only expand short briefs; empty groups can use story context
            if (!raw && !story) return;
            pending.push({
                index: i,
                brief: raw || "",
                prompt: raw || "",
                label: seg.label || (globalScope ? "整局成片" : `分镜${i + 1}`),
                duration: Number(seg.durationSec) || defaultDurationSec(taskKey),
            });
        });
        if (!pending.length) {
            if (skipped > 0) {
                setStatus(
                    statusEl,
                    globalScope
                        ? "成片提示词已完整，无需再扩；改简述后再点，或用「→ 全局」"
                        : "各组已是完整提示词，无需再扩；改简述后再点，或用「故事 → 自动分镜 / N 组分镜」重做",
                    "ok",
                );
            } else {
                setStatus(
                    statusEl,
                    globalScope
                        ? "请先填写成片简述，或在上方填写整片故事"
                        : "请先在各组填写简述，或在上方填写整片故事",
                    "err",
                );
            }
            return;
        }
        setStatus(
            statusEl,
            globalScope
                ? `正在按 ${taskKey}/${mode}：扩写整局成片提示词…`
                : `正在按 ${taskKey}/${mode}：扩写 ${pending.length} 组`
                    + (skipped ? `（跳过 ${skipped} 组已完整提示词）` : "")
                    + "…",
        );
        try {
            const body = commonBody({
                expand_mode: "groups",
                brief: story,
                story_context: story,
                duration: defaultDurationSec(taskKey),
                groups: pending,
                shot_count: pending.length,
            });
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/local_expand", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const count = applyShotsToGroups(data.shots || [], { keepScope: globalScope });
            if (data.global_prompt) applyGlobalPrompt(data.global_prompt);
            const skipNote = skipped ? `，跳过 ${skipped} 组已完整` : "";
            setStatus(
                statusEl,
                (globalScope ? `已同步成片提示词` : `已同步 ${count} 组`)
                + (globalScope ? "" : skipNote)
                + (data.global_prompt ? "，并更新全局提示词" : "")
                + `（模式 ${mode}，任务 ${taskKey}）`,
                "ok",
            );
            if (globalScope) editor.syncLocalDirectorForTask?.();
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const syncShotsToDesk = async (shots, data, mode, taskKey, statusMsg) => {
        const defSec = defaultDurationSec(taskKey);
        editor.timeline.editMode = "segment";
        editor.timeline.segments = shots.map((shot, i) => newBatchSegment({
            durationSec: Number(shot.duration) || defSec,
            prompt: shot.prompt || "",
            label: shot.label || `分镜${i + 1}`,
            taskType: editor.timeline.global?.taskType || "",
        }));
        editor.timeline.segments.forEach((seg, i) => {
            seg.prompt = shots[i]?.prompt || "";
            seg.label = shots[i]?.label || `分镜${i + 1}`;
            const sec = Number(shots[i]?.duration);
            if (Number.isFinite(sec) && sec > 0) seg.durationSec = sec;
        });
        if (data.global_prompt) applyGlobalPrompt(data.global_prompt);
        if (editor.isImageBatch?.() || editor.getDirectorMode?.() === "prompt_batch") {
            normalizeImageBatchSegments(editor);
            editor.renderImageBatchGroups?.();
        } else if (editor.isFl2vMode?.()) {
            // fl2v: shots are source of truth — rebuild from expanded prompts
            const prevShots = editor.timeline.shots || [];
            editor.timeline.shots = shots.map((shot, i) => {
                const prev = prevShots[i];
                return newFl2vShot({
                    ...(prev || {}),
                    id: prev?.id,
                    prompt: shot.prompt || "",
                    label: shot.label || `分镜${i + 1}`,
                    durationSec: Number(shot.duration) || defSec,
                    startImage: prev?.startImage || null,
                    endImage: prev?.endImage || null,
                    fl_gen: prev?.fl_gen,
                });
            });
            editor.timeline.timelineMode = "fl2v";
            syncFl2vFromShots(editor);
            updateFl2vDetailUI(editor);
            editor.updateSelectionUI?.();
            editor.scheduleRender?.();
        }
        editor.selectedIndex = 0;
        editor.commit?.(false, { syncTimeline: true });
        editor.flushTimelineSync?.();
        editor.updateDomWidgetHeight?.();
        editor.updateVideoNameLabel?.();
        const shotEl = q('[data-r="ld-shot-count"]');
        if (shotEl) {
            shotEl.value = String(shots.length);
            delete shotEl.dataset.userSet;
        }
        syncLocalDirectorForTask(editor);
        // One button, one job: do not chain bible / image-director rebuild.
        setStatus(
            statusEl,
            `${statusMsg}。需要时再点「故事 → 连续性/声景」或参考图/首尾帧按钮。`,
            "ok",
        );
    };

    const doStorySplit = async () => {
        if ((editor.timeline?.editMode || "global") === "global" || editor.isGlobalMode?.()) {
            setStatus(statusEl, "整局模式为单视频流程，不能拆分镜。请切到「分镜模式」，或用「→ 全局」扩写成片提示词", "err");
            return;
        }
        if (!requireModel()) return;
        syncLocalDirectorForTask(editor);
        const brief = q('[data-r="ld-brief"]')?.value?.trim() || "";
        if (!brief) {
            setStatus(statusEl, "请先填写整片故事 / 创意简述", "err");
            return;
        }
        const taskKey = editor.getTaskKey?.() || "t2v";
        const mode = directorModeFromTaskKey(taskKey);
        const nGroups = Math.max(1, (editor.timeline.segments || []).length || 1);
        const shotEl = q('[data-r="ld-shot-count"]');
        let shotCount = parseInt(shotEl?.value, 10);
        if (!Number.isFinite(shotCount) || shotCount < 1) {
            shotCount = nGroups;
            if (shotEl) shotEl.value = String(shotCount);
        }
        shotCount = Math.max(1, Math.min(16, shotCount));
        setStatus(statusEl, `正在按 ${taskKey}/${mode} 一次写出 ${shotCount} 组分镜（分隔符切割同步）…`);
        try {
            const body = commonBody({
                expand_mode: "story_split",
                brief,
                shot_count: shotCount,
                duration: defaultDurationSec(taskKey),
            });
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/local_expand", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const shots = data.shots || [];
            if (!shots.length) throw new Error("未返回任何分镜");
            await syncShotsToDesk(
                shots,
                data,
                mode,
                taskKey,
                `已生成 ${shots.length} 组（固定镜数，模式 ${mode}，任务 ${taskKey}）`,
            );
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const doStoryAuto = async () => {
        if ((editor.timeline?.editMode || "global") === "global" || editor.isGlobalMode?.()) {
            setStatus(statusEl, "整局模式为单视频流程，不能自动分镜。请切到「分镜模式」，或用「→ 全局」扩写成片提示词", "err");
            return;
        }
        if (!requireModel()) return;
        syncLocalDirectorForTask(editor);
        const brief = q('[data-r="ld-brief"]')?.value?.trim() || "";
        if (!brief) {
            setStatus(statusEl, "请先填写整片故事 / 创意简述", "err");
            return;
        }
        const taskKey = editor.getTaskKey?.() || "t2v";
        const mode = directorModeFromTaskKey(taskKey);
        const shotEl = q('[data-r="ld-shot-count"]');
        const minEl = q('[data-r="ld-shot-min"]');
        const maxEl = q('[data-r="ld-shot-max"]');
        const durMinEl = q('[data-r="ld-dur-min"]');
        const durMaxEl = q('[data-r="ld-dur-max"]');
        let shotMin = parseInt(minEl?.value, 10);
        let shotMax = parseInt(maxEl?.value, 10);
        let durMin = parseFloat(durMinEl?.value);
        let durMax = parseFloat(durMaxEl?.value);
        if (!Number.isFinite(shotMin) || shotMin < 1) shotMin = 2;
        if (!Number.isFinite(shotMax) || shotMax < 1) shotMax = 8;
        if (!Number.isFinite(durMin) || durMin < 1) durMin = 2;
        if (!Number.isFinite(durMax) || durMax < 1) durMax = 12;
        shotMax = Math.max(1, Math.min(16, shotMax));
        shotMin = Math.max(1, Math.min(shotMax, shotMin));
        durMax = Math.max(1, Math.min(30, durMax));
        durMin = Math.max(1, Math.min(durMax, durMin));
        if (minEl) minEl.value = String(shotMin);
        if (maxEl) maxEl.value = String(shotMax);
        if (durMinEl) durMinEl.value = String(durMin);
        if (durMaxEl) durMaxEl.value = String(durMax);
        const midDur = Math.round(((durMin + durMax) / 2) * 10) / 10;
        setStatus(
            statusEl,
            `正在按剧情自动分镜（镜数 ${shotMin}～${shotMax}，单镜 ${durMin}～${durMax}s）…`,
        );
        try {
            const body = commonBody({
                expand_mode: "story_auto",
                brief,
                shot_min: shotMin,
                shot_max: shotMax,
                duration_min: durMin,
                duration_max: durMax,
                duration: midDur,
            });
            // Auto plans need more tokens
            if (body.backend === "cloud" && !body.max_tokens) {
                body.max_tokens = body.thinking === "enabled" ? 16384 : 12288;
            }
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/local_expand", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const shots = data.shots || [];
            if (!shots.length) throw new Error("自动分镜未返回任何 <<<SHOT_n>>> 内容");
            const total = Number(data.total_duration) || shots.reduce((a, s) => a + (Number(s.duration) || 0), 0);
            const durHint = shots.map((s) => `${s.label || "镜"} ${Number(s.duration) || "?"}s`).join(" · ");
            await syncShotsToDesk(
                shots,
                data,
                mode,
                taskKey,
                `已自动同步 ${shots.length} 组（总约 ${total.toFixed(1)}s）：${durHint}`,
            );
            // Keep user's custom max; only refresh fixed-N field to actual count for convenience
            if (shotEl) {
                shotEl.value = String(shots.length);
                delete shotEl.dataset.userSet;
            }
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const doExpand = async (toSegment) => {
        const model = requireModel();
        if (!model) return;
        syncLocalDirectorForTask(editor);
        editor.harvestBatchPrompts?.();
        const taskKey = editor.getTaskKey?.() || "t2v";
        const mode = directorModeFromTaskKey(taskKey);
        const story = q('[data-r="ld-brief"]')?.value?.trim() || "";
        const existingGlobal = harvestLdGlobalPrompt()
            || String(editor.timeline.global?.prompt || "").trim();
        let brief = story;
        let duration = defaultDurationSec(taskKey);
        if (toSegment) {
            const seg = editor.timeline.segments?.[editor.selectedIndex];
            brief = String(seg?.prompt || "").trim() || story;
            if (seg?.durationSec) duration = Number(seg.durationSec) || duration;
        } else {
            // 扩写全局：优先扩写本框内容；否则用故事简述
            brief = existingGlobal || story;
        }
        if (!brief) {
            setStatus(statusEl, "请先在「全局提示词」或「创意简述」中填写内容", "err");
            return;
        }
        setStatus(statusEl, toSegment
            ? `提示词导演扩写当前组…（${taskKey}/${mode}）`
            : `提示词导演扩写全局…（保留场景位置/声景设定）`);
        try {
            const body = commonBody({
                expand_mode: toSegment ? "shot" : "global",
                brief,
                single_shot: !!toSegment,
                expand_global: !toSegment,
                duration,
                story_context: story && brief !== story ? story : "",
                shot_index: toSegment ? editor.selectedIndex : 0,
                shot_total: Math.max(1, (editor.timeline.segments || []).length || 1),
                global_prompt: existingGlobal,
            });
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/local_expand", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const text = data.text || data.prompt || data.global_prompt || "";
            if (toSegment) {
                applyShotsToGroups([{
                    index: editor.selectedIndex || 0,
                    prompt: text,
                    label: editor.timeline.segments?.[editor.selectedIndex]?.label,
                }]);
            } else {
                applyGlobalPrompt(text);
                editor.commit?.(false, { syncTimeline: true });
            }
            setStatus(
                statusEl,
                toSegment ? `已扩写当前组（${mode}）` : `已扩写全局提示词（${mode}）`,
                "ok",
            );
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const applyStudioBibleToUI = (data) => {
        ensureTimelineStudio(editor.timeline);
        if (data?.continuity && typeof data.continuity === "object") {
            editor.timeline.continuity = {
                ...(editor.timeline.continuity || {}),
                ...data.continuity,
                inject: data.continuity.inject !== false,
            };
        }
        if (data?.desk && typeof data.desk === "object") {
            editor.timeline.desk = {
                ...(editor.timeline.desk || {}),
                style: data.desk.style ?? editor.timeline.desk.style,
                soundscape: data.desk.soundscape ?? editor.timeline.desk.soundscape,
                music: data.desk.music ?? editor.timeline.desk.music,
            };
        }
        const setVal = (sel, val) => {
            const el = q(sel);
            if (el && document.activeElement !== el) el.value = val ?? "";
        };
        setVal('[data-r="cont-characters"]', editor.timeline.continuity?.characters || "");
        setVal('[data-r="cont-locations"]', editor.timeline.continuity?.locations || "");
        setVal('[data-r="cont-props"]', editor.timeline.continuity?.props || "");
        const inj = q('[data-r="cont-inject"]');
        if (inj) inj.checked = editor.timeline.continuity?.inject !== false;
        setVal('[data-r="desk-style"]', editor.timeline.desk?.style || "");
        setVal('[data-r="desk-soundscape"]', editor.timeline.desk?.soundscape || "");
        setVal('[data-r="desk-music"]', editor.timeline.desk?.music || "");
    };

    /** Fill continuity + global soundscape from story. Returns message or null on skip. */
    const fillStudioBibleFromStory = async ({ silent = false, overwrite = true } = {}) => {
        if (!requireModel()) return null;
        syncLocalDirectorForTask(editor);
        persistTextDirectorFromUI();
        const brief = q('[data-r="ld-brief"]')?.value?.trim()
            || String(editor.timeline.desk?.text_director?.brief || "").trim()
            || String(editor.timeline.global?.prompt || "").trim();
        if (!brief) {
            if (!silent) setStatus(statusEl, "请先填写整片故事 / 创意简述（或全局提示词）", "err");
            return null;
        }
        if (!silent) setStatus(statusEl, "正在按故事填充连续性与全局声景…");
        const body = commonBody({
            brief,
            timeline: editor.timeline,
            overwrite: !!overwrite,
            max_tokens: (() => {
                const td = ensureTextDirector();
                if (td.backend === "cloud" && td.llm_api_format === "智谱 GLM") {
                    return td.zhipu_thinking ? 4096 : 2048;
                }
                return 2048;
            })(),
        });
        if (!body.model) return null;
        const res = await api.fetchApi("/minimax/director/extract_studio_bible", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await readApiJson(res);
        if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        applyStudioBibleToUI(data);
        editor.commit?.(false, { syncTimeline: true });
        editor.flushTimelineSync?.();
        return data.message || "已填充连续性与全局声景";
    };

    const doFillStudioBible = async () => {
        try {
            const msg = await fillStudioBibleFromStory({ silent: false, overwrite: true });
            if (!msg) return;
            // Jump to continuity tab so user sees the fill
            const tabBtn = desk.querySelector('[data-tab="continuity"]');
            if (tabBtn) tabBtn.click();
            setStatus(statusEl, `${msg}。可到「连续性 / 全局声景」页核对。`, "ok");
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const doExtractAssets = async () => {
        if (!requireModel()) return;
        syncLocalDirectorForTask(editor);
        persistTextDirectorFromUI();
        editor.harvestBatchPrompts?.();
        editor.flushTimelineSync?.();
        const brief = q('[data-r="ld-brief"]')?.value?.trim()
            || String(editor.timeline.desk?.text_director?.brief || "").trim()
            || String(editor.timeline.global?.prompt || "").trim();
        if (!brief) {
            setStatus(statusEl, "请先填写整片故事 / 创意简述（或全局提示词）", "err");
            return;
        }
        setStatus(statusEl, "正在提取人物定妆（大头照+三视图）与场景图提示词…");
        try {
            const body = commonBody({
                brief,
                timeline: editor.timeline,
                enable_gen: true,
                max_tokens: (() => {
                    const td = ensureTextDirector();
                    if (td.backend === "cloud" && td.llm_api_format === "智谱 GLM") {
                        return td.zhipu_thinking ? 8192 : 4096;
                    }
                    return 4096;
                })(),
            });
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/extract_assets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);

            ensureTimelineStudio(editor.timeline);
            // Continuity: only fill empty fields — do not overwrite bible / manual edits
            if (data.continuity && typeof data.continuity === "object") {
                const prev = editor.timeline.continuity || {};
                const next = { ...prev };
                for (const key of ["characters", "locations", "props"]) {
                    const incoming = String(data.continuity[key] || "").trim();
                    if (incoming && !String(prev[key] || "").trim()) {
                        next[key] = incoming;
                    }
                }
                if (data.continuity.inject !== undefined) {
                    next.inject = data.continuity.inject !== false;
                }
                editor.timeline.continuity = next;
            }
            if (data.image_director && typeof data.image_director === "object") {
                const incoming = { ...data.image_director };
                // Keep prompts out of working slots — they go to draft preview
                const draftGlobal = incoming.global_ref_prompt;
                const draftShots = incoming.shot_image_prompts;
                delete incoming.global_ref_prompt;
                delete incoming.shot_image_prompts;
                editor.timeline.image_director = {
                    ...(editor.timeline.image_director || {}),
                    ...incoming,
                };
                fillIdirPromptDraft(editor, {
                    globalPrompt: data.global_ref_prompt ?? draftGlobal ?? "",
                    shotPrompts: data.shot_image_prompts ?? draftShots ?? "",
                    autoApplyIfEmpty: true,
                });
            } else {
                editor.timeline.image_director.enabled = true;
                fillIdirPromptDraft(editor, {
                    globalPrompt: data.global_ref_prompt || "",
                    shotPrompts: data.shot_image_prompts || "",
                    autoApplyIfEmpty: true,
                });
            }
            editor.timeline.image_director.enabled = true;

            setNodeWidget(editor.node, "image_director_enable", true);
            const en = q('[data-r="idir-enable"]');
            if (en) en.checked = true;
            const cEl = q('[data-r="cont-characters"]');
            const lEl = q('[data-r="cont-locations"]');
            const pEl = q('[data-r="cont-props"]');
            if (cEl && document.activeElement !== cEl) {
                cEl.value = editor.timeline.continuity?.characters || "";
            }
            if (lEl && document.activeElement !== lEl) {
                lEl.value = editor.timeline.continuity?.locations || "";
            }
            if (pEl && document.activeElement !== pEl) {
                pEl.value = editor.timeline.continuity?.props || "";
            }

            renderGuideRefs(editor);
            renderGenPlanUI(editor);
            editor.commit?.(false, { syncTimeline: true });
            editor.flushTimelineSync?.();

            // Switch to Image Director tab so user sees imported prompts / cards
            const tabBtn = desk.querySelector('[data-tab="imagedir"]');
            if (tabBtn) tabBtn.click();

            const nC = data.character_count ?? (data.characters || []).length;
            const nS = data.scene_count ?? (data.scenes || []).length;
            const msg = data.message || `已提取 ${nC} 个人物 + ${nS} 个场景并导入参考图导演`;
            setStatus(statusEl, `${msg}。提示词在「预览/调试」草稿中，确认后「应用到生图槽」再点②出图。`, "ok");
            setStatus(idirStatus, `${msg}（已勾选人物/场景生图；请核对草稿）`, "ok");
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    const doExtractFlPrompts = async () => {
        if (!requireModel()) return;
        if (!isEditorFl2v(editor) && !editor.isFl2vMode?.()) {
            setStatus(statusEl, "请先将任务切换为「首尾帧」模式（fl2v）", "err");
            return;
        }
        syncLocalDirectorForTask(editor);
        persistTextDirectorFromUI();
        editor.harvestBatchPrompts?.();
        // Ensure shots exist / sync from segments before LLM
        if (editor.isFl2vMode?.()) {
            const segs = editor.timeline.segments || [];
            const prevShots = editor.timeline.shots || [];
            if (!prevShots.length && segs.length) {
                editor.timeline.shots = segs.map((seg, i) => newFl2vShot({
                    prompt: seg.prompt || "",
                    label: seg.label || `分镜${i + 1}`,
                    durationSec: Number(seg.durationSec) || defaultDurationSec("fl2v"),
                }));
            } else if (prevShots.length && segs.length) {
                prevShots.forEach((shot, i) => {
                    if (!shot || !segs[i]) return;
                    if (!(shot.prompt || "").trim() && (segs[i].prompt || "").trim()) {
                        shot.prompt = segs[i].prompt;
                    }
                    if (!(shot.label || "").trim() && segs[i].label) shot.label = segs[i].label;
                });
            }
            editor.timeline.timelineMode = "fl2v";
            syncFl2vFromShots(editor);
        }
        editor.flushTimelineSync?.();
        const brief = q('[data-r="ld-brief"]')?.value?.trim()
            || String(editor.timeline.desk?.text_director?.brief || "").trim()
            || String(editor.timeline.global?.prompt || "").trim();
        const hasShotText = (editor.timeline.shots || []).some((s) => (s?.prompt || "").trim())
            || (editor.timeline.segments || []).some((s) => (s?.prompt || "").trim());
        if (!brief && !hasShotText) {
            setStatus(statusEl, "请先填写故事或完成分镜扩写，再生成首尾帧提示词", "err");
            return;
        }
        setStatus(statusEl, "正在按内容生成各组首帧/尾帧提示词…");
        try {
            const body = commonBody({
                brief,
                timeline: editor.timeline,
                enable_gen: true,
                max_tokens: (() => {
                    const td = ensureTextDirector();
                    const n = Math.max(1, (editor.timeline.shots || []).length || 1);
                    if (td.backend === "cloud" && td.llm_api_format === "智谱 GLM") {
                        return td.zhipu_thinking ? Math.min(16384, 2048 * n + 2048) : Math.min(12288, 1536 * n + 2048);
                    }
                    return Math.min(8192, 1024 * n + 2048);
                })(),
            });
            if (!body.model) return;
            const res = await api.fetchApi("/minimax/director/extract_fl_prompts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await readApiJson(res);
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);

            ensureTimelineStudio(editor.timeline);
            editor.timeline.timelineMode = "fl2v";
            if (Array.isArray(data.shots) && data.shots.length) {
                editor.timeline.shots = data.shots.map((s, i) => {
                    const prev = editor.timeline.shots?.[i];
                    return newFl2vShot({
                        ...(prev || {}),
                        ...s,
                        id: prev?.id || s.id,
                        startImage: s.startImage || prev?.startImage || null,
                        endImage: s.endImage || prev?.endImage || null,
                        fl_gen: {
                            ...(prev?.fl_gen || {}),
                            ...(s?.fl_gen || {}),
                        },
                    });
                });
            }
            if (data.image_director && typeof data.image_director === "object") {
                const incoming = { ...data.image_director };
                const draftGlobal = incoming.global_ref_prompt;
                const draftShots = incoming.shot_image_prompts;
                delete incoming.global_ref_prompt;
                delete incoming.shot_image_prompts;
                editor.timeline.image_director = {
                    ...(editor.timeline.image_director || {}),
                    ...incoming,
                };
                fillIdirPromptDraft(editor, {
                    globalPrompt: data.global_ref_prompt ?? draftGlobal ?? "",
                    shotPrompts: data.shot_image_prompts ?? draftShots ?? "",
                    autoApplyIfEmpty: true,
                });
            } else {
                fillIdirPromptDraft(editor, {
                    globalPrompt: data.global_ref_prompt || "",
                    shotPrompts: data.shot_image_prompts || "",
                    autoApplyIfEmpty: true,
                });
            }
            editor.timeline.image_director.enabled = true;

            syncFl2vFromShots(editor);
            updateFl2vDetailUI(editor);
            renderFlDirectorUI(editor);

            setNodeWidget(editor.node, "image_director_enable", true);
            const en = q('[data-r="idir-enable"]');
            if (en) en.checked = true;

            const tabBtn = desk.querySelector('[data-tab="imagedir"]');
            if (tabBtn) tabBtn.click();

            editor.commit?.(false, { syncTimeline: true });
            editor.flushTimelineSync?.();
            editor.scheduleRender?.();

            const n = data.shot_count ?? (editor.timeline.shots || []).length;
            const msg = data.message || `已为 ${n} 组生成首/尾帧提示词并同步`;
            setStatus(statusEl, `${msg}。提示词在「预览/调试」草稿中，确认后「应用到生图槽」再点②。`, "ok");
            setStatus(idirStatus, `${msg}（已勾选生成首/尾帧；请核对草稿）`, "ok");
        } catch (err) {
            setStatus(statusEl, String(err?.message || err), "err");
        }
    };

    q('[data-a="ld-expand-groups"]').onclick = () => { void doExpandGroups(); };
    q('[data-a="ld-story-auto"]').onclick = () => { void doStoryAuto(); };
    q('[data-a="ld-story-split"]').onclick = () => { void doStorySplit(); };
    q('[data-a="ld-fill-bible"]').onclick = () => { void doFillStudioBible(); };
    q('[data-a="ld-extract-assets"]').onclick = () => { void doExtractAssets(); };
    q('[data-a="ld-extract-fl"]').onclick = () => { void doExtractFlPrompts(); };
    q('[data-a="ld-expand"]').onclick = () => { void doExpand(false); };
    q('[data-a="ld-expand-seg"]').onclick = () => { void doExpand(true); };
    const shotCountEl = q('[data-r="ld-shot-count"]');
    if (shotCountEl) {
        shotCountEl.addEventListener("input", () => { shotCountEl.dataset.userSet = "1"; });
        shotCountEl.addEventListener("change", () => { shotCountEl.dataset.userSet = "1"; });
    }
    const modeEl = q('[data-r="ld-mode"]');
    if (modeEl) {
        modeEl.addEventListener("change", () => {
            setNodeWidget(editor.node, "local_director_mode", modeEl.value);
        });
    }
    syncLocalDirectorForTask(editor);

    const shotPreview = q('[data-r="shot-preview"]');
    q('[data-a="export-shots"]').onclick = async () => {
        try {
            const res = await api.fetchApi("/minimax/director/shot_list", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ timeline: editor.timeline }),
            });
            const data = await res.json();
            if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            if (shotPreview) shotPreview.value = data.markdown || "";
            setStatus(statusEl, "分镜表已生成", "ok");
        } catch (err) {
            if (shotPreview) shotPreview.value = String(err?.message || err);
        }
    };
    q('[data-a="copy-shots"]').onclick = async () => {
        const text = shotPreview?.value || "";
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setStatus(statusEl, "已复制到剪贴板", "ok");
        } catch {
            setStatus(statusEl, "复制失败", "err");
        }
    };

    // Hook selection UI refresh
    const origUpdate = editor.updateSelectionUI?.bind(editor);
    if (origUpdate && !editor._studioUpdatePatched) {
        editor._studioUpdatePatched = true;
        editor.updateSelectionUI = function (...args) {
            const r = origUpdate(...args);
            syncSegStudioFields(this);
            syncDeskFields(this);
            return r;
        };
    }

    // Hook commit to persist studio fields
    const origCommit = editor.commit?.bind(editor);
    if (origCommit && !editor._studioCommitPatched) {
        editor._studioCommitPatched = true;
        editor.commit = function (...args) {
            ensureTimelineStudio(this.timeline);
            return origCommit(...args);
        };
    }

    editor.updateImageDirectorVisibility = () => updateImageDirectorVisibility(editor);
    editor.syncLocalDirectorForTask = () => syncLocalDirectorForTask(editor);
    syncSegStudioFields(editor);
    syncDeskFields(editor);
    updateImageDirectorVisibility(editor);
    syncLocalDirectorForTask(editor);

    // Production binder: step wizard IA (bible → shots → media → output)
    try {
        applyBinderShell(editor);
    } catch (err) {
        console.warn("[MiniMaxH3Director] binder shell failed:", err);
    }
    requestAnimationFrame(() => editor.updateDomWidgetHeight?.());
}

function syncSegStudioFields(editor) {
    const seg = editor.timeline?.segments?.[editor.selectedIndex];
    if (!seg) return;
    if (editor.segLabelInput) editor.segLabelInput.value = seg.label || "";
    if (editor.segCamera) {
        const cam = seg.camera || CAMERA_PRESETS[1];
        if (CAMERA_PRESETS.includes(cam)) editor.segCamera.value = cam;
        else {
            // keep custom text by selecting custom option visually but show in title
            editor.segCamera.value = CAMERA_PRESETS.includes(cam) ? cam : CAMERA_PRESETS[0];
            if (cam && !CAMERA_PRESETS.includes(cam)) {
                editor.segCamera.title = `当前自定义：${cam}`;
            }
        }
    }
    if (editor.segTransition) editor.segTransition.value = TRANSITIONS.includes(seg.transition) ? seg.transition : "cut";
    if (editor.segRetake) editor.segRetake.checked = !!seg.retake;
    if (editor.segRetakeNote) editor.segRetakeNote.value = seg.retake_note || "";
}

/** Sync local 提示词导演 MODE + shot count from current task / prompt groups. */
export function syncLocalDirectorForTask(editor) {
    const desk = editor?.studioDesk;
    if (!desk) return;
    const taskKey = editor.getTaskKey?.() || "t2v";
    const mode = directorModeFromTaskKey(taskKey);
    const globalScope = (editor.timeline?.editMode || "global") === "global"
        || (typeof editor.isGlobalMode === "function" && editor.isGlobalMode());
    const modeSel = desk.querySelector('[data-r="ld-mode"]');
    // Always follow generation task → director MODE (文生/图生/首尾帧/改视频)
    if (modeSel) {
        modeSel.value = mode;
        setNodeWidget(editor.node, "local_director_mode", mode);
    }
    const nGroups = Math.max(1, (editor.timeline?.segments || []).length || 1);
    const shotEl = desk.querySelector('[data-r="ld-shot-count"]');
    if (shotEl && document.activeElement !== shotEl && !shotEl.dataset.userSet) {
        if (taskUsesPromptGroups(taskKey)) shotEl.value = String(nGroups);
    }

    // 整局：单视频，无分镜 — 隐藏自动分镜 / N 组分镜与镜数区间
    const hideSplit = globalScope;
    const shotCountWrap = desk.querySelector('[data-r="ld-shot-count-wrap"]')
        || desk.querySelector('[data-r="ld-shot-count"]')?.closest?.(".h3d-studio-field");
    shotCountWrap?.classList.toggle("hidden", hideSplit);
    const shotRangeRow = desk.querySelector('[data-r="ld-shot-range-row"]')
        || desk.querySelector('[data-r="ld-shot-min"]')?.closest?.(".h3d-studio-row");
    shotRangeRow?.classList.toggle("hidden", hideSplit);
    for (const sel of [
        '[data-r="ld-shot-split-action"]',
        '[data-a="ld-story-auto"]',
        '[data-a="ld-story-split"]',
    ]) {
        desk.querySelectorAll(sel).forEach((el) => el.classList.toggle("hidden", hideSplit));
    }
    const segOnly = desk.querySelector('[data-r="ld-seg-only-action"]')
        || desk.querySelector('[data-a="ld-expand-seg"]');
    segOnly?.classList.toggle("hidden", hideSplit);
    const expandGroupsBtn = desk.querySelector('[data-a="ld-expand-groups"]');
    if (expandGroupsBtn) {
        // 整局仍可扩写第 1 组成片提示词（非拆分镜）
        expandGroupsBtn.textContent = hideSplit
            ? "扩写成片提示词并同步"
            : "按提示词组扩写并同步";
        expandGroupsBtn.title = hideSplit
            ? "只扩写当前整局成片提示词；不会拆分镜"
            : "只扩写尚未完整的组简述；已是完整提示词的组会跳过，不会重跑分镜/连续性/参考图";
    }

    const hint = desk.querySelector('[data-r="ld-mode-hint"]');
    if (hint) {
        const labels = {
            T2VA: "文生视频/图",
            I2VA: "图生 / 参考主体",
            FL2VA: "首尾帧",
            L2VA: "视频改视频 / 尾帧",
        };
        const key = String(taskKey || "").split(" — ", 1)[0].trim();
        let groupNote;
        if (key === "m2v") {
            groupNote = globalScope
                ? "动作迁移 · 只需动作视频 + 人物图/场景图/音频（可选整局/分镜）"
                : `动作迁移 · 当前 ${nGroups} 分段；各卡只配人物图/场景图/音频`;
        } else if (globalScope) {
            groupNote = "整局模式 · 单视频，不可自动分镜 → 用「→ 全局」扩写成片提示词";
        } else if (taskUsesPromptGroups(taskKey)) {
            groupNote = `当前 ${nGroups} 个提示词组 → 按组扩写`;
        } else {
            groupNote = "当前为时间线模式 → 可写全局或拆成多组";
        }
        hint.textContent = `任务 ${taskKey} → 导演模式 ${mode}（${labels[mode] || mode}）。${groupNote}`;
    }
    const flow = desk.querySelector('[data-r="ld-flow-hint"]');
    if (flow) {
        const key = resolveTaskKey(taskKey);
        if (key === "m2v") {
            flow.textContent = globalScope
                ? "动作迁移：选整局 → 上传动作视频 + 人物图/场景图/音频 → Queue（无需提示词）"
                : "动作迁移：选分镜 → 媒体轨均分/裁切 → 各段上传人物图/场景图/音频 → Queue（无需提示词）";
        } else {
            flow.textContent = globalScope
                ? "整局流程：故事 / 简述 →（可选）连续性/声景 →「→ 全局」扩写成片提示词 →（可选）参考图或首尾帧。无分镜、不分镜组。"
                : "流程：故事分镜 →（可选）连续性/声景 →（可选）参考图或首尾帧；已有各组简述时用「按组扩写」。各按钮只做一步，不会自动连锁其它步骤。";
        }
    }
    updatePromptDirectorVisibility(editor);
}

/** Show/hide「提示词导演」tab；m2v 强制关闭。 */
export function updatePromptDirectorVisibility(editor) {
    const desk = editor?.studioDesk;
    if (!desk) return;
    const taskKey = editor.getTaskKey?.() || "t2v";
    const show = taskUsesPromptDirector(taskKey);
    const tabBtn = desk.querySelector('[data-tab="director"]');
    const page = desk.querySelector('[data-page="director"]');
    tabBtn?.classList.toggle("hidden", !show);
    if (page) {
        page.style.display = show ? "" : "none";
        page.classList.toggle("hidden", !show);
    }
    if (!show) {
        setNodeWidget(editor.node, "local_director_enable", false);
        const td = editor.timeline?.desk?.text_director;
        if (td && typeof td === "object") {
            td.enabled = false;
            td.expand_on_queue = false;
        }
        if (tabBtn?.classList.contains("active") || page?.classList.contains("active")) {
            const fallback = desk.querySelector('[data-tab="continuity"]') || desk.querySelector("[data-tab]");
            if (fallback) fallback.click();
        }
    }
}

/** Show/hide「参考图导演 / 首尾帧导演」tab by task type; disable flags for pure t2v/t2i/m2v. */
export function updateImageDirectorVisibility(editor) {
    const desk = editor?.studioDesk;
    if (!desk) return;
    const taskKey = editor.getTaskKey?.() || "t2v";
    const key = resolveTaskKey(taskKey);
    const show = taskUsesImageDirector(taskKey);
    const showPrompt = taskUsesPromptDirector(taskKey);
    const isFl = isEditorFl2v(editor);
    const isM2v = key === "m2v";
    updatePromptDirectorVisibility(editor);
    const tabBtn = desk.querySelector('[data-tab="imagedir"]');
    const page = desk.querySelector('[data-page="imagedir"]');
    tabBtn?.classList.toggle("hidden", !show);
    if (page) page.style.display = show ? "" : "none";
    if (tabBtn) tabBtn.textContent = isFl ? "首尾帧导演" : "参考图导演";

    const title = desk.querySelector('[data-r="desk-title"]');
    if (title) {
        if (isM2v) {
            title.textContent = "动作迁移 · 动作视频 + 人物图/场景图/音频";
        } else if (show) {
            title.textContent = isFl
                ? "H3 导演工台 · 连续性 / 声景 / 提示词 / 首尾帧"
                : "H3 导演工台 · 连续性 / 声景 / 提示词 / 参考图";
        } else {
            title.textContent = showPrompt
                ? "H3 导演工台 · 连续性 / 声景 / 提示词"
                : "H3 导演工台 · 连续性 / 声景";
        }
    }

    const i2vBlock = desk.querySelector('[data-r="idir-i2v-block"]');
    const flBlock = desk.querySelector('[data-r="idir-fl-block"]');
    i2vBlock?.classList.toggle("hidden", !show || isFl);
    flBlock?.classList.toggle("hidden", !show || !isFl);

    const setTxt = (sel, text) => {
        const el = desk.querySelector(sel);
        if (el) el.textContent = text;
    };
    setTxt('[data-r="idir-enable-label"]', isFl ? "启用首尾帧导演" : "启用参考图导演");
    setTxt('[data-r="idir-inject-label"]', isFl ? "自动注入到各组首/尾帧槽" : "自动注入到时间线");
    setTxt('[data-r="idir-build-label"]', isFl ? "① 生成首尾帧提示词" : "① 生成生图提示词");
    setTxt('[data-r="idir-queue-label"]', isFl ? "② 仅生首尾帧并预览" : "② 仅生参考图并预览");
    setTxt('[data-r="idir-ready-label"]', isFl ? "③ 确认帧 → 准备出片" : "③ 确认图 → 准备出片");
    setTxt('[data-r="idir-global-prompt-label"]', isFl ? "正式 · 导演说明（②生图用）" : "正式 · 全局参考图提示词（②生图用）");
    setTxt('[data-r="idir-shot-prompts-label"]', isFl ? "正式 · 各组首/尾帧提示词汇总（②生图用）" : "正式 · 各组生图提示词（②生图用）");
    setTxt(
        '[data-r="idir-hint"]',
        isFl
            ? "①或提示词导演先写到「预览/调试」草稿 → 应用到生图槽 → ②预览首尾帧 → ③再 Queue。"
            : "①或提示词导演先写到「预览/调试」草稿 → 应用到生图槽 → ②预览参考图 → ③再 Queue。全局参考图槽仅用户底图，生成结果不回写。",
    );

    // Prompt-director import buttons: assets for refs mode, FL for fl2v
    desk.querySelector('[data-a="ld-extract-assets"]')?.classList.toggle("hidden", isFl);
    desk.querySelector('[data-a="ld-extract-fl"]')?.classList.toggle("hidden", !isFl);

    if (show && isFl) renderFlDirectorUI(editor);
    else if (show) {
        renderGenPlanUI(editor);
        renderGuideRefs(editor);
    }

    if (!show) {
        // Leave pure text workflows clean — don't run ref gen on Queue
        if (editor.timeline?.image_director) {
            editor.timeline.image_director.enabled = false;
            editor.timeline.image_director.generate_on_queue = false;
            editor.timeline.image_director.stills_only_done = false;
        }
        setNodeWidget(editor.node, "image_director_enable", false);
        setNodeWidget(editor.node, "ref_gen_enable", false);
        setNodeWidget(editor.node, "ref_gen_only", false);
        const en = desk.querySelector('[data-r="idir-enable"]');
        if (en) en.checked = false;

        // If user was on imagedir tab, switch away
        if (tabBtn?.classList.contains("active") || page?.classList.contains("active")) {
            const fallback = desk.querySelector('[data-tab="continuity"]') || desk.querySelector("[data-tab]");
            if (fallback) fallback.click();
        }
    }
}

function syncDeskFields(editor) {
    ensureTimelineStudio(editor.timeline);
    const desk = editor.studioDesk;
    if (!desk) return;
    const set = (sel, val, isCheck = false) => {
        const el = desk.querySelector(sel);
        if (!el) return;
        if (isCheck) el.checked = !!val;
        else if (document.activeElement !== el) el.value = val ?? "";
    };
    set('[data-r="cont-inject"]', editor.timeline.continuity.inject, true);
    set('[data-r="cont-characters"]', editor.timeline.continuity.characters);
    set('[data-r="cont-locations"]', editor.timeline.continuity.locations);
    set('[data-r="cont-props"]', editor.timeline.continuity.props);
    set('[data-r="desk-style"]', editor.timeline.desk.style);
    set('[data-r="desk-soundscape"]', editor.timeline.desk.soundscape);
    set('[data-r="desk-music"]', editor.timeline.desk.music);
    // Prompt director backend settings
    const td = normalizeTextDirector(editor.timeline.desk?.text_director);
    editor.timeline.desk.text_director = td;
    set('[data-r="ld-backend"]', td.backend === "cloud" ? "cloud" : "local");
    set('[data-r="ld-brief"]', td.brief);
    set('[data-r="ld-global-prompt"]', editor.timeline.global?.prompt || "");
    set('[data-r="ld-zhipu-thinking"]', !!td.zhipu_thinking, true);
    set('[data-r="ld-api-format"]', td.llm_api_format || "Ollama");
    set('[data-r="ld-api-url"]', td.llm_url || "http://127.0.0.1:11434");
    set('[data-r="ld-api-model"]', td.llm_model || "");
    set('[data-r="ld-api-key"]', td.llm_api_key || "");
    const localPanel = desk.querySelector('[data-r="ld-local-panel"]');
    const cloudPanel = desk.querySelector('[data-r="ld-cloud-panel"]');
    localPanel?.classList.toggle("hidden", td.backend !== "local");
    cloudPanel?.classList.toggle("hidden", td.backend !== "cloud");
    const idir = editor.timeline.image_director || {};
    ensureGenPlan(idir, editor.timeline.segments || []);
    set('[data-r="idir-enable"]', idir.enabled, true);
    set('[data-r="idir-auto-inject"]', idir.auto_inject !== false, true);
    set('[data-r="idir-gen-backend"]', (idir.gen_backend === "cloud" || String(idir.gen_backend || "").includes("云端") || String(idir.gen_backend || "").toLowerCase() === "api") ? "cloud" : "local");
    set('[data-r="idir-local-profile"]', LOCAL_MODEL_PROFILES[idir.local_model_profile] ? idir.local_model_profile : "auto");
    set('[data-r="idir-gen-api-format"]', idir.gen_api_format || "智谱 GLM");
    set('[data-r="idir-gen-api-url"]', idir.gen_api_url || "https://open.bigmodel.cn/api/paas/v4");
    set('[data-r="idir-gen-api-model"]', idir.gen_api_model || "cogview-3-flash");
    set('[data-r="idir-gen-api-key"]', idir.gen_api_key || "");
    {
        const raw = String(idir.gen_backend || "local").toLowerCase();
        const backend = (raw === "cloud" || raw === "api" || raw.includes("云端")) ? "cloud" : "local";
        idir.gen_backend = backend;
        if (!LOCAL_MODEL_PROFILES[idir.local_model_profile]) idir.local_model_profile = "auto";
        desk.querySelector('[data-r="idir-cloud-gen-panel"]')?.classList.toggle("hidden", backend !== "cloud");
        desk.querySelectorAll('[data-r="idir-local-gen-only"]').forEach((el) => {
            el.classList.toggle("hidden", backend === "cloud");
        });
        const title = desk.querySelector('[data-r="idir-gen-params-title"]');
        if (title) title.textContent = backend === "cloud" ? "云端生图尺寸" : "文生图参数（本地可切换模型）";
        const ph = desk.querySelector('[data-r="idir-local-profile-hint"]');
        if (ph) ph.textContent = (LOCAL_MODEL_PROFILES[idir.local_model_profile] || LOCAL_MODEL_PROFILES.auto).wire;
    }
    set('[data-r="idir-unified"]', idir.unified_ref_note);
    set('[data-r="idir-suffix"]', idir.style_suffix);
    set('[data-r="idir-global-prompt"]', idir.global_ref_prompt);
    set('[data-r="idir-shot-prompts"]', idir.shot_image_prompts);
    {
        const draft = idir.prompt_draft && typeof idir.prompt_draft === "object"
            ? idir.prompt_draft
            : { global: "", shots: "" };
        idir.prompt_draft = draft;
        set('[data-r="idir-draft-global"]', draft.global || "");
        set('[data-r="idir-draft-shots"]', draft.shots || "");
    }
    set('[data-r="idir-use-video-size"]', !!idir.use_video_size, true);
    set('[data-r="idir-width"]', idir.width ?? 1024);
    set('[data-r="idir-height"]', idir.height ?? 576);
    set('[data-r="idir-steps"]', idir.steps ?? 8);
    set('[data-r="idir-cfg"]', idir.cfg ?? 2);
    set('[data-r="idir-denoise"]', idir.denoise ?? 1);
    set('[data-r="idir-seed"]', idir.seed ?? -1);
    set('[data-r="idir-sampler"]', idir.sampler || "euler_ancestral");
    set('[data-r="idir-scheduler"]', idir.scheduler || "normal");
    set('[data-r="idir-negative"]', idir.negative || REF_NEG_DEFAULT);
    if (editor.runScopeSelect && document.activeElement !== editor.runScopeSelect) {
        editor.runScopeSelect.value = editor.timeline.run_scope || "all";
    }
    renderGuideRefs(editor);
    renderGenPlanUI(editor);
    updateImageDirectorVisibility(editor);
    syncLocalDirectorForTask(editor);
}

function applyRunScope(editor, scope) {
    ensureTimelineStudio(editor.timeline);
    editor.timeline.run_scope = scope;
    const segs = editor.timeline.segments || [];
    if (scope === "all") {
        editor.timeline.runSelectEnabled = false;
        editor.timeline.runSelection = [];
    } else if (scope === "retake") {
        const sel = segs.map((s, i) => (s?.retake ? i : -1)).filter((i) => i >= 0);
        editor.timeline.runSelectEnabled = sel.length > 0;
        editor.timeline.runSelection = sel.length ? sel : [];
        if (!sel.length) {
            // fall back: enable select mode empty → user sees warning
            editor.timeline.runSelectEnabled = true;
            editor.timeline.runSelection = [];
        }
    } else {
        // selected — use existing checkboxes / runSelection; if empty select all with run_selected
        const sel = segs.map((s, i) => (s?.run_selected !== false ? i : -1)).filter((i) => i >= 0);
        editor.timeline.runSelectEnabled = true;
        editor.timeline.runSelection = sel.length ? sel : segs.map((_, i) => i);
    }
    editor.updateRunSelectUI?.();
    editor.commit?.(false, { syncTimeline: true });
}

async function loadLocalModels(modelSel, statusEl) {
    if (!modelSel) return;
    try {
        const res = await api.fetchApi("/minimax/director/local_models");
        const data = await res.json();
        const models = data?.models || [];
        modelSel.innerHTML = "";
        if (!data?.available) {
            modelSel.innerHTML = `<option value="">（未安装 LLM Text Processor）</option>`;
            setStatus(statusEl, "本地导演需要 ComfyUI-LLM-text-processor + models/LLM 下的 GGUF（可改用云端 API）", "err");
            return;
        }
        for (const m of models) {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            modelSel.appendChild(opt);
        }
        if (!models.length) {
            modelSel.innerHTML = `<option value="">（无 GGUF 模型）</option>`;
        }
    } catch (err) {
        modelSel.innerHTML = `<option value="">（加载失败）</option>`;
        setStatus(statusEl, String(err?.message || err), "err");
    }
}

/** Call after parseTimeline to keep studio fields. */
export function normalizeParsedTimeline(data) {
    return ensureTimelineStudio(data);
}
