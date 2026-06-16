import { useSoundStore } from '../store/useSoundStore';
import { SoundButton } from './SoundButton';

export function SoundBoard() {
  const viewMode = useSoundStore((s) => s.viewMode);

  return (
    <div className={`soundboard ${viewMode === 'list' ? 'list' : 'grid'}`}>
      {Array.from({ length: 32 }, (_, i) => (
        <SoundButton key={i + 1} slotId={i + 1} />
      ))}
    </div>
  );
}
