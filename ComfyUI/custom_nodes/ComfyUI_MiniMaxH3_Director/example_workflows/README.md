# MiniMax H3 Director — 示例工作流

请在 ComfyUI 中拖入使用。需已安装支持官方 MiniMax H3 的 ComfyUI（v0.30.0+）。

| 文件 | 说明 |
|------|------|
| `完整版_MiniMaxH3导演台.json` | 唯一推荐工作流：导演台 + 文生图（DreamShaperXL）+ 导出。任务模式（t2v / fl2v / r2v / v2v 等）在节点内切换。 |

## 模型路径（与官方模板一致）

| 用途 | 文件名 | 目录 |
|------|--------|------|
| UNET (t2v/i2v/fl2v) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| UNET (r2v / v2v / rv2v) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

CLIP Loader 的 **type 必须选 `minimax`**。

## 默认参数摘要

- 画布默认 **0.4MP 16:9（864×480）**，**5 秒 / 124** 帧 @ **24 fps**（17k+5 网格）
- **25** steps，`res_multistep` + `simple`，CFG **1.0**
- Sigma shift：video **12** / audio **3**

## 下游

导演台 → `CreateVideo` → `SaveVideo`（前缀 `video/MiniMaxH3_Director_*`）；报告可用 `PreviewAny`。
