# -*- coding: utf-8 -*-
"""Inject EasyCache between TE-Speed (or UNET) and MiniMaxH3Director."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "example_workflows"

NODE_TYPE = "EasyCache"
# defaults from comfy_extras/nodes_easycache.py
WIDGETS = [0.2, 0.15, 0.95, False]


def _inject(wf: dict) -> bool:
    nodes = wf.get("nodes") or []
    links = wf.get("links") or []
    if not isinstance(nodes, list) or not isinstance(links, list):
        return False

    if any(isinstance(n, dict) and n.get("type") == NODE_TYPE for n in nodes):
        return False

    director = next(
        (n for n in nodes if isinstance(n, dict) and n.get("type") == "MiniMaxH3Director"),
        None,
    )
    if not director:
        return False

    model_in = next(
        (
            inp
            for inp in (director.get("inputs") or [])
            if isinstance(inp, dict) and inp.get("name") == "model"
        ),
        None,
    )
    if not model_in or model_in.get("link") is None:
        return False
    old_link_id = int(model_in["link"])

    link_row = None
    link_idx = None
    for i, row in enumerate(links):
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        if int(row[0]) == old_link_id and int(row[3]) == int(director["id"]):
            link_row = list(row)
            link_idx = i
            break
    if link_row is None:
        return False

    src_id = int(link_row[1])
    src_slot = int(link_row[2])
    src_node = next(
        (n for n in nodes if isinstance(n, dict) and int(n.get("id", -1)) == src_id),
        None,
    )
    if not src_node:
        return False

    used_ids = {int(n["id"]) for n in nodes if isinstance(n, dict) and n.get("id") is not None}
    ec_id = max(used_ids | {0}) + 1
    used_links = {int(r[0]) for r in links if isinstance(r, (list, tuple)) and r}
    new_link_id = max(used_links | {0}) + 1

    src_pos = src_node.get("pos") or [0, 0]
    dir_pos = director.get("pos") or [400, 80]
    ec_pos = [
        (float(src_pos[0]) + float(dir_pos[0])) / 2.0 + 40.0,
        float(src_pos[1]) + 200.0,
    ]

    ec_node = {
        "id": ec_id,
        "type": NODE_TYPE,
        "pos": ec_pos,
        "size": [300, 150],
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
                "localized_name": "reuse_threshold",
                "name": "reuse_threshold",
                "type": "FLOAT",
                "widget": {"name": "reuse_threshold"},
                "link": None,
            },
            {
                "localized_name": "start_percent",
                "name": "start_percent",
                "type": "FLOAT",
                "widget": {"name": "start_percent"},
                "link": None,
            },
            {
                "localized_name": "end_percent",
                "name": "end_percent",
                "type": "FLOAT",
                "widget": {"name": "end_percent"},
                "link": None,
            },
            {
                "localized_name": "verbose",
                "name": "verbose",
                "type": "BOOLEAN",
                "widget": {"name": "verbose"},
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
        "title": "EasyCache 加速",
        "properties": {"Node name for S&R": NODE_TYPE},
        "widgets_values": list(WIDGETS),
    }

    for out in src_node.get("outputs") or []:
        if not isinstance(out, dict):
            continue
        ols = out.get("links")
        if isinstance(ols, list) and old_link_id in ols:
            out["links"] = [new_link_id if x == old_link_id else x for x in ols]

    links[link_idx] = [
        old_link_id,
        ec_id,
        0,
        int(director["id"]),
        int(link_row[4]),
        "MODEL",
    ]
    links.append([new_link_id, src_id, src_slot, ec_id, 0, "MODEL"])

    nodes.append(ec_node)
    wf["nodes"] = nodes
    wf["links"] = links
    wf["last_node_id"] = max(int(wf.get("last_node_id") or 0), ec_id)
    wf["last_link_id"] = max(int(wf.get("last_link_id") or 0), new_link_id, old_link_id)
    return True


def main() -> None:
    changed, skipped = [], []
    for path in sorted(ROOT.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if _inject(data):
            path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            changed.append(path.name)
        else:
            skipped.append(path.name)
    print("updated:", changed)
    print("skipped:", skipped)


if __name__ == "__main__":
    main()
