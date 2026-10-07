import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { TUTORIAL_STEPS } from '../tutorial';

interface Props {
  /** Called when the tour is finished or skipped. */
  onClose: () => void;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Gap between the highlighted element and the tour card, and between the card and the window edge. */
const GAP = 12;
/** Extra space drawn around the highlighted element. */
const PAD = 6;
const CARD_MAX_WIDTH = 380;
/** Used before the card has been measured once. */
const CARD_FALLBACK_HEIGHT = 220;

/** The element a step points at, if it is rendered and has a size (hidden panels have none). */
function findTarget(target: string | undefined): HTMLElement | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Card position next to the highlight: below it if there is room, else above, else pinned to the bottom. */
function cardPosition(spot: Box, cardHeight: number): { top: number; left: number; width: number } {
  const width = Math.min(CARD_MAX_WIDTH, window.innerWidth - GAP * 2);
  const left = Math.min(Math.max(spot.left, GAP), window.innerWidth - width - GAP);
  const below = spot.top + spot.height + GAP;
  const above = spot.top - GAP - cardHeight;
  let top: number;
  if (below + cardHeight <= window.innerHeight - GAP) top = below;
  else if (above >= GAP) top = above;
  else top = Math.max(GAP, window.innerHeight - cardHeight - GAP);
  return { top, left, width };
}

/**
 * First-launch tour. Dims the page, highlights one element per step and explains it.
 * Blocks clicks on the page while open so nothing is traded or changed by accident.
 */
export function Tutorial({ onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(CARD_FALLBACK_HEIGHT);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = TUTORIAL_STEPS[index];
  const last = index === TUTORIAL_STEPS.length - 1;

  const measure = useCallback(() => {
    const el = findTarget(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      setSpot({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    } else {
      setSpot(null);
    }
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [step.target]);

  // Bring the step's element into view, then measure once layout has settled.
  useEffect(() => {
    findTarget(step.target)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [step.target, measure]);

  // Follow the element when the window is resized or anything scrolls.
  useEffect(() => {
    let frame = 0;
    const onChange = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [measure]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  const next = () => (last ? onClose() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') back();
    else if (e.key === 'Tab') {
      // Keep keyboard focus on the tour buttons; the page underneath is not usable while the tour is open.
      const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextAt = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      e.preventDefault();
      buttons[nextAt].focus();
    }
  };

  const missing = Boolean(step.target) && spot === null;
  const pos = spot ? cardPosition(spot, cardHeight) : null;

  return (
    <div className="tour-layer" onKeyDown={onKeyDown}>
      {spot ? (
        <div
          className="tour-spot"
          aria-hidden
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      ) : (
        <div className="tour-dim" aria-hidden />
      )}
      <div
        ref={cardRef}
        className={`tour-card ${pos ? '' : 'tour-card-center'}`}
        style={pos ? { top: pos.top, left: pos.left, width: pos.width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <div className="tour-count">
          Step {index + 1} of {TUTORIAL_STEPS.length}
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-body">{step.body}</p>
        {missing && (
          <p className="tour-hidden-note">{step.whenHidden ?? 'This part is not on screen right now.'}</p>
        )}
        <div className="tour-actions">
          {!last && (
            <button type="button" className="btn-ghost tour-skip" onClick={onClose}>
              Skip tour
            </button>
          )}
          <div className="spacer" />
          {index > 0 && (
            <button type="button" className="btn-ghost" onClick={back}>
              Back
            </button>
          )}
          <button type="button" className="btn-primary" onClick={next}>
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
