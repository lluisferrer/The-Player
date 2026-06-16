import { SoundButton } from './SoundButton';

export function SoundBoard() {
  return (
    <div className="soundboard">
      {Array.from({ length: 32 }, (_, i) => (
        <SoundButton key={i + 1} slotId={i + 1} />
      ))}
    </div>
  );
}
