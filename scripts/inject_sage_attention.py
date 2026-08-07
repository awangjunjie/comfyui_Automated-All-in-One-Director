# -*- coding: utf-8 -*-
"""Inject PathchSageAttentionKJ (KJNodes) into model acceleration chain.

Preferred chain:
  UNETLoader -> PathchSageAttentionKJ -> TE-Speed -> EasyCache -> MiniMaxH3Director
"""

from __future__ import annotations

import json
from pathlib import Path

NODE_TYPE = "PathchSageAttentionKJ"
# sage_attention mode + allow_compile
WIDGETS = ["auto", False]


def _inject(wf: dict) -> bool:
    nodes = wf.get("nodes") or []
    links = wf.get("links") or []
    if not isinstance(nodes, list) or not isinstance(links, list):
        return False

    if any(isinstance(n, dict) and n.get("type") == NODE_TYPE for n in nodes):
        return False

    # Prefer insert after UNETLoader output that feeds the accel chain / director
    unet = next((n for n in nodes if isinstance(n, dict) and n.get("type") == "UNETLoader"), None)
    if not unet:
        return False

    # Find MODEL link leaving UNET (first output slot 0)
    out_links = None
    for out in unet.get("outputs") or []:
        if isinstance(out, dict) and out.get("type") == "MODEL" and out.get("links"):
            out_links = out.get("links")
            break
    if not out_links:
        return False
    old_link_id = int(out_links[0])

    link_row = None
    link_idx = None
    for i, row in enumerate(links):
        if isinstance(row, (list, tuple)) and len(row) >= 6 and int(row[0]) == old_link_id:
            link_row = list(row)
            link_idx = i
            break
    if link_row is None:
        return False

    # Must originate from this UNET
    if int(link_row[1]) != int(unet["id"]):
        return False

    dst_id = int(link_row[3])
    dst_slot = int(link_row[4])

    used_ids = {int(n["id"]) for n in nodes if isinstance(n, dict) and n.get("id") is not None}
    sage_id = max(used_ids | {0}) + 1
    used_links = {int(r[0]) for r in links if isinstance(r, (list, tuple)) and r}
    new_link_id = max(used_links | {0}) + 1

    unet_pos = unet.get("pos") or [0, 0]
    sage_pos = [float(unet_pos[0]) + 380.0, float(unet_pos[1])]

    sage_node = {
        "id": sage_id,
        "type": NODE_TYPE,
        "pos": sage_pos,
        "size": [320, 110],
        "flags": {},
        "order": int(unet.get("order", 0)) + 1,
        "mode": 0,
        "inputs": [
            {
                "localized_name": "model",
                "name": "model",
                "type": "MODEL",
                "link": new_link_id,
            },
            {
                "localized_name": "sage_attention",
                "name": "sage_attention",
                "type": "COMBO",
                "widget": {"name": "sage_attention"},
                "link": None,
            },
            {
                "localized_name": "allow_compile",
                "name": "allow_compile",
                "shape": 7,
                "type": "BOOLEAN",
                "widget": {"name": "allow_compile"},
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
        "title": "SageAttention 加速",
        "properties": {"Node name for S&R": NODE_TYPE},
        "widgets_values": list(WIDGETS),
    }

    # UNET now feeds sage via new_link; old link becomes sage -> previous destination
    for out in unet.get("outputs") or []:
        if not isinstance(out, dict):
            continue
        ols = out.get("links")
        if isinstance(ols, list) and old_link_id in ols:
            out["links"] = [new_link_id if x == old_link_id else x for x in ols]

    links[link_idx] = [
        old_link_id,
        sage_id,
        0,
        dst_id,
        dst_slot,
        "MODEL",
    ]
    links.append([new_link_id, int(unet["id"]), int(link_row[2]), sage_id, 0, "MODEL"])

    nodes.append(sage_node)
    wf["nodes"] = nodes
    wf["links"] = links
    wf["last_node_id"] = max(int(wf.get("last_node_id") or 0), sage_id)
    wf["last_link_id"] = max(int(wf.get("last_link_id") or 0), new_link_id, old_link_id)
    return True


def main() -> None:
    roots = [
        Path(__file__).resolve().parents[1] / "example_workflows",
        Path(r"E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\user\default\workflows"),
    ]
    changed, skipped = [], []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            types = {n.get("type") for n in (data.get("nodes") or []) if isinstance(n, dict)}
            if "MiniMaxH3Director" not in types:
                continue
            if _inject(data):
                path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                changed.append(f"{root.name}/{path.name}")
            else:
                skipped.append(f"{root.name}/{path.name}")
    print("updated:", len(changed))
    for x in changed:
        print(" ", x)
    print("skipped:", len(skipped))


if __name__ == "__main__":
    main()
