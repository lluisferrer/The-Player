// Format del fitxer de show: rutes relatives, separació show/màquina i lectura v1/v2.
import { describe, it, expect } from 'vitest';
import {
  toShowRelative, fromShowRelative, dirOf, showNameOf, serializeShow, parseShow,
  mediaPathsOf, SHOW_DEFAULTS,
} from '../showFile';

const WIN_SHOW = 'D:\\Shows\\Gala\\Gala.ezyshow';
const LIN_SHOW = '/home/op/Shows/Gala/Gala.ezyshow';

const baseState = (over = {}) => ({
  slots: [
    { id: 1, filePath: 'D:\\Shows\\Gala\\Media\\intro.wav', label: 'Intro', volume: 0.5 },
    { id: 2, filePath: null, label: '' },
    { id: 3, filePath: 'E:\\Other\\fx.mp3', label: 'FX' },
  ],
  playlist: [{ id: 7, filePath: 'd:\\shows\\gala\\Media\\song.mp3', label: 'Song' }],
  crossfade: 3, playlistRepeatMode: 'off', playlistShuffle: false, playlistVolume: 0.8,
  ...SHOW_DEFAULTS,
  // Globals de màquina: no han d'anar al fitxer.
  selectedDeviceId: 'asio:MixPre|0,1',
  colorOutputs: { red: 'native:X|0,1' },
  ...over,
});

describe('rutes', () => {
  it('dirOf i showNameOf', () => {
    expect(dirOf(WIN_SHOW)).toBe('D:\\Shows\\Gala');
    expect(showNameOf(WIN_SHOW)).toBe('Gala');
    expect(showNameOf(LIN_SHOW)).toBe('Gala');
  });
  it('relativa dins la carpeta, sense distingir majúscules a Windows', () => {
    expect(toShowRelative('D:\\Shows\\Gala\\Media\\a.wav', 'D:\\Shows\\Gala')).toBe('Media/a.wav');
    expect(toShowRelative('d:\\shows\\gala\\Media\\a.wav', 'D:\\Shows\\Gala')).toBe('Media/a.wav');
    expect(toShowRelative('E:\\x\\a.wav', 'D:\\Shows\\Gala')).toBe('E:\\x\\a.wav');
  });
  it('a Linux sí que distingeix majúscules', () => {
    expect(toShowRelative('/home/op/Shows/Gala/Media/a.wav', '/home/op/Shows/Gala')).toBe('Media/a.wav');
    expect(toShowRelative('/home/op/shows/gala/Media/a.wav', '/home/op/Shows/Gala')).toBe('/home/op/shows/gala/Media/a.wav');
  });
  it('no confon una carpeta germana amb el mateix prefix', () => {
    expect(toShowRelative('D:\\Shows\\Gala 2\\Media\\a.wav', 'D:\\Shows\\Gala')).toBe('D:\\Shows\\Gala 2\\Media\\a.wav');
  });
  it('relativa → absoluta amb el separador del sistema', () => {
    expect(fromShowRelative('Media/a.wav', 'D:\\Shows\\Gala')).toBe('D:\\Shows\\Gala\\Media\\a.wav');
    expect(fromShowRelative('Media/a.wav', '/home/op/Gala')).toBe('/home/op/Gala/Media/a.wav');
    expect(fromShowRelative('E:\\x\\a.wav', '/home/op/Gala')).toBe('E:\\x\\a.wav');
  });
});

describe('serializeShow', () => {
  it('rutes relatives, només cues ocupats i res de la màquina', () => {
    const d = serializeShow(baseState(), WIN_SHOW);
    expect(d.version).toBe(2);
    expect(d.slots.map((s) => s.id)).toEqual([1, 3]);
    expect(d.slots[0].filePath).toBe('Media/intro.wav');
    expect(d.slots[1].filePath).toBe('E:\\Other\\fx.mp3');
    expect(d.playlist.tracks[0].filePath).toBe('Media/song.mp3');
    expect(JSON.stringify(d)).not.toContain('MixPre');
    expect(d.show.selectedDeviceId).toBeUndefined();
  });
  it('és determinista (serveix per detectar canvis)', () => {
    expect(JSON.stringify(serializeShow(baseState(), WIN_SHOW)))
      .toBe(JSON.stringify(serializeShow(baseState(), WIN_SHOW)));
  });
});

describe('parseShow', () => {
  it('v2: anada i tornada, a una altra carpeta', () => {
    const raw = JSON.stringify(serializeShow(baseState(), WIN_SHOW));
    const p = parseShow(raw, 'F:\\Backup\\Gala\\Gala.ezyshow');
    expect(p.legacy).toBe(false);
    expect(p.slots[0].filePath).toBe('F:\\Backup\\Gala\\Media\\intro.wav');
    expect(p.playlist.tracks[0].filePath).toBe('F:\\Backup\\Gala\\Media\\song.mp3');
  });
  it('v2 creat a Windows i obert a Linux', () => {
    const raw = JSON.stringify(serializeShow(baseState(), WIN_SHOW));
    const p = parseShow(raw, LIN_SHOW);
    expect(p.slots[0].filePath).toBe('/home/op/Shows/Gala/Media/intro.wav');
  });
  it('v1: rutes absolutes i només els globals del show', () => {
    const raw = JSON.stringify({
      app: 'ezyPlayer', kind: 'show', version: 1,
      slots: [{ id: 4, filePath: 'C:\\m\\a.wav', label: 'A' }],
      globals: { globalFadeIn: 2, cuesDeviceId: 'asio:X|0,1' },
      playlist: { tracks: [{ filePath: 'C:\\m\\s.mp3', label: 'S' }] },
    });
    const p = parseShow(raw, 'C:\\old\\export.ezyshow');
    expect(p.legacy).toBe(true);
    expect(p.slots[0].filePath).toBe('C:\\m\\a.wav');
    expect(p.show.globalFadeIn).toBe(2);
    expect(p.show.cuesDeviceId).toBeUndefined();
    expect(p.show.duckAmount).toBe(SHOW_DEFAULTS.duckAmount);
  });
  it('rebutja fitxers que no són shows o de versions futures', () => {
    expect(() => parseShow('nope', WIN_SHOW)).toThrow();
    expect(() => parseShow('{"app":"x"}', WIN_SHOW)).toThrow();
    expect(() => parseShow('{"app":"ezyPlayer","version":99}', WIN_SHOW)).toThrow(/newer/);
  });
});

describe('mediaPathsOf', () => {
  it('cues, playlist i imatge de blackout, sense duplicats', () => {
    const st = baseState({ videoIdleImage: 'E:\\Other\\fx.mp3' });
    expect(mediaPathsOf(st).sort()).toEqual([
      'D:\\Shows\\Gala\\Media\\intro.wav', 'E:\\Other\\fx.mp3', 'd:\\shows\\gala\\Media\\song.mp3',
    ].sort());
  });
});
