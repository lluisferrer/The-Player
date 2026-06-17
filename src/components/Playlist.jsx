import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSoundStore } from '../store/useSoundStore';
import { plPosition } from '../lib/playlistEngine';
import { fmtTime } from '../hooks/usePlaybackTime';

function basename(p) { return p.split(/[\\/]/).pop() || p; }

export function Playlist() {
  const playlist      = useSoundStore((s) => s.playlist);
  const playlistIndex = useSoundStore((s) => s.playlistIndex);
  const playing       = useSoundStore((s) => s.playlistPlaying);
  const paused        = useSoundStore((s) => s.playlistPaused);
  const volume        = useSoundStore((s) => s.playlistVolume);

  const {
    addPlaylistTracks, removePlaylistTrack, movePlaylistTrack, clearPlaylist,
    setPlaylistVolume,
    playlistPlayPause, playlistStop, playlistNext, playlistPrev, playlistPlayIndex,
  } = useSoundStore.getState();

  const [pos, setPos] = useState({ elapsed: 0, duration: 0, index: -1 });
  useEffect(() => {
    let raf;
    const tick = () => {
      setPos(plPosition());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleAdd = async () => {
    try {
      const sel = await open({
        multiple: true,
        filters: [{ name: 'Àudio', extensions: ['mp3', 'wav', 'ogg', 'flac'] }],
      });
      if (!sel) return;
      const paths = Array.isArray(sel) ? sel : [sel];
      addPlaylistTracks(paths.map((p) => ({ filePath: p, label: basename(p) })));
    } catch (e) {
      console.warn('No s\'han pogut afegir pistes:', e);
    }
  };

  const current = playlist[playlistIndex];
  const progress = pos.duration ? pos.elapsed / pos.duration : 0;
  const playLabel = playing ? '❚❚' : '▶';

  return (
    <div className="playlist">
      <div className="pl-toolbar">
        <div className="pl-transport">
          <button onClick={playlistPrev} title="Anterior">⏮</button>
          <button className="pl-play" onClick={playlistPlayPause} title="Play / Pausa">{playLabel}</button>
          <button onClick={playlistStop} title="Stop">■</button>
          <button onClick={playlistNext} title="Següent">⏭</button>
        </div>

        <label className="pl-vol" title="Volum de la playlist">
          Vol
          <input
            type="range" min="0" max="1" step="0.01"
            value={volume}
            onChange={(e) => setPlaylistVolume(parseFloat(e.target.value))}
          />
        </label>

        <span className="pl-spacer" />
        <button className="pl-btn" onClick={handleAdd}>+ Afegeix pistes</button>
        <button className="pl-btn" onClick={clearPlaylist} disabled={playlist.length === 0}>Buida</button>
      </div>

      {/* Now playing */}
      <div className="pl-now">
        <div className="pl-now-info">
          <span className="pl-now-name">{current ? current.label : '—'}</span>
          <span className="pl-now-time">
            {fmtTime(pos.elapsed)} {pos.duration ? `/ ${fmtTime(pos.duration)}` : ''}
          </span>
        </div>
        <div className="pl-now-bar">
          <div className="pl-now-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      {/* Llista */}
      <div className="pl-list">
        {playlist.length === 0 ? (
          <div className="pl-empty">
            Llista buida. Afegeix pistes amb «+ Afegeix pistes».
          </div>
        ) : (
          playlist.map((t, i) => (
            <div
              className={`pl-item ${i === playlistIndex ? 'current' : ''}`}
              key={t.id}
              onDoubleClick={() => playlistPlayIndex(i)}
            >
              <span className="pl-num">{i === playlistIndex && (playing || paused) ? '▶' : i + 1}</span>
              <span className="pl-name" title={t.filePath}>{t.label}</span>
              <div className="pl-item-actions">
                <button onClick={() => movePlaylistTrack(i, i - 1)} disabled={i === 0} title="Amunt">↑</button>
                <button onClick={() => movePlaylistTrack(i, i + 1)} disabled={i === playlist.length - 1} title="Avall">↓</button>
                <button onClick={() => playlistPlayIndex(i)} title="Reprodueix">▶</button>
                <button onClick={() => removePlaylistTrack(t.id)} title="Treu">✕</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
