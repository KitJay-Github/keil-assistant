/**
 * Declarative schema of the Keil "Options for Target" dialog.
 *
 * Every field is described once and reused by:
 * - `uvOptions.ts` (read/write of `.uvprojx` fields)
 * - `uvoptFile.ts` (read/write of `.uvoptx` / `.uvopt` fields)
 * - `viewData.ts` (view model sent to the webview panel)
 *
 * Element paths are relative to the `<Target>` element. Paths were verified
 * against `.tmp/schema-ref.md` (derived from 1431 real projects) and the real
 * project corpus in `E:\APP\Keil`. A toolchain that does not emit an element
 * simply does not get a key in `path`; the panel marks such fields as
 * unavailable instead of guessing values.
 *
 * Keil stores several different "optimisation"/"warning" options under
 * similarly named elements, and their semantics differ per toolchain:
 * - `.uvprojx` ARM  (AC5, `TargetArmAds/Cads`): `Optim` 0-4, `wLevel` 0-2
 * - `.uvprojx` ARM6 (AC6, `TargetArmAds/Cads`): `Optim` 0-8, `wLevel` 0-4
 * - `.uvprojx` C51  (`Target51/C51`):           `Optimize` 0-9, `WarningLevel` 0-3
 * - `.uvprojx` C251 (`Target251/C251`):         `Optim`   0-9, `wLevel`      0-3
 * Therefore those values are declared as separate fields with their own label
 * so the panel never mixes two different scales.
 */
import {
    OptionEnumValue,
    OptionFieldDef,
    OptionFileKind,
    OptionTabDef,
    OptionValueType,
    UvToolchainKind
} from './types';

type ToolchainPaths = Partial<Record<UvToolchainKind, string[]>>;

// ---------------------------------------------------------------------------
// Path helpers (relative to <Target>)
// ---------------------------------------------------------------------------

function tco(...rest: string[]): string[] {
    return ['TargetOption', 'TargetCommonOption', ...rest];
}
function common(...rest: string[]): string[] {
    return ['TargetOption', 'CommonProperty', ...rest];
}
function dll(...rest: string[]): string[] {
    return ['TargetOption', 'DllOption', ...rest];
}
function debugOption(...rest: string[]): string[] {
    return ['TargetOption', 'DebugOption', ...rest];
}
function utilities(...rest: string[]): string[] {
    return ['TargetOption', 'Utilities', ...rest];
}
function cads(...rest: string[]): string[] {
    return ['TargetOption', 'TargetArmAds', 'Cads', ...rest];
}
function aads(...rest: string[]): string[] {
    return ['TargetOption', 'TargetArmAds', 'Aads', ...rest];
}
function ldads(...rest: string[]): string[] {
    return ['TargetOption', 'TargetArmAds', 'LDads', ...rest];
}
function c51Compiler(...rest: string[]): string[] {
    return ['TargetOption', 'Target51', 'C51', ...rest];
}
function c51Misc(...rest: string[]): string[] {
    return ['TargetOption', 'Target51', 'Target51Misc', ...rest];
}
function c51Asm(...rest: string[]): string[] {
    return ['TargetOption', 'Target51', 'Ax51', ...rest];
}
function c51Linker(...rest: string[]): string[] {
    return ['TargetOption', 'Target51', 'Lx51', ...rest];
}
function c251Compiler(...rest: string[]): string[] {
    return ['TargetOption', 'Target251', 'C251', ...rest];
}
function c251Misc(...rest: string[]): string[] {
    return ['TargetOption', 'Target251', 'Target251Misc', ...rest];
}
function c251Asm(...rest: string[]): string[] {
    return ['TargetOption', 'Target251', 'Ax51', ...rest];
}
function c251Linker(...rest: string[]): string[] {
    return ['TargetOption', 'Target251', 'Lx51', ...rest];
}
/** `.uvopt` paths: children of `<TargetOption>` inside `<Target>`. */
function opt(...rest: string[]): string[] {
    return ['TargetOption', ...rest];
}

function all(path: string[]): ToolchainPaths {
    return { ARM: path, ARM6: path, C51: path, C251: path };
}
function forArm(path: string[]): ToolchainPaths {
    return { ARM: path, ARM6: path };
}
function forArm5(path: string[]): ToolchainPaths {
    return { ARM: path };
}
function forArm6(path: string[]): ToolchainPaths {
    return { ARM6: path };
}
function forC51(path: string[]): ToolchainPaths {
    return { C51: path };
}
function forC251(path: string[]): ToolchainPaths {
    return { C251: path };
}
function forC51C251(c51: string[], c251: string[]): ToolchainPaths {
    return { C51: c51, C251: c251 };
}
function forAllButArm6(path: string[]): ToolchainPaths {
    return { ARM: path, C51: path, C251: path };
}

// ---------------------------------------------------------------------------
// Field factory
// ---------------------------------------------------------------------------

function field(
    id: string,
    label: string,
    hint: string,
    type: OptionValueType,
    file: OptionFileKind,
    path: ToolchainPaths,
    extra: Partial<OptionFieldDef> = {}
): OptionFieldDef {
    return { id, label, hint, type, file, path, ...extra };
}

/** Boolean field stored as `'1'` / `'0'` (Keil's convention). */
function boolField(
    id: string,
    label: string,
    hint: string,
    path: ToolchainPaths,
    extra: Partial<OptionFieldDef> = {}
): OptionFieldDef {
    return field(id, label, hint, 'bool', 'uvprojx', path, extra);
}

/** Boolean field stored in the companion `.uvopt(x)` file. */
function uvoptBoolField(
    id: string,
    label: string,
    hint: string,
    path: ToolchainPaths,
    extra: Partial<OptionFieldDef> = {}
): OptionFieldDef {
    return field(id, label, hint, 'bool', 'uvopt', path, extra);
}

/** String field stored in the companion `.uvopt(x)` file. */
function uvoptField(
    id: string,
    label: string,
    hint: string,
    type: OptionValueType,
    path: ToolchainPaths,
    extra: Partial<OptionFieldDef> = {}
): OptionFieldDef {
    return field(id, label, hint, type, 'uvopt', path, extra);
}

// ---------------------------------------------------------------------------
// Enum value helpers
// ---------------------------------------------------------------------------

const BOOLEAN_OPTIONS: OptionEnumValue[] = [
    { value: '1', label: '启用（1）' },
    { value: '0', label: '禁用（0）' }
];

const HEX_FORMAT_OPTIONS: OptionEnumValue[] = [
    { value: '1', label: 'HEX-386（32 位段地址）' },
    { value: '0', label: 'HEX-80（16 位段地址）' }
];

const INCLUDE_IN_BUILD_OPTIONS: OptionEnumValue[] = [
    { value: '1', label: '参与编译（1）' },
    { value: '0', label: '不参与编译（0）' },
    { value: '2', label: '使用上级/缺省设置（2）' }
];

/** C51/C251 "Optimize for size/speed" switch. */
const SIZE_SPEED_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '代码大小优先（SIZE）' },
    { value: '1', label: '执行速度优先（SPEED）' }
];

/** AC5 optimisation levels: uVision order is 默认, Level 0, Level 1, Level 2, Level 3. */
const ARM_OPTIM_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '默认（编译器缺省 -O2）' },
    { value: '1', label: 'Level 0 (-O0)' },
    { value: '2', label: 'Level 1 (-O1)' },
    { value: '3', label: 'Level 2 (-O2)' },
    { value: '4', label: 'Level 3 (-O3)' }
];

/** AC6 optimisation levels: default followed by the armclang -O levels. */
const ARM6_OPTIM_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '默认（编译器缺省）' },
    { value: '1', label: 'Level 0 (-O0)' },
    { value: '2', label: 'Level 1 (-O1)' },
    { value: '3', label: 'Level 2 (-O2)' },
    { value: '4', label: 'Level 3 (-O3)' },
    { value: '5', label: 'Fast (-Ofast)' },
    { value: '6', label: 'Balanced (-Os balanced)' },
    { value: '7', label: 'Size (-Oz image size)' },
    { value: '8', label: 'Maximum (-Omax)' }
];

/** ARM Compiler 5 warning level (0 = 最少警告, 2 = 全部警告). */
const ARM_WLEVEL_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '0（默认/最少警告）' },
    { value: '1', label: '1（标准警告）' },
    { value: '2', label: '2（全部警告）' }
];

/** ARM Compiler 6 warning level (uVision exposes more levels than AC5). */
const ARM6_WLEVEL_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '0（默认/最少警告）' },
    { value: '1', label: '1（标准警告）' },
    { value: '2', label: '2（较多警告）' },
    { value: '3', label: '3（全部警告）' },
    { value: '4', label: '4（最严格）' }
];

function numericLevelOptions(directive: string, max: number): OptionEnumValue[] {
    const options: OptionEnumValue[] = [];
    for (let level = 0; level <= max; level++) {
        options.push({
            value: String(level),
            label: `${level}（${directive}(${level})）`
        });
    }
    return options;
}

/** C51 `OPTIMIZE(n)`, n = 0..9. */
const C51_OPTIMIZE_OPTIONS = numericLevelOptions('OPTIMIZE', 9);
/** C251 `OPTIM(n)`, n = 0..9. */
const C251_OPTIM_OPTIONS = numericLevelOptions('OPTIM', 9);

/** C51/C251 four level warning scale. */
const FOUR_LEVEL_WARNING_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '0（无警告）' },
    { value: '1', label: '1（标准警告）' },
    { value: '2', label: '2（全部警告）' },
    { value: '3', label: '3（最严格）' }
];

/**
 * C51 / C251 memory model. The raw numbers are shared but the meaning differs:
 * C51: 0 = SMALL, 1 = COMPACT, 2 = LARGE
 * C251: 0 = TINY, 1 = XTINY, 2 = SMALL, 3 = XSMALL, 4 = LARGE
 */
const MEMORY_MODEL_OPTIONS: OptionEnumValue[] = [
    { value: '0', label: '0（C51: SMALL / C251: TINY）' },
    { value: '1', label: '1（C51: COMPACT / C251: XTINY）' },
    { value: '2', label: '2（C51: LARGE / C251: SMALL）' },
    { value: '3', label: '3（仅 C251: XSMALL）' },
    { value: '4', label: '4（仅 C251: LARGE）' }
];

/**
 * Fallback `Utilities/Flash1/DriverSelection` entries.
 *
 * The real value space is installation dependent: uVision writes
 * `4096 + <0-based index>` of the selected debugger inside the driver list of the
 * device's CPU group (`CPUDLLn` in `TOOLS.INI`). `viewData.ts` therefore replaces
 * these options with the drivers of the local Keil installation
 * (`keilInstall.ts`); only `-1` / `0` are stable across installations.
 */
const DRIVER_SELECTION_OPTIONS: OptionEnumValue[] = [
    { value: '-1', label: '-1（未选择调试/下载驱动）' },
    { value: '0', label: '0（未指定，使用默认驱动）' }
];

// ---------------------------------------------------------------------------
// Tab: target
// ---------------------------------------------------------------------------

const TARGET_TAB: OptionTabDef = {
    id: 'target',
    title: '目标（Target）',
    sections: [
        {
            id: 'target.device',
            title: '器件与封装',
            description: '器件选择与 Flash 下载参数，保存在 .uvprojx 中。',
            fields: [
                field('target.device', '器件型号', 'Device', 'string', 'uvprojx', all(tco('Device')), {
                    placeholder: 'STM32F407VGTx',
                    tooltip: 'uVision 器件数据库中选中的器件名称。'
                }),
                field('target.vendor', '芯片厂商', 'Vendor', 'string', 'uvprojx', all(tco('Vendor')), {
                    placeholder: 'STMicroelectronics'
                }),
                field('target.packId', '器件支持包', 'PackID', 'string', 'uvprojx', forArm(tco('PackID')), {
                    placeholder: 'Keil.STM32F4xx_DFP.2.17.1',
                    tooltip: '仅 ARM（AC5/AC6）工程包含 PackID。'
                }),
                field('target.deviceId', '器件编号', 'DeviceId', 'string', 'uvprojx', all(tco('DeviceId')), {
                    readonly: true,
                    tooltip: 'uVision 内部器件编号，由器件选择自动写入，建议不要手工修改。'
                }),
                field('target.cpu', 'CPU 参数', 'Cpu', 'multiline', 'uvprojx', all(tco('Cpu')), {
                    placeholder: 'IRAM(0x20000000-0x2001FFFF) IROM(0x8000000-0x807FFFF) CLOCK(8000000) CPUTYPE("Cortex-M4")',
                    tooltip: '内存映射与 CPU 类型由器件数据库生成，多行文本。'
                }),
                field('target.sfdFile', 'SFR/SVD 描述文件', 'SFDFile', 'string', 'uvprojx', all(tco('SFDFile')), {
                    placeholder: '$$Device:STM32F407VGTx$CMSIS\\SVD\\STM32F407.svd'
                }),
                field('target.flashDriverDll', 'Flash 算法参数', 'FlashDriverDll', 'multiline', 'uvprojx', forArm(tco('FlashDriverDll')), {
                    placeholder: 'UL2CM3(-S0 -C0 -P0 -FD20000000 -FC1000)',
                    tooltip: 'ARM 工程的 Flash 下载算法参数串；C51/C251 使用 Utilities/Flash2 指定下载驱动。'
                }),
                field('target.registerFile', '寄存器头文件', 'RegisterFile', 'string', 'uvprojx', all(tco('RegisterFile')), {
                    readonly: true,
                    placeholder: 'REGX51.H'
                })
            ]
        },
        {
            id: 'target.clock',
            title: '时钟与内存模型',
            fields: [
                uvoptField('target.xtal', '晶振频率（Hz）', 'Xtal (CLKADS)', 'number', all(opt('CLKADS')), {
                    numeric: { min: 0, step: 1 },
                    placeholder: '8000000',
                    tooltip: '保存在 .uvoptx/.uvopt 的 CLKADS 元素中；工程缺少 .uvopt 文件时不可用。'
                }),
                field('target.memoryModel', '内存模型', 'MemoryModel', 'enum', 'uvprojx',
                    forC51C251(c51Misc('MemoryModel'), c251Misc('MemoryModel')), {
                    enumValues: MEMORY_MODEL_OPTIONS,
                    tooltip: 'C51 与 C251 的模型编号含义不同：C51 为 SMALL/COMPACT/LARGE，C251 为 TINY/XTINY/SMALL/XSMALL/LARGE。'
                })
            ]
        },
        {
            id: 'target.build',
            title: '构建行为',
            fields: [
                field('target.includeInBuild', '参与编译', 'IncludeInBuild', 'enum', 'uvprojx',
                    all(common('IncludeInBuild')), {
                    enumValues: INCLUDE_IN_BUILD_OPTIONS,
                    tooltip: '目标级的 IncludeInBuild（CommonProperty）；分组/文件级同名元素使用相同的取值约定。'
                })
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: output
// ---------------------------------------------------------------------------

const OUTPUT_TAB: OptionTabDef = {
    id: 'output',
    title: '输出（Output）',
    sections: [
        {
            id: 'output.artifacts',
            title: '输出文件',
            fields: [
                field('output.outputName', '输出文件名', 'OutputName', 'string', 'uvprojx', all(tco('OutputName')), {
                    placeholder: 'Demo'
                }),
                field('output.outputDirectory', '输出目录', 'OutputDirectory', 'string', 'uvprojx', all(tco('OutputDirectory')), {
                    placeholder: '.\\Objects\\'
                }),
                field('output.listingPath', 'Listing 目录', 'ListingPath', 'string', 'uvprojx', all(tco('ListingPath')), {
                    placeholder: '.\\Listings\\'
                }),
                boolField('output.createExecutable', '生成可执行文件', 'CreateExecutable', all(tco('CreateExecutable'))),
                boolField('output.createLib', '生成库文件', 'CreateLib', all(tco('CreateLib'))),
                boolField('output.createHexFile', '生成 HEX 文件', 'CreateHexFile', all(tco('CreateHexFile'))),
                field('output.hexFormatSelection', 'HEX 格式', 'HexFormatSelection', 'enum', 'uvprojx',
                    all(tco('HexFormatSelection')), {
                    enumValues: HEX_FORMAT_OPTIONS,
                    tooltip: 'HEX-80 使用 16 位段地址（8051/251 常用），HEX-386 使用 32 位段地址（ARM 常用）。'
                }),
                boolField('output.debugInformation', '生成调试信息', 'DebugInformation', all(tco('DebugInformation'))),
                boolField('output.browseInformation', '生成浏览信息', 'BrowseInformation', all(tco('BrowseInformation'))),
                boolField('output.createBatchFile', '生成批处理文件', 'CreateBatchFile', all(tco('CreateBatchFile'))),
                boolField('output.merge32K', '合并 32K 段', 'Merge32K', all(tco('Merge32K')))
            ]
        },
        {
            id: 'output.userPrograms',
            title: '用户命令',
            description: '编译前/编译后自动执行的用户程序。',
            fields: [
                boolField('output.beforeMakeRunUserProg1', '编译前执行用户程序 1', 'BeforeMake/RunUserProg1',
                    all(tco('BeforeMake', 'RunUserProg1'))),
                field('output.beforeMakeUserProg1Name', '编译前用户程序 1 命令行', 'BeforeMake/UserProg1Name', 'multiline',
                    'uvprojx', all(tco('BeforeMake', 'UserProg1Name')), {
                    placeholder: 'cmd.exe /C copy "!L" "..\\@L.bin"'
                }),
                boolField('output.afterMakeRunUserProg1', '编译后执行用户程序 1', 'AfterMake/RunUserProg1',
                    all(tco('AfterMake', 'RunUserProg1'))),
                field('output.afterMakeUserProg1Name', '编译后用户程序 1 命令行', 'AfterMake/UserProg1Name', 'multiline',
                    'uvprojx', all(tco('AfterMake', 'UserProg1Name')), {
                    placeholder: 'fromelf --bin --output ".\\Objects\\Demo.bin" ".\\Objects\\Demo.axf"'
                })
            ]
        },
        {
            id: 'output.uvoptListing',
            title: 'Listing 输出（.uvopt）',
            description: 'Listing 页眉/页宽等设置保存在 .uvoptx/.uvopt 的 OPTLEX 中。',
            fields: [
                uvoptField('output.uvoptListingPath', 'Listing 目录（.uvopt）', 'OPTLEX/ListingPath', 'string',
                    all(opt('OPTLEX', 'ListingPath')), {
                    placeholder: '.\\Listings\\'
                }),
                uvoptField('output.uvoptPageWidth', 'Listing 页宽', 'OPTLEX/PageWidth', 'number',
                    all(opt('OPTLEX', 'PageWidth')), {
                    numeric: { min: 1, max: 255, step: 1 },
                    placeholder: '79'
                }),
                uvoptField('output.uvoptPageLength', 'Listing 页长', 'OPTLEX/PageLength', 'number',
                    all(opt('OPTLEX', 'PageLength')), {
                    numeric: { min: 1, max: 255, step: 1 },
                    placeholder: '66'
                }),
                uvoptField('output.uvoptTabStop', 'Listing Tab 宽度', 'OPTLEX/TabStop', 'number',
                    all(opt('OPTLEX', 'TabStop')), {
                    numeric: { min: 1, max: 16, step: 1 },
                    placeholder: '8'
                })
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: ccpp
// ---------------------------------------------------------------------------

const ARM_VARIOUS = 'VariousControls';
const C51_VARIOUS = c51Compiler('VariousControls');
const C251_VARIOUS = c251Compiler('VariousControls');

const CCPP_TAB: OptionTabDef = {
    id: 'ccpp',
    title: 'C/C++',
    sections: [
        {
            id: 'ccpp.preprocessor',
            title: '预处理与包含路径',
            fields: [
                field('ccpp.define', '预定义宏', 'Define', 'multiline', 'uvprojx', {
                    ARM: cads(ARM_VARIOUS, 'Define'),
                    ARM6: cads(ARM_VARIOUS, 'Define'),
                    C51: [...C51_VARIOUS, 'Define'],
                    C251: [...C251_VARIOUS, 'Define']
                }, {
                    placeholder: 'USE_HAL_DRIVER,STM32F407xx',
                    tooltip: '多个宏用逗号分隔（ARM）或空格分隔（C51/C251），按 uVision 原始写法保存。'
                }),
                field('ccpp.undefine', '取消宏定义', 'Undefine', 'multiline', 'uvprojx', {
                    ARM: cads(ARM_VARIOUS, 'Undefine'),
                    ARM6: cads(ARM_VARIOUS, 'Undefine'),
                    C51: [...C51_VARIOUS, 'Undefine'],
                    C251: [...C251_VARIOUS, 'Undefine']
                }, {
                    tooltip: '清除上级（Target/Group/File）定义的宏。'
                }),
                field('ccpp.includePath', '头文件包含路径', 'IncludePath', 'multiline', 'uvprojx', {
                    ARM: cads(ARM_VARIOUS, 'IncludePath'),
                    ARM6: cads(ARM_VARIOUS, 'IncludePath'),
                    C51: [...C51_VARIOUS, 'IncludePath'],
                    C251: [...C251_VARIOUS, 'IncludePath']
                }, {
                    placeholder: '.\\Application;.\\Drivers;.\\Drivers\\CMSIS'
                }),
                field('ccpp.miscControls', '其他编译器选项', 'MiscControls', 'multiline', 'uvprojx', {
                    ARM: cads(ARM_VARIOUS, 'MiscControls'),
                    ARM6: cads(ARM_VARIOUS, 'MiscControls'),
                    C51: [...C51_VARIOUS, 'MiscControls'],
                    C251: [...C251_VARIOUS, 'MiscControls']
                }, {
                    placeholder: '--diag_suppress=66'
                })
            ]
        },
        {
            id: 'ccpp.optimization',
            title: '优化与告警',
            description: '不同工具链的优化/告警刻度彼此独立，请按当前工具链对应的项填写。',
            fields: [
                field('ccpp.optim', 'ARM 优化等级（Optim，AC5）', 'ARM Compiler 5 Cads/Optim', 'enum', 'uvprojx',
                    forArm5(cads('Optim')), {
                    enumValues: ARM_OPTIM_OPTIONS,
                    tooltip: 'ARM Compiler 5 的优化等级，对应 uVision C/C++ 页 Optimization 下拉框。'
                }),
                boolField('ccpp.oTime', 'ARM 优化目标为时间（oTime，AC5）', 'ARM Compiler 5 Cads/oTime',
                    forArm5(cads('oTime')), {
                    tooltip: '对应 uVision 的 "Optimize for Time"；未勾选表示代码大小优先。'
                }),
                field('ccpp.optimArm6', 'ARM6 优化等级（Optim，AC6）', 'Arm Compiler 6 Cads/Optim', 'enum', 'uvprojx',
                    forArm6(cads('Optim')), {
                    enumValues: ARM6_OPTIM_OPTIONS,
                    tooltip: 'ARM Compiler 6 (armclang) 的优化等级，刻度比 AC5 更细（-O0…-Omax）。'
                }),
                boolField('ccpp.oTimeArm6', 'ARM6 优化目标为时间（oTime，AC6）', 'Arm Compiler 6 Cads/oTime',
                    forArm6(cads('oTime'))),
                field('ccpp.optimizeC51', 'C51 优化等级（Optimize）', 'C51 compiler C51/Optimize', 'enum', 'uvprojx',
                    forC51(c51Compiler('Optimize')), {
                    enumValues: C51_OPTIMIZE_OPTIONS,
                    tooltip: '仅 C51 使用的 OPTIMIZE(0…9) 刻度，与 ARM/C251 的 Optim 含义不同。'
                }),
                field('ccpp.sizeSpeedC51', 'C51 优化目标（SizeSpeed）', 'C51 compiler C51/SizeSpeed', 'enum',
                    'uvprojx', forC51(c51Compiler('SizeSpeed')), {
                    enumValues: SIZE_SPEED_OPTIONS,
                    tooltip: 'C51 的代码大小/执行速度优化目标（SIZE/SPEED）。'
                }),
                field('ccpp.optimC251', 'C251 优化等级（Optim）', 'C251 compiler C251/Optim', 'enum', 'uvprojx',
                    forC251(c251Compiler('Optim')), {
                    enumValues: C251_OPTIM_OPTIONS,
                    tooltip: 'C251 使用 OPTIM(0…9) 刻度，与 C51 的 Optimize、ARM 的 Optim 含义不同。'
                }),
                field('ccpp.sizeSpeedC251', 'C251 优化目标（SizSpd）', 'C251 compiler C251/SizSpd', 'enum',
                    'uvprojx', forC251(c251Compiler('SizSpd')), {
                    enumValues: SIZE_SPEED_OPTIONS
                }),
                field('ccpp.wLevel', 'ARM 告警等级（wLevel，AC5）', 'ARM Compiler 5 Cads/wLevel', 'enum',
                    'uvprojx', forArm5(cads('wLevel')), {
                    enumValues: ARM_WLEVEL_OPTIONS,
                    tooltip: 'ARM Compiler 5 的警告等级（数值越大警告越完整）。'
                }),
                field('ccpp.wLevelArm6', 'ARM6 告警等级（wLevel，AC6）', 'Arm Compiler 6 Cads/wLevel', 'enum',
                    'uvprojx', forArm6(cads('wLevel')), {
                    enumValues: ARM6_WLEVEL_OPTIONS,
                    tooltip: 'ARM Compiler 6 的警告等级；AC6 比 AC5 多若干档。'
                }),
                field('ccpp.warningLevelC51', 'C51 告警等级（WarningLevel）', 'C51 compiler C51/WarningLevel', 'enum',
                    'uvprojx', forC51(c51Compiler('WarningLevel')), {
                    enumValues: FOUR_LEVEL_WARNING_OPTIONS,
                    tooltip: '仅 C51 使用的 WarningLevel(0…3) 刻度，与 ARM/C251 的 wLevel 不是同一组值。'
                }),
                field('ccpp.wLevelC251', 'C251 告警等级（wLevel）', 'C251 compiler C251/wLevel', 'enum',
                    'uvprojx', forC251(c251Compiler('wLevel')), {
                    enumValues: FOUR_LEVEL_WARNING_OPTIONS,
                    tooltip: 'C251 的 wLevel(0…3) 刻度，语义与 C51 的 WarningLevel 不同。'
                })
            ]
        },
        {
            id: 'ccpp.language',
            title: '语言标准',
            description: 'C99 / GNU 扩展开关为 ARM 系列独有；C51/C251 没有对应元素。',
            fields: [
                boolField('ccpp.c99', 'ARM 启用 C99 模式（uC99，AC5）', 'ARM Compiler 5 Cads/uC99',
                    forArm5(cads('uC99'))),
                boolField('ccpp.gnu', 'ARM 启用 GNU 扩展（uGnu，AC5）', 'ARM Compiler 5 Cads/uGnu',
                    forArm5(cads('uGnu'))),
                boolField('ccpp.c99Arm6', 'ARM6 启用 C99 模式（uC99，AC6）', 'Arm Compiler 6 Cads/uC99',
                    forArm6(cads('uC99'))),
                boolField('ccpp.gnuArm6', 'ARM6 启用 GNU 扩展（uGnu，AC6）', 'Arm Compiler 6 Cads/uGnu',
                    forArm6(cads('uGnu')))
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: asm
// ---------------------------------------------------------------------------

const ASM_TAB: OptionTabDef = {
    id: 'asm',
    title: '汇编（Asm）',
    sections: [
        {
            id: 'asm.preprocessor',
            title: '汇编预处理',
            fields: [
                field('asm.define', '汇编预定义宏', 'Assembler Define', 'multiline', 'uvprojx', {
                    ARM: aads(ARM_VARIOUS, 'Define'),
                    ARM6: aads(ARM_VARIOUS, 'Define'),
                    C51: c51Asm(ARM_VARIOUS, 'Define'),
                    C251: c251Asm(ARM_VARIOUS, 'Define')
                }),
                field('asm.undefine', '汇编取消宏定义', 'Assembler Undefine', 'multiline', 'uvprojx', {
                    ARM: aads(ARM_VARIOUS, 'Undefine'),
                    ARM6: aads(ARM_VARIOUS, 'Undefine'),
                    C51: c51Asm(ARM_VARIOUS, 'Undefine'),
                    C251: c251Asm(ARM_VARIOUS, 'Undefine')
                }),
                field('asm.includePath', '汇编包含路径', 'Assembler IncludePath', 'multiline', 'uvprojx', {
                    ARM: aads(ARM_VARIOUS, 'IncludePath'),
                    ARM6: aads(ARM_VARIOUS, 'IncludePath'),
                    C51: c51Asm(ARM_VARIOUS, 'IncludePath'),
                    C251: c251Asm(ARM_VARIOUS, 'IncludePath')
                }),
                field('asm.miscControls', '其他汇编器选项', 'Assembler MiscControls', 'multiline', 'uvprojx', {
                    ARM: aads(ARM_VARIOUS, 'MiscControls'),
                    ARM6: aads(ARM_VARIOUS, 'MiscControls'),
                    C51: c51Asm(ARM_VARIOUS, 'MiscControls'),
                    C251: c251Asm(ARM_VARIOUS, 'MiscControls')
                })
            ]
        },
        {
            id: 'asm.arm',
            title: 'ARM 汇编选项',
            fields: [
                boolField('asm.thumbArm', '默认 Thumb 模式（Aads/thumb）', 'Assembler thumb mode', forArm(aads('thumb'))),
                boolField('asm.interwArm', 'ARM/Thumb 互调用（Aads/interw）', 'Enable ARM/Thumb interworking',
                    forArm(aads('interw'))),
                boolField('asm.swStkChkArm', '软件栈检查（Aads/SwStkChk）', 'Software stack checking',
                    forArm(aads('SwStkChk'))),
                boolField('asm.noWarnArm', '关闭汇编器警告（Aads/NoWarn）', 'Suppress assembler warnings',
                    forArm(aads('NoWarn')))
            ]
        },
        {
            id: 'asm.c51',
            title: 'C51/C251 汇编选项（Ax51）',
            fields: [
                boolField('asm.useStandard', '使用标准汇编器（Ax51/UseStandard）', 'Use standard assembler',
                    forC51C251(c51Asm('UseStandard'), c251Asm('UseStandard'))),
                boolField('asm.useCase', '汇编区分大小写（Ax51/UseCase）', 'Case sensitive assembler',
                    forC51C251(c51Asm('UseCase'), c251Asm('UseCase'))),
                boolField('asm.useMpl', '使用 MPL 宏处理（Ax51/UseMpl）', 'Enable MPL macro processing',
                    forC51C251(c51Asm('UseMpl'), c251Asm('UseMpl'))),
                boolField('asm.useMod51', '使用 MOD51 寄存器定义（Ax51/UseMod51）', 'Use MOD51 register definitions',
                    forC51C251(c51Asm('UseMod51'), c251Asm('UseMod51')))
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: linker
// ---------------------------------------------------------------------------

const LINKER_TAB: OptionTabDef = {
    id: 'linker',
    title: '链接器（Linker）',
    sections: [
        {
            id: 'linker.arm',
            title: 'ARM 链接器（LDads）',
            fields: [
                field('linker.scatterFile', '分散加载文件', 'ScatterFile', 'string', 'uvprojx',
                    forArm(ldads('ScatterFile')), {
                    placeholder: '.\\Objects\\Demo.sct'
                }),
                field('linker.ldMisc', '其他链接器选项', 'LDads/Misc', 'multiline', 'uvprojx', forArm(ldads('Misc')), {
                    placeholder: '--no_remove'
                }),
                field('linker.textAddressRange', '代码地址范围', 'TextAddressRange', 'string', 'uvprojx',
                    forArm(ldads('TextAddressRange')), {
                    placeholder: '0x08000000'
                }),
                field('linker.dataAddressRange', '数据地址范围', 'DataAddressRange', 'string', 'uvprojx',
                    forArm(ldads('DataAddressRange')), {
                    placeholder: '0x20000000'
                }),
                field('linker.includeLibs', '附加库文件', 'IncludeLibs', 'string', 'uvprojx', forArm(ldads('IncludeLibs'))),
                field('linker.includeLibsPath', '附加库搜索路径', 'IncludeLibsPath', 'string', 'uvprojx',
                    forArm(ldads('IncludeLibsPath'))),
                boolField('linker.ropi', '只读位置无关（Ropi）', 'Read-only position independence', forArm(ldads('Ropi'))),
                boolField('linker.rwpi', '读写位置无关（Rwpi）', 'Read-write position independence', forArm(ldads('Rwpi'))),
                boolField('linker.noStLib', '不链接标准库（noStLib）', 'Do not link standard library', forArm(ldads('noStLib'))),
                boolField('linker.useFile', '使用链接控制文件（useFile）', 'Use linker control file',
                    {
                        ARM: ldads('useFile'),
                        ARM6: ldads('useFile'),
                        C51: c51Linker('useFile'),
                        C251: c251Linker('useFile')
                    })
            ]
        },
        {
            id: 'linker.c51',
            title: 'C51/C251 链接器（Lx51）',
            fields: [
                field('linker.lxMiscControls', '其他链接器选项（Lx51/MiscControls）', 'Lx51/MiscControls', 'multiline',
                    'uvprojx', forC51C251(c51Linker('MiscControls'), c251Linker('MiscControls')), {
                    placeholder: 'REMOVEUNUSED,NOOVERLAY'
                }),
                field('linker.linkerCmdFile', '链接命令文件（LinkerCmdFile）', 'Lx51/LinkerCmdFile', 'string', 'uvprojx',
                    forC51C251(c51Linker('LinkerCmdFile'), c251Linker('LinkerCmdFile'))),
                field('linker.lxWarningLevel', '链接器告警等级（Lx51 WarningLevel）', 'Lx51/WarningLevel', 'enum',
                    'uvprojx', forC51C251(c51Linker('WarningLevel'), c251Linker('WarningLevel')), {
                    enumValues: FOUR_LEVEL_WARNING_OPTIONS,
                    tooltip: 'C51/C251 链接器的告警等级，与编译器告警等级是独立的两组设置。'
                }),
                boolField('linker.dataOverlaying', '数据覆盖分析（DataOverlaying）', 'Lx51 data overlaying',
                    forC51C251(c51Linker('DataOverlaying'), c251Linker('DataOverlaying'))),
                boolField('linker.linkonly', '仅链接（linkonly）', 'Lx51 link only',
                    forC51C251(c51Linker('linkonly'), c251Linker('linkonly'))),
                field('linker.stack', '堆栈段大小（Stack）', 'Lx51/Stack', 'string', 'uvprojx',
                    forC51C251(c51Linker('Stack'), c251Linker('Stack'))),
                field('linker.disableWarningNumbers', '屏蔽告警编号', 'Lx51/DisableWarningNumbers', 'string', 'uvprojx',
                    forC51C251(c51Linker('DisableWarningNumbers'), c251Linker('DisableWarningNumbers')), {
                    placeholder: '15,16'
                }),
                field('linker.codeBaseAddress', '代码段基地址', 'Lx51/CodeBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('CodeBaseAddress'), c251Linker('CodeBaseAddress'))),
                field('linker.xdataBaseAddress', 'XDATA 段基地址', 'Lx51/XDataBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('XDataBaseAddress'), c251Linker('XDataBaseAddress'))),
                field('linker.pdataBaseAddress', 'PDATA 段基地址', 'Lx51/PDataBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('PDataBaseAddress'), c251Linker('PDataBaseAddress'))),
                field('linker.bitBaseAddress', 'BIT 段基地址', 'Lx51/BitBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('BitBaseAddress'), c251Linker('BitBaseAddress'))),
                field('linker.dataBaseAddress', 'DATA 段基地址', 'Lx51/DataBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('DataBaseAddress'), c251Linker('DataBaseAddress'))),
                field('linker.idataBaseAddress', 'IDATA 段基地址', 'Lx51/IDataBaseAddress', 'string', 'uvprojx',
                    forC51C251(c51Linker('IDataBaseAddress'), c251Linker('IDataBaseAddress')))
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: debug
// ---------------------------------------------------------------------------

const DEBUG_TAB: OptionTabDef = {
    id: 'debug',
    title: '调试（Debug）',
    sections: [
        {
            id: 'debug.driver',
            title: '调试驱动（.uvprojx DllOption）',
            fields: [
                field('debug.simDllName', '仿真器 DLL', 'SimDllName', 'string', 'uvprojx', all(dll('SimDllName'))),
                field('debug.simDllArguments', '仿真器 DLL 参数', 'SimDllArguments', 'string', 'uvprojx',
                    all(dll('SimDllArguments'))),
                field('debug.simDlgDll', '仿真器 CPU DLL', 'SimDlgDll', 'string', 'uvprojx', all(dll('SimDlgDll'))),
                field('debug.simDlgDllArguments', '仿真器 CPU DLL 参数', 'SimDlgDllArguments', 'string', 'uvprojx',
                    all(dll('SimDlgDllArguments'))),
                field('debug.targetDllName', '目标驱动 DLL', 'TargetDllName', 'string', 'uvprojx', all(dll('TargetDllName'))),
                field('debug.targetDllArguments', '目标驱动 DLL 参数', 'TargetDllArguments', 'string', 'uvprojx',
                    all(dll('TargetDllArguments'))),
                field('debug.targetDlgDll', '目标 CPU DLL', 'TargetDlgDll', 'string', 'uvprojx', all(dll('TargetDlgDll'))),
                field('debug.targetDlgDllArguments', '目标 CPU DLL 参数', 'TargetDlgDllArguments', 'string', 'uvprojx',
                    all(dll('TargetDlgDllArguments')))
            ]
        },
        {
            id: 'debug.hex',
            title: '调试 Hex 输出（.uvprojx DebugOption/OPTHX）',
            fields: [
                boolField('debug.hexSelection', '调试时生成 Hex', 'OPTHX/HexSelection', all(debugOption('OPTHX', 'HexSelection'))),
                field('debug.hexRangeLowAddress', 'Hex 范围低地址', 'OPTHX/HexRangeLowAddress', 'string', 'uvprojx',
                    all(debugOption('OPTHX', 'HexRangeLowAddress')), { placeholder: '0' }),
                field('debug.hexRangeHighAddress', 'Hex 范围高地址', 'OPTHX/HexRangeHighAddress', 'string', 'uvprojx',
                    all(debugOption('OPTHX', 'HexRangeHighAddress')), { placeholder: '0' }),
                field('debug.hexOffset', 'Hex 段偏移', 'OPTHX/HexOffset', 'string', 'uvprojx',
                    all(debugOption('OPTHX', 'HexOffset')), { placeholder: '0' }),
                field('debug.oh166RecLen', 'HEX-166 记录长度', 'OPTHX/Oh166RecLen', 'number', 'uvprojx',
                    all(debugOption('OPTHX', 'Oh166RecLen')), {
                    numeric: { min: 1, max: 255, step: 1 },
                    placeholder: '16'
                })
            ]
        },
        {
            id: 'debug.simulator',
            title: '仿真器（.uvprojx DebugOption/Simulator）',
            description: '仅 AC5/C51/C251 目标写入该子树；AC6 工程由 .uvopt 的 DebugOpt 控制。',
            fields: [
                boolField('debug.useSimulator', '使用仿真器', 'Simulator/UseSimulator',
                    forAllButArm6(debugOption('Simulator', 'UseSimulator'))),
                boolField('debug.simLoadApplicationAtStartup', '仿真启动时加载程序', 'Simulator/LoadApplicationAtStartup',
                    forAllButArm6(debugOption('Simulator', 'LoadApplicationAtStartup'))),
                boolField('debug.simRunToMain', '仿真启动运行到 main', 'Simulator/RunToMain',
                    forAllButArm6(debugOption('Simulator', 'RunToMain'))),
                boolField('debug.simRestoreBreakpoints', '仿真恢复断点', 'Simulator/RestoreBreakpoints',
                    forAllButArm6(debugOption('Simulator', 'RestoreBreakpoints'))),
                boolField('debug.simRestoreWatchpoints', '仿真恢复观察点', 'Simulator/RestoreWatchpoints',
                    forAllButArm6(debugOption('Simulator', 'RestoreWatchpoints')))
            ]
        },
        {
            id: 'debug.target',
            title: '目标调试（.uvprojx DebugOption/Target）',
            description: '仅 AC5/C51/C251 目标写入该子树。',
            fields: [
                boolField('debug.useTarget', '使用目标调试', 'Target/UseTarget',
                    forAllButArm6(debugOption('Target', 'UseTarget'))),
                boolField('debug.targetLoadApplicationAtStartup', '目标调试启动时加载程序',
                    'Target/LoadApplicationAtStartup',
                    forAllButArm6(debugOption('Target', 'LoadApplicationAtStartup'))),
                boolField('debug.targetRunToMain', '目标调试运行到 main', 'Target/RunToMain',
                    forAllButArm6(debugOption('Target', 'RunToMain'))),
                boolField('debug.targetRestoreBreakpoints', '目标调试恢复断点', 'Target/RestoreBreakpoints',
                    forAllButArm6(debugOption('Target', 'RestoreBreakpoints'))),
                boolField('debug.targetRestoreWatchpoints', '目标调试恢复观察点', 'Target/RestoreWatchpoints',
                    forAllButArm6(debugOption('Target', 'RestoreWatchpoints'))),
                field('debug.targetDllDriver', '调试器驱动文件', 'TargetDlls/Driver', 'string', 'uvprojx',
                    forAllButArm6(debugOption('TargetDlls', 'Driver')), {
                    placeholder: 'BIN\\UL2CM3.DLL'
                }),
                field('debug.targetDllsInitializationFile', '目标调试初始化文件', 'TargetDlls/InitializationFile', 'string',
                    'uvprojx', forAllButArm6(debugOption('TargetDlls', 'InitializationFile')), {
                    placeholder: '.\\Debug_RAM.ini'
                }),
                field('debug.simDllsInitializationFile', '仿真器初始化文件', 'SimDlls/InitializationFile', 'string',
                    'uvprojx', forAllButArm6(debugOption('SimDlls', 'InitializationFile')), {
                    placeholder: '.\\Simulator.ini'
                }),
                field('debug.targetSelection', '调试目标选择', 'DebugOption/TargetSelection', 'string', 'uvprojx',
                    forAllButArm6(debugOption('TargetSelection')), {
                    tooltip: 'uVision 写入的调试器选择索引，通常由调试器选择自动维护。'
                })
            ]
        },
        {
            id: 'debug.uvoptDebugger',
            title: '调试器选项（.uvopt DebugOpt）',
            description: '调试器选择与启动行为保存在 .uvoptx/.uvopt 的 DebugOpt 中。',
            fields: [
                uvoptBoolField('debug.uvoptRunSim', '使用仿真器（uSim）', 'DebugOpt/uSim', all(opt('DebugOpt', 'uSim'))),
                uvoptBoolField('debug.uvoptRunTarget', '使用目标调试（uTrg）', 'DebugOpt/uTrg', all(opt('DebugOpt', 'uTrg'))),
                uvoptBoolField('debug.uvoptSimLoadApp', '仿真启动时加载程序（sLdApp）', 'DebugOpt/sLdApp',
                    all(opt('DebugOpt', 'sLdApp'))),
                uvoptBoolField('debug.uvoptSimGomain', '仿真启动运行到 main（sGomain）', 'DebugOpt/sGomain',
                    all(opt('DebugOpt', 'sGomain'))),
                uvoptBoolField('debug.uvoptTargetLoadApp', '目标调试启动时加载程序（tLdApp）', 'DebugOpt/tLdApp',
                    all(opt('DebugOpt', 'tLdApp'))),
                uvoptBoolField('debug.uvoptTargetGomain', '目标调试运行到 main（tGomain）', 'DebugOpt/tGomain',
                    all(opt('DebugOpt', 'tGomain'))),
                uvoptBoolField('debug.uvoptSimRbreak', '仿真恢复断点（sRbreak）', 'DebugOpt/sRbreak',
                    all(opt('DebugOpt', 'sRbreak'))),
                uvoptBoolField('debug.uvoptTargetRbreak', '目标调试恢复断点（tRbreak）', 'DebugOpt/tRbreak',
                    all(opt('DebugOpt', 'tRbreak'))),
                uvoptField('debug.uvoptSimDll', '仿真驱动 DLL（sDll）', 'DebugOpt/sDll', 'string',
                    all(opt('DebugOpt', 'sDll'))),
                uvoptField('debug.uvoptTargetDll', '目标驱动 DLL（tDll）', 'DebugOpt/tDll', 'string',
                    all(opt('DebugOpt', 'tDll'))),
                uvoptField('debug.uvoptTargetDlgDll', '目标 CPU DLL（tDlgDll）', 'DebugOpt/tDlgDll', 'string',
                    all(opt('DebugOpt', 'tDlgDll'))),
                uvoptField('debug.uvoptMonitor', '调试监视器驱动（pMon）', 'DebugOpt/pMon', 'string',
                    all(opt('DebugOpt', 'pMon')), {
                    placeholder: 'BIN\\UL2CM3.DLL'
                }),
                uvoptField('debug.uvoptTargetSel', '调试器序号（nTsel）', 'DebugOpt/nTsel', 'number',
                    all(opt('DebugOpt', 'nTsel')), {
                    numeric: { min: -1, max: 128, step: 1 },
                    tooltip: 'uVision Debug 页「Use:」下拉的调试器序号（本机 TOOLS.INI 的 CPUDLL 列表序号）。' +
                        '使用面板中的「调试器类型」下拉时，会自动同时维护 nTsel、uSim/uTrg 与 pMon。'
                })
            ]
        },
        {
            id: 'debug.uvoptRun',
            title: '运行控制（.uvopt OPTTT）',
            fields: [
                uvoptBoolField('debug.uvoptOptRunSim', '调试时运行仿真（RunSim）', 'OPTTT/RunSim',
                    all(opt('OPTTT', 'RunSim'))),
                uvoptBoolField('debug.uvoptOptRunTarget', '调试时运行目标（RunTarget）', 'OPTTT/RunTarget',
                    all(opt('OPTTT', 'RunTarget'))),
                uvoptBoolField('debug.uvoptOptBeepAtEnd', '编译结束提示音（BeepAtEnd）', 'OPTTT/BeepAtEnd',
                    all(opt('OPTTT', 'BeepAtEnd'))),
                uvoptBoolField('debug.uvoptOptRunAbUc', '下载后运行（RunAbUc）', 'OPTTT/RunAbUc',
                    all(opt('OPTTT', 'RunAbUc')))
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Tab: utilities
// ---------------------------------------------------------------------------

const UTILITIES_TAB: OptionTabDef = {
    id: 'utilities',
    title: '工具（Utilities）',
    sections: [
        {
            id: 'utilities.flash',
            title: '下载算法与工具',
            fields: [
                boolField('utilities.useTargetDll', '使用目标驱动（UseTargetDll）', 'Flash1/UseTargetDll',
                    all(utilities('Flash1', 'UseTargetDll'))),
                boolField('utilities.useExternalTool', '使用外部工具（UseExternalTool）', 'Flash1/UseExternalTool',
                    all(utilities('Flash1', 'UseExternalTool'))),
                boolField('utilities.runIndependent', '独立运行（RunIndependent）', 'Flash1/RunIndependent',
                    all(utilities('Flash1', 'RunIndependent'))),
                boolField('utilities.updateFlashBeforeDebugging', '调试前更新 Flash（UpdateFlashBeforeDebugging）',
                    'Flash1/UpdateFlashBeforeDebugging', all(utilities('Flash1', 'UpdateFlashBeforeDebugging'))),
                field('utilities.capability', '调试器能力位（Capability）', 'Flash1/Capability', 'enum', 'uvprojx',
                    all(utilities('Flash1', 'Capability')), {
                    enumValues: BOOLEAN_OPTIONS,
                    tooltip: 'uVision 根据所选调试器写入的能力标记，通常无需修改。'
                }),
                field('utilities.driverSelection', '调试/下载驱动选择（DriverSelection）', 'Flash1/DriverSelection', 'enum',
                    'uvprojx', all(utilities('Flash1', 'DriverSelection')), {
                    enumValues: DRIVER_SELECTION_OPTIONS,
                    tooltip: '编号 = 4096 + 本机 TOOLS.INI 中该调试器的序号；面板会按本机 Keil 安装动态列出全部驱动。' +
                        '勾选 “使用调试驱动”（UseTargetDll/bUseTDR）时该值仅作记录，实际以 Options→Debug 的调试器为准。'
                }),
                field('utilities.flash2', 'Flash 下载算法 DLL', 'Utilities/Flash2', 'string', 'uvprojx',
                    all(utilities('Flash2')), {
                    placeholder: 'BIN\\CMSIS_AGDI.dll',
                    tooltip: '下载到目标芯片时使用的 Flash 算法 DLL。'
                }),
                field('utilities.flash3', '外部下载工具命令行', 'Utilities/Flash3', 'string', 'uvprojx',
                    all(utilities('Flash3')), {
                    placeholder: '"nrfprog" (-2 %H -x $X)'
                }),
                field('utilities.flash4', '外部工具初始化文件', 'Utilities/Flash4', 'string', 'uvprojx',
                    all(utilities('Flash4')), {
                    placeholder: '.\\Prog_Ext_Flash.ini'
                })
            ]
        },
        {
            id: 'utilities.misc',
            title: '其他',
            fields: [
                boolField('utilities.bUseTDR', '使用目标驱动记录（bUseTDR）', 'Utilities/bUseTDR',
                    all(utilities('bUseTDR'))),
                boolField('utilities.fcArmLst', '生成 ARM 配置文件列表（FcArmLst）', 'Utilities/FcArmLst',
                    all(utilities('FcArmLst')))
            ]
        }
    ]
};

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/** All option tabs, in the order they are shown in the panel. */
export const OPTION_TABS: OptionTabDef[] = [
    TARGET_TAB,
    OUTPUT_TAB,
    CCPP_TAB,
    ASM_TAB,
    LINKER_TAB,
    DEBUG_TAB,
    UTILITIES_TAB
];

/** Fast id -> field lookup used by the data layer and the panel. */
export const OPTION_FIELDS_BY_ID: ReadonlyMap<string, OptionFieldDef> = new Map(
    OPTION_TABS.flatMap((tab) => tab.sections.flatMap((section) => section.fields))
        .map((optionField) => [optionField.id, optionField] as [string, OptionFieldDef])
);

/** All schema fields in declaration order. */
export const OPTION_FIELDS: readonly OptionFieldDef[] = Array.from(OPTION_FIELDS_BY_ID.values());

export function getOptionField(id: string): OptionFieldDef | undefined {
    return OPTION_FIELDS_BY_ID.get(id);
}

/** True when the field is declared for the given toolchain family. */
export function isFieldDeclaredFor(field: OptionFieldDef, toolchain: UvToolchainKind): boolean {
    const path = field.path[toolchain];
    return Array.isArray(path) && path.length > 0;
}
