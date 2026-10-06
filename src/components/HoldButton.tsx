import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  disabled: boolean;
  /** How long the button must be held, in milliseconds. */
  holdMs?: number;
  onComplete: () => void;
}

/**
 * Press and hold to confirm. Releasing early cancels. Works with a pointer or with Space/Enter held down.
 * Prevents accidental single clicks; the wallet still asks for approval afterwards.
 * The parent must change `key` whenever what is being confirmed changes, so a hold in progress is dropped.
 */
export function HoldButton({ label, disabled, holdMs = 1300, onComplete }: Props) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  const start = () => {
    if (disabled || timer.current !== undefined) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onComplete();
    }, holdMs);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`trade-btn hold-btn ${holding ? 'is-holding' : ''}`}
      style={{ ['--hold-ms' as string]: `${holdMs}ms` }}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') cancel();
      }}
      onBlur={cancel}
    >
      <span className="hold-fill" aria-hidden />
      <span className="hold-label">{holding ? 'Keep holding…' : label}</span>
    </button>
  );
}
