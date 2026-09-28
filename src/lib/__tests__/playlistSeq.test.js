// Seqüenciació de la Playlist: següent/anterior amb repeat i shuffle.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nextIndex, prevIndex } from '../playlistSeq';

const g = (n, mode = 'off', shuffle = false) => () => ({
  playlist: Array.from({ length: n }, (_, i) => ({ id: i })),
  playlistRepeatMode: mode,
  playlistShuffle: shuffle,
});

describe('nextIndex', () => {
  afterEach(() => vi.restoreAllMocks());
  it('llista buida → null', () => expect(nextIndex(g(0), 0)).toBeNull());
  it('seqüencial i final sense repetició', () => {
    expect(nextIndex(g(3), 0)).toBe(1);
    expect(nextIndex(g(3), 2)).toBeNull();
  });
  it("repeat list torna a l'inici", () => expect(nextIndex(g(3, 'list'), 2)).toBe(0));
  it("repeat song: només l'avanç automàtic repeteix", () => {
    expect(nextIndex(g(3, 'song'), 1, true)).toBe(1);
    expect(nextIndex(g(3, 'song'), 1, false)).toBe(2);
  });
  it('shuffle mai repeteix la mateixa pista', () => {
    // 0.4 → índex 1 (el mateix: torna a tirar), 0.9 → índex 2.
    const r = vi.spyOn(Math, 'random').mockReturnValueOnce(0.4).mockReturnValueOnce(0.9);
    expect(nextIndex(g(3, 'off', true), 1)).toBe(2);
    expect(r).toHaveBeenCalledTimes(2);
  });
  it('shuffle amb una sola pista', () => {
    expect(nextIndex(g(1, 'off', true), 0)).toBeNull();
    expect(nextIndex(g(1, 'list', true), 0)).toBe(0);
  });
});

describe('prevIndex', () => {
  it('buida → null', () => expect(prevIndex(g(0), 0)).toBeNull());
  it("retrocedeix i s'atura a 0 sense repetició", () => {
    expect(prevIndex(g(3), 2)).toBe(1);
    expect(prevIndex(g(3), 0)).toBe(0);
  });
  it('repeat list salta al final', () => expect(prevIndex(g(3, 'list'), 0)).toBe(2));
});
