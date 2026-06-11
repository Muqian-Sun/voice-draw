# CLAUDE.md — 题目二：AI 语音绘图工具

纯语音控制的绘图工具（无鼠标键盘）。设计文档见 `docs/`（架构与开发计划、交互协议规范、规则层与执行语义规格、指令能力与实现状态），实现以这四份文档为准；协议/数值改动必须同步更新对应文档。

## 赛制硬性约束（违反 = 作品无效，开发全程必须遵守）

- 仓库须在开题后创建；**所有 commit 时间戳必须落在批次窗口内**；不 rebase/导入旧历史
- **严禁突击提交**：必须全周期持续交付，每天都有 PR 和 commit，最后一天一次性导入视为无效
- 一切变更走 `feat/*` 分支 → PR → merge，**禁止直接 push main**
- **每个 PR 只做一件事**，粒度尽可能小；大功能拆成多个独立 PR
- **每个 PR 合并后 main 必须可运行**：评委任意时间 clone 都能复现演示。强依赖外部服务的功能先有降级路径再合并（WebSpeech 兜底、调试面板文本输入）
- 新增第三方依赖必须同步写进 README 依赖表；复用过去的代码必须在 PR 描述注明来源
- 交付物：公开仓库 + README + demo 视频（外链放 README 顶部）

## PR 描述规范（每个 PR 必须包含四要素）

```markdown
## 功能描述    <!-- 实现/修改了什么，用户如何使用 -->
## 实现思路    <!-- 技术选型与核心逻辑，关联设计文档章节，如 docs/交互协议规范 §1.4 -->
## 测试方式    <!-- 评委如何验证：启动命令 + 操作步骤 + 预期结果；有自动化测试写运行命令 -->
## 依赖与来源声明  <!-- 新增三方库（同步 README）；复用旧代码注明出处；无则写"无" -->
```

模板放 `.github/pull_request_template.md`。标题一句话说明本 PR 新增/修改了什么。

## 仓库结构

```
frontend/   # React + TS + Vite + Konva 绘图应用主体
backend/    # Node 代理：密钥隔离、ASR WebSocket 转发、LLM 转发
docs/       # 设计文档（4 份）+ 评审材料
.github/pull_request_template.md
README.md
```

`backend/.env.example` 列出全部环境变量（火山 ASR、火山方舟 LLM、TTS 密钥）；README 写明无密钥时的降级运行方式。

## PR 拆分计划（20 个，对齐 M0~M4，每日 3~5 个）

**Day 1（M0 骨架+绘图引擎）**
1. chore: 初始化 monorepo 骨架（frontend/backend）+ README 初版 ✅(GH PR#2)
2. feat: 绘图 DSL 类型与 zod Schema（协议 §1.3-1.4）✅(GH PR#3)
3. feat: 场景图 + DSL 解释器（create/style/move/delete）✅(GH PR#4)
4. feat: 事务式 undo/redo（场景快照栈，规格 §5.4）✅(GH PR#5)
5. feat: 文本调试面板（输入 DSL/自然语言 + 事件日志）✅(GH PR#6)

**Day 2（M1 语音链路）**
6. feat: 自动布局与相对定位解析（外贴/内贴/clamp，规格 §5.2-5.5）✅(GH PR#7)
7. feat: backend ASR WebSocket 转发协议（协议 §3.2）✅(GH PR#8)
8. feat: 麦克风采集 + Silero VAD 断句 + 主状态机（协议 §4.1）✅(GH PR#9)
9. feat: 前端流式 ASR Provider + 实时字幕（网关 mock 全链路 + WebSpeech 兜底切换）✅(GH PR#10)
9b. feat: 火山引擎豆包流式 ASR 真实上游接入（VolcAsrUpstream，二进制帧协议）✅(GH PR#11)

**Day 3（M2 指令理解）**
10. feat: lexicon 词表模块（颜色/形状/方位/量词，唯一来源，规格 §2）✅(GH PR#12)
11. feat: 同音词纠错（词表 + 拼音编辑距离回退，规格 §3）✅(GH PR#13)
12. feat: 规则快路径 T1~T11 模板解析（规格 §4）✅(GH PR#14)
12b. feat: 解释器补全修改类操作 resize/rotate/rename/setText/zorder/focus/export（弹性追加）✅(GH PR#15)
13. feat: backend LLM 转发 + parse 模式解析（System Prompt 构建期生成 + JSON 校验重试）✅(GH PR#17)
14. feat: 焦点对象与指代消解（规格 §5.1）✅(GH PR#18)

**Day 4（M3 拆解+反馈闭环）**
15. feat: TTS 反馈编排（豆包语音合成 1.0 + speechSynthesis 兜底、半双工互斥）✅(GH PR#23)
16. feat: 破坏性操作语音确认（confirm-pending，协议 §4.3）
17. feat: 歧义澄清多轮（AMBIGUOUS_TARGET + expecting 快匹配，规格 §5.7）
18. feat: plan 模式创作拆解（自动编组 + desc 进度播报）

**Day 5（M4 优化+交付）**
19. feat: partial 投机解析 + 延迟/成本埋点看板
20. docs+test: Golden 30 句自动化回归 + README 终版 + 实现状态定稿 + demo 视频链接

弹性：超前则 P2 能力各追加独立小 PR；延期可降级 17/19（状态文档如实记录原因），**PR 20 文档定稿绝不挤掉**。

## README 必须包含

- 顶部：一句话简介 + demo 视频链接（bilibili/云盘，无登录可播放）
- 功能演示（能力话术表 + GIF）、架构图、快速开始（环境/配置/启动/验证）
- **第三方依赖列表**（库名/用途，注明除依赖外代码全部原创）——赛制硬性要求
- 指令能力与实现状态链接、设计文档索引、分工说明

## Demo 视频脚本（3~5 分钟，全程配音讲解）

1. 0:00 开场：题目 + 架构图一页（三层理解 + DSL）
2. 0:30 基础链路：画红圆 → 左上角蓝矩形 → 右移一点 → 把它变大（展示字幕与延迟看板）
3. 1:30 容错："花一个园"纠错；双圆歧义澄清；"清空画布"语音确认
4. 2:15 复杂拆解："画一个雪人"进度播报；"把它移到右边"整组移动；"在雪人左边画棵比它矮的树"
5. 3:15 工程佐证：规则层命中率、LLM 调用计数、Golden 测试
6. 4:00 收尾：实现状态总结 + 未完成项原因

录制：需系统声音内录（录到 TTS）；ASR 偶发识别错可顺势当容错素材，不必重录。

## 开发工作流提醒（给 Claude 的指令）

- 每完成一个 PR 范围的功能：跑通该 PR 的"测试方式"再提交；commit message 与 PR 范围一致
- **每个 PR 合并后在本文件「PR 拆分计划」对应条目标记 ✅(GH PR#n)**——本条目自身的勾在该 PR 内创建 PR 后追加提交（此时才知道 GH 编号）
- 合并后做冒烟验证：起前后端，用调试面板灌一句 Golden 话术
- 改 lexicon 数值 → 同步规格文档 §2 与 System Prompt → 跑 Golden 回归
- 新依赖 → 同一 PR 内更新 README 依赖表
- 实现状态文档（docs/题目二-指令能力与实现状态.md）在每个里程碑完成时更新状态列，不要攒到最后
