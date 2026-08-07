# ComfyUI MiniMax H3 Director

基于 **ComfyUI 官方 MiniMax-H3** 的多段音视频导演台插件。仓库地址：[AIMixer/ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)

**English** → [README_EN.md](README_EN.md)

![MiniMaxH3Director 工作流截图](docs/screenshot.png)

## 功能介绍

**MiniMaxH3Director** 是面向长视频、多段生成的 MiniMax H3 导演台节点，把分段计划、条件编码、采样解码和导出整合在一个节点里。底层走官方 `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` + `MiniMaxH3SigmaShift` + `KSampler` + AV 分离解码链路，原生输出立体声音频。

### 核心能力

| 功能 | 说明 |
|------|------|
| **多段时间轴** | 节点内上传视频，支持切分、均分、智能分镜分割（PySceneDetect）、追加；分割点可选中删除；可视化时间轴预览每段范围与缩略图 |
| **多任务模式** | `task_type`：`t2v`（文生视频）、`i2v`（图生视频）、`fl2v`（首尾帧生视频）、`r2v`（参考主体生视频 / 素材组）、`v2v`（视频转视频）、`rv2v`（参考素材改视频） |
| **首尾帧 (fl2v)** | 独立首尾帧时间轴：多组关键帧、「添加一组」上传首帧（必传）与尾帧（可选）；拖缘调时长；提示词写中间运动；支持「选择运行」只跑部分组 |
| **参考素材组 (r2v)** | fl2v 式分组 UI：每组图片1–9 / 音频1–3 / 视频1–3；提示词用 `<Picture N>` / `<Video K>` / `<Audio J>`（或 `@` 引用）；时间轴预览与选中状态同步 |
| **源视频编辑 (v2v / rv2v)** | Bernini 风格源视频时间轴；每段源画面自动绑定 `<Video 1>`；`rv2v` 另可挂参考图（图片1–9）与参考音频（音频1–3） |
| **选择运行** | 开启后只采样勾选的片段/素材组；未勾选段可用缓存或源画面填充（全部导出时） |
| **原生立体声音频** | 与画面同次采样生成；`v2v`/`rv2v` 可选生成声音 / 使用原声 / 静音 |
| **运行报告** | `report` 口输出分段计划、每段任务摘要 |

### 输入 / 输出

**输入：** `model` → `video_vae` → `audio_vae` → `clip`

**输出：** `images` → `audio` → `fps` → `frame_count` → `source_images` → `report`

> CLIP Loader 的 **type 必须选 `minimax`**（Qwen3-VL）。  
> `t2v` / `i2v` / `fl2v` 用 **fl2va** UNET；`r2v` / `v2v` / `rv2v` 用 **ref2va** UNET。

## 依赖

请将 **ComfyUI** 升级到 **v0.30.0** 及以上（含官方 MiniMax H3 节点：[PR #15224](https://github.com/comfyanonymous/ComfyUI/pull/15224)、[PR #15228](https://github.com/comfyanonymous/ComfyUI/pull/15228)）。

可选：`scenedetect`（智能分割）、`opencv-python-headless`（源视频解码）、`imageio-ffmpeg`（原声抽取）——见 `requirements.txt`。

## 安装

### 方法一：手动安装（标准方式）

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git

pip install -r ComfyUI_MiniMaxH3_Director/requirements.txt
```

重启 ComfyUI。

### 方法二：ComfyUI Manager

1. 打开 **ComfyUI Manager**
2. 选择 **Install via Git URL**
3. 填入 `https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git` 并安装
4. 重启 ComfyUI

## 模型与工作流下载

完整资源包（**MiniMax H3 模型权重** + **示例 JSON 工作流**）见：

**[Comfyit 搅拌站 · 文章 506：MiniMax H3 模型和工作流](https://comfyit.cn/article/506)**

下载后将 `models/` 合并到 `ComfyUI/models/`，JSON 工作流拖入 ComfyUI 即可。

也可参考：

- **Hugging Face：** [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)
- **ComfyUI 文档：** [MiniMax H3 工作流示例](https://docs.comfy.org/zh/tutorials/video/minimax/minimax-h3)

本仓库自带示例：`example_workflows/`

| 工作流 | task_type | UNET | 说明 |
|--------|-----------|------|------|
| `minimax_h3_director_t2v.json` | t2v | fl2va | 文生音视频 |
| `minimax_h3_director_fl2v.json` | fl2v | fl2va | 首尾帧（「添加一组」） |
| `minimax_h3_director_r2v.json` | r2v | **ref2va** | 参考改视频素材组 |
| `minimax_h3_director_v2v.json` | v2v | **ref2va** | 源视频时间轴编辑 |
| `minimax_h3_director_rv2v.json` | rv2v | **ref2va** | 源视频 + 参考图/音频 |

### 推荐模型文件

| 用途 | 文件名 | 目录 |
|------|--------|------|
| UNET (t2v / i2v / fl2v) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| UNET (r2v / v2v / rv2v) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

## 快速开始

1. 确认 ComfyUI ≥ **0.30.0**，已能加载官方 MiniMax H3 节点
2. 从 [文章 506](https://comfyit.cn/article/506) 或本仓库 `example_workflows/` 加载示例
3. 连接 UNET / CLIP / video_vae / audio_vae，在导演台 UI 内编辑时间轴与提示词后 Queue

**视频教程：** [B 站合集 · 插件使用教程](https://space.bilibili.com/1997403556/lists/8357740)

### 默认采样参数

- 画布默认 **0.4MP 16:9（864×480）**，**5 秒 / 124** 帧 @ **24 fps**（17k+5 网格）
- **25** steps，`res_multistep` + `simple`，CFG **1.0**
- Sigma shift：video **12** / audio **3**

### 首尾帧 fl2v 用法摘要

1. 任务类型选 **「首尾帧生视频 (fl2v)」**
2. 点击「添加一组」，上传首帧（必传）与尾帧（可选）
3. 在镜卡片或时间轴上调整时长；提示词写中间运动 / 镜头 / 过渡
4. Queue 生成；多组可勾选「选择运行」只跑部分组

### 参考主体 r2v 用法摘要

1. 任务类型选 **「参考主体生视频 (r2v)」**（需 **ref2va** UNET + audio_vae）
2. 点击「添加素材组」；在组内上传图片1–9 / 音频1–3 / 视频1–3
3. 提示词中用 `<Picture N>` / `<Video K>` / `<Audio J>`，或输入 `@` 选择已上传素材
4. 时间轴可预览各组时长与缩略图；「选择运行」与素材组勾选同步

### 源视频 v2v / rv2v 用法摘要

1. 选 **v2v** 或 **rv2v**，上传源视频并分段（切分 / 均分 / 智能分割）
2. 每段写提示词；系统自动将源片段绑定为 `<Video 1>`
3. `rv2v` 可额外上传参考图 / 参考音频；声音模式可选生成 / 原声 / 静音

## 配套生态 · [Comfyit 搅拌站](https://comfyit.cn/)

[Comfyit](https://comfyit.cn/) 提供环境、模型、工作流与教程配套：

| 栏目 | 链接 |
|------|------|
| 模型 / 工作流包 | [comfyit.cn/article/506](https://comfyit.cn/article/506) |
| 官方 MiniMax H3 文档 | [docs.comfy.org · MiniMax H3](https://docs.comfy.org/zh/tutorials/video/minimax/minimax-h3) |
| 插件视频教程 | [B 站合集](https://space.bilibili.com/1997403556/lists/8357740) |
| 产品中心 | [comfyit.cn/products](https://comfyit.cn/products) |
| 插件广场 | [comfyit.cn/plugins](https://comfyit.cn/plugins) |
| 模型广场 | [comfyit.cn/resources/models](https://comfyit.cn/resources/models) |
| 工作流广场 | [comfyit.cn/workflows](https://comfyit.cn/workflows) |

## 作者与交流

| | |
|---|---|
| **维护者** | [AI搅拌手 / AIMixer](https://github.com/AIMixer) |
| **本仓库** | [github.com/AIMixer/ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) |
| **姊妹插件** | [ComfyUI_Bernini_Director](https://github.com/AIMixer/ComfyUI_Bernini_Director) |
| **作者 QQ** | **3697688140** |
| **B 站** | [space.bilibili.com/1997403556](https://space.bilibili.com/1997403556) |
| **插件教程** | [B 站合集 · 使用教程](https://space.bilibili.com/1997403556/lists/8357740) |
| **QQ 交流群** | **551482703** · **425064221** · **559826331** |
| **Comfyit 搅拌站** | [comfyit.cn](https://comfyit.cn/) |

## 致谢

- [Comfy-Org / ComfyUI](https://github.com/Comfy-Org/ComfyUI) — 官方 MiniMax H3 支持
- [MiniMax-AI](https://github.com/MiniMax-AI) — MiniMax H3 模型
- [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) — 权重与文档

## 许可证

Apache-2.0
