import type { TransportState } from 'cosmo-ai';

function label(transport: TransportState): string {
  if (transport === 'ready' || transport === 'connected') return 'Live';
  if (transport === 'reconnecting') return 'Reconnecting…';
  if (transport === 'disconnecting') return 'Ending…';
  if (transport === 'disconnected') return 'Ended';
  if (transport === 'failed') return 'Connection failed';
  return 'Connecting…';
}

/** Connection state, plus anything the app needs to admit — a rejected tool,
 *  a camera that never started, a mic toggle that did not take. Failures land
 *  here rather than in the console, because the kitchen cannot see the console. */
export function StatusPill({
  transport,
  note,
}: {
  transport: TransportState;
  note: string | null;
}) {
  const live = transport === 'ready' || transport === 'connected';
  const bad = transport === 'failed';
  return (
    <div className="status">
      <span className={`pill${live ? ' live' : ''}${bad ? ' bad' : ''}`}>
        <span className="dot" />
        {label(transport)}
      </span>
      {note !== null && <span className="pill warn">{note}</span>}
    </div>
  );
}
