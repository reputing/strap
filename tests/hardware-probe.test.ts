import { describe, expect, it } from 'vitest';
import { parseHardware } from '@main/platform/windows/windows-adapter';

const base = {
  cpuModel: 'AMD Ryzen 5 5600X',
  cpuCores: 6,
  cpuThreads: 12,
  cpuMhz: 3700,
  memoryTotal: 16 * 1024 ** 3,
  memoryFree: 8 * 1024 ** 3,
  osName: 'Windows 11 Pro',
  osVersion: '10.0.26200',
  osBuild: '26200',
  osArch: '64-bit'
};

const gpu = { model: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', memoryBytes: 2_147_483_648 };

describe('hardware probe', () => {
  it('reads a GPU list', () => {
    const hw = parseHardware({ ...base, gpus: [gpu] });
    expect(hw.gpu).toHaveLength(1);
    expect(hw.gpu[0]?.model).toBe('NVIDIA GeForce RTX 3060');
  });

  it('reads a GPU list that PowerShell wrapped in a second list', () => {
    const hw = parseHardware({ ...base, gpus: [[gpu]] });
    expect(hw.gpu[0]?.model).toBe('NVIDIA GeForce RTX 3060');
    expect(hw.gpu[0]?.vendor).toBe('NVIDIA');
  });

  it('reads a single adapter that arrived as a bare object', () => {
    const hw = parseHardware({ ...base, gpus: gpu });
    expect(hw.gpu[0]?.model).toBe('NVIDIA GeForce RTX 3060');
  });

  it('drops an empty entry rather than reporting a GPU called Unknown', () => {
    expect(parseHardware({ ...base, gpus: [[]] }).gpu).toEqual([]);
    expect(parseHardware({ ...base, gpus: [] }).gpu).toEqual([]);
    expect(parseHardware(base).gpu).toEqual([]);
  });

  it('classifies integrated graphics as such, which a lost GPU name prevented', () => {
    const integrated = { model: 'Intel(R) UHD Graphics 620', vendor: 'Intel Corporation', memoryBytes: null };
    const hw = parseHardware({ ...base, memoryTotal: 8 * 1024 ** 3, gpus: [[integrated]] });
    expect(hw.tier).toBe('low');
  });

  it('reports memory the adapter could not describe as unknown rather than as a wrapped value', () => {
    const hw = parseHardware({ ...base, gpus: [{ ...gpu, memoryBytes: 4_293_918_720 }] });
    expect(hw.gpu[0]?.memoryBytes).toBeNull();
  });
});
