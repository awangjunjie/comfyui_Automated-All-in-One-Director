# ComfyUI MiniMax H3 Director

Multi-segment AV timeline director for **official ComfyUI MiniMax-H3**.  
Repository: [AIMixer/ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)

**Current author: 若扶清 (Ruo Fuqing)** · QQ `3193470083` — continued from the original work by [AIMixer](https://github.com/AIMixer).

**中文文档** → [README.md](README.md)

![MiniMaxH3Director workflow screenshot](docs/screenshot.png)

## Features

**MiniMaxH3Director** is a single-node director for long-form, multi-segment MiniMax H3 audio–video generation — timeline planning, conditioning, sampling, AV decode, and export in one place. It wraps the official `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` + `MiniMaxH3SigmaShift` + `KSampler` pipeline with native stereo audio.

### Core capabilities

| Feature | Description |
|---------|-------------|
| **Multi-segment timeline** | Upload video in-node; split, equal-split, smart shot-split (PySceneDetect), append; selectable/deletable split points; visual timeline with thumbs |
| **Task modes** | `t2v`, `i2v`, `fl2v` (first/last frame), `r2v` (reference material groups), `v2v` (video-to-video), `rv2v` (reference-guided source edit) |
| **First/last frame (fl2v)** | Dedicated shot groups: add group → start frame required, end frame optional; drag edges for duration; run-select per group |
| **Reference groups (r2v)** | fl2v-style groups: up to 9 images / 3 audios / 3 videos per group; prompt tags `<Picture N>` / `<Video K>` / `<Audio J>` (or `@` picker); timeline preview synced with card selection |
| **Source-video edit (v2v / rv2v)** | Bernini-style source timeline; each segment bound as `<Video 1>`; `rv2v` adds optional refs (images 1–9, audios 1–3) |
| **Run select** | Sample only checked segments/groups; unselected may use cache or source passthrough when exporting all |
| **Native stereo audio** | Generated with the picture; `v2v`/`rv2v` can generate / keep source / mute |
| **Run report** | `report` output with plan and per-segment summary |

### Inputs / outputs

**Inputs:** `model` → `video_vae` → `audio_vae` → `clip`

**Outputs:** `images` → `audio` → `fps` → `frame_count` → `source_images` → `report`

> CLIP Loader **type must be `minimax`** (Qwen3-VL).  
> Use **fl2va** UNET for `t2v` / `i2v` / `fl2v`; **ref2va** for `r2v` / `v2v` / `rv2v`.

## Requirements

**ComfyUI ≥ v0.30.0** with official MiniMax H3 nodes ([PR #15224](https://github.com/comfyanonymous/ComfyUI/pull/15224), [PR #15228](https://github.com/comfyanonymous/ComfyUI/pull/15228)).

Optional: `scenedetect`, `opencv-python-headless`, `imageio-ffmpeg` — see `requirements.txt`.

## Installation

### Method 1: Manual (standard)

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git

pip install -r ComfyUI_MiniMaxH3_Director/requirements.txt
```

Restart ComfyUI.

### Method 2: ComfyUI Manager

1. Open **ComfyUI Manager**
2. Choose **Install via Git URL**
3. Enter `https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git` and install
4. Restart ComfyUI

## Models & workflow downloads

Full pack (**MiniMax H3 weights** + **example JSON workflows**):

**[Comfyit · article 506 — MiniMax H3 models & workflows](https://comfyit.cn/article/506)**

Merge `models/` into `ComfyUI/models/`, then drag a JSON workflow into ComfyUI.

Also available:

- **Hugging Face:** [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)
- **ComfyUI docs:** [MiniMax H3 workflows](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)

This repo ships examples under `example_workflows/`:

| Workflow | task_type | UNET | Notes |
|----------|-----------|------|--------|
| `minimax_h3_director_t2v.json` | t2v | fl2va | Text to AV |
| `minimax_h3_director_fl2v.json` | fl2v | fl2va | First/last frame groups |
| `minimax_h3_director_r2v.json` | r2v | **ref2va** | Reference material groups |
| `minimax_h3_director_v2v.json` | v2v | **ref2va** | Source-video timeline edit |
| `minimax_h3_director_rv2v.json` | rv2v | **ref2va** | Source + reference images/audio |

### Recommended model files

| Role | Filename | Directory |
|------|----------|-----------|
| UNET (t2v / i2v / fl2v) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| UNET (r2v / v2v / rv2v) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

## Quick start

1. Ensure ComfyUI ≥ **0.30.0** with MiniMax H3 nodes
2. Load an example from [article 506](https://comfyit.cn/article/506) or `example_workflows/`
3. Connect UNET / CLIP / video_vae / audio_vae, edit the timeline UI, Queue

### Default sampling

- Canvas default **0.4MP 16:9 (864×480)**, **5s / 124** frames @ **24 fps** (17k+5 grid)
- **25** steps, `res_multistep` + `simple`, CFG **1.0**
- Sigma shift: video **12** / audio **3**

## Ecosystem · [Comfyit](https://comfyit.cn/)

| Resource | Link |
|----------|------|
| Models & workflows pack | [comfyit.cn/article/506](https://comfyit.cn/article/506) |
| Official MiniMax H3 docs | [docs.comfy.org · MiniMax H3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) |
| Product center | [comfyit.cn/products](https://comfyit.cn/products) |
| Plugins | [comfyit.cn/plugins](https://comfyit.cn/plugins) |
| Models | [comfyit.cn/resources/models](https://comfyit.cn/resources/models) |
| Workflows | [comfyit.cn/workflows](https://comfyit.cn/workflows) |

## Contact

| | |
|---|---|
| **Current author / maintainer** | **若扶清 (Ruo Fuqing)** |
| **Author QQ** | **3193470083** |
| **Repository** | [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) |

This project builds on and continues the MiniMax H3 Director work originally published by [AIMixer](https://github.com/AIMixer). Thanks to the original author for the open-source foundation.  
Original author: QQ `3697688140` · groups `551482703` / `425064221` / `559826331` · [Bilibili](https://space.bilibili.com/1997403556) · sibling plugin [ComfyUI_Bernini_Director](https://github.com/AIMixer/ComfyUI_Bernini_Director)

## Credits

- **AIMixer** — original author and primary reference implementation
- [Comfy-Org / ComfyUI](https://github.com/Comfy-Org/ComfyUI) — official MiniMax H3 support
- [MiniMax-AI](https://github.com/MiniMax-AI) — MiniMax H3 model
- [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) — weights & docs

## License

Apache-2.0
