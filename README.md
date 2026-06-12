# VoiceDraw — 纯语音控制的 AI 绘图工具

> 七牛云 1024 创作节 · 题目二。不使用鼠标键盘，仅通过语音指令完成绘图创作。

📺 **Demo 视频**：录制完成后填入（bilibili 外链，无登录可播放）

## 功能演示

完整 26 项能力清单见 [指令能力与实现状态](docs/题目二-指令能力与实现状态.md)（P0 11/11、P1 8/8）：

| 你说 | 发生什么 |
|------|------|
| "在左上角画一个大的蓝色矩形" | 规则层 <3ms 解析（颜色/尺寸/位置槽位），零 LLM 成本 |
| "把它往右移一点" / "缩小一半" | 焦点指代（画布虚线框可视）+ 模糊量词映射 |
| "花一个园" | 同音词纠错 → "画一个圆"（词表 + 拼音编辑距离回退） |
| "把圆变大"（画布有红蓝两圆） | 播报"有红色和蓝色两个圆，要哪个？"→ 答"红色的"直接执行 |
| "清空画布" → "确认" | 破坏性操作语音二次确认（5 秒超时视为取消） |
| "画一个雪人" | LLM 拆解 10+ 部件、自动编组、逐步语音播报进度 |
| "把雪人往右移很多" | 整组移动（组提升语义，规则层 0.3ms 命中） |
| "在雪人左边画一棵比它矮的树" | 相对定位 + 相对尺寸（树干高 = 参照 ×0.4 精确落地） |
| "撤销" / "保存图片" | 快照式撤销 / 导出 PNG |

## 架构

三层指令理解 + 统一绘图 DSL：本地规则快路径（高频指令 <50ms 零成本）→ LLM 结构化解析（空间关系/指代）→ Agent 创作拆解（组合图案）。所有理解层输出同一套 JSON 原子操作，执行引擎基于 Konva 场景图渲染，天然支持事务式 undo/redo。语音输入为本地 VAD 断句 + 火山引擎豆包流式 ASR（mock/WebSpeech 兜底），反馈经火山豆包 TTS（speechSynthesis 兜底）播报闭环，全程半双工互斥。

详见 [架构设计与开发计划](docs/题目二-架构设计与开发计划.md)、[交互协议规范](docs/题目二-交互协议规范.md)。

## 快速开始

**环境要求**：Node ≥ 20、pnpm ≥ 9、Chrome 浏览器（需要麦克风权限）

```bash
# 1. 安装依赖
pnpm install

# 2. （可选）配置密钥——不配置也能启动，自动降级
cp backend/.env.example backend/.env   # ASR 填 VOLC_API_KEY；LLM 填方舟 ARK_API_KEY；TTS 填 VOLC_TTS_APPID/TOKEN

# 3. 一条命令启动前后端
pnpm dev
# 前端 http://localhost:5173  后端 http://localhost:8787

# 4. 验证
# 打开 http://localhost:5173 应看到 1024×768 空画布；调试面板输入"画一个红色的圆"即出图
# curl http://localhost:8787/healthz 应返回 {"ok":true,...}

# 5. 回归测试（Golden 30 句，规格附录 B）
cd frontend && pnpm test                      # 离线全量（含 Golden B1/B2/澄清）
GOLDEN_LIVE=1 pnpm test golden                # B3/B4 真实 LLM 实跑（需 backend 已启动 + ARK 密钥）
```

**无密钥降级**：未配置 `VOLC_API_KEY` 时 ASR 走 mock 上游（固定话术演示），网关不可用再降浏览器 WebSpeech；未配置 `ARK_API_KEY` 时 LLM 解析不可用，规则层指令（创建/移动/缩放/撤销等）仍可用；未配置 `VOLC_TTS_APPID/TOKEN` 时播报自动降级浏览器 speechSynthesis，亦可用调试面板文本输入验证全链路。

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
