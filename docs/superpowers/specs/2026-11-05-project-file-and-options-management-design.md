# 工程文件管理与 Options 管理设计

> 状态：已确认，进入实施
> 关联版本：2.6.0
> 基线提交：`82e1516`（ruiwarn/keil-assistant master）

## 背景

当前扩展对 `.uvproj/.uvprojx` 只做**只读解析**（`xml2js` 解析后构建工程树），因此用户无法在 VS Code 内完成两件高频操作：

1. 维护工程文件与分组（新增/删除/重命名分组，加入/移除文件，移动文件，切换是否参与编译）。
2. 维护 Keil「Options for Target」中的常用配置（输出、C/C++、汇编、链接、调试、下载与魔术棒工具配置）。

历史版本在 `docs/superpowers/specs/2026-03-24-compatible-issue-support-design.md` 中明确写过「不支持 `.uvproj/.uvprojx` 写回」。本次工作正式解除该限制，但必须以**最小侵入、可回退、可测试**的方式实现。

## 目标

- 在工程树上下文中提供完整的工程文件管理命令。
- 提供 Webview 形式的「Options for Target」面板，覆盖 Keil 选项对话框的主要标签页。
- 所有写回必须：保留原文件其余内容与格式、UTF-8 编码与 BOM 状态不变、写前自动备份、写后自动刷新工程树。
- 新增逻辑尽量抽为纯函数模块，`src/extension.ts` 只做接线。
- 具备单元测试；在不具备 Keil 环境的机器上 `npm test` 可全部通过。

## 非目标

- 不实现断点、变量监控、调试器接入等运行时调试能力。
- 不实现 RTE（Run-Time Environment）组件的增删。
- 不修改 `.uvoptx/.uvopt` 中与调试器注册表（`TargetDriverDllRegistry`）相关的二进制式键值，仅处理可读写的常规字段。
- 不引入新的运行时依赖（不新增 npm `dependencies`）。
- 不改变现有 build / rebuild / download / 工程树默认交互。

## 兼容性护栏

1. **只读场景不受影响**：未使用新命令时，行为与 2.5.2 完全一致。
2. **解析失败即放弃写回**：任何一次写回前都重新解析；结构不符合预期（找不到 `<Project>`、找不到目标、找不到分组）时只提示错误，不写文件。
3. **写前备份**：默认开启（`KeilAssistant.Project.BackupBeforeWrite`），备份写入扩展全局存储目录，不污染用户工程目录。
4. **非 UTF-8 文件只读**：检测到非 UTF-8 编码时禁止写回并提示用户，避免破坏中文工程。
5. **文件被 Keil 占用时重试并给出明确提示**：`EBUSY/EPERM` 重试 5 次（每次 200ms），仍失败则提示「请先关闭 uVision 中打开的工程」。
6. **面板只读字段明确标注**：`.uvoptx` 缺失时，Xtal/Debug 字段标记为不可用并给出原因，而不是猜测写值。

## 设计总览

```
┌──────────────────────────── src/extension.ts（接线，Lead 负责）────────────────────────────┐
│  registerProjectFileCommands(services)            OptionsPanelHost 适配层                    │
│         │                                                  │                                │
│         ▼                                                  ▼                                │
│  src/project/projectFileCommands.ts（A）        src/project/optionsPanel.ts（C）            │
│         │                                                  │  ▲                             │
│         ▼                                                  ▼  │ postMessage                 │
│  src/project/uvGroups.ts（A）                    res 无依赖：panelAssets.ts 内联 HTML/CSS/JS │
│         │                                                  │                                │
│         ▼                                                  ▼                                │
│  src/project/options/uvOptions.ts（B）  ←──  uvOptionSchema.ts（B）                         │
│  src/project/options/uvoptFile.ts（B）                                                      │
│         │                                                                                   │
│         └──────────────┬───────────────┘                                                    │
│                        ▼                                                                    │
│              src/project/uvXml.ts（Lead）：偏移保留 XML DOM + 文本级编辑                     │
│              src/project/projectFileIo.ts（Lead）：编码/备份/原子写/EBUSY 重试               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**为什么不用 `xml2js` 重写整份文件**：`xml2js` 回写会重排缩进、丢失属性/空元素形态、改写 XML 声明，导致 `git diff` 全文件变化，且 uVision 对格式敏感。因此新增自研「偏移保留」解析器，只对变更区间做文本替换。

## 模块与文件归属

| 归属 | 文件 |
| --- | --- |
| Lead | `src/project/uvXml.ts`、`src/project/projectFileIo.ts`、`src/project/options/types.ts`、`src/extension.ts`、`src/test/uvXml.test.ts`、`src/test/projectFileIo.test.ts`、`src/test/fixtures/**`、`scripts/integration-smoke.js`、本文档 |
| A | `src/project/uvGroups.ts`、`src/project/projectFileCommands.ts`、`src/test/uvGroups.test.ts` |
| B | `src/project/options/uvOptionSchema.ts`、`src/project/options/uvOptions.ts`、`src/project/options/uvoptFile.ts`、`src/project/options/viewData.ts`、`src/test/uvOptions.test.ts`、`src/test/uvoptFile.test.ts`、`src/test/optionsViewData.test.ts` |
| C | `src/project/optionsPanel.ts`、`src/project/options/panelAssets.ts`、`src/project/options/protocol.ts`、`src/test/panelAssets.test.ts`、`src/test/optionsProtocol.test.ts` |
| D | `package.json`（contributes）、`README.md`、`README_EN.md`、`CHANGELOG.md`、`scripts/validate-keil-corpus.js`、`src/test/packageContributions.test.ts`（扩展） |

禁止跨归属修改文件。需要对方改动时通过 Lead 协调。

## 1. 核心层：`src/project/uvXml.ts`

### 数据结构

```ts
export interface XmlTextEdit { start: number; end: number; text: string; }

export interface XmlElement {
    name: string;
    attributes: Array<{ name: string; value: string }>;
    children: XmlElement[];
    parent?: XmlElement;
    start: number;        // '<' 位置
    startTagEnd: number;  // 开始标签 '>' 之后
    innerEnd: number;     // 结束标签 '<' 位置；自闭合时等于 startTagEnd
    end: number;          // 结束标签 '>' 之后；自闭合时等于 startTagEnd
    selfClosing: boolean;
}

export interface XmlDocument { root: XmlElement; source: string; }

export function parseXml(source: string): XmlDocument;                  // 容错解析；结构非法抛错
export function childElements(el: XmlElement, name: string): XmlElement[];
export function firstChild(el: XmlElement, name: string): XmlElement | undefined;
export function findPath(root: XmlElement, path: string[]): XmlElement | undefined;
export function findPaths(root: XmlElement, path: string[]): XmlElement[];   // 支持重复节点（如 Target）
export function getAttribute(el: XmlElement, name: string): string | undefined;
export function textOf(el: XmlElement): string;                        // 已解码实体
export function escapeXmlText(value: string): string;
export function escapeXmlAttribute(value: string): string;
export function decodeXmlText(value: string): string;
export function detectIndentUnit(source: string): string;              // 默认 '  '
export function indentOf(source: string, el: XmlElement): string;      // 该元素所在行行首缩进
export function indentAt(source: string, pos: number): string;

export function buildLeafElement(name: string, value: string, indent: string): string;
//  -> `${indent}<Name>value</Name>`
export function buildContainerElement(
    name: string, childrenXml: string[], indent: string, unit: string
): string;
```

### 编辑器

```ts
export type ApplyOutcome = 'unchanged' | 'updated' | 'created';

export class XmlEditor {
    constructor(doc: XmlDocument);
    readonly doc: XmlDocument;
    get dirty(): boolean;

    textAt(base: XmlElement, path: string[]): string | undefined;
    setTextAt(base: XmlElement, path: string[], value: string): ApplyOutcome;          // 缺失则创建整段路径
    setAttributeAt(base: XmlElement, path: string[], attr: string, value: string): ApplyOutcome;
    insertChildXml(base: XmlElement, pathToParent: string[], fragmentXml: string): boolean; // fragment 由调用方按缩进生成
    removeAt(base: XmlElement, path: string[]): boolean;                              // 删除首个匹配
    removeAllAt(base: XmlElement, path: string[]): number;
    appendChild(base: XmlElement, childXml: string): boolean;                          // base 为父元素

    apply(): string;   // 按 offset 降序应用编辑，返回新文本
}
```

**实现要求**

1. 解析器必须正确处理：XML 声明、注释、CDATA、单/双引号属性、自闭合标签、`\r\n` 与 `\n` 混排、元素间文本。
2. `parseXml(source)` + 空编辑 → `apply()` 必须与 `source` **逐字节一致**（round-trip 不改动）。
3. `setTextAt` 只替换叶子元素的内部文本；若整段路径缺失，则在**最深层已存在祖先**的结束标签前插入按现有缩进生成的嵌套片段。
4. 同一父元素多次追加时保持调用顺序（`apply()` 对同 offset 的插入按登记顺序拼接）。
5. 元素文本内的 `&`、`<`、`>` 必须转义；读回时反转义。
6. 不允许在 `apply()` 中重新解析整段文本去回填 offset（编辑全部基于原始 source 计算）。
7. 新增缩进：父元素缩进 + `detectIndentUnit`；自闭合父元素（如 `<Files/>`）先展开为成对标签再插入。

### 编码与写回：`src/project/projectFileIo.ts`

```ts
export interface ProjectTextFile { path: string; text: string; bom: boolean; encoding: 'utf8'; }

export function readProjectTextFile(filePath: string): ProjectTextFile;   // 非 UTF-8 抛 ProjectEncodingError
export class ProjectEncodingError extends Error { readonly filePath: string; }

export interface WriteResult { ok: boolean; backupPath?: string; error?: string; }
export function writeProjectTextFile(
    file: ProjectTextFile, nextText: string,
    options: { backupDir?: string; retries?: number; retryDelayMs?: number }
): Promise<WriteResult>;
```

**实现要求**

1. 读取：`fs.readFileSync` 取 Buffer → 识别并剥离 UTF-8 BOM → `new TextDecoder('utf-8', { fatal: true })` 严格解码；失败抛 `ProjectEncodingError`。
2. 写入：先写 `path + '.kltmp'`，再 `fs.renameSync` 覆盖；内容为 `BOM? + nextText`。
3. `EBUSY/EPERM/EACCES` 重试，默认 5 次，间隔 200ms，全部失败返回 `{ok:false, error}`。
4. `backupDir` 存在时，先把原文件复制为 `backupDir/<basename>.<yyyyMMdd-HHmmss-SSS>.bak`。
5. 写成功后不删除 BOM 状态记录；不对文件权限/属性做改动。

## 2. 工程文件管理：`src/project/uvGroups.ts`（A）

```ts
export type UvToolchainKind = 'ARM' | 'ARM6' | 'C51' | 'C251';

export interface UvFileEntry {
    fileName: string; filePath: string; fileType: number; includeInBuild: boolean;
}
export interface UvGroupEntry { name: string; includeInBuild: boolean; files: UvFileEntry[]; }
export interface UvTargetSummary { name: string; toolchain: UvToolchainKind; groupCount: number; fileCount: number; }

export function listTargets(xml: string): UvTargetSummary[];
export function detectToolchainOfTarget(xml: string, targetName: string): UvToolchainKind | undefined;
export function readTargetGroups(xml: string, targetName: string): UvGroupEntry[] | undefined;

export function addGroup(xml: string, targetName: string, groupName: string): string;
export function renameGroup(xml: string, targetName: string, oldName: string, newName: string): string;
export function removeGroup(xml: string, targetName: string, groupName: string): string;
export function addFiles(
    xml: string, targetName: string, groupName: string,
    files: Array<{ filePath: string; fileName: string; fileType: number }>
): { xml: string; added: string[]; skipped: string[] };
export function removeFile(xml: string, targetName: string, groupName: string, filePath: string): string;
export function moveFile(
    xml: string, targetName: string, fromGroup: string, toGroup: string, filePath: string
): string;
export function setFileInBuild(
    xml: string, targetName: string, groupName: string, filePath: string, include: boolean
): string;
export function setGroupInBuild(xml: string, targetName: string, groupName: string, include: boolean): string;

export function fileTypeForPath(filePath: string): number;
export function toUvProjectPath(projectDir: string, absPath: string): string;   // '.\src\main.c'
export function fromUvProjectPath(projectDir: string, uvPath: string): string;  // 绝对路径
```

**行为约定**

- `targetName` 必须存在，否则抛 `Error`（消息含目标名）。
- 分组名比较用精确匹配（区分大小写）；文件路径比较用 `normalize` + 小写 + `\\`→`/` 归一。
- `addGroup`：已存在同名分组时原样返回（幂等）。
- `addFiles`：目标分组不存在时自动创建；重复文件进入 `skipped`；`<Files>` 缺失时创建。
- `removeFile`/`removeGroup`：不存在时原样返回（幂等）。
- `setFileInBuild(false)` 写 `IncludeInBuild=0`；`true` 写 `1`。`FileOption/CommonProperty` 缺失时创建。
- `setGroupInBuild` 同理，路径 `GroupOption/CommonProperty/IncludeInBuild`。
- `removeGroup` 需连同其 `<Files>` 一并删除。
- `fileTypeForPath`：`.c`→1、`.cpp/.cc/.cxx/.c++`→8、`.s/.asm/.a51`→2、`.lib/.a`→4、`.o/.obj`→3、图片(`.png/.jpg/.gif/.bmp`)→9、`.html/.htm/.inp`→7、其余→5。
- `toUvProjectPath`：优先 `.\` 前缀 + 反斜杠；跨盘符时返回 `path` 绝对形式；`fromUvProjectPath` 反向解析（`.\`、`..\`、绝对路径都支持）。

### 命令层：`src/project/projectFileCommands.ts`（A）

```ts
export interface ProjectFileCommandContext {
    prjID: string;
    projectFile: string;   // 绝对路径
    projectDir: string;
    targetName: string;    // 当前活动目标
    toolchain: UvToolchainKind;
    groupName?: string;    // Source 所在分组
    filePath?: string;     // Source 绝对路径
}

export interface ProjectFileCommandServices {
    resolve(item: unknown): ProjectFileCommandContext | undefined;
    applyChange(
        ctx: ProjectFileCommandContext,
        mutate: (xml: string) => string,
        options?: { successMessage?: string }
    ): Promise<boolean>;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
}

export function registerProjectFileCommands(services: ProjectFileCommandServices): vscode.Disposable[];
```

命令与行为（`vscode.commands` id → 处理函数）：

| 命令 | 行为 |
| --- | --- |
| `project.addFilesToGroup` | `showOpenDialog`（可多选，过滤器：源文件/所有文件）→ 过滤掉工程内已存在文件 → `addFiles` → 提示新增/跳过数量 |
| `project.newFile` | 输入文件名（默认 `new_file.c`）→ 选择分组（分组列表 + 「新建分组…」）→ 在工程目录创建文件（按扩展名给模板）→ `addFiles` → 打开文件 |
| `project.removeFile` | 二次确认（`warning` + `Remove`）→ `removeFile` |
| `project.addGroup` | 输入分组名 → `addGroup` |
| `project.renameGroup` | 预填当前名 → `renameGroup` |
| `project.removeGroup` | 警告确认（含文件数量）→ `removeGroup` |
| `project.moveFileToGroup` | 选择目标分组（排除当前分组）→ `moveFile` |
| `project.toggleFileInBuild` | 读取当前状态取反 → `setFileInBuild` |
| `project.toggleGroupInBuild` | 读取当前状态取反 → `setGroupInBuild` |

多目标工程默认作用于**当前活动目标**；提示信息中需带目标名。

## 3. Options 层

### 3.1 字段 schema：`src/project/options/uvOptionSchema.ts`（B）

```ts
export type OptionTabId = 'target' | 'output' | 'ccpp' | 'asm' | 'linker' | 'debug' | 'utilities';
export type OptionValueType = 'string' | 'multiline' | 'bool' | 'number' | 'enum';
export type OptionFileKind = 'uvprojx' | 'uvopt';

export interface OptionEnumValue { value: string; label: string; }

export interface OptionFieldDef {
    id: string;                      // 稳定 id，如 'ccpp.optim'
    label: string;                   // 中文标签
    hint?: string;                   // 英文/补充说明
    type: OptionValueType;
    file: OptionFileKind;
    path: Partial<Record<UvToolchainKind, string[]>>;   // 相对 <Target> 的路径
    enumValues?: OptionEnumValue[];
    placeholder?: string;
    numeric?: { min?: number; max?: number; step?: number };
    readonly?: boolean;              // 只读展示
    tooltip?: string;
}

export interface OptionSectionDef { id: string; title: string; description?: string; fields: OptionFieldDef[]; }
export interface OptionTabDef { id: OptionTabId; title: string; sections: OptionSectionDef[]; }
export const OPTION_TABS: OptionTabDef[];
```

字段覆盖范围（必须包含，可增不可减）：

- **target**：Device、Vendor、PackID、Cpu（多行）、SFDFile、FlashDriverDll、Xtal（`.uvopt` 的 `CLKADS`）、MemoryModel（C51/C251 `Target51Misc/MemoryModel`、`Target251Misc/MemoryModel`）
- **output**：OutputName、OutputDirectory、ListingPath、CreateExecutable、CreateLib、CreateHexFile、HexFormatSelection、DebugInformation、BrowseInformation、CreateBatchFile、Merge32K；BeforeMake/AfterMake 的 `RunUserProg1`/`UserProg1Name`
- **ccpp**：Define、Undefine、IncludePath、MiscControls（`VariousControls`）、优化等级、优化目标（size/time）、告警等级、C99/GNU 开关（按工具链映射）
- **asm**：Define、Undefine、IncludePath、MiscControls、`thumb`/`UseStandard` 等
- **linker**：ARM `LDads`（ScatterFile、Misc、TextAddressRange、DataAddressRange、IncludeLibs、Ropi/Rwpi、noStLib）；C51/C251 `Lx51`（MiscControls、LinkerCmdFile、WarningLevel、DataOverlaying、useFile、linkonly、Stack、*BaseAddress）
- **debug**：`.uvprojx` 中 `DllOption`（SimDllName/SimDlgDll/TargetDllName/TargetDlgDll）、`DebugOption/OPTHX`（HexSelection 等）；`.uvopt` 中 `DebugOpt`（uSim/uTrg、sLdApp/sGomain/tLdApp/tGomain、sRbreak/tRbreak、sDll/tDll/tDlgDll、pMon）、`OPTTT`（RunSim/RunTarget/BeepAtEnd）
- **utilities**：`.uvprojx` `Utilities/Flash1`（UseTargetDll、UseExternalTool、RunIndependent、UpdateFlashBeforeDebugging、Capability、DriverSelection）、`Flash2`（下载算法 DLL）、`bUseTDR`、`FcArmLst`

> C51/C251 与 ARM 的路径差异通过 `path` 的 `Partial<Record<...>>` 表达；某工具链没有该字段时，该字段在面板中标记 `unavailable`。

### 3.2 uvprojx 读写：`src/project/options/uvOptions.ts`（B）

```ts
export interface OptionReadResult { toolchain: UvToolchainKind; values: Record<string, string | undefined>; }
export function readTargetOptions(xml: string, targetName: string): OptionReadResult;
export interface OptionApplyResult { xml: string; changed: string[]; warnings: string[]; }
export function applyTargetOptions(
    xml: string, targetName: string, values: Record<string, string>
): OptionApplyResult;
```

- `readTargetOptions`：仅返回 `file === 'uvprojx'` 字段；缺失返回 `undefined`。
- `applyTargetOptions`：只处理 `file === 'uvprojx'` 字段；值未变化不产生编辑；`changed` 记录字段 id。
- 工具链无法识别时抛错；目标不存在时抛错。

### 3.3 uvopt 读写：`src/project/options/uvoptFile.ts`（B）

```ts
export function isUvoptFileName(filePath: string): boolean;      // .uvopt/.uvoptx
export function findUvoptFileForProject(projectFile: string): string | undefined;  // 同目录同名替换扩展名，含 .uvoptx 优先
export function readUvoptOptions(xml: string, targetName: string): Record<string, string | undefined>;
export function applyUvoptOptions(xml: string, targetName: string, values: Record<string, string>): OptionApplyResult;
```

- 文件根元素为 `ProjectOpt`；`<Target>/<TargetName>` 定位目标；`<TargetOption>` 下为各 `OPT*` 块。
- 缺失文件由上层处理（不创建新文件），只读字段标注不可用。

### 3.4 面板视图数据：`src/project/options/viewData.ts`（B）

```ts
export interface OptionFieldView {
    id: string; label: string; hint?: string; type: OptionValueType;
    value: string; options?: OptionEnumValue[]; placeholder?: string;
    readonly?: boolean; unavailable?: boolean; unavailableReason?: string;
}
export interface OptionSectionView { id: string; title: string; description?: string; fields: OptionFieldView[]; }
export interface OptionTabView { id: string; title: string; sections: OptionSectionView[]; }
export interface OptionsViewData {
    projectLabel: string;
    projectFile: string;
    uvoptFile?: string;
    targets: string[];
    activeTarget: string;
    toolchain: string;
    tabs: OptionTabView[];
    warnings: string[];
    readonly: boolean;             // 非 UTF-8 或解析失败时整面板只读
    readonlyReason?: string;
}
export function buildOptionsViewData(input: {
    projectLabel: string; projectFile: string;
    uvprojxText: string; uvoptText?: string;
    activeTarget?: string;
}): OptionsViewData;

export function splitValuesByFile(fields: OptionFieldView[]): { uvprojx: string[]; uvopt: string[] };
```

`buildOptionsViewData` 必须：过滤当前工具链不可用字段（`unavailable` + 原因）、`uvoptText` 缺失时所有 `.uvopt` 字段 `unavailable`、目标列表来自 `<TargetName>`。

### 3.5 面板：`src/project/optionsPanel.ts`（C）

```ts
export interface OptionsPanelHost {
    readonly prjID: string;
    readonly projectLabel: string;
    readonly projectFile: string;
    loadViewData(targetName?: string): Promise<OptionsViewData>;
    saveValues(targetName: string, values: Record<string, string>): Promise<OptionApplyResultSummary>;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
}
export interface OptionApplyResultSummary { changed: string[]; warnings: string[]; }

export class OptionsPanel {
    static show(extensionUri: vscode.Uri, host: OptionsPanelHost, targetName?: string): OptionsPanel;
    static find(prjID: string): OptionsPanel | undefined;
    static disposeAll(): void;
    reload(): Promise<void>;
    dispose(): void;
}
```

消息协议（必须完全一致）：

- webview → 扩展：`{ type: 'ready' }`、`{ type: 'save', target: string, values: Record<string,string> }`、`{ type: 'reload', target: string }`、`{ type: 'switchTarget', target: string }`、`{ type: 'openFile', which: 'uvprojx' | 'uvopt' }`
- 扩展 → webview：`{ type: 'init', data: OptionsViewData }`、`{ type: 'saved', changed: string[], warnings: string[] }`、`{ type: 'error', message: string }`、`{ type: 'busy', value: boolean }`

**UI 要求**

- 左侧标签页导航（target/output/ccpp/asm/linker/debug/utilities），右侧分区表单。
- 顶部：工程名、目标下拉框、`保存`、`重新加载`、`打开工程文件`。
- 字段按 `type` 渲染：`string`/`number` → input；`multiline` → textarea；`bool` → checkbox（值 `'1'/'0'`）；`enum` → select。
- 修改后显示未保存标记与「保存」按钮可用状态；保存成功提示已保存字段数。
- 只读/不可用字段禁用并显示原因 tooltip。
- 样式使用 VS Code 主题变量（`--vscode-*`），支持浅色/深色；CSP 严格（`nonce`，禁止内联脚本执行）。
- HTML/CSS/JS 全部由 `src/project/options/panelAssets.ts` 内联生成（不新增 `res/` 静态资源），并提供纯函数 `buildOptionsHtml({ nonce, cspSource })` 供单测。

### 3.6 面板接线（Lead，`src/extension.ts`）

- `project.options` 命令：解析当前上下文 → 找到 `KeilProject` 与目标 → 组装 `OptionsPanelHost` → `OptionsPanel.show()`。
- `saveValues`：读取 uvprojx（与 uvopt，如涉及）→ `applyTargetOptions` / `applyUvoptOptions` → `writeProjectTextFile`（备份 + 重试）→ 刷新工程树 → 返回 `{changed, warnings}`。
- 面板随工程关闭/扩展停用而 `dispose`。

## 4. 命令与贡献点（D 负责 `package.json`，Lead 负责注册实现）

### 命令

| 命令 id | 标题 | 默认菜单位置 |
| --- | --- | --- |
| `project.options` | 工程选项(Options for Target)… | `view/title`（`view == project`）、`view/item/context`（Project/Target） |
| `project.addFilesToGroup` | 添加文件到分组… | `view/item/context`（FileGroup/Project/Target） |
| `project.newFile` | 新建源文件并加入工程… | `view/item/context`（Project/FileGroup/Target） |
| `project.removeFile` | 从工程移除文件 | `view/item/context`（Source） |
| `project.addGroup` | 新建分组… | `view/item/context`（Project/Target/FileGroup） |
| `project.renameGroup` | 重命名分组… | `view/item/context`（FileGroup） |
| `project.removeGroup` | 删除分组 | `view/item/context`（FileGroup） |
| `project.moveFileToGroup` | 移动文件到分组… | `view/item/context`（Source） |
| `project.toggleFileInBuild` | 切换文件是否参与编译 | `view/item/context`（Source） |
| `project.toggleGroupInBuild` | 切换分组是否参与编译 | `view/item/context`（FileGroup） |

### 设置

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `KeilAssistant.Project.BackupBeforeWrite` | boolean | `true` | 写回工程文件前备份到扩展全局存储目录 |

### 其他

- `package.json` 版本号：`2.6.0`。
- `activationEvents` 无需改动（命令贡献会自动激活）。
- README/README_EN 增加「工程文件管理」「工程选项」章节；CHANGELOG 增加 `## [2.6.0] - 2026-11-05`。
- README.md 需恢复 `marketplaceMetadata.test.ts` 断言的两段结构（`## What Is Different In This Edition?`、`## Project Origin`），修复基线红测。

## 5. 测试策略

所有测试为纯 Node + `assert`（与现有 `src/test/*.test.ts` 一致），不依赖 vscode 运行时。

| 测试文件 | 覆盖点 |
| --- | --- |
| `uvXml.test.ts` | 全 fixture round-trip 逐字节一致；实体转义；自闭合展开；缺路径创建；删除；CRLF；注释/CDATA；缩进推导 |
| `projectFileIo.test.ts` | BOM 保留；非 UTF-8 拒绝；备份文件生成；`EBUSY` 重试（模拟 rename 抛错）；临时文件清理 |
| `uvGroups.test.ts` | 分组/文件增删改移；幂等；重复跳过；build 开关；路径转换；多目标隔离；C51/C251/ARM6 fixture |
| `uvOptions.test.ts` | 四类工具链读取；写回后回读一致；未变化不写；缺失节点创建；未知目标抛错 |
| `uvoptFile.test.ts` | Xtal/Debug/Listing 读写；`.uvopt` 与 `.uvoptx` 兼容；缺失目标处理 |
| `optionsViewData.test.ts` | 标签页/分区结构；不可用字段标注；目标列表；只读模式 |
| `panelAssets.test.ts` | HTML 含 CSP/nonce；不含内联事件处理器；标签页与字段渲染占位 |
| `packageContributions.test.ts` | 新命令/菜单/设置存在且 when 条件正确 |

另提供开发脚本 `scripts/validate-keil-corpus.js`（D）：扫描指定目录内所有 `.uvproj/.uvprojx`，校验解析成功 + 无编辑 round-trip 一致 + 读取全部目标分组，输出统计；不纳入 `npm test`。

## 6. 验收标准

1. `npm run compile`、`npm run lint`、`npm test` 全部通过（含基线红测修复）。
2. 语料验证：本机 1400+ 真实工程文件 100% 解析成功且 round-trip 逐字节一致。
3. 对真实工程执行「加入文件 → 删除文件 → 新建分组 → 删除分组」后，文件仅产生预期行变更（`git diff` 仅新增/删除对应节点）。
4. Options 面板可读写 ARM / ARM6 / C51 / C251 四类工程的公共字段；`.uvopt` 缺失时相关字段标注不可用。
5. 备份文件生成于全局存储目录，用户工程目录无额外产物。
6. `vsce` 打包内容包含 `dist/extension.js` 与新命令（可由 `npx @vscode/vsce ls` 验证）。
