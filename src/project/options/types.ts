/**
 * Shared type contracts for Keil project option editing.
 *
 * This file is the single source of truth for the data shapes exchanged between:
 * - the option schema / read-write model (`uvOptionSchema.ts`, `uvOptions.ts`, `uvoptFile.ts`)
 * - the webview option panel host (`optionsPanel.ts`) and its generated assets (`panelAssets.ts`)
 * - the extension wiring (`extension.ts`)
 *
 * Keep this file free of runtime dependencies so it can be imported from unit tests.
 */

/** Toolchain family detected from the target XML subtree. */
export type UvToolchainKind = 'ARM' | 'ARM6' | 'C51' | 'C251';

/** Option tabs mirroring the Keil "Options for Target" dialog. */
export type OptionTabId = 'target' | 'output' | 'ccpp' | 'asm' | 'linker' | 'debug' | 'utilities';

/**
 * Input control used to edit an option field.
 * `info` renders a read-only text value (used by the generated MCU / debugger
 * information sections); it never takes part in dirty tracking or saving.
 */
export type OptionValueType = 'string' | 'multiline' | 'bool' | 'number' | 'enum' | 'info';

/** Project file that owns a given option field. */
export type OptionFileKind = 'uvprojx' | 'uvopt';

export interface OptionEnumValue {
    /** Raw value written into the XML file. */
    value: string;
    /** Human readable label rendered in the panel. */
    label: string;
}

/** Declarative description of one editable target option. */
export interface OptionFieldDef {
    /** Stable identifier, e.g. `ccpp.optim`. Never localized, never reordered casually. */
    id: string;
    /** Chinese label rendered in the panel. */
    label: string;
    /** Optional English/short hint rendered next to the label. */
    hint?: string;
    type: OptionValueType;
    file: OptionFileKind;
    /**
     * Element path relative to the `<Target>` element, per toolchain family.
     * Elements missing from a toolchain are simply not declared here.
     */
    path: Partial<Record<UvToolchainKind, string[]>>;
    enumValues?: OptionEnumValue[];
    placeholder?: string;
    numeric?: { min?: number; max?: number; step?: number };
    /** Value rendered but not editable. */
    readonly?: boolean;
    /** Longer explanation/tooltip text. */
    tooltip?: string;
}

export interface OptionSectionDef {
    id: string;
    title: string;
    description?: string;
    fields: OptionFieldDef[];
}

export interface OptionTabDef {
    id: OptionTabId;
    title: string;
    sections: OptionSectionDef[];
}

/** One field as rendered by the webview. */
export interface OptionFieldView {
    id: string;
    label: string;
    hint?: string;
    type: OptionValueType;
    value: string;
    options?: OptionEnumValue[];
    placeholder?: string;
    readonly?: boolean;
    /** True when the active toolchain / project files cannot provide this value. */
    unavailable?: boolean;
    unavailableReason?: string;
}

export interface OptionSectionView {
    id: string;
    title: string;
    description?: string;
    fields: OptionFieldView[];
}

export interface OptionTabView {
    id: string;
    title: string;
    sections: OptionSectionView[];
}

/** Complete payload sent from the extension host to the webview. */
export interface OptionsViewData {
    projectLabel: string;
    projectFile: string;
    uvoptFile?: string;
    targets: string[];
    activeTarget: string;
    /** Human readable toolchain label, e.g. `ARM (AC6)`. */
    toolchain: string;
    tabs: OptionTabView[];
    warnings: string[];
    /** Whole panel is read-only (non UTF-8 file, unparsable XML, ...). */
    readonly: boolean;
    readonlyReason?: string;
}

/** Result of applying option edits, surfaced back to the panel and the user. */
export interface OptionApplyResult {
    xml: string;
    changed: string[];
    warnings: string[];
}

/** Summary returned by the panel host after a save request. */
export interface OptionApplyResultSummary {
    changed: string[];
    warnings: string[];
}
