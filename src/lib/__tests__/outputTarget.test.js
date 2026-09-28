// Tests del contracte de routing: serialització de targets (WASAPI / ASIO /
// natiu), resolució per color i normalització de plataforma (Linux).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  makeAsioTargetStr, makeNativeTargetStr, parseTarget, isAsioTarget, isNativeTarget,
  isHardwareEngineTarget, targetLabel, resolveCueTargetStr, platformTarget,
  platformColorOutputs, NATIVE_DEFAULT_TARGET,
} from '../outputTarget';

describe('serialització de targets', () => {
  it('ASIO: round-trip driver + canals', () => {
    const s = makeAsioTargetStr('MixPre', [2, 3]);
    expect(s).toBe('asio:MixPre|2,3');
    expect(parseTarget(s)).toEqual({ kind: 'asio', driver: 'MixPre', channels: [2, 3] });
  });

  it('natiu: round-trip i dispositiu buit = per defecte', () => {
    expect(parseTarget(makeNativeTargetStr('Altavoces (X)', [0, 1])))
      .toEqual({ kind: 'native', device: 'Altavoces (X)', channels: [0, 1] });
    expect(NATIVE_DEFAULT_TARGET).toBe('native:|0,1');
    expect(parseTarget(NATIVE_DEFAULT_TARGET)).toEqual({ kind: 'native', device: '', channels: [0, 1] });
  });

  it('descarta canals invàlids en construir', () => {
    expect(makeAsioTargetStr('D', [0, -1, 1.5, 3])).toBe('asio:D|0,3');
  });

  it('retrocompatible: qualsevol altre string és WASAPI', () => {
    expect(parseTarget('{0.0.0.1}.{abc}')).toEqual({ kind: 'wasapi', deviceId: '{0.0.0.1}.{abc}' });
    expect(parseTarget('')).toEqual({ kind: 'wasapi', deviceId: 'default' });
    expect(parseTarget(undefined)).toEqual({ kind: 'wasapi', deviceId: 'default' });
  });

  it('predicats de motor', () => {
    expect(isAsioTarget('asio:D|0,1')).toBe(true);
    expect(isNativeTarget('native:|0,1')).toBe(true);
    expect(isHardwareEngineTarget('default')).toBe(false);
    expect(isHardwareEngineTarget('native:X|0,1')).toBe(true);
    expect(isHardwareEngineTarget(null)).toBe(false);
  });

  it('etiquetes llegibles (canals 1-indexats)', () => {
    expect(targetLabel('asio:MixPre|2,3')).toBe('ASIO · MixPre · ch 3-4');
    expect(targetLabel('native:|0,1')).toBe('Default · ch 1-2');
    expect(targetLabel('default')).toBe('Per defecte');
  });
});

describe('resolveCueTargetStr', () => {
  const state = { selectedDeviceId: 'native:|0,1', colorOutputs: { '#f00': 'asio:D|4,5' } };
  it('el color assignat mana sobre el bus de Cues', () => {
    expect(resolveCueTargetStr(state, { color: '#f00' })).toBe('asio:D|4,5');
  });
  it('sense color o color no assignat → bus de Cues', () => {
    expect(resolveCueTargetStr(state, { color: null })).toBe('native:|0,1');
    expect(resolveCueTargetStr(state, { color: '#0f0' })).toBe('native:|0,1');
  });
});

describe('normalització de plataforma', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('fora de Linux no toca res', () => {
    expect(platformTarget('default')).toBe('default');
    expect(platformColorOutputs({ a: 'x' })).toEqual({ a: 'x' });
    expect(platformColorOutputs(undefined)).toEqual({});
  });

  it('a Linux, Web Audio → natiu per defecte; ASIO/natiu i "cues" es respecten', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15' });
    vi.resetModules();
    const m = await import('../outputTarget');
    expect(m.IS_LINUX).toBe(true);
    expect(m.platformTarget('default')).toBe('native:|0,1');
    expect(m.platformTarget('')).toBe('native:|0,1');
    expect(m.platformTarget('native:ravenna_out|4,5')).toBe('native:ravenna_out|4,5');
    expect(m.platformColorOutputs({ r: 'someWasapiId', g: 'cues', b: 'native:aes67|0,1' }))
      .toEqual({ r: 'native:|0,1', b: 'native:aes67|0,1' });
  });

  it('Android no compta com a Linux', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
    vi.resetModules();
    const m = await import('../outputTarget');
    expect(m.IS_LINUX).toBe(false);
  });
});
