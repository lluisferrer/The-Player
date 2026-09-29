// Interfície del show com a document: panell FILES (New / Open / Save / Save As /
// recents), diàleg de nom i ubicació, avís de canvis sense desar, pantalla
// d'inici quan no hi ha cap show obert, i el títol del show a la capçalera.
//
// Tota la lògica de disc és a useShowFile; aquí només hi ha el flux de diàlegs.

import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSoundStore } from '../store/useSoundStore';
import { useShowFile, defaultShowsDir } from '../hooks/useShowFile';
import { showNameOf, dirOf } from '../lib/showFile';
import logo from '../assets/ezyPlayerMinimalLogo.svg';

// ── Títol del show a la capçalera (i a la barra de la finestra) ─────────────

export function ShowTitle() {
  const path = useSoundStore((s) => s.currentShowPath);
  const dirty = useSoundStore((s) => s.showDirty);
  const busy = useSoundStore((s) => s.showBusy);
  const jobs = useSoundStore((s) => s.mediaJobs);
  const name = path ? showNameOf(path) : null;

  useEffect(() => {
    const title = name ? `${name}${dirty ? ' •' : ''} — ezyPlayer` : 'ezyPlayer';
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [name, dirty]);

  // Progrés de les còpies a Media/: nombre de fitxers pendents i % del que es copia ara.
  const list = Object.values(jobs);
  const active = list.find((j) => j.total > 0);
  const pct = active ? Math.floor((active.copied / active.total) * 100) : 0;

  return (
    <div className="show-title" title={path || ''}>
      <span className="show-title-name">{name || 'No show open'}</span>
      {dirty && <span className="show-title-dirty" title="Unsaved changes">●</span>}
      {busy === 'opening' && <span className="show-title-status">Opening…</span>}
      {busy === 'saving' && <span className="show-title-status">Saving…</span>}
      {list.length > 0 && (
        <span className="show-title-status" title={list.map((j) => j.name).join('\n')}>
          Copying {list.length} file{list.length > 1 ? 's' : ''}{active ? ` · ${pct}%` : ''}
        </span>
      )}
    </div>
  );
}

// ── Diàleg de nom + ubicació (New show / Save As) ────────────────────────────

function ShowNameDialog({ title, confirmLabel, note, onConfirm, onCancel }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { defaultShowsDir().then(setParent); }, []);

  const pickFolder = async () => {
    try {
      const dir = await open({ directory: true, multiple: false, defaultPath: parent || undefined });
      if (dir) setParent(dir);
    } catch { /* cancel·lat */ }
  };

  const confirm = async () => {
    if (!name.trim() || !parent || busy) return;
    setBusy(true);
    const ok = await onConfirm({ parent, name: name.trim() });
    setBusy(false);
    if (ok) onCancel();
  };

  return (
    <div className="editor-overlay" onClick={busy ? undefined : onCancel}>
      <div className="editor-panel library-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">{title}</span>
          <button className="editor-close" onClick={onCancel} disabled={busy}>✕</button>
        </div>
        {note && <p className="library-showfile-desc">{note}</p>}
        <div className="library-save">
          <input
            type="text"
            autoFocus
            placeholder="Show name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
            disabled={busy}
          />
        </div>
        <div className="show-location">
          <span className="show-location-path" title={parent}>
            {parent ? `${parent}${parent.includes('\\') ? '\\' : '/'}${name.trim() || '…'}` : '…'}
          </span>
          <button className="editor-btn" onClick={pickFolder} disabled={busy}>Change folder…</button>
        </div>
        <p className="library-showfile-desc">
          A folder with this name is created there. Every file you add to the show is copied into
          its <code>Media</code> folder, so you can move or copy the whole folder to another computer.
        </p>
        <div className="show-dialog-actions">
          <button className="editor-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="editor-btn primary" onClick={confirm} disabled={busy || !name.trim() || !parent}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Canvis sense desar ───────────────────────────────────────────────────────

function UnsavedDialog({ onSave, onDiscard, onCancel }) {
  const path = useSoundStore((s) => s.currentShowPath);
  const [busy, setBusy] = useState(false);
  return (
    <div className="editor-overlay" onClick={busy ? undefined : onCancel}>
      <div className="editor-panel" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">Save changes to «{path ? showNameOf(path) : ''}»?</span>
        </div>
        <p className="library-showfile-desc">Your changes will be lost if you don't save them.</p>
        <div className="show-dialog-actions">
          <button className="editor-btn" onClick={onDiscard} disabled={busy}>Don't save</button>
          <span style={{ flex: 1 }} />
          <button className="editor-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="editor-btn primary"
            disabled={busy}
            onClick={async () => { setBusy(true); await onSave(); setBusy(false); }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Llista de shows recents ──────────────────────────────────────────────────

function RecentList({ onOpen }) {
  const recents = useSoundStore((s) => s.recentShows);
  const current = useSoundStore((s) => s.currentShowPath);
  const list = recents.filter((r) => r.path !== current);
  if (list.length === 0) return <div className="library-empty">No recent shows.</div>;
  return (
    <div className="library-list">
      {list.map((r) => (
        <div className="library-item" key={r.path}>
          <div className="library-item-info">
            <span className="library-item-name">{r.name}</span>
            <span className="library-item-meta" title={r.path}>{dirOf(r.path)}</span>
          </div>
          <button className="editor-btn primary" onClick={() => onOpen(r.path)}>Open</button>
        </div>
      ))}
    </div>
  );
}

// ── Contenidor: panell FILES, pantalla d'inici i diàlegs ────────────────────
//
// Props: filesOpen / onCloseFiles (botó FILES de la capçalera), closeAsk (l'usuari
// vol tancar l'app amb canvis), onCloseCancel, onCloseConfirm (tanca de debò).

export function ShowUI({ filesOpen, onCloseFiles, closeAsk, onCloseCancel, onCloseConfirm }) {
  const { newShow, openShow, saveShow, saveShowAs } = useShowFile();
  const current = useSoundStore((s) => s.currentShowPath);
  const busy = useSoundStore((s) => s.showBusy);
  const hasContent = useSoundStore((s) => s.slots.some((x) => x.filePath || x.label) || s.playlist.length > 0);

  // null | { kind: 'name', mode: 'new'|'saveAs', note? } | { kind: 'unsaved', then }
  const [dialog, setDialog] = useState(null);

  // Si hi ha canvis sense desar, pregunta abans de fer `then`.
  const guard = (then) => {
    const st = useSoundStore.getState();
    if (st.currentShowPath && st.showDirty) setDialog({ kind: 'unsaved', then });
    else then();
  };

  const doOpen = async (path) => {
    setDialog(null);
    onCloseFiles();
    const r = await openShow(path);
    if (r === 'legacy') {
      setDialog({
        kind: 'name', mode: 'saveAs',
        note: 'This show was made with an older version of ezyPlayer. Save it as a show folder: its files will be copied into the new folder.',
      });
    }
  };

  const actions = {
    newShow: () => guard(() => { onCloseFiles(); setDialog({ kind: 'name', mode: 'new' }); }),
    open: () => guard(() => doOpen()),
    openRecent: (path) => guard(() => doOpen(path)),
    save: async () => {
      if (useSoundStore.getState().currentShowPath) { await saveShow(); onCloseFiles(); }
      else { onCloseFiles(); setDialog({ kind: 'name', mode: 'saveAs' }); }
    },
    saveAs: () => { onCloseFiles(); setDialog({ kind: 'name', mode: 'saveAs' }); },
  };

  // Tancar l'app amb canvis: mateix diàleg, i en acabar tanca de debò.
  useEffect(() => {
    if (closeAsk) setDialog({ kind: 'unsaved', then: onCloseConfirm, onCancel: onCloseCancel });
  }, [closeAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelUnsaved = () => {
    if (dialog && dialog.onCancel) dialog.onCancel();
    setDialog(null);
  };

  return (
    <>
      {filesOpen && (
        <div className="editor-overlay" onClick={onCloseFiles}>
          <div className="editor-panel library-panel" onClick={(e) => e.stopPropagation()}>
            <div className="editor-header">
              <span className="editor-title">Show</span>
              <button className="editor-close" onClick={onCloseFiles}>✕</button>
            </div>
            {current && (
              <div className="library-item">
                <div className="library-item-info">
                  <span className="library-item-name">{showNameOf(current)}</span>
                  <span className="library-item-meta" title={current}>{dirOf(current)}</span>
                </div>
              </div>
            )}
            <div className="show-actions">
              <button className="editor-btn" onClick={actions.newShow}>New show…</button>
              <button className="editor-btn" onClick={actions.open}>Open show…</button>
              <button className="editor-btn primary" onClick={actions.save}>Save</button>
              <button className="editor-btn" onClick={actions.saveAs}>Save as…</button>
            </div>
            <div className="library-section-title">Recent shows</div>
            <RecentList onOpen={actions.openRecent} />
          </div>
        </div>
      )}

      {/* Pantalla d'inici: cap show obert (primera vegada, o l'últim ja no existeix). */}
      {!current && !busy && !dialog && (
        <div className="editor-overlay start-screen">
          <div className="editor-panel library-panel">
            <div className="start-brand">
              <img src={logo} alt="" className="brand-logo" />
              <span className="brand-name"><span className="brand-ezy">ezy</span><span className="brand-app">Player</span></span>
            </div>
            <div className="show-actions">
              <button className="editor-btn primary" onClick={() => setDialog({ kind: 'name', mode: 'new' })}>New show…</button>
              <button className="editor-btn" onClick={() => doOpen()}>Open show…</button>
            </div>
            {hasContent && (
              <>
                <p className="library-showfile-desc">
                  Your current cues and playlist are not saved as a show yet. Save them as a show
                  folder to keep them: their files will be copied into it.
                </p>
                <div className="show-actions">
                  <button className="editor-btn primary" onClick={() => setDialog({ kind: 'name', mode: 'saveAs' })}>
                    Save current cues as a show…
                  </button>
                </div>
              </>
            )}
            <div className="library-section-title">Recent shows</div>
            <RecentList onOpen={(p) => doOpen(p)} />
          </div>
        </div>
      )}

      {dialog?.kind === 'name' && (
        <ShowNameDialog
          title={dialog.mode === 'new' ? 'New show' : 'Save show as'}
          confirmLabel={dialog.mode === 'new' ? 'Create' : 'Save'}
          note={dialog.note}
          onConfirm={dialog.mode === 'new' ? newShow : saveShowAs}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'unsaved' && (
        <UnsavedDialog
          onSave={async () => { if (await saveShow()) { const t = dialog.then; setDialog(null); await t(); } }}
          onDiscard={async () => { const t = dialog.then; setDialog(null); await t(); }}
          onCancel={cancelUnsaved}
        />
      )}
    </>
  );
}
