# VoiceDraw — 纯语音控制的 AI 绘图工具

> 七牛云 1024 创作节 · 题目二。不使用鼠标键盘，仅通过语音指令完成绘图创作。

📺 **Demo 视频**：开发完成后补充（bilibili 外链）

## 功能演示

🚧 开发中。目标能力示例（完整清单见 [指令能力与实现状态](docs/题目二-指令能力与实现状态.md)）：

| 你说 | 画布 |
|------|------|
| "在左上角画一个大的蓝色矩形" | 创建图形（颜色/尺寸/位置槽位） |
| "把它往右移一点" / "变大一点" | 焦点指代 + 模糊量词 |
| "画一个雪人" | LLM 拆解为多步绘制并语音播报进度 |
| "清空画布" → "确认" | 破坏性操作语音二次确认 |

## 架构

三层指令理解 + 统一绘图 DSL：本地规则快路径（高频指令 <50ms 零成本）→ LLM 结构化解析（空间关系/指代）→ Agent 创作拆解（组合图案）。所有理解层输出同一套 JSON 原子操作，执行引擎基于 Konva 场景图渲染，天然支持事务式 undo/redo。语音输入为本地 VAD 断句 + 火山引擎豆包流式 ASR（mock/WebSpeech 兜底），反馈经七牛 TTS 播报闭环。

详见 [架构设计与开发计划](docs/题目二-架构设计与开发计划.md)、[交互协议规范](docs/题目二-交互协议规范.md)。

## 快速开始

**环境要求**：Node ≥ 20、pnpm ≥ 9、Chrome 浏览器（需要麦克风权限）

```bash
# 1. 安装依赖
pnpm install

# 2. （可选）配置密钥——不配置也能启动，自动降级
cp backend/.env.example backend/.env   # ASR 填火山引擎 VOLC_API_KEY；LLM 填火山方舟 ARK_API_KEY

# 3. 一条命令启动前后端
pnpm dev
# 前端 http://localhost:5173  后端 http://localhost:8787

# 4. 验证
# 打开 http://localhost:5173 应看到 1024×768 空画布
# curl http://localhost:8787/healthz 应返回 {"ok":true,...}
```

**无密钥降级**：未配置 `VOLC_API_KEY` 时 ASR 走 mock 上游（固定话术演示），网关不可用再降浏览器 WebSpeech；未配置 `ARK_API_KEY` 时 LLM 解析不可用，规则层指令（创建/移动/缩放/撤销等）仍可用，亦可用调试面板文本输入验证全链路。

## 第三方依赖列表

除以下开源依赖外，**全部代码为本项目原创**：

| 库 | 用途 |
|----|------|
| react / react-dom | 前端 UI 框架 |
| konva / react-konva | Canvas 2D 场景图渲染（绘图执行引擎底座） |
| zod | 运行时 Schema 校验（前后端：DSL / LLM 输出 / ASR 转发协议） |
| vitest | 单元测试（前后端） |
| ws | backend ASR WebSocket 网关与上游转发 |
| @ricky0123/vad-web | Silero VAD 本地断句（WASM，静音帧不上传） |
| pinyin-pro | 汉字转拼音（同音词纠错的拼音编辑距离回退） |
| onnxruntime-web | VAD 模型推理运行时（资产本地化，不走 CDN） |
| vite-plugin-static-copy | 构建期复制 VAD/ONNX 资产到产物 |
| vite / @vitejs/plugin-react | 前端构建与开发服务器 |
| typescript | 类型系统（前后端） |
| express | backend HTTP 服务（密钥隔离代理） |
| dotenv | backend 环境变量加载 |
| tsx | TS 直跑（backend 开发期 + 前端 Prompt 生成脚本） |
| concurrently | 一条命令并行启动前后端 |

> 新增依赖随对应 PR 同步更新本表。

## 设计文档

| 文档 | 内容 |
|------|------|
| [架构设计与开发计划](docs/题目二-架构设计与开发计划.md) | 总体架构、技术选型、M0~M4 里程碑 |
| [交互协议规范](docs/题目二-交互协议规范.md) | 绘图 DSL、LLM 输入输出协议、语音协议、状态机 |
| [规则层与执行语义规格](docs/题目二-规则层与执行语义规格.md) | 词表/纠错/模板文法/执行语义/System Prompt/Golden 测试集 |
| [指令能力与实现状态](docs/题目二-指令能力与实现状态.md) | 26 项能力清单与实现状态（提交件，随里程碑更新） |

## 分工说明

个人参赛（[@Muqian-Sun](https://github.com/Muqian-Sun)）：全部模块独立完成。
