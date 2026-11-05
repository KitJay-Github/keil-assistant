# Keil Assistant Community Fork

> 面向 Keil MDK / C51 工程的社区维护版 VS Code 扩展。
>
> 在原版 Keil Assistant 停止更新后继续维护，并补充工程文件管理、Options for Target 编辑、AI 集成与兼容性优先的工程树改进。

## What Is Different In This Edition?

- This repository is the community-maintained continuation of the original Keil Assistant for VS Code.
- Community-maintained fixes and releases after the original extension stopped active updates
- Project file and target option management directly inside VS Code (new in 2.6.0)
- GitHub Copilot Chat Tools integration for build and project queries
- Compatibility-first project explorer improvements that preserve old defaults
- Safer `c_cpp_properties.json` merging and clearer recovery commands

## Project Origin

- This repository started from the original **Keil Assistant** codebase and now follows its own maintenance and release cycle.
- Existing installs keep the same extension ID and `KeilAssistant.*` settings keys.
- Repository: <https://github.com/ruiwarn/keil-assistant>
- Issues: <https://github.com/ruiwarn/keil-assistant/issues>

## 概述

Keil Assistant 在 VS Code 与 Keil uVision 工程之间搭起桥梁：无需离开 VS Code，即可浏览工程树、编译/下载工程、维护工程文件与目标选项，并为 C/C++ 扩展生成 IntelliSense 配置，覆盖 ARM、C51 与 C251 工程。

**基本信息：**

- 扩展市场 ID：`candycium.keil-assistant-new`
- 兼容 Keil uVision 5 及以上版本
- Windows 专用（Keil uVision 仅支持 Windows）
- 需要 [C/C++ 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) 提供语言服务

## Features

### Project Management

- Auto-discovers Keil C51/ARM/C251 projects in workspace
- Native project explorer with file tree, targets, and groups
- **NEW — Project file management**: create, rename and delete groups; add, remove or create source files; move files between groups; toggle build inclusion per file or group
- **NEW — Options for Target panel**: edit the seven Keil option tabs in a webview, reading and writing both `.uvprojx` and `.uvopt/.uvoptx`
- **NEW — Safe write-back**: strict UTF-8 validation, BOM preservation, automatic backups, atomic writes and `EBUSY` retries
- Automatic `c_cpp_properties.json` generation for C/C++ IntelliSense
- Watch Keil project files and sync changes in real time

### Build & Debug Workflow

- One-click build, rebuild, and download from VS Code status bar
- Target switching without opening Keil uVision
- Multi-core build execution when toolchain supports it
- Build output parsing with error navigation

### AI Integration (GitHub Copilot)

- `keil-assistant_buildProject` — build or rebuild via natural language
- `keil-assistant_getProjectInfo` — query project structure and active target
- Inspect build failures with file paths, line numbers, and error codes

### Compatibility-First Design

- Existing `KeilAssistant.*` config keys remain unchanged
- Optional explorer enhancements (sorting, auto-reveal, state restore) default to off
- Safer merge strategy for `c_cpp_properties.json` to avoid overwriting user fields

## 工程文件管理

在工程树中直接维护 Keil 工程的分组与文件。所有修改只作用于**当前活动目标**，保存后自动刷新工程树；多目标工程请先在工程树上切换目标。

| 命令 | 说明 | 入口 |
| --- | --- | --- |
| `project.options`（工程选项(Options for Target)…） | 打开目标选项面板，见下一节 | 工程树标题栏、工程/目标右键菜单、命令面板 |
| `project.addFilesToGroup`（添加文件到分组…） | 选择一个或多个已存在的源文件加入分组，工程中已存在的文件会自动跳过 | 工程/目标/分组右键菜单 |
| `project.newFile`（新建源文件并加入工程…） | 在工程目录按扩展名创建模板文件，加入所选分组并打开 | 工程/目标/分组右键菜单、命令面板 |
| `project.addGroup`（新建分组…） | 新建源文件分组，同名分组不会重复创建 | 工程/目标/分组右键菜单、命令面板 |
| `project.renameGroup`（重命名分组…） | 重命名分组，组内文件引用保持不变 | 分组右键菜单 |
| `project.removeGroup`（删除分组） | 二次确认后删除分组及其文件引用（不会删除磁盘上的文件） | 分组右键菜单 |
| `project.removeFile`（从工程移除文件） | 二次确认后从工程中移除文件引用（不会删除磁盘上的文件） | 源文件右键菜单 |
| `project.moveFileToGroup`（移动文件到分组…） | 把文件移动到同一目标下的其他分组 | 源文件右键菜单 |
| `project.toggleFileInBuild`（切换文件是否参与编译） | 切换文件的 `IncludeInBuild`（`1`/`0`），不修改文件内容 | 源文件右键菜单 |
| `project.toggleGroupInBuild`（切换分组是否参与编译） | 切换分组级的 `IncludeInBuild`（`1`/`0`） | 分组右键菜单 |

> 提示：`project.options`、`project.addGroup`、`project.newFile` 同时出现在命令面板（需打开工作区目录）；其余命令仅在工程树上下文菜单中提供，避免误操作。

## 工程选项 (Options for Target)

`project.options` 打开基于 Webview 的 Options 面板，用 VS Code 主题样式编辑 Keil「Options for Target」对话框中的常用配置。

**面板能力：**

- 顶部显示工程名与目标下拉框，可切换目标、保存、重新加载，以及打开工程文件（`.uvprojx` / `.uvopt/.uvoptx`）。
- 左侧为标签页导航，右侧为按分区组织的表单；字段按类型渲染为输入框、多行文本框、复选框（`1`/`0`）或下拉框。
- 修改后显示未保存标记；保存成功后提示已写回的字段数量，并自动刷新工程树。
- 保存时同时处理 **`.uvprojx` 与 `.uvopt/.uvoptx` 双文件**：属于 `.uvprojx` 的字段写入工程文件，属于 `.uvopt` 的字段写入选项文件。
- 支持 ARM、ARM6、C51、C251 四类工具链；当前工具链不适用的字段会自动禁用并说明原因。
- 新增两个**只读信息区**：`target` 标签页的「MCU 信息」（器件、内核、主频、Flash/RAM 大小与地址、其他片上存储、FPU/DSP/TrustZone/大小端、寄存器头文件、SVD），以及 `debug` 标签页的「调试器 / 下载信息」（调试器名称、驱动 DLL 及**调试器版本**、Flash 下载算法及版本、**uVision 版本**）。
- `utilities` 中的 **DriverSelection 下拉列表按本机 Keil 的 `TOOLS.INI` 动态生成**（编号 = 4096 + 本机驱动列表序号），并显示当前编号对应的调试器名称；换用其他版本的 Keil 安装时编号含义可能不同。

**支持的 7 个标签页：**

| 标签页 | 主要内容 |
| --- | --- |
| `target` Target | 器件（Device/Vendor/PackID）、Cpu 参数、SFD 文件、Flash 驱动、晶振 Xtal、C51/C251 内存模型；只读「MCU 信息」 |
| `output` Output | 输出名与输出目录、Listing 目录、可执行文件/库/HEX 生成、调试与浏览信息、批处理文件、32K 合并、编译前后用户程序 |
| `ccpp` C/C++ | Define/Undefine、Include Paths、Misc Controls、优化等级与优化目标、告警等级、C99/GNU 开关 |
| `asm` Asm | 汇编宏定义、Include Paths、Misc Controls、Thumb/标准汇编等开关 |
| `linker` Linker | ARM 分散加载（Scatter）文件、地址范围、Ropi/Rwpi、不链接标准库；C51/C251 的 Lx51 配置 |
| `debug` Debug | 仿真/目标 DLL、调试器 DLL、Hex 显示选项、运行与停止行为、BeepAtEnd 等；只读「调试器 / 下载信息」 |
| `utilities` Utilities | Flash 下载算法 DLL、Use Target DLL/External Tool、调试前更新 Flash、bUseTDR、FcArmLst 等；DriverSelection 由本机 TOOLS.INI 生成 |

**`.uvopt/.uvoptx` 限制：**

- 工程缺少同名 `.uvopt/.uvoptx` 文件时，属于该文件的字段（如 Xtal、调试器相关项）会标记为「不可用」并显示原因；扩展不会自动创建该文件。
- 扩展只读写 `.uvoptx` 中的常规可编辑字段，不会修改与调试器注册表（`TargetDriverDllRegistry`）相关的键值。
- 不提供 RTE（Run-Time Environment）组件的增删能力。

**备份与写回安全：**

- 默认开启 `KeilAssistant.Project.BackupBeforeWrite`：每次写回前把原文件复制到扩展全局存储目录（不污染用户工程目录），文件名形如 `main.uvprojx.20261105-143201-123.bak`；可在设置中关闭。
- 写回只替换发生变化的节点，保留原文件其余内容与格式，并保持原有 UTF-8 BOM 状态。
- 非 UTF-8 编码的工程文件只读，禁止写回并提示原因，避免破坏中文工程。
- 写入采用「临时文件 + 重命名」的原子写入；文件被 Keil uVision 占用（`EBUSY/EPERM`）时重试 5 次（每次 200ms），仍失败会提示先关闭 uVision 中打开的工程。

## 快速开始

1. 安装 [C/C++ 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
2. 从扩展市场安装 Keil Assistant
3. 将 `KeilAssistant.MDK.Uv4Path` 或 `KeilAssistant.C51.Uv4Path` 设置为 `UV4.exe` 的绝对路径
4. 打开包含 `.uvprojx` / `.uvproj` 文件的文件夹
5. 工程会自动加载，即可通过状态栏或工程树编译、下载，并在工程树中维护文件与选项

## 运行要求

- Windows（Keil uVision 仅支持 Windows）
- Keil uVision 5 或更高版本
- VS Code 1.85.0 或更高版本

## 仓库与反馈

- **源码：** <https://github.com/ruiwarn/keil-assistant>
- **问题反馈：** <https://github.com/ruiwarn/keil-assistant/issues>
- **扩展市场：** `candycium.keil-assistant-new`

## 社区

由嵌入式开发者维护、为嵌入式开发者服务。欢迎提交贡献、缺陷报告与功能建议。

---

*This is a community-maintained continuation starting from v2.0.0. The original project is no longer actively updated.*
