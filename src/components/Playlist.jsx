import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { SkipBack, SkipForward, Play, Pause, Square, Repeat, Repeat1, Shuffle } from 'lucide-react';
import { useSoundStore } from '../store/useSoundStore';
import { plPosition } from '../lib/playlistEngine';
import { plaPosition, plaActive } from '../lib/playlistAsio';
import { fmtTime } from '../hooks/usePlaybackTime';

function basename(p) { return p.split(/[\\/]/).pop() || p; }

export function Playlist() {
  const playlist      = useSoundStore((s) => s.playlist);
  const playlistIndex = useSoundStore((s) => s.playlistIndex);
  const selected      = useSoundStore((s) => s.playlistSelected);
  const playing       = useSoundStore((s) => s.playlistPlaying);
  const paused        = useSoundStore((s) => s.playlistPaused);
  const volume        = useSoundStore((s) => s.playlistVolume);
  const repeatMode    = useSoundStore((s) => s.playlistRepeatMode);
  const shuffle       = useSoundStore((s) => s.playlistShuffle);

  const {
    addPlaylistTracks, removePlaylistTrack, movePlaylistTrack, clearPlaylist,
    setPlaylistVolume, setPlaylistSelected,
    cyclePlaylistRepeat, togglePlaylistShuffle,
    playlistPlayPause, playlistStop, playlistNext, playlistPrev, playlistPlayIndex,
    playlistSeek,
  } = useSoundStore.getState();

  // Barra de reproducció arrossegable (seek)
  const barRef = useRef(null);
  const seekToClientX = (clientX) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    playlistSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
  };
  const [seekDragging, setSeekDragging] = useState(false);
  const onBarPointerDown = (e) => {
    e.preventDefault();
    seekToClientX(e.clientX);
    setSeekDragging(true);
  };
  // Listeners de drag amb cleanup lligat al cicle de vida (sense fuites si es
  // desmunta el component a mig arrossegament)
  useEffect(() => {
    if (!seekDragging) return;
    const onMove = (ev) => seekToClientX(ev.clientX);
    const onUp = () => setSeekDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [seekDragging]);

  const [pos, setPos] = useState({ elapsed: 0, duration: 0, index: -1 });
  useEffect(() => {
    let raf;
    const tick = () => {
      // Si la playlist sona pel motor natiu (ASIO), la posició ve d'allà.
      setPos(plaActive() ? plaPosition() : plPosition());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleAdd = async () => {
    try {
      const sel = await open({
        multiple: true,
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac'] }],
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

  // Botó de repetició de tres estats: off → song → list
  const RepeatIcon = repeatMode === 'song' ? Repeat1 : Repeat;
  const repeatTitle =
    repeatMode === 'song' ? 'Repeat track'
    : repeatMode === 'list' ? 'Repeat list'
    : 'Repeat off';

  return (
    <div className="playlist">
      <div className="pl-toolbar">
        <div className="pl-transport">
          <button onClick={playlistPrev} title="Previous"><SkipBack size={16} fill="currentColor" /></button>
          <button className="pl-play" onClick={playlistPlayPause} title="Play / Pause">
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button onClick={playlistStop} title="Stop"><Square size={16} fill="currentColor" /></button>
          <button onClick={playlistNext} title="Next"><SkipForward size={16} fill="currentColor" /></button>
          <button
            className={`pl-toggle ${repeatMode !== 'off' ? 'active' : ''}`}
            onClick={cyclePlaylistRepeat}
            title={repeatTitle}
          ><RepeatIcon size={16} /></button>
          <button
            className={`pl-toggle ${shuffle ? 'active' : ''}`}
            onClick={togglePlaylistShuffle}
            title="Shuffle"
          ><Shuffle size={16} /></button>
        </div>

        <label className="pl-vol" title="Playlist volume">
          Vol
          <input
            type="range" min="0" max="1" step="0.01"
            value={volume}
            onChange={(e) => setPlaylistVolume(parseFloat(e.target.value))}
          />
        </label>

        <span className="pl-spacer" />
        <button className="pl-btn" onClick={handleAdd}>+ Add tracks</button>
        <button className="pl-btn" onClick={clearPlaylist} disabled={playlist.length === 0}>Clear</button>
      </div>

      {/* Now playing */}
      <div className="pl-now">
        <div className="pl-now-info">
          <span className="pl-now-name">{current ? current.label : '—'}</span>
          <span className="pl-now-time">
            {fmtTime(pos.elapsed)} {pos.duration ? `/ ${fmtTime(pos.duration)}` : ''}
          </span>
        </div>
        <div className="pl-now-bar" ref={barRef} onPointerDown={onBarPointerDown} style={{ cursor: 'pointer' }}>
          <div className="pl-now-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      {/* Llista */}
      <div className="pl-list">
        {playlist.length === 0 ? (
          <div className="pl-empty">
            Empty list. Add tracks with “+ Add tracks”.
          </div>
        ) : (
          playlist.map((t, i) => (
            <div
              className={`pl-item ${i === playlistIndex ? 'current' : ''} ${i === selected ? 'selected' : ''}`}
              key={t.id}
              onClick={() => setPlaylistSelected(i)}
              onDoubleClick={() => playlistPlayIndex(i)}
            >
              <span className="pl-num">{i === playlistIndex && (playing || paused) ? '▶' : i + 1}</span>
              <span className="pl-name" title={t.filePath}>{t.label}</span>
              <div className="pl-item-actions">
                <button onClick={() => movePlaylistTrack(i, i - 1)} disabled={i === 0} title="Move up">↑</button>
                <button onClick={() => movePlaylistTrack(i, i + 1)} disabled={i === playlist.length - 1} title="Move down">↓</button>
                <button onClick={() => playlistPlayIndex(i)} title="Play">▶</button>
                <button onClick={() => removePlaylistTrack(t.id)} title="Remove">✕</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
