# Zed 与 mutishell 的 Windows IME 处理对比

## 目的

本文记录当前 mutishell 在 Claude Code、Codex、OpenCode 等高频重绘 TUI
中遇到的中文输入法候选窗定位问题，并与 Zed 的 Windows 原生 IME 实现进行
对比。它是后续技术决策和验证的依据，不代表本文中的改造已经实现。

## 问题定义

当前现象通常发生在终端正在流式输出或 TUI 正在频繁重绘时：

- xterm 屏幕上的视觉光标已在输入区域；
- Windows 中文输入法候选窗却出现在历史位置、窗口左上角或窗口边界外；
- 一旦候选窗出现，浏览器可能将其锚点锁定，随后 DOM textarea 的移动无法
  可靠地修正位置；
- 窗口靠近屏幕底部时，候选窗还可能被任务栏遮挡。

这不是 PTY 收发文本错误。问题出在“系统 IME 需要锚点”的时刻，终端渲染
状态、隐藏输入控件位置和视觉光标位置没有可靠地保持一致。

## 当前 mutishell 链路

```text
Windows IME
  -> WebView2 DOM composition 事件
  -> xterm helper textarea / composition view
  -> xterm onData
  -> Tauri terminal_write
  -> portable-pty

PTY 输出
  -> terminal://data
  -> App.tsx 每终端串行 xterm.write
  -> xterm buffer / canvas
  -> xterm 同步 helper textarea 到 buffer 光标
```

当前实现的职责划分如下：

- `src/components/TerminalView.tsx` 创建 xterm，保留 xterm 自己的 helper
  textarea 与 composition view，不再创建固定 textarea 或底部 IME dock。
- `TerminalView` 在捕获阶段观察 `compositionstart`，通知 `App` 当前终端进入
  组合态；在 `compositionend` 后延迟释放，以便 xterm 先完成自己的组合文本提交。
- `src/App.tsx` 对每个终端维持串行的 `terminal.write(data, callback)` 队列；
  组合期间暂停向 xterm 交付 PTY 输出，并延后 fit、refresh、纹理图集更新。
- xterm 已升级至 `6.1.0-beta.288`。该版本在 `compositionstart` 时会先重同步
  helper textarea 到最新 buffer 光标，专门缓解高频重绘 TUI 的锚点过期问题。

这套方案保护了组合输入不被流式输出打断，但最终候选窗位置仍由 WebView2
根据隐藏 textarea 决定。

## Zed 链路

```text
Windows WM_IME_STARTCOMPOSITION / WM_IME_COMPOSITION
  -> GPUI PlatformInputHandler
  -> Editor 的 UTF-16 选区与 marked range
  -> 编辑器布局快照计算字符像素边界
  -> 逻辑像素转物理 client 像素
  -> ImmSetCompositionWindow + ImmSetCandidateWindow
```

Zed 使用自己的 Windows 窗口过程、GPUI 渲染管线和编辑器文本模型。它不通过
浏览器 textarea 接收或定位 IME。

### 语义输入模型

GPUI 定义 `InputHandler`，要求当前聚焦文本元素能够提供：

- 当前选择范围和组合中的 marked range；
- UTF-16 范围的文本内容；
- 替换文本、替换并标记组合文本、取消标记；
- 任意 UTF-16 文本范围的真实像素边界。

每一帧绘制聚焦编辑器时，Zed 将带有本帧元素边界的 input handler 注册给
平台层。因此 IME 查询的不是猜测的 DOM 控件位置，而是当前编辑器布局中的
语义光标位置。

### 坐标策略

Zed 的编辑器用显示快照、横向/纵向滚动偏移、gutter 宽度、字形 advance 和
行高，计算目标 UTF-16 位置的矩形。组合态下它优先定位 marked range 在当前
视觉行的起点；如果 marked text 已经换行，则向后找到当前视觉行的起点。这使
候选窗不会因组合文本跨行而错误锚定到上一行。

### 定位时机

Zed 有两次定位机会：

1. 选区变动后调用 `invalidate_character_coordinates()`，在下一帧布局完成后
   主动向平台层推送最新坐标。
2. 收到 `WM_IME_STARTCOMPOSITION` 时，同步重新读取当前选区的矩形并再次设置
   IME 位置。

第二次同步定位是处理流式刷新竞态的关键。即使选区刚在一帧中移动，Windows
准备开始组合输入时仍会取得最新坐标，而不是等待异步 DOM 布局或下一个事件。

### Windows 原生交互

Zed 将逻辑像素乘以窗口 DPI scale factor，得到当前 HWND client area 的物理
坐标，并将 Y 轴放在光标单元格的中点。随后对同一个 `HIMC` 同时调用：

- `ImmSetCompositionWindow`，使用 `CFS_POINT` 设置组合窗口位置；
- `ImmSetCandidateWindow`，使用 `CFS_CANDIDATEPOS` 设置候选窗口位置。

它还在 `WM_IME_COMPOSITION` 中通过 `ImmGetCompositionStringW` 读取：

- `GCS_RESULTSTR`：已确认文本，提交到编辑器；
- `GCS_COMPSTR`：仍在组合的文本，写入 marked range；
- `GCS_CURSORPOS` 与 `GCS_COMPATTR`：组合串内部光标位置，仅在位置邻近未转换
  文本时采用，否则回退到组合串末尾。

因此候选窗位置、组合字符串、编辑器光标和绘制结果都由 Zed 的同一套模型
管理。

## 对比

| 维度 | mutishell 当前实现 | Zed 实现 | 对当前问题的影响 |
| --- | --- | --- | --- |
| 宿主 | Tauri + WebView2 | 自有 Win32 HWND + GPUI/DirectX | Zed 可在原生消息循环内同步处理 IME；mutishell 需要跨 WebView 边界。 |
| 终端/编辑器渲染 | xterm canvas，输入来自隐藏 textarea | 自有编辑器布局和 GPU 渲染 | Zed 可直接知道语义光标像素；xterm 主要知道 buffer 光标。 |
| 输入法事件 | DOM `composition*` 事件 | `WM_IME_*` 原生消息 | DOM 事件到达时，WebView 可能已锁定候选窗锚点。 |
| 候选窗位置来源 | WebView2 根据 textarea 矩形推断 | 应用显式传递 `POINT` | Zed 不依赖浏览器对隐藏控件的推断。 |
| 定位触发 | xterm 光标/resize 同步；6.1 beta 在 composition start 再同步 | 选区变更后的下一帧推送，加上 `WM_IME_STARTCOMPOSITION` 同步重算 | Zed 有更可靠的时序保障。 |
| 组合文本状态 | xterm 维护 textarea 值和 composition view | 编辑器维护 marked range、selection、UTF-16 光标 | Zed 能处理跨行组合文本和 IME 内部光标。 |
| 流式输出策略 | 组合期间暂停 frontend 到 xterm 的 PTY 输出 | 编辑器状态与本地输入模型在同一 UI 线程更新 | mutishell 的暂停可减小竞态，但不能主动控制系统候选窗。 |
| 候选窗边界 | 由 Windows/WebView2 决定，可能受任务栏和过期锚点影响 | 由 Windows 根据应用给定 client 坐标决定 | Zed 至少能保证锚点是最新真实光标位置。 |

## Zed 做得更好的地方

### 1. 输入状态与渲染几何是同一事实来源

Zed 的 selection、marked text、字符布局和候选窗坐标来自同一个编辑器快照。
没有“视觉光标在 A，隐藏 textarea 在 B”的第二状态源。

### 2. 原生同步时机正确

`WM_IME_STARTCOMPOSITION` 中直接设置位置，不等待异步 JavaScript、React
状态更新或浏览器渲染。这是高频输出场景比 WebView/xterm 更稳定的根本原因。

### 3. 主动更新两个窗口

Zed 同时更新 composition window 和 candidate window。只移动一个控件会让某些
输入法的下划线预编辑文本、候选条或两者之一仍使用旧位置。

### 4. 组合态是第一类编辑器状态

Zed 将组合文本建模为 marked range，区分未确认和已确认文本，并处理组合串内
部光标。这使它可以在输入法尚未提交文字时继续正确布局和绘制。

### 5. 对换行和 DPI 有明确处理

它按视觉行计算候选锚点，并在调用 Windows API 前明确进行 logical-to-physical
转换。这两个细节分别避免长中文组合串换行错位和高 DPI 屏幕偏移。

## 不能直接照搬的部分

### 不能替换为 Zed 的 GPUI/编辑器

GPUI 和 `gpui_windows` 的 crate metadata 为 Apache-2.0，但将其嵌入现有 Tauri
应用相当于替换 WebView、React UI 和 xterm 渲染层，不是一个局部组件替换。
即使只复用 Zed 的 `WM_IME_COMPOSITION` 文本处理，也会与 WebView2/xterm 已有的
composition 事件竞争，可能造成输入丢失或重复。因此第一阶段不能截获或转发
组合文本，只能研究定位。

### 终端的视觉光标不一定有语义模型

Zed 编辑器知道每个字符的文档位置。通用 PTY 终端只能观察 ANSI buffer 光标。
如果某个 TUI 故意绘制一个与 buffer 光标不同的“虚拟光标”，任何通用 xterm
或原生 IME 桥都无法从 PTY 字节流推断真实编辑位置。此情况需要终端协议支持或
应用特定适配，不应通过固定 textarea 或底部 dock 伪造位置。

## 对 mutishell 的建议路线

### 阶段 0：建立观测，不改变行为

记录以下数据并在 Claude Code、Codex、OpenCode 中复现：

- xterm `buffer.active.cursorX/cursorY`；
- xterm helper textarea 的 `getBoundingClientRect()`；
- 终端 screen 元素的矩形、`cols/rows` 和 `devicePixelRatio`；
- `compositionstart`、`compositionupdate`、`compositionend` 的时序；
- Windows `GetFocus()` 返回的实际输入 HWND。

目标是确认候选窗错误时，xterm buffer 光标是否已经等于视觉光标。若不等，
原生定位只能改善部分场景；若相等，原生桥接有明确价值。

### 阶段 1：仅定位的 Windows 原生桥接 POC

保持 WebView2/xterm 处理输入文本，新增仅 Windows 的 Rust 命令：

1. 前端在 xterm 已完成一次写入、光标移动、fit 或 resize 后缓存最新光标矩形；
2. Rust 在 UI 线程找到当前真正拥有 IME context 的 WebView 子 HWND，而不是假定
   Tauri 顶层 HWND 一定正确；
3. 按该 HWND 的 client 坐标和 DPI 调用 `ImmSetCompositionWindow` 与
   `ImmSetCandidateWindow`；
4. 在每次位置变化前置更新，避免等到 DOM `compositionstart` 后再异步 invoke；
5. 不处理 `WM_IME_COMPOSITION`，不改变 xterm 的 `onData` 路径。

验收标准是：中文候选窗在流式 Claude Code 输入区稳定跟随、窗口贴近任务栏时
不再跳到历史位置或左上角，并且 Codex/OpenCode 的输入、候选、提交均无重复。

### 阶段 2：仅在阶段 1 不足时评估窗口消息钩子

若 WebView2 会覆盖桥接设置，才研究在实际输入子 HWND 的
`WM_IME_STARTCOMPOSITION` 前后更新位置。该方案涉及 WebView2 内部子窗口、线程
亲和性和窗口过程兼容性，风险明显高于阶段 1，不应作为首选实现。

## 相关源码与资料

- 当前实现：`src/components/TerminalView.tsx`、`src/App.tsx`、
  `docs/AI_HANDOFF.md`。
- xterm 针对动态 TUI 的 textarea 重同步修复：
  <https://github.com/xtermjs/xterm.js/commit/9e1b89651ade95bd5b5308741591705ca4fcc750>
- Zed GPUI 输入处理接口：
  <https://github.com/zed-industries/zed/blob/aeeacf5439b2d30d01e38d65d767e6f31b255ecc/crates/gpui/src/platform.rs#L1524-L1638>
- Zed 候选坐标计算与下一帧更新：
  <https://github.com/zed-industries/zed/blob/aeeacf5439b2d30d01e38d65d767e6f31b255ecc/crates/gpui/src/platform.rs#L1403-L1452>
  <https://github.com/zed-industries/zed/blob/aeeacf5439b2d30d01e38d65d767e6f31b255ecc/crates/gpui/src/window.rs#L5205-L5214>
- Zed Windows 原生 IME 消息和 IMM 调用：
  <https://github.com/zed-industries/zed/blob/aeeacf5439b2d30d01e38d65d767e6f31b255ecc/crates/gpui_windows/src/events.rs#L581-L727>
- Windows API：
  <https://learn.microsoft.com/windows/win32/api/imm/nf-imm-immsetcandidatewindow>
  <https://learn.microsoft.com/windows/win32/api/imm/nf-imm-immsetcompositionwindow>
