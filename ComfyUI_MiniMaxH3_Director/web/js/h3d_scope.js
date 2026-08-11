/**
 * Workflow scope: 整局 (single video) ↔ 分镜 (multi-shot / multi-group).
 * Feature parity; only the content unit changes.
 */

function _q(root, sel) {
    try {
        return root?.querySelector?.(sel) || null;
    } catch {
        return null;
    }
}

export function isWorkflowGlobal(editor) {
    return (editor?.timeline?.editMode || "global") === "global";
}

/** Ensure chrome-level 整局/分镜 switch exists and is wired. */
export function ensureScopeSwitch(editor) {
    const root = editor?.root;
    if (!root) return null;
    let sw = _q(root, '[data-r="h3d-scope-switch"]');
    if (!sw) {
        sw = document.createElement("div");
        sw.className = "h3d-scope-switch";
        sw.dataset.r = "h3d-scope-switch";
        sw.innerHTML = `
          <button type="button" class="h3d-scope-btn" data-a="scope-global" title="单视频流程：一套提示词 / 参考走完全程">整局模式</button>
          <button type="button" class="h3d-scope-btn" data-a="scope-segment" title="分镜 / 多组流程：按镜或素材组推进">分镜模式</button>`;
        const chrome = _q(root, ".h3d-chrome");
        if (chrome) {
            const chips = chrome.querySelector(".h3d-chrome-chips");
            if (chips) chrome.insertBefore(sw, chips);
            else chrome.appendChild(sw);
        } else {
            root.insertBefore(sw, root.firstChild);
        }
    }
    if (!sw.dataset.wired) {
        sw.dataset.wired = "1";
        sw.querySelector('[data-a="scope-global"]')?.addEventListener("click", (e) => {
            e.stopPropagation();
            editor.setEditMode?.("global");
        });
        sw.querySelector('[data-a="scope-segment"]')?.addEventListener("click", (e) => {
            e.stopPropagation();
            editor.setEditMode?.("segment");
        });
    }
    return sw;
}

function updateScopeCopy(root, global) {
    const shotsBtn = _q(root, '[data-step="shots"]');
    if (shotsBtn) {
        const span = shotsBtn.querySelector("span");
        const em = shotsBtn.querySelector("em");
        if (span) span.textContent = global ? "整局内容" : "分镜清单";
        if (em) em.textContent = global ? "单视频 · 提示词 · 参考" : "组 / 镜 / 提示词";
    }
    const head = _q(root, '[data-r="h3d-panel-shots"] .h3d-binder-head');
    if (head) {
        const b = head.querySelector("b");
        const s = head.querySelector("span");
        if (b) b.textContent = global ? "02 · 整局内容" : "02 · 分镜清单";
        if (s) {
            s.textContent = global
                ? "单视频生成：功能与分镜一致，但只走一条成片"
                : "按组 / 按镜推进，多段生成";
        }
    }
    const brand = _q(root, ".h3d-chrome-brand span");
    if (brand && root.classList.contains("h3d-binder")) {
        brand.textContent = global
            ? "整局模式 · 单视频流程"
            : "分镜模式 · 多组 / 多镜流程";
    }
}

/**
 * Apply scope to binder labels, multi-group chrome, and refresh content UIs.
 */
export function applyWorkflowScope(editor) {
    const root = editor?.root;
    if (!root) return;
    ensureScopeSwitch(editor);
    const global = isWorkflowGlobal(editor);
    root.dataset.h3dScope = global ? "global" : "segment";
    root.classList.toggle("h3d-scope-global", global);
    root.classList.toggle("h3d-scope-segment", !global);

    for (const sel of ['[data-a="scope-global"]', '[data-a="mode-global"]']) {
        root.querySelectorAll(sel).forEach((el) => el.classList.toggle("active", global));
        root.querySelectorAll(sel).forEach((el) => {
            if (el.tagName === "BUTTON" && sel.includes("mode-global")) {
                el.textContent = "整局模式";
            }
        });
    }
    for (const sel of ['[data-a="scope-segment"]', '[data-a="mode-segment"]']) {
        root.querySelectorAll(sel).forEach((el) => el.classList.toggle("active", !global));
        root.querySelectorAll(sel).forEach((el) => {
            if (el.tagName === "BUTTON" && sel.includes("mode-segment")) {
                el.textContent = "分镜模式";
            }
        });
    }

    updateScopeCopy(root, global);

    if (editor.chromeChipMode) {
        editor.chromeChipMode.textContent = global ? "整局模式" : "分镜模式";
        editor.chromeChipMode.classList.toggle("on", true);
    }

    // Prefer primary unit when entering 整局
    if (global && (!Number.isFinite(editor.selectedIndex) || editor.selectedIndex < 0)) {
        editor.selectedIndex = 0;
    }

    // Multi-group controls live inside lists; hide in 整局
    const multi = !global;
    const fl2vActions = editor.fl2vUi?.actions;
    if (fl2vActions && editor.isFl2vMode?.()) {
        fl2vActions.classList.toggle("hidden", !multi);
    }
    const batchAdd = editor.batchPanel?.querySelector?.('[data-a="batch-add"]');
    const batchDel = editor.batchPanel?.querySelector?.('[data-a="batch-del-selected"]');
    if (editor.isImageBatch?.()) {
        if (batchAdd) {
            // m2v 用媒体轨均分建组，整局/分镜都隐藏「添加素材组」
            batchAdd.classList.toggle("hidden", global || !!editor.isM2vBatch?.());
        }
        if (batchDel) {
            batchDel.classList.toggle(
                "hidden",
                global || !editor.isR2vBatch?.() || !!editor.isM2vBatch?.(),
            );
        }
    }
    // 提示词导演：整局无分镜，隐藏自动分镜控件
    try {
        editor.syncLocalDirectorForTask?.();
    } catch {
        /* ignore */
    }
    try {
        editor.updateVideoNameLabel?.();
    } catch {
        /* ignore */
    }
    // Do not call updateModeUI here — it may re-enter scope apply.
}
