import { Check } from '@phosphor-icons/react';
import type { Stage } from '../workspace';

/** Find → Seed → Record → Check → Clean. Each stage opens its page. */
export function Stepper({ stages, compact = false, current }: { stages: Stage[]; compact?: boolean; current?: string }) {
  return (
    <ol className={`stepper${compact ? ' stepper-compact' : ''}`} aria-label="Test progress">
      {stages.map((s, i) => (
        <li key={s.id} className={`stage stage-${s.state}`} aria-current={current === s.route ? 'step' : undefined}>
          <button type="button" className="stage-button" onClick={() => { location.hash = s.route; }}
            title={compact ? `${s.label}: ${s.detail}` : undefined}>
            <span className="stage-dot" aria-hidden>
              {s.state === 'done' ? <Check size={compact ? 10 : 13} weight="bold" /> : s.state === 'active' ? <span className="stage-pulse" /> : i + 1}
            </span>
            <span className="stage-text">
              <span className="stage-label">{s.label}</span>
              {!compact && <span className="stage-detail">{s.detail}</span>}
            </span>
            <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'active' ? ' (now)' : ''}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
