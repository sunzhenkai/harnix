import { describe, expect, it } from 'vitest';
import {
  createHarness,
  defaultHarnixSettings,
  listHarnessDescriptors,
  normalizeHarnixSettings,
  probeHarness,
} from './index.js';

describe('harnix aggregate package', () => {
  it('lists descriptors for native, pi, and acp', () => {
    const descriptors = listHarnessDescriptors();
    expect(descriptors.map((d) => d.id)).toEqual(['native', 'pi', 'acp']);
    expect(descriptors.find((d) => d.id === 'acp')?.requiresProvider).toBe(false);
  });

  it('creates native, pi, and acp harnesses from HarnixSettings', async () => {
    const settings = normalizeHarnixSettings({
      defaultKind: 'pi',
      acp: {
        defaultAgentId: 'mock',
        agents: {
          mock: {
            id: 'mock',
            name: 'Mock',
            enabled: true,
            command: process.execPath,
            args: ['-e', 'console.log("ok")'],
          },
        },
      },
    });

    const nativeHarness = createHarness({
      kind: 'native',
      settings,
      provider: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3' },
    });
    expect(nativeHarness.capabilities.id).toBe('native');

    const piHarness = createHarness({
      kind: 'pi',
      settings,
      provider: { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
    });
    expect(piHarness.capabilities.id).toBe('pi');

    const acpHarness = createHarness({ kind: 'acp', settings });
    expect(acpHarness.capabilities.id).toBe('acp');
    await acpHarness.close?.();
  });

  it('probes native/pi provider settings and acp disabled state', async () => {
    const settings = defaultHarnixSettings();
    const okNative = await probeHarness({
      kind: 'native',
      settings,
      provider: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3' },
    });
    expect(okNative.ok).toBe(true);

    const missingProvider = await probeHarness({ kind: 'pi', settings });
    expect(missingProvider.ok).toBe(false);

    const noAcp = await probeHarness({ kind: 'acp', settings });
    expect(noAcp.status).toBe('disabled');
  });
});
