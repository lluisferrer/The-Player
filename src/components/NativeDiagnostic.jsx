import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Modal de diagnòstic d'àudio natiu: llista dispositius de sortida amb els
// seus canals REALS (via cpal/WASAPI) i permet treure un to de prova per canal.
export function NativeDiagnostic({ onClose }) {
  const [outputs, setOutputs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setOutputs(await invoke('list_audio_outputs'));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const tone = async (name, ch) => {
    try {
      await invoke('play_test_tone', { deviceName: name, channel: ch, seconds: 1.0 });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-panel library-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">Diagnòstic d'àudio natiu (cpal / WASAPI)</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="diag-error">⚠ {error}</div>}
        {!outputs && !error && <div className="library-empty">Carregant dispositius…</div>}
        {outputs && outputs.length === 0 && <div className="library-empty">Cap dispositiu de sortida.</div>}

        <div className="library-list">
          {outputs && outputs.map((o, i) => (
            <div className="diag-item" key={i}>
              <div className="diag-head">
                <span className="diag-name">
                  {o.name}{o.is_default ? '  (per defecte)' : ''}
                </span>
                <span className={`diag-ch ${o.max_channels > 2 ? 'multi' : ''}`}>
                  {o.max_channels} canals · {o.default_sample_rate} Hz
                </span>
              </div>
              {o.max_channels > 0 && (
                <div className="diag-tones">
                  <span className="diag-tones-label">To de prova:</span>
                  {Array.from({ length: o.max_channels }, (_, c) => (
                    <button
                      key={c}
                      className="diag-tone-btn"
                      onClick={() => tone(o.name, c)}
                      title={`To de 440 Hz al canal ${c + 1}`}
                    >
                      {c + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="diag-note">
          Si un dispositiu mostra <b>més de 2 canals</b> i el to surt pel canal correcte,
          el routing multicanal i la cue són viables amb un motor d'àudio natiu.
        </div>
      </div>
    </div>
  );
}
