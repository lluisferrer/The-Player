// Regla anti-duplicació: cada cue surt per UN sol camí segons el seu target.
import { describe, it, expect } from 'vitest';
import { dispatchCue } from '../cueDispatch';

const st = (selectedDeviceId, colorOutputs = {}) => ({ selectedDeviceId, colorOutputs });

describe('dispatchCue', () => {
  it('ASIO', () => {
    const d = dispatchCue(st('asio:MixPre|0,1'), { color: null });
    expect(d.route).toBe('asio');
    expect(d.target.driver).toBe('MixPre');
  });
  it('natiu', () => {
    expect(dispatchCue(st('native:|0,1'), {}).route).toBe('native');
  });
  it('WASAPI per defecte', () => {
    expect(dispatchCue(st('default'), {}).route).toBe('wasapi');
  });
  it('el color decideix el camí per damunt del bus', () => {
    const d = dispatchCue(st('default', { blue: 'native:X|2,3' }), { color: 'blue' });
    expect(d).toEqual({ route: 'native', target: { kind: 'native', device: 'X', channels: [2, 3] } });
  });
});
