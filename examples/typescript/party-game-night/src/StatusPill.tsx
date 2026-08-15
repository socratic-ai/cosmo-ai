import type { TransportState } from 'cosmo-ai';

function label(transport: TransportState): string {
  if (transport === 'ready' || transport === 'connected') return 'On air';
  if (transport === 'reconnecting') return 'Reconnecting…';
  if (transport === 'disconnecting') return 'Ending…';
  if (transport === 'disconnected') return 'Off air';
  if (transport === 'failed') return 'Connection failed';
  return 'Connecting…';
}

export function StatusPill({
  transport,
  warning,
}: {
  transport: TransportState;
  warning: string | null;
}) {
  const live = transport === 'ready' || transport === 'connected';
  const bad = transport === 'failed';
  return (
    <div className="status">
      <span className={`pill${live ? ' live' : ''}${bad ? ' bad' : ''}`}>
        <span className="dot" />
        {label(transport)}
      </span>
      {warning !== null && <span className="pill warn">{warning}</span>}
    </div>
  );
}
