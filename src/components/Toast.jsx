import { useEffect } from 'react';
import { useSoundStore } from '../store/useSoundStore';

// Durada (ms) abans que un toast es tanqui sol
const AUTO_DISMISS_MS = 6000;

// ToastItem: gestiona el seu propi timer d'auto-descart per evitar fuites.
// Quan el component es desmunta (per dismissNotification d'un altre origen) el
// cleanup de useEffect cancel·la el setTimeout pendent.
function ToastItem({ notif }) {
  const dismissNotification = useSoundStore((s) => s.dismissNotification);

  useEffect(() => {
    const timer = setTimeout(() => {
      dismissNotification(notif.id);
    }, AUTO_DISMISS_MS);
    // Neteja: cancel·la si el component es desmunta abans que expiri el timer
    return () => clearTimeout(timer);
  }, [notif.id, dismissNotification]);

  // Color de vora/accent segons el tipus de notificació
  const accentVar =
    notif.type === 'error'   ? 'var(--vu-red)'    :
    notif.type === 'warning' ? 'var(--vu-yellow)'  :
    'var(--accent)';

  // Etiqueta en anglès (UI en anglès), el missatge ve del backend i pot ser en català
  const typeLabel =
    notif.type === 'error'   ? 'Error'   :
    notif.type === 'warning' ? 'Warning' :
    'Info';

  return (
    <div
      className="toast-item"
      style={{ '--toast-accent': accentVar }}
    >
      <div className="toast-header">
        <span className="toast-type">{typeLabel}</span>
        <button
          className="toast-close"
          onClick={() => dismissNotification(notif.id)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      <p className="toast-message">{notif.message}</p>
    </div>
  );
}

// Toast: contenidor fix (cantonada inferior dreta) que llegeix la llista del store
// i renderitza un ToastItem per cada notificació activa.
export function Toast() {
  const notifications = useSoundStore((s) => s.notifications);

  // No renderitzem res si no hi ha notificacions (evita el div buit al DOM)
  if (notifications.length === 0) return null;

  return (
    <div
      className="toast-container"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {notifications.map((n) => (
        <ToastItem key={n.id} notif={n} />
      ))}
    </div>
  );
}
