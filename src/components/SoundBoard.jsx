import { useSoundStore } from '../store/useSoundStore';
import { SoundButton } from './SoundButton';

const SLOTS_PER_PAGE = 32;

export function SoundBoard() {
  const currentPage = useSoundStore((s) => s.currentPage);
  const numPages    = useSoundStore((s) => s.numPages);
  const setPage     = useSoundStore((s) => s.setPage);

  const base = currentPage * SLOTS_PER_PAGE;

  return (
    <>
      <div className="soundboard grid">
        {Array.from({ length: SLOTS_PER_PAGE }, (_, i) => (
          <SoundButton key={base + i + 1} slotId={base + i + 1} />
        ))}
      </div>

      <div className="page-dots">
        {Array.from({ length: numPages }, (_, p) => (
          <button
            key={p}
            className={`page-dot ${p === currentPage ? 'active' : ''}`}
            onClick={() => setPage(p)}
            title={`Page ${p + 1}`}
          />
        ))}
      </div>
    </>
  );
}
