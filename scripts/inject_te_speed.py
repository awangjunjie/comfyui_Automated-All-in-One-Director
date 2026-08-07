# -*- coding: utf-8 -*-
"""Inject TESpeedMiniMaxH3 between UNETLoader and MiniMaxH3Director in workflows."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "example_workflows"

TE_NODE_TYPE = "TESpeedMiniMaxH3"
TE_WIDGETS = [0.12, 0.1, 0.9, 2, "auto"]


def _inject(wf: dict) -> bool:
    nodes = wf.get("nodes") or []
    links = wf.get("links") or []
    if not isinstance(nodes, list) or not isinstance(links, list):
        return False

    # Already injected?
    if any(isinstance(n, dict) and n.get("type") == TE_NODE_TYPE for n in nodes):
        return False

    director = next((n for n in nodes if isinstance(n, dict) and n.get("type") == "MiniMaxH3Director"), None)
    if not director:
        return False

    model_in = next(
        (inp for inp in (director.get("inputs") or []) if isinstance(inp, dict) and inp.get("name") == "model"),
        None,
    )
    if not model_in or model_in.get("link") is None:
        return False
    old_link_id = int(model_in["link"])

    # Find the MODEL link into director
    link_row = None
    link_idx = None
    for i, row in enumerate(links):
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        if int(row[0]) == old_link_id and int(row[3]) == int(director["id"]) and int(row[4]) == 0:
            link_row = row
            link_idx = i
            break
    if link_row is None:
        # fallback: match by link id only
        for i, row in enumerate(links):
            if isinstance(row, (list, tuple)) and len(row) >= 6 and int(row[0]) == old_link_id:
                link_row = row
                link_idx = i
                break
    if link_row is None:
        return False

    src_id = int(link_row[1])
    src_slot = int(link_row[2])
    src_node = next((n for n in nodes if isinstance(n, dict) and int(n.get("id", -1)) == src_id), None)
    if not src_node:
        return False

    # New ids
    used_ids = {int(n["id"]) for n in nodes if isinstance(n, dict) and n.get("id") is not None}
    te_id = max(used_ids | {0}) + 1
    used_links = {int(r[0]) for r in links if isinstance(r, (list, tuple)) and r}
    new_link_id = max(used_links | {0}) + 1

    # Position: between source and director
    src_pos = src_node.get("pos") or [0, 0]
    dir_pos = director.get("pos") or [400, 80]
    te_pos = [
        (float(src_pos[0]) + float(dir_pos[0])) / 2.0,
        float(src_pos[1]),
    ]

    te_node = {
        "id": te_id,
        "type": TE_NODE_TYPE,
        "pos": te_pos,
        "size": [320, 170],
        "flags": {},
        "order": int(src_node.get("order", 0)) + 1,
        "mode": 0,
        "inputs": [
            {
                "localized_name": "model",
                "name": "model",
                "type": "MODEL",
                "link": new_link_id,
            },
            {
                "localized_name": "processing_control_value",
                "name": "processing_control_value",
                "type": "FLOAT",
                "widget": {"name": "processing_control_value"},
                "link": None,
            },
            {
                "localized_name": "processing_percent_1",
                "name": "processing_percent_1",
                "type": "FLOAT",
                "widget": {"name": "processing_percent_1"},
                "link": None,
            },
            {
                "localized_name": "processing_percent_2",
                "name": "processing_percent_2",
                "type": "FLOAT",
                "widget": {"name": "processing_percent_2"},
                "link": None,
            },
            {
                "localized_name": "mcs",
                "name": "mcs",
                "type": "INT",
                "widget": {"name": "mcs"},
                "link": None,
            },
            {
                "localized_name": "device",
                "name": "device",
                "type": "COMBO",
                "widget": {"name": "device"},
                "link": None,
            },
        ],
        "outputs": [
            {
                "localized_name": "MODEL",
                "name": "MODEL",
                "type": "MODEL",
                "links": [old_link_id],
            }
        ],
        "title": "TE-Speed MiniMaxH3 加速",
        "properties": {"Node name for S&R": TE_NODE_TYPE},
        "widgets_values": list(TE_WIDGETS),
    }

    # Rewire: src -> TE (new_link), TE -> director (old_link)
    # Update source node output links: replace old_link_id with new_link_id
    for out in src_node.get("outputs") or []:
        if not isinstance(out, dict):
            continue
        ols = out.get("links")
        if isinstance(ols, list) and old_link_id in ols:
            out["links"] = [new_link_id if x == old_link_id else x for x in ols]

    # Update old link row to come from TE
    links[link_idx] = [
        old_link_id,
        te_id,
        0,
        int(director["id"]),
        int(link_row[4]),
        "MODEL",
    ]
    links.append([new_link_id, src_id, src_slot, te_id, 0, "MODEL"])

    nodes.append(te_node)
    wf["nodes"] = nodes
    wf["links"] = links
    wf["last_node_id"] = max(int(wf.get("last_node_id") or 0), te_id)
    wf["last_link_id"] = max(int(wf.get("last_link_id") or 0), new_link_id, old_link_id)

    # Expand model group if present
    for g in wf.get("groups") or []:
        if not isinstance(g, dict):
            continue
        title = str(g.get("title") or "")
        if "模型" in title or "Model" in title.lower():
            box = g.get("bounding")
            if isinstance(box, list) and len(box) >= 4:
                # widen group to cover TE node
                g["bounding"] = [
                    box[0],
                    box[1],
                    max(float(box[2]), float(te_pos[0]) - float(box[0]) + 360),
                    max(float(box[3]), 560),
                ]
    return True


def main() -> None:
    changed = []
    skipped = []
    for path in sorted(ROOT.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if _inject(data):
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            changed.append(path.name)
        else:
            skipped.append(path.name)
    print("updated:", changed)
    print("skipped:", skipped)


if __name__ == "__main__":
    main()
