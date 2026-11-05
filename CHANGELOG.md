# Change Log

All notable changes to the "keil-assistant-new" extension will be documented in this file.

## [2.6.3] - 2026-11-05

### 新增功能 🚀

- **Debug 页新增「调试器适配器设置（J-Link / J-Trace）」区**：对应 uVision 的 `Debug → Settings`（Cortex JLink/JTrace Target Driver Setup）弹窗
  - **调试接口 Port**：JTAG / SW
  - **最大时钟 Max Clock**：50/33/25/20/10/5/3/2/1 MHz、500/200 kHz（同时维护 `-S` 速度码与 `-ZTIFSpeedSel`）
  - **Connect**：Normal / with Pre-reset / under Reset；**Reset**：Normal / Core / Reset Pin / Connect under Reset / Halt after Bootloader / Halt before Bootloader / Kinetis / ADI Halt after Kernel / Core and Peripherals / LPC1200
  - **Reset after Connect** 开关
  - **Interface**：USB / TCP-IP，含 IP 地址与端口（`-JU/-JI/-JP`）
  - 所有项写入 `.uvoptx` 的 `TargetDriverDllRegistry`（JL2CM3）参数串；仅改动适配器标志位，串号、JTAG 链、Trace 与 Flash 设置逐字节保留
- 新增模块 `src/project/options/jlinkSettings.ts`（读取/写回/选项表），面板仅在工程存在 J-Link 驱动记录时显示该分区

### 优化改进 ✅

- `npm run smoke` 扩展到 96 项：新增 J-Link 适配器设置读写断言（Port/速度/Connect/Reset/Interface/IP 端口）
- 扩展版本号更新至 2.6.3

### 已知限制 ⚠️

- Connect / Reset / Reset after Connect 的取值编码依据 uVision J-Link 驱动参数推导，保存后建议在 uVision 的 `Debug → Settings` 中核对一次
- 工程若尚未在 uVision 中打开过 Debug 设置（缺少 `TargetDriverDllRegistry/JL2CM3` 记录），该分区不会显示，也不会写入

## [2.6.2] - 2026-11-05

### 新增功能 🚀

- **Debug 页新增「调试器类型」下拉**（`debug` 标签页）：
  - 列表来自本机 Keil 安装 `TOOLS.INI` 的驱动表（ULINK2/ME、ULINK Pro、ULINKplus、CMSIS-DAP、J-LINK、Models、ST-Link、NULink、Pemicro、SiLabs、Altera、TI XDS 等，按 CPU 家族取对应 `CPUDLLn` 列表）
  - 支持「使用仿真器（Use Simulator）」；选择后保存会同步维护 `.uvoptx` 的 `DebugOpt/uSim`、`uTrg`、`nTsel`、`pMon`
  - 新增只读/可编辑字段「调试器序号（nTsel）」，并保留原有 uSim/uTrg/pMon 等细项字段
- **Device 页新增「芯片型号」下拉**（`target` 标签页）：
  - 扫描本机 CMSIS-Pack（`TOOLS.INI` 的 `RTEPATH`，回退 `%LOCALAPPDATA%\\Arm\\Packs` / `<KeilRoot>\\PACK`）生成设备清单，实测本机约 1 万个器件；首次后台扫描数秒并写入缓存，完成后自动刷新面板
  - 设备数量大时，下拉框上方自动出现搜索框（按型号/厂商过滤）
  - 选择设备并保存后，按 Pack 同步更新 `.uvprojx` 的 `Device`、`Vendor`、`PackID`、`PackURL`、`Cpu`（内核/内存/FPU/DSP/TrustZone），以及可解析到的 `SFDFile`/`RegisterFile`
- 新增零依赖模块：`src/project/options/debuggerSelect.ts`（调试器选择读写）、`src/project/options/deviceDatabase.ts`（CMSIS-Pack 解析/扫描/设备写回）、`src/project/options/deviceCatalogService.ts`（缓存与后台扫描服务）

### 优化改进 ✅

- 面板为大枚举字段（>40 项，如器件列表）自动渲染搜索框，过滤不影响选中值
- `npm run smoke` 扩展到 84 项检查：真实 Pack 扫描、器件/调试器切换写回、`.uvprojx`/`.uvoptx` 双文件校验
- 扩展版本号更新至 2.6.2

### 已知限制 ⚠️

- 器件切换只更新器件/内核/内存等字段，**启动文件、Flash 下载算法与 `ArmAdsMisc/OnChipMemories` 不会自动重配**，请在 uVision 的 Options→Device/Utilities 中确认后再编译下载
- 器件列表包含本机 Pack 缓存（`.Web`/`.Download`）中的器件；同名器件会优先使用**已安装**的 Pack，但仅存在于缓存中的器件可能写入未安装的 PackID
- 调试器序号（`nTsel`）与 `DriverSelection` 的编号依赖本机 uVision 安装的驱动表，跨版本可能不一致
- 首次打开 Options 面板时若缓存为空，器件列表会在后台扫描完成后自动补齐（面板会提示“正在扫描”）

## [2.6.1] - 2026-11-05

### 新增功能 🚀

- **Options 面板新增只读「MCU 信息」区**（`target` 标签页）：
  - 从工程中的 `Device` / `Cpu` 描述解析器件型号、厂商、芯片包、内核（CPUTYPE）、主频、Flash / RAM 大小与起始地址、其他片上存储（`IRAM2`/`XRAM`/`OCR_RVCTn` 等）
  - 识别 `FPU`/`FPU2`/`FPU3`、`DSP`、`TrustZone`、大小端，并显示寄存器头文件与 SVD 文件
  - 覆盖 ARM / ARM6 / C51 / C251 四类工程（C51/C251 显示 `MCS-51 (8051)` / `MCS-251` 内核与片上存储）
- **Options 面板新增只读「调试器 / 下载信息」区**（`debug` 标签页）：
  - 调试器名称（由 `.uvoptx` 的 `DebugOpt/pMon` 或 `.uvprojx` 的 `DllOption` 解析，并对照本机 `TOOLS.INI` 得到可读名称）
  - 调试器驱动 DLL 与 **调试器版本**（读取 DLL 的 PE `VERSIONINFO` 文件版本）
  - Flash 下载算法 DLL 及其版本、**uVision 版本**（`UV4.exe` 文件版本）
- **`DriverSelection` 下拉列表补全**：改为按**本机 Keil 安装的 `TOOLS.INI`** 动态生成（编号 = 4096 + 本机驱动列表序号，完整列出本机全部调试驱动），不再使用不完整的推测列表；同时显示当前编号对应的调试器名称
- 新增零依赖模块：`src/project/fileVersion.ts`（PE `VERSIONINFO` 解析，含 PowerShell 回退）、`src/project/options/mcuInfo.ts`（Cpu 描述解析）、`src/project/options/keilInstall.ts`（`TOOLS.INI` 解析与驱动匹配）

### 优化改进 ✅

- 面板新增 `info` 只读字段类型：以纯文本渲染，不参与脏值跟踪与保存
- `npm run smoke` 增加 MCU 信息、驱动列表、调试器版本、uVision 版本的端到端断言（本机存在 Keil 安装时启用）
- 扩展版本号更新至 2.6.1

### 已知限制 ⚠️

- `DriverSelection` 编号依赖生成该工程的 uVision 安装；跨版本安装时编号可能不一致，面板会标注「未在本机驱动列表中」；勾选「使用调试驱动」时该值仅作记录
- 调试器 / 下载信息为只读展示，实际调试器与下载参数仍以 uVision 的 Options→Debug/Utilities 为准

## [2.6.0] - 2026-11-05

### 新增功能 🚀

- **工程文件管理**：在工程树中直接维护分组与文件，无需打开 Keil uVision
  - 分组：新建、重命名、删除分组
  - 文件：通过文件对话框添加源文件到分组、新建源文件并加入工程、从工程移除文件、移动文件到其他分组
  - 编译开关：切换分组 / 文件是否参与编译（`IncludeInBuild`）
  - 所有操作只作用于当前活动目标，仅修改对应 `<Groups>` 节点并自动刷新工程树
- **Options for Target 面板**：新增 `project.options` 命令，以 Webview 面板编辑工程选项
  - 覆盖 `target` / `output` / `ccpp` / `asm` / `linker` / `debug` / `utilities` 共 7 个标签页
  - 同时读写 `.uvprojx` 与 `.uvopt/.uvoptx` 双文件，支持目标切换、重新加载与打开工程文件
  - 支持 ARM / ARM6 / C51 / C251 四类工具链；不适用字段自动禁用并说明原因
- **写回安全机制**
  - 严格 UTF-8 校验：非 UTF-8 工程文件只读并提示原因，避免破坏中文工程
  - BOM 保留：写回后保持原文件原有的 UTF-8 BOM 状态
  - 写前自动备份：默认备份到扩展全局存储目录，不污染用户工程目录
  - 原子写入与 `EBUSY` 重试：临时文件 + 重命名写入，文件被 uVision 占用时重试 5 次（每次 200ms），仍失败则提示先关闭工程
- **新增设置** `KeilAssistant.Project.BackupBeforeWrite`（boolean，默认 `true`）：控制写回工程文件前是否自动备份
- 新增命令：`project.options`、`project.addFilesToGroup`、`project.newFile`、`project.removeFile`、`project.addGroup`、`project.renameGroup`、`project.removeGroup`、`project.moveFileToGroup`、`project.toggleFileInBuild`、`project.toggleGroupInBuild`

### 优化改进 ✅

- 工程树标题栏新增 Options 入口；工程/目标/分组/源文件右键菜单按编辑、文件、选项、编译分组整理
- README / README_EN 新增工程文件管理与工程选项章节，补充命令表、7 个标签页说明与写回限制
- 新增 `npm run validate:corpus` 脚本，可对本地 Keil 工程语料批量校验 XML 解析与无编辑 round-trip 一致性
- 新增 `npm run smoke` 接线冒烟脚本（stub VS Code API），覆盖命令注册、工程文件写回、工程树刷新与 Options 面板读写链路
- 扩展版本号更新至 2.6.0

### 已知限制 ⚠️

- 不修改 `.uvoptx` 中与调试器注册表（`TargetDriverDllRegistry`）相关的键值，仅处理常规可读写字段
- 不支持 RTE（Run-Time Environment）组件的增删
- 工程缺少同名 `.uvopt/.uvoptx` 时，相关字段在面板中标记为不可用，扩展不会自动创建该文件
- 面板暂不包含断点、变量监控与调试器接入等运行时调试能力

## [2.5.2] - 2026-03-25

### 优化改进 ✨

- 移除 README 与仓库说明中引用的 Marketplace 高风险截图，避免继续展示带有 VS Code、Copilot、Live Share 等第三方界面元素的素材
- 为中英文 README 补充明确的仓库与问题反馈链接，便于扩展市场审核核对社区分支归属
- 新增回归测试，防止后续版本重新引入上述截图引用
- 保持扩展 ID、发布者、`KeilAssistant.*` 配置键和运行行为不变，继续兼容老用户升级路径

## [2.5.1] - 2026-03-25

### 优化改进 ✨

- 调整扩展市场可见标识，明确声明这是原版 Keil Assistant 的社区维护分支
- 更新扩展显示名、简介、设置分组标题与中英文 README 首页，降低与原扩展的混淆度
- 替换为新的社区分支图标，同时保持扩展 ID 与 `KeilAssistant.*` 配置键不变，避免影响老用户升级路径

## [2.5.0] - 2026-03-24

### 新增功能 🚀

- 新增兼容性优先的工程树选项：
  - `KeilAssistant.ProjectExplorer.RememberExpandedState`
  - `KeilAssistant.ProjectExplorer.SortOrder`
  - `KeilAssistant.ProjectExplorer.AutoRevealCurrentFile`
- 新增命令：
  - `Refresh Keil Project`
  - `Clear Project Cache And Refresh`
  - `Reveal Current File In Keil Project`
- 将常用工程树动作补充到工程树标题栏和项目右键菜单，减少只依赖命令面板的使用成本

### 修复问题 🔧

- `c_cpp_properties.json` 改为合并更新插件管理的配置项，尽量保留用户自定义字段，减少误覆盖
- 在打开工程和执行 build/rebuild/download 前增加更明确的路径校验，遇到无效 `UV4.exe`、工程文件或工程目录时更早报错
- 增强工程刷新与缓存清理后的恢复流程，降低缓存失效导致的工程加载失败问题

### 兼容性说明 🔗

- 默认行为保持兼容老用户：
  - `RememberExpandedState = false`
  - `SortOrder = legacy`
  - `AutoRevealCurrentFile = false`
- 新增命令本轮仅通过命令面板提供，不增加常驻侧栏按钮
- 新增测试入口和单元测试覆盖配置合并、路径校验与工程树状态逻辑

## [2.4.1] - 2025-12-29

### 优化改进 ✨

- 启动时自动加载工作区内全部 Keil 工程
- 记住上次激活工程，避免下次启动重复选择
- 侧栏项目列表标记当前激活工程（*）
- Open 工程时自动激活对应工程
- 切换目标/关闭工程时同步持久化当前工程
- 关闭的工程不会在下次启动自动加载

## [2.4.0] - 2025-12-23

### 优化改进 ✨

- 更新 Chat Tools 的警告提示，减少对用户工作流的干扰
- 更新 Chat Tools 工具名称，符合命名最佳实践
- 更新工具链判断逻辑，支持 C51 项目识别

### 修复问题 🔧

- 增强 build-tool 的 exitCode 处理逻辑，覆盖未定义退出代码的情况

## [2.3.1] - 2025-12-22

### 修复问题 🔧

- 修复多工作区场景下 C/C++ 配置写入到工作区根目录的问题，改为写入各项目目录的 `.vscode`

## [2.3.0] - 2025-12-21

### 新增功能 🚀

- **GitHub Copilot Chat 集成**: 为插件新增 Language Model Tools 支持，使 GitHub Copilot 能够直接调用 Keil Assistant 功能
  - **编译工具** (`keil-assistant_buildProject`): 支持编译或重新编译指定目标，实时返回编译结果和错误信息
  - **项目信息工具** (`keil-assistant_getProjectInfo`): 获取项目详细信息，包括项目类型、目标列表、源文件等
  - **自然语言交互**: 用户可以在 Copilot Chat 中用自然语言执行操作，如 "帮我构建项目"、"构建STC8A目标"
  - **自动化迭代**: 编码代理可以通过调用工具实现 "编写-编译-修复" 的完整自动化开发流程，可获得详细的编译失败信息
  - **工具可见性**: 所有工具自动在 VS Code 的 "配置工具" 界面显示，可以明确禁用工具使LLM不进行工具调用

## [2.2.1] - 2025-12-10

### 新增功能 ✨

- **智能C/C++配置管理**: 新增项目标签支持，C/C++配置名称现在使用"项目名_目标名"格式，避免多项目配置冲突
- **自动配置切换**: 切换目标时自动应用对应的C/C++配置，无需手动选择
- **增强的配置检测**: 自动检测并迁移旧版本配置，确保向后兼容
- **新增C251支持**: 完整支持Keil C251项目，包括自动检测、编译和下载功能
- **WSL环境检测**: 新增WSL环境检测，当运行在WSL中时提供明确的错误提示

### 系统头文件检测重大优化 🔧

- **全新智能检测算法**: 大幅改进Keil系统头文件路径检测机制
  - 支持完整Keil V5安装（ARMCC + ARMCLANG双编译器）
  - 支持不完整Keil V5安装（仅ARMCLANG编译器）
  - 支持Keil V6版本（AC6目录结构）
  - 多重fallback机制确保100%检测成功
- **详细调试日志**: 新增完整的路径检测调试信息，便于问题定位
- **智能工具链选择**: 根据uAC6标志和实际安装情况自动选择最合适的编译器路径
- **错误诊断增强**: 当检测失败时提供详细的错误信息和解决建议

### 用户体验改进 🎯

- **异步操作优化**: 目标切换和配置应用改为异步操作，避免界面阻塞
- **配置自动应用**: 项目激活时自动应用对应的C/C++配置设置
- **更好的错误处理**: 增强了异常捕获和错误提示，提升稳定性
- **任务执行优化**: 使用ProcessExecution替代ShellExecution，提升任务执行的可靠性和性能

### 技术细节 📝

- 新增 `applyActiveCppConfiguration()`方法，实现配置的智能应用
- 优化 `setActiveTarget()`方法，支持异步操作和自动配置切换
- 改进 `getSystemIncludes()`方法，添加详细的调试输出和智能路径检测
- 配置名称清理函数 `sanitizeConfigNamePart()`，确保文件名合法
- 新增 `C251Target`类，完整支持C251项目类型
- 任务执行改为使用 `ProcessExecution`，避免Shell相关的问题

### 兼容性改进 🔗

- **向后兼容**: 自动迁移旧版本的C/C++配置，无需用户手动调整
- **WSL友好**: 明确提示WSL环境限制，引导用户正确使用环境
- **VSCode兼容**: 优化任务执行机制，提升与新版本VSCode的兼容性

## [2.1.7] - 2025-08-26

### 重大修复 🔧

- **修复**: Keil 系统头文件路径检测失败导致 IntelliSense 功能异常的问题
- **增强**: 全新的智能头文件路径检测算法，支持多种 Keil 安装场景：
  - 完整 Keil V5 安装（ARMCC + ARMCLANG 双编译器）
  - 不完整 Keil V5 安装（仅安装 ARMCLANG 编译器）
  - Keil V6 版本兼容支持（AC6 目录结构）
  - 多重 fallback 机制确保路径检测成功
- **改进**: 新增详细的调试日志输出，便于问题排查和诊断
- **修复**: 解决 c_cpp_properties.json 中缺少系统头文件路径导致的代码智能提示失效问题
- **提升**: 显著改善 VSCode 中 Keil 项目的 IntelliSense 和代码补全体验

### 技术细节 📝

- 智能检测 ARMCC 目录存在性，自适应选择合适的编译器路径
- 支持从 `XXX\UV4.exe` 路径自动推导系统头文件位置
- 兜底机制：当所有检测都失败时，使用 ARMCC 作为最兼容的选择
- 详细日志记录每个检测步骤，方便用户和开发者调试

## [2.1.6] - 2025-01-24

### 修复问题 🔧

- 修复 VSCode 1.103+ 版本兼容性问题：调整 Shell 任务执行参数处理方式，解决"实时系统找不到指定路径"的编译错误
- 修复 c_cpp_properties.json 文件位置变更导致的 IntelliSense 问题：确保文件生成在工作区 .vscode 目录中，解决代码波浪线报错问题

## [2.1.5] - 2025-06-09

### 优化改进 ✨

- 插件的消息弹窗1s后自动关闭

## [2.1.3] - 2025-05-09

### 修复问题 🔧

- 彻底解决VSCode“问题”面板中错误路径（特别是包含 `..`的路径）显示不正确及无法跳转的问题，改为插件手动解析编译日志并使用绝对路径生成诊断信息。
- 确保VSCode终端中Ctrl+点击错误路径（包括含 `..`的路径）能够正确定位到源代码。

### 优化改进 ✨

- 将插件生成的日志文件 (`keil-assistant.log`, `uv4.log`) 及 `c_cpp_properties.json` 的存储位置从工作区 `.vscode`目录迁移到VSCode全局插件存储区，并按项目ID进行隔离，保持工作区整洁。
- 动态调整编译时使用的并行任务数 (`-j` 参数)：ARM项目使用CPU核心数，C51项目使用核心数与4之间的较小值（至少为1），以优化编译速度。

## [2.1.2]

### 修复问题 🔧

- 修复文件路径处理问题，解决文件路径中出现的错误盘符问题
- 优化路径处理逻辑，确保正确解析相对路径和绝对路径
- 改进工作区根路径的处理方式

## [2.1.0]

### 新增功能 ✨

- 添加智能项目自动搜索功能
- 新增状态栏快捷按钮
- 实现多核心并行编译支持
- 添加跨模块优化（CMO）支持
- 优化项目类型自动识别

### 性能优化 🚀

- 提升编译速度高达 300%
- 减少项目加载时间 50%
- 优化内存占用，降低 30%

### 用户体验改进 🎯

- 重新设计状态栏按钮布局
- 添加编译进度实时显示
- 优化项目切换体验
- 改进错误提示信息

### 修复问题 🔧

- 修复项目自动加载问题
- 解决多项目冲突问题
- 修复编译参数设置问题

## [2.0.0]

- **Note:** This project is now maintained by a new team. Development continues from this version onwards.
- Updated project name to "keil-assistant-new" to reflect new ownership
- Updated VSCode engine compatibility to support latest versions
- Initial setup for future improvements including:
  - Modernized codebase
  - Improved error handling
  - Enhanced performance
- Removed outdated dependencies and configurations

---

## [v1.7.1]

- Fixed: can't use shortcut key

---

## [v1.7.0]

- Change: adjust view
- Optimize: Update doc
- Optimize: support double click to open file with non-preview mode

---

## [v1.6.2]

- Fixed: output messy code
- Optimize: extend more armcc keywords

---

## [v1.6.1]

- Fixed: error rebuild command

---

## [v1.6.0]

- New: support show source referance files
- New: add exclude list on open multi-project workspace

---

## [v1.5.0]

- New: add 'Active Target' button
- Changed: adjust keybindings

---

## [v1.4.0]

- New: support multi-target keil project
- New: add armclang cpp macros

---

## [v1.3.3]

- Optimize: extend more armcc keywords

---

## [v1.3.2]

- Fixed: some incorrect C51 keywords
- Fixed: some other bugs

---

## [v1.3.1]

- Fixed: add missed system include path
- Changed: remove c51 language highlight
- Optimized: add more system macro

---

## [v1.3.0]

- Add: switch workspace after open project
- Changed: change icon
- Fixed: build failed without workspace

---

## [v1.2.1]

- Add: Add some internal defines for ARM/C51

---

## [v1.2.0]

- Fixed: Can't run task by CMD
- Add: Shortcut keys

---

## [v1.1.0]

- Fixed: Not found C51/STM32 system include dir
- Fixed: Invalid macro

---

## [v1.0.0]

- First release
