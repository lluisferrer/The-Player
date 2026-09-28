// Mapa de tecles QWERTY → slots (i tecles de transport que han de quedar lliures).
import { describe, it, expect } from 'vitest';
import { keyForSlot, slotForKey } from '../keyMap';

describe('keyMap', () => {
  it('extrems de cada fila', () => {
    expect(keyForSlot(1)).toBe('1');
    expect(keyForSlot(8)).toBe('8');
    expect(keyForSlot(9)).toBe('q');
    expect(keyForSlot(32)).toBe(',');
  });
  it('fora de rang → buit / null', () => {
    expect(keyForSlot(0)).toBe('');
    expect(keyForSlot(33)).toBe('');
    expect(slotForKey(undefined)).toBeNull();
  });
  it('round-trip dels 32 slots i majúscules', () => {
    for (let i = 1; i <= 32; i++) expect(slotForKey(keyForSlot(i))).toBe(i);
    expect(slotForKey('Q')).toBe(9);
  });
  it('les tecles de transport (9, 0, P) queden lliures', () => {
    expect(slotForKey('9')).toBeNull();
    expect(slotForKey('0')).toBeNull();
    expect(slotForKey('p')).toBeNull();
  });
});
