# mutishell

mutishell 是一个纯 Rust 的 Windows 项目目录与原生终端启动器。

它不使用 Tauri、React 或 WebView2。界面由 eframe/egui 直接绘制，项目目录、
Shell 配置与主题保存在本地 JSON 文件中。

## 功能

- 左侧项目目录管理：添加、搜索、拖动排序和移除。
- 可拖动调整侧栏宽度，宽度会在下次启动恢复。
- PowerShell 7、Windows PowerShell、Command Prompt、Git Bash、WSL 的可编辑
  Shell Profile。
- 在选中项目目录中启动独立的系统终端窗口。
- 原生设置窗口，管理 Shell 路径、默认 Shell 和项目目录。
- 最小化时隐藏到 Windows 通知区域托盘。
- 右键托盘图标显示全部项目目录；点击目录会直接使用默认 Shell 打开终端。

## 运行

需要 Rust stable MSVC 工具链和 Windows 图形运行环境。

开发运行：

    cargo run --manifest-path src-tauri/Cargo.toml

发布构建：

    cargo build --release --manifest-path src-tauri/Cargo.toml

生成的可执行文件：

    src-tauri\target\release\mutishell.exe

## 项目结构

    src-tauri/
      Cargo.toml                  原生应用依赖
      src/
        main.rs                   二进制入口
        lib.rs                    原生 UI、托盘、配置与终端启动逻辑

## 配置

配置文件保存在：

    %APPDATA%\mutishell\state.json

旧版配置仍可读取。旧的内嵌终端标签和 WebView 配置字段会在下次保存时自动丢弃。

## 原生终端

每次启动都会校验项目目录和 Shell 可执行文件。Windows 上使用
CREATE_NEW_CONSOLE 创建独立控制台窗口，因此外部终端不会占用或依赖
mutishell 的进程内存。
