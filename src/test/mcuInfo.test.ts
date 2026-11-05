import { strict as assert } from 'assert';
import {
    McuDescription,
    McuMemoryRegion,
    buildMcuInfoRows,
    formatAddress,
    formatBytes,
    parseCpuDescription,
    parseMcuDescription
} from '../project/options/mcuInfo';
import { getOptionField } from '../project/options/uvOptionSchema';

/**
 * Real `Cpu` strings taken from the project corpus. They cover the five shapes
 * the parser has to understand: ARM with `start,size`, ARM with inclusive
 * ranges, ARM with a second RAM region, C51 (no `CPUTYPE`) and C251.
 */
const ARM_CORTEX_M4 =
    'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE';
const ARM_CORTEX_M3_RANGE =
    'IRAM(0x20000000-0x20001FFF) IROM(0x0000000-0x001FFFF) CLOCK(16000000) CPUTYPE("Cortex-M3") TZ';
const ARM_MULTI_RAM =
    'IRAM(0x10000000-0x10007FFF) IRAM2(0x2007C000-0x20083FFF) IROM(0-0x7FFFF) CLOCK(12000000) CPUTYPE("Cortex-M3")';
const C51_CPU = 'IRAM(0-0x7F) IROM(0-0xFFF) CLOCK(12000000)';
const C251_CPU = 'IRAM(0 - 0x41F) CLOCK(24000000) IROM(0xFF0000-0xFF3FFF)';

function memoryRegion(kind: string, start: number, size: number): McuMemoryRegion {
    return { kind, start, size };
}

function rowValue(rows: ReturnType<typeof buildMcuInfoRows>, id: string): string {
    const row = rows.find((entry) => entry.id === id);
    assert.ok(row, `row ${id} not rendered`);
    return row.value;
}

describe('mcuInfo', () => {
    it('parses the five real world Cpu string shapes', () => {
        const m4 = parseCpuDescription(ARM_CORTEX_M4);
        assert.equal(m4.core, 'Cortex-M4');
        assert.equal(m4.clockHz, 12000000);
        assert.deepEqual(m4.flash, memoryRegion('IROM', 0x08000000, 0x00100000));
        assert.deepEqual(m4.ram, memoryRegion('IRAM', 0x20000000, 0x00020000));
        assert.deepEqual(m4.memories, [
            memoryRegion('IRAM', 0x20000000, 0x00020000),
            memoryRegion('IROM', 0x08000000, 0x00100000)
        ]);
        assert.equal(m4.fpu, true);
        assert.equal(m4.dsp, undefined);
        assert.equal(m4.trustZone, undefined);
        assert.equal(m4.endian, 'little');

        const m3 = parseCpuDescription(ARM_CORTEX_M3_RANGE);
        assert.equal(m3.core, 'Cortex-M3');
        assert.equal(m3.clockHz, 16000000);
        assert.deepEqual(m3.flash, memoryRegion('IROM', 0, 0x20000));
        assert.deepEqual(m3.ram, memoryRegion('IRAM', 0x20000000, 0x2000));
        assert.deepEqual(m3.memories, [
            memoryRegion('IRAM', 0x20000000, 0x2000),
            memoryRegion('IROM', 0, 0x20000)
        ]);
        assert.equal(m3.fpu, undefined);
        assert.equal(m3.dsp, undefined);
        assert.equal(m3.trustZone, true);
        assert.equal(m3.endian, undefined);

        const multi = parseCpuDescription(ARM_MULTI_RAM);
        assert.equal(multi.core, 'Cortex-M3');
        assert.equal(multi.clockHz, 12000000);
        assert.deepEqual(multi.memories, [
            memoryRegion('IRAM', 0x10000000, 0x8000),
            memoryRegion('IRAM2', 0x2007c000, 0x8000),
            memoryRegion('IROM', 0, 0x80000)
        ]);
        assert.deepEqual(multi.flash, memoryRegion('IROM', 0, 0x80000));
        assert.deepEqual(multi.ram, memoryRegion('IRAM', 0x10000000, 0x8000));
        assert.equal(multi.fpu, undefined);
        assert.equal(multi.endian, undefined);

        // C51 / C251 strings carry no CPUTYPE: the core is inferred from the map.
        const c51 = parseCpuDescription(C51_CPU);
        assert.equal(c51.core, 'MCS-51 (8051)');
        assert.equal(c51.clockHz, 12000000);
        assert.deepEqual(c51.flash, memoryRegion('IROM', 0, 0x1000));
        assert.deepEqual(c51.ram, memoryRegion('IRAM', 0, 0x80));
        assert.equal(c51.fpu, undefined);
        assert.equal(c51.dsp, undefined);
        assert.equal(c51.trustZone, undefined);
        assert.equal(c51.endian, undefined);

        const c251 = parseCpuDescription(C251_CPU);
        assert.equal(c251.core, 'MCS-251');
        assert.equal(c251.clockHz, 24000000);
        assert.deepEqual(c251.memories, [
            memoryRegion('IRAM', 0, 0x420),
            memoryRegion('IROM', 0xff0000, 0x4000)
        ]);
        assert.deepEqual(c251.flash, memoryRegion('IROM', 0xff0000, 0x4000));
        assert.deepEqual(c251.ram, memoryRegion('IRAM', 0, 0x420));
        assert.equal(c251.fpu, undefined);
        assert.equal(c251.trustZone, undefined);
        assert.equal(c251.endian, undefined);
    });

    it('converts comma sizes and inclusive address ranges to byte counts', () => {
        const range = parseCpuDescription('IRAM(0x20000000-0x20001FFF)');
        assert.deepEqual(range.ram, memoryRegion('IRAM', 0x20000000, 8192));
        assert.equal(formatBytes(8192), '8 KB');

        const paddedRange = parseCpuDescription('IRAM(0 - 0x41F)');
        assert.deepEqual(paddedRange.ram, memoryRegion('IRAM', 0, 0x420));

        const comma = parseCpuDescription('IROM(0x08000000,0x00100000)');
        assert.deepEqual(comma.flash, memoryRegion('IROM', 0x08000000, 0x00100000));

        const zeroBased = parseCpuDescription('IROM(0-0xFFF)');
        assert.deepEqual(zeroBased.flash, memoryRegion('IROM', 0, 4096));
        assert.equal(formatBytes(4096), '4 KB');

        // A single address has no known extent; it is kept with a zero size.
        const single = parseCpuDescription('IRAM(0x20000000)');
        assert.deepEqual(single.ram, memoryRegion('IRAM', 0x20000000, 0));
        assert.equal(formatBytes(0), '0 B');

        // Decimal tokens are accepted as well.
        const decimal = parseCpuDescription('IROM(0,4096)');
        assert.deepEqual(decimal.flash, memoryRegion('IROM', 0, 4096));

        // OCR_RVCTn regions use the same `start,size` / `start-end` syntax.
        const ocr = parseCpuDescription('OCR_RVCT1(0x20000000,0x00010000) OCR_RVCT2(0x20010000-0x2001FFFF)');
        assert.deepEqual(ocr.memories, [
            memoryRegion('OCR_RVCT1', 0x20000000, 0x10000),
            memoryRegion('OCR_RVCT2', 0x20010000, 0x10000)
        ]);
    });

    it('never throws on empty or malformed Cpu strings', () => {
        const emptyInputs: (string | undefined)[] = [
            undefined,
            '',
            '   ',
            'garbage',
            'IRAM(0x20000000',
            'IRAM(zzz) IROM() CLOCK(abc)',
            'mcuInfo'
        ];
        for (const input of emptyInputs) {
            const description = parseCpuDescription(input);
            assert.deepEqual(description.memories, [], String(input));
            assert.equal(description.flash, undefined, String(input));
            assert.equal(description.ram, undefined, String(input));
            assert.equal(description.clockHz, undefined, String(input));
        }

        // A string without a memory map still yields the information it does carry.
        const coreOnly = parseCpuDescription('CPUTYPE("Cortex-M4") FPU2 ELITTLE');
        assert.equal(coreOnly.core, 'Cortex-M4');
        assert.equal(coreOnly.fpu, true);
        assert.equal(coreOnly.endian, 'little');
        assert.deepEqual(coreOnly.memories, []);

        assert.doesNotThrow(() => parseMcuDescription({}, 'ARM'));
        assert.doesNotThrow(() => parseMcuDescription({ 'target.cpu': 'IRAM(0x20000000' }, 'C51'));
        assert.doesNotThrow(() => buildMcuInfoRows({ 'target.cpu': 'IROM(zzz)' }, 'C251'));
    });

    it('formats byte counts for the B / KB / MB boundaries', () => {
        assert.equal(formatBytes(0), '0 B');
        assert.equal(formatBytes(123), '123 B');
        assert.equal(formatBytes(512), '512 B');
        assert.equal(formatBytes(1023), '1023 B');
        assert.equal(formatBytes(1024), '1 KB');
        assert.equal(formatBytes(1536), '1.5 KB');
        assert.equal(formatBytes(65536), '64 KB');
        assert.equal(formatBytes(524288), '512 KB');
        assert.equal(formatBytes(1048576), '1 MB');
        assert.equal(formatBytes(1572864), '1.5 MB');
    });

    it('formats addresses as lower case hexadecimal with eight digits', () => {
        assert.equal(formatAddress(0), '0x00000000');
        assert.equal(formatAddress(0xfff), '0x00000fff');
        assert.equal(formatAddress(0x08000000), '0x08000000');
        assert.equal(formatAddress(0x2007c000), '0x2007c000');
        assert.equal(formatAddress(0xffffffff), '0xffffffff');
    });

    it('formats the clock with exact MHz decimals, dropping to Hz below 1 MHz', () => {
        const cases: [string, string][] = [
            ['CLOCK(72000000)', '72 MHz'],
            ['CLOCK(12500000)', '12.5 MHz'],
            ['CLOCK(11059200)', '11.0592 MHz'],
            ['CLOCK(24000000)', '24 MHz'],
            ['CLOCK(123)', '123 Hz']
        ];
        for (const item of cases) {
            const rows = buildMcuInfoRows({ 'target.cpu': item[0] }, 'ARM');
            assert.equal(rowValue(rows, 'mcu.clock'), item[1], item[0]);
        }
    });

    it('parses FPU3(...), MVE(...) and IROM2/XRAM2 tokens from modern projects', () => {
        // Taken from a real Cortex-M55 project of the local corpus: `FPU3(DFPU)`
        // precedes `CLOCK`, `MVE(FP)` is a feature token, not a memory region.
        const cpu =
            'IRAM(0x30000000,0x00020000) IRAM2(0x20000000,0x00020000) ' +
            'IROM(0x10000000,0x00200000) IROM2(0x00000000,0x00200000) ' +
            'CPUTYPE("Cortex-M55") FPU3(DFPU) DSP TZ MVE(FP) CLOCK(12000000) ESEL ELITTLE';
        const description = parseCpuDescription(cpu);
        assert.equal(description.core, 'Cortex-M55');
        assert.equal(description.fpu, true);
        assert.equal(description.dsp, true);
        assert.equal(description.trustZone, true);
        assert.equal(description.endian, 'little');
        assert.deepEqual(
            description.memories.map((region) => region.kind),
            ['IRAM', 'IRAM2', 'IROM', 'IROM2']
        );
        assert.deepEqual(
            description.memories.find((region) => region.kind === 'IROM2'),
            memoryRegion('IROM2', 0, 0x200000)
        );

        const rows = buildMcuInfoRows({ 'target.cpu': cpu }, 'ARM6');
        assert.equal(rowValue(rows, 'mcu.clock'), '12 MHz');
        assert.equal(rowValue(rows, 'mcu.flash'), '2 MB @ 0x10000000');
        assert.equal(rowValue(rows, 'mcu.ram'), '128 KB @ 0x30000000');
        assert.equal(
            rowValue(rows, 'mcu.otherMemories'),
            'IRAM2 128 KB @ 0x20000000; IROM2 2 MB @ 0x00000000'
        );
        assert.equal(rowValue(rows, 'mcu.features'), 'FPU、DSP、TrustZone、小端');
    });

    it('reports big endian targets in the features row', () => {
        const cpu = 'IRAM(0x20000000,0x1000) IROM(0x0,0x1000) CLOCK(1000000) CPUTYPE("Cortex-R4") EBIG';
        const description = parseCpuDescription(cpu);
        assert.equal(description.endian, 'big');
        assert.equal(description.core, 'Cortex-R4');
        const rows = buildMcuInfoRows({ 'target.cpu': cpu }, 'ARM');
        assert.equal(rowValue(rows, 'mcu.features'), '大端');
    });

    it('merges the target option values into a complete description', () => {
        const description = parseMcuDescription(
            {
                'target.device': ' STM32F407VGTx ',
                'target.vendor': 'STMicroelectronics',
                'target.packId': 'Keil.STM32F4xx_DFP.2.17.1',
                'target.cpu': ARM_CORTEX_M4,
                'target.sfdFile': '$$Device:STM32F407VGTx$Device\\STM32F4xx.svd',
                'target.registerFile': 'stm32f4xx.h'
            },
            'ARM6'
        );
        assert.equal(description.device, 'STM32F407VGTx');
        assert.equal(description.vendor, 'STMicroelectronics');
        assert.equal(description.packId, 'Keil.STM32F4xx_DFP.2.17.1');
        assert.equal(description.core, 'Cortex-M4');
        assert.equal(description.registerFile, 'stm32f4xx.h');
        assert.equal(description.svdFile, '$$Device:STM32F407VGTx$Device\\STM32F4xx.svd');
        assert.equal(description.clockHz, 12000000);

        // The Cpu CLOCK wins over the .uvopt crystal; the crystal is the fallback.
        const fallback = parseMcuDescription(
            {
                'target.cpu': 'IRAM(0x20000000,0x00010000) IROM(0x08000000,0x00080000) CPUTYPE("Cortex-M3")',
                'target.xtal': '8000000'
            },
            'ARM'
        );
        assert.equal(fallback.clockHz, 8000000);

        const c51 = parseMcuDescription({ 'target.cpu': C51_CPU, 'target.registerFile': 'REGX51.H' }, 'C51');
        assert.equal(c51.core, 'MCS-51 (8051)');
        assert.equal(c51.registerFile, 'REGX51.H');
        assert.equal(c51.svdFile, undefined);

        const c251 = parseMcuDescription({ 'target.cpu': C251_CPU }, 'C251');
        assert.equal(c251.core, 'MCS-251');

        // An ARM Cpu string without CPUTYPE must not be reported as a legacy core.
        const noCpuType = parseMcuDescription(
            { 'target.cpu': 'IRAM(0x20000000,0x00010000) IROM(0x08000000,0x00080000)' },
            'ARM'
        );
        assert.equal(noCpuType.core, undefined);
        assert.equal(noCpuType.clockHz, undefined);
    });

    it('builds the read-only rows of an ARM project', () => {
        const rows = buildMcuInfoRows(
            {
                'target.device': 'STM32F407VGTx',
                'target.vendor': 'STMicroelectronics',
                'target.packId': 'Keil.STM32F4xx_DFP.2.17.1',
                'target.cpu': ARM_CORTEX_M4,
                'target.sfdFile': '$$Device:STM32F407VGTx$Device\\STM32F4xx.svd',
                'target.registerFile': ''
            },
            'ARM6'
        );
        assert.deepEqual(rows.map((row) => row.id), [
            'mcu.device',
            'mcu.core',
            'mcu.clock',
            'mcu.flash',
            'mcu.ram',
            'mcu.features',
            'mcu.svdFile'
        ]);
        assert.equal(rowValue(rows, 'mcu.device'), 'STM32F407VGTx');
        assert.equal(rowValue(rows, 'mcu.core'), 'Cortex-M4');
        assert.equal(rowValue(rows, 'mcu.clock'), '12 MHz');
        assert.equal(rowValue(rows, 'mcu.flash'), '1 MB @ 0x08000000');
        assert.equal(rowValue(rows, 'mcu.ram'), '128 KB @ 0x20000000');
        assert.equal(rowValue(rows, 'mcu.features'), 'FPU、小端');
        assert.equal(rowValue(rows, 'mcu.svdFile'), '$$Device:STM32F407VGTx$Device\\STM32F4xx.svd');
        for (const row of rows) {
            assert.ok(row.label.length > 0, `row ${row.id} has no label`);
        }
    });

    it('builds the read-only rows of a C51 project without ARM-only rows', () => {
        const rows = buildMcuInfoRows(
            {
                'target.device': 'AT89C51',
                'target.vendor': 'Atmel',
                'target.cpu': C51_CPU,
                'target.registerFile': 'REGX51.H',
                // A SVD file is not a C51 concept: never render the row, even if stored.
                'target.sfdFile': 'legacy.svd'
            },
            'C51'
        );
        assert.deepEqual(rows.map((row) => row.id), [
            'mcu.device',
            'mcu.core',
            'mcu.clock',
            'mcu.flash',
            'mcu.ram',
            'mcu.registerFile'
        ]);
        assert.equal(rowValue(rows, 'mcu.device'), 'AT89C51');
        assert.equal(rowValue(rows, 'mcu.core'), 'MCS-51 (8051)');
        assert.equal(rowValue(rows, 'mcu.clock'), '12 MHz');
        assert.equal(rowValue(rows, 'mcu.flash'), '4 KB @ 0x00000000');
        assert.equal(rowValue(rows, 'mcu.ram'), '128 B @ 0x00000000');
        assert.equal(rowValue(rows, 'mcu.registerFile'), 'REGX51.H');
        assert.equal(rows.some((row) => row.id === 'mcu.features'), false);
        assert.equal(rows.some((row) => row.id === 'mcu.svdFile'), false);

        const c251Rows = buildMcuInfoRows(
            { 'target.cpu': C251_CPU, 'target.registerFile': 'REG251S.H' },
            'C251'
        );
        assert.equal(rowValue(c251Rows, 'mcu.core'), 'MCS-251');
        assert.equal(rowValue(c251Rows, 'mcu.clock'), '24 MHz');
        assert.equal(rowValue(c251Rows, 'mcu.flash'), '16 KB @ 0x00ff0000');
        assert.equal(rowValue(c251Rows, 'mcu.ram'), '1.03 KB @ 0x00000000');
        assert.equal(rowValue(c251Rows, 'mcu.registerFile'), 'REG251S.H');
        assert.equal(c251Rows.some((row) => row.id === 'mcu.features'), false);
    });

    it('renders unknown values as an em dash and omits empty optional rows', () => {
        const rows = buildMcuInfoRows({}, 'ARM');
        assert.deepEqual(rows.map((row) => row.id), [
            'mcu.device',
            'mcu.core',
            'mcu.clock',
            'mcu.flash',
            'mcu.ram'
        ]);
        for (const row of rows) {
            assert.equal(row.value, '—', row.id);
        }

        const deviceOnly = buildMcuInfoRows({ 'target.device': 'STM32F103C8Tx' }, 'ARM');
        assert.equal(rowValue(deviceOnly, 'mcu.device'), 'STM32F103C8Tx');
        assert.equal(rowValue(deviceOnly, 'mcu.core'), '—');
        assert.equal(rowValue(deviceOnly, 'mcu.clock'), '—');
        assert.equal(rowValue(deviceOnly, 'mcu.flash'), '—');
        assert.equal(rowValue(deviceOnly, 'mcu.ram'), '—');
    });

    it('lists memory regions beyond the first IROM and IRAM as other memories', () => {
        const rows = buildMcuInfoRows({ 'target.cpu': ARM_MULTI_RAM }, 'ARM');
        assert.equal(rowValue(rows, 'mcu.flash'), '512 KB @ 0x00000000');
        assert.equal(rowValue(rows, 'mcu.ram'), '32 KB @ 0x10000000');
        assert.equal(rowValue(rows, 'mcu.otherMemories'), 'IRAM2 32 KB @ 0x2007c000');

        const multiple = buildMcuInfoRows(
            {
                'target.cpu':
                    'IRAM(0x0,0x100) IRAM2(0x2007C000,0x8000) IROM(0x0,0x1000) XRAM(0x0,0x400)'
            },
            'ARM'
        );
        assert.equal(
            rowValue(multiple, 'mcu.otherMemories'),
            'IRAM2 32 KB @ 0x2007c000; XRAM 1 KB @ 0x00000000'
        );

        const noOthers = buildMcuInfoRows({ 'target.cpu': ARM_CORTEX_M4 }, 'ARM');
        assert.equal(noOthers.some((row) => row.id === 'mcu.otherMemories'), false);
    });

    it('uses the target.* field ids declared in uvOptionSchema', () => {
        // Ids read by parseMcuDescription / buildMcuInfoRows must exist in the
        // schema, otherwise a typo would silently produce empty MCU information.
        const ids = [
            'target.device',
            'target.vendor',
            'target.packId',
            'target.cpu',
            'target.sfdFile',
            'target.registerFile',
            'target.xtal'
        ];
        for (const id of ids) {
            const optionField = getOptionField(id);
            assert.ok(optionField, `option field ${id} is not declared in uvOptionSchema`);
            assert.equal(optionField.id, id);
        }

        // The memory description is keyed by these ids once more, end to end.
        const description: McuDescription = parseMcuDescription(
            { 'target.device': 'AT89C51', 'target.cpu': C51_CPU, 'target.registerFile': 'REGX51.H' },
            'C51'
        );
        assert.equal(description.device, 'AT89C51');
        assert.equal(description.registerFile, 'REGX51.H');
        assert.equal(description.flash?.start, 0);
        assert.equal(description.ram?.size, 0x80);
    });
});
