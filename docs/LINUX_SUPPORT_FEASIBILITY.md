# Linux 支持可行性与 Shell Profile 重构方案

## 结论

在以下前提成立时，mutishell 支持 Linux 的工作量属于中等偏小，不需要重写现有架构：

1. Shell profile 改为可自定义配置，不再只依赖后端写死的 Windows profile。
2. Linux 下可以暂不支持“打开资源管理器/文件管理器”能力。
3. Linux 下可以暂不支持“剪贴板文件/截图转路径”增强能力，继续使用 Linux 终端和 shell 的默认粘贴行为。

当前架构中，Tauri、React、xterm.js 和 `portable-pty` 都具备跨平台基础。主要改造点集中在 shell profile 管理、平台默认配置、路径 quoting、少量 Windows-only 功能降级。

## 目标范围

第一阶段目标：

- Windows 现有体验保持不变。
- Shell profile 支持真正自定义，包括新增、删除、编辑 executable 和 args。
- 后端按平台加载默认 shell profile JSON。
- Linux 上支持基础终端能力：添加项目目录、创建终端、输入输出、resize、关闭、恢复会话。
- Linux 上默认提供常见 shell profile，例如 system shell、bash、zsh、fish、pwsh。
- Linux 下不实现 Windows 专用的剪贴板文件/截图转路径逻辑。
- Linux 下可以隐藏或禁用“打开资源管理器”按钮。

非目标：

- 不在第一阶段实现 Linux 文件管理器复制文件后粘贴成路径。
- 不在第一阶段实现 Linux 截图剪贴板自动保存为图片路径。
- 不承诺所有 Linux 桌面环境的剪贴板协议一致行为。
- 不改动终端 UI 的核心交互模型。

## 当前 Windows 绑定点

### 后端默认 profile 写死

`src-tauri/src/lib.rs` 中的 `default_shell_profiles()` 当前直接返回 Windows PowerShell、PowerShell 7、CMD、Git Bash、WSL。

影响：

- Linux 首次启动没有合适默认 shell。
- 自定义 profile 被内置 profile 白名单限制。
- 跨平台默认配置难以维护。

### `terminal_create` 使用内置 profile 作为启动白名单

当前创建终端时会先从 `default_shell_profiles()` 查找 `shell_profile_id`。即使前端传入了完整 `shell_profile`，如果 id 不在内置列表中也会失败。

影响：

- 现在的 profile 不是完全自定义，只是允许修改内置 profile 的 executable。
- Linux 用户无法添加任意 shell profile 后直接启动。

### 打开目录直接调用 Explorer

`open_path_in_explorer` 直接执行 `explorer`。

影响：

- Linux 下不可用。
- 第一阶段可以隐藏入口或返回明确错误。

### 剪贴板文件/截图读取依赖 Windows API

Windows 下通过 `windows-sys` 读取 `CF_HDROP`、DIB、DIBV5 等剪贴板格式。非 Windows 当前实现返回空数组。

影响：

- Linux 下不会得到文件路径或截图临时文件。
- 在当前前提下这是可接受行为，普通文本粘贴仍可继续。

### 路径 quoting 默认偏 Windows

`src/utils/terminalPaths.ts` 当前按 profile id 区分 PowerShell、CMD、Git Bash、WSL，未知 profile 默认使用 CMD 双引号。

影响：

- Linux 自定义 profile 的路径插入需要 POSIX quoting。
- Windows 既有 profile id 的规则应保持不变。

### 打包目标只有 NSIS

`src-tauri/tauri.conf.json` 当前 bundle target 为 `nsis`。

影响：

- Linux 需要增加或按平台选择 `deb`、`appimage`、`rpm` 等目标。

## 推荐设计

### 平台默认 profile JSON

新增默认配置文件：

```text
src-tauri/defaults/shell-profiles.windows.json
src-tauri/defaults/shell-profiles.linux.json
src-tauri/defaults/shell-profiles.macos.json
```

Rust 侧使用 `include_str!` 按平台编译进二进制，避免运行时资源路径问题。

示例：

```rust
#[cfg(target_os = "windows")]
const DEFAULT_SHELL_PROFILES_JSON: &str =
    include_str!("../defaults/shell-profiles.windows.json");

#[cfg(target_os = "linux")]
const DEFAULT_SHELL_PROFILES_JSON: &str =
    include_str!("../defaults/shell-profiles.linux.json");
```

Windows JSON 应保持现有 profile id 不变：

- `powershell`
- `pwsh`
- `cmd`
- `git-bash`
- `wsl`

这样旧 state 和旧 tab 仍能找到对应 profile。

Linux JSON 可提供：

- `system-shell`
- `bash`
- `zsh`
- `fish`
- `pwsh`

`system-shell` 可以使用 `$SHELL`，但加载时需要在 Rust 中展开环境变量，不能直接把 `$SHELL` 传给 `CommandBuilder`。

### ShellProfile 模型

可以在现有模型上扩展：

```ts
type ShellProfile = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  icon: string;
  detected: boolean;
  builtin?: boolean;
  shellFamily?: "powershell" | "cmd" | "posix" | "wsl";
};
```

`builtin` 用于 UI 表达“平台默认 profile”，但不应阻止用户编辑。

`shellFamily` 用于路径 quoting 和少量 shell 行为判断，避免继续把逻辑绑定到固定 id。为了兼容旧数据，可以先让前端按 id 推断，后续再逐步写入 state。

### State 合并策略

加载 state 时按以下规则处理：

1. 如果没有 state，使用当前平台默认 profile。
2. 如果 state 中已有 profile，用户 state 优先。
3. 当前平台 defaults 中存在但 state 缺失的 profile，追加进去。
4. state 中存在但 defaults 中不存在的 profile，保留，视为用户自定义 profile。
5. 不要用 defaults 覆盖用户改过的 executable、args、name。
6. 每次加载后重新检测 `detected`。
7. 如果默认 profile 不可用，选择第一个 detected profile。

这个策略可以保证 Windows 用户修改过的 Git Bash 或 PowerShell 路径不会被升级覆盖。

### 终端启动策略

`terminal_create` 应调整为：

1. 优先使用请求中的完整 `shell_profile`。
2. 如果请求没有完整 profile，再从默认 profile 或 state profile 中查找 id。
3. 不再要求 profile id 必须出现在平台 defaults 中。
4. 启动前校验 executable 非空。
5. 校验 executable 存在，或可从 `PATH` 中找到。
6. 校验 cwd 存在且是目录。

这样自定义 profile 才是真正可启动的配置。

### 可执行文件检测

Windows 保留现有行为：

- 支持绝对路径。
- 支持从 `PATH` 查找。
- 没有扩展名时尝试 `.exe`。
- 保留 Git Bash launcher 归一化逻辑。

Linux 行为：

- 支持绝对路径。
- 支持从 `PATH` 查找。
- 不自动补 `.exe`。
- `$SHELL`、`$HOME` 等环境变量在加载 defaults 或校验前展开。

### 路径 quoting

建议逐步改为按 `shellFamily` 判断：

- `powershell`: PowerShell 单引号规则。
- `cmd`: CMD 双引号规则。
- `wsl`: Windows drive path 转 `/mnt/<drive>/...` 后 POSIX quoting。
- `posix`: POSIX 单引号规则。

兼容过渡期：

- 现有 `powershell`、`pwsh` 继续按 PowerShell。
- 现有 `cmd` 继续按 CMD。
- 现有 `git-bash` 继续将反斜杠转 `/` 后 POSIX quoting。
- 现有 `wsl` 继续按 WSL 转换。
- Linux 新增 profile 默认按 POSIX。
- Windows 未知 profile 可以继续按 CMD，避免改变现有行为。

### Windows-only 功能降级

打开目录：

- Windows: 保持调用 Explorer，或后续迁移到统一 opener。
- Linux: 第一阶段隐藏按钮，或点击后提示“不支持当前平台”。

剪贴板文件/截图转路径：

- Windows: 保持现有实现。
- Linux: `save_system_clipboard_files()` 返回空数组，继续走普通文本粘贴。
- 如果 Linux 下发现当前 paste 拦截影响 Codex CLI 的图片粘贴行为，再按平台绕过增强 paste manager。

## 对 Windows 版本的影响评估

只要遵守以下原则，影响可以控制得很低：

- Windows 默认 profile id 不变。
- Windows 默认 executable 和 args 原样迁移到 JSON。
- state 合并时用户配置优先。
- Windows path quoting 规则不改。
- Windows 剪贴板增强逻辑不改。
- Git Bash `git-bash.exe` 到 `bin/bash.exe` 的归一化逻辑保留。
- 第一阶段先做重构并验证 Windows，再引入 Linux defaults。

主要风险：

1. 合并逻辑覆盖用户自定义路径。
2. `terminal_create` 放开白名单后缺少必要校验。
3. 路径 quoting 兜底行为影响 Windows 自定义 profile。
4. Linux 下 paste manager 拦截了某些终端默认能力。

对应控制方式：

1. 明确 state 优先，defaults 只补缺失。
2. 后端保留 executable、PATH、cwd 校验。
3. Windows 未知 profile 暂时保留 CMD 兜底，Linux 未知 profile 使用 POSIX 兜底。
4. Linux 实机验证普通文本粘贴和 Codex CLI 图片粘贴。

## 建议实施步骤

### 阶段 1: Windows 无行为变化重构

- 新增 Windows 默认 profile JSON。
- Rust 改为从 JSON 加载 defaults。
- 保持 Windows profile id、executable、args 不变。
- 实现 state 和 defaults 合并。
- `terminal_create` 支持请求中的完整自定义 profile。
- 保留所有 Windows 特有逻辑。
- 验证 Windows 构建和现有功能。

### 阶段 2: 自定义 profile UI

- 设置页支持新增 profile。
- 设置页支持删除用户自定义 profile。
- 设置页支持编辑 args。
- 默认 profile 单选逻辑支持新增 profile。
- 对内置 profile 和用户 profile 做清晰展示。

### 阶段 3: Linux defaults 和平台行为

- 新增 Linux 默认 profile JSON。
- 增加 POSIX path quoting。
- 调整 executable 检测平台差异。
- Linux 下隐藏或禁用打开目录按钮。
- 确认非 Windows 剪贴板文件转路径保持空实现。
- 增加 Linux bundle target。

### 阶段 4: Linux 实机验证

- 在 Linux 机器上安装 Tauri 依赖。
- 跑 `npm run build`。
- 跑 `cargo check`。
- 跑 `npm run tauri dev`。
- 验证 bash/zsh/fish/pwsh 启动。
- 验证终端输入输出、resize、关闭、重启。
- 验证项目和 tab 恢复。
- 验证普通文本粘贴。
- 验证拖拽文件路径插入。
- 验证 Codex CLI 在 Linux 终端中的图片粘贴行为。

## 验证清单

Windows 回归：

- PowerShell 能启动。
- PowerShell 7 能启动。
- CMD 能启动。
- Git Bash 能启动，包含自定义安装路径。
- WSL 能启动。
- 添加项目目录后自动创建默认终端。
- 保存并重启后项目和 tabs 恢复。
- 拖拽文件插入路径。
- Explorer 复制文件后粘贴为路径。
- 截图剪贴板粘贴为临时图片路径。
- 清理粘贴临时文件。
- 关闭单个终端和关闭全部终端。

Linux MVP：

- 首次启动出现 Linux 默认 profiles。
- `$SHELL` 能正确展开。
- bash 或 zsh 能启动。
- 自定义 profile 能新增并启动。
- POSIX 路径插入 quoting 正确。
- 打开文件管理器入口不会导致崩溃。
- 普通文本粘贴可用。
- state 保存和恢复可用。
- 打包产物可生成。

## 工作量判断

按当前前提，整体工作量不大。主要是把已经存在的 shell profile 概念从“后端内置列表”升级为“平台 defaults 加用户配置”的模型。

推荐按阶段推进，先做 Windows 无行为变化重构，再加 Linux defaults。这样可以最大程度保护当前成熟的 Windows 版本。
