# MiniMax H3 Director — 示例工作流

拖入 ComfyUI 画布即可使用。需已安装本插件，且 ComfyUI 主干含 MiniMax H3（v0.30.0+）。

| 文件 | 任务 | UNET | 说明 |
|------|------|------|------|
| `minimax_h3_director_t2v.json` | t2v | fl2va | 文生音视频，可直接 Queue |
| `minimax_h3_director_fl2v.json` | fl2v | fl2va | 首尾帧；「添加一组」后上传首帧（必传）与尾帧（可选） |
| `minimax_h3_director_r2v.json` | r2v | **ref2va** | 参考改视频；素材组：图片1–9 / 音频1–3 / 视频1–3 |
| `minimax_h3_director_v2v.json` | v2v | **ref2va** | 源视频编辑；导演台上传视频并分段（同 Bernini v2v） |
| `minimax_h3_director_rv2v.json` | rv2v | **ref2va** | 参考改视频；源视频 + 图片1–9 |

## 模型路径（与官方模板一致）

| 用途 | 文件名 | 目录 |
|------|--------|------|
| UNET (t2v/i2v/fl2v) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| UNET (r2v / v2v / rv2v) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

CLIP Loader 的 **type 必须选 `minimax`**。

## 默认采样参数

- 画布默认 **0.4MP 16:9（864×480）**，**5 秒 / 124** 帧 @ **24 fps**（17k+5 网格）
- **25** steps，`res_multistep` + `simple`，CFG **1.0**
- Sigma shift：video **12** / audio **3**

## 输出

导演台 → `CreateVideo` → `SaveVideo`（前缀 `video/MiniMaxH3_Director_*`），报告接 `PreviewAny`。
