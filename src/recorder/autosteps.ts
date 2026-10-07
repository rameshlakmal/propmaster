// Auto steps: instead of typing a step before every action, the tester just tests. Changes come in
// bursts (one per click or form submit), so a quiet gap between changes ends a step, and each step is
// named after what its changes did. A step the tester did type names the next burst; later bursts in it
// get names of their own.
//
// Steps are worked out when the recording is read, from the stored changes and the gap saved with the
// session, so the same recording always gives the same steps.
import { describeChanges } from './describe.js';
import type { Change, Marker, Recording, Step } from './types.js';

export const DEFAULT_GAP_MS = 3000;

/** Changes in order, cut wherever more than `gapMs` passes between one change and the next. */
export function bursts(changes: Change[], gapMs: number): Change[][] {
  const sorted = [...changes].sort((a, b) => a.id - b.id);
  const out: Change[][] = [];
  let last = -Infinity;
  for (const c of sorted) {
    const at = c.changedAt.getTime();
    if (out.length === 0 || at - last > gapMs) out.push([]);
    out[out.length - 1]!.push(c);
    last = at;
  }
  return out;
}

/** Each marker goes to the last step that started at or before it (or the first step). */
function placeMarkers(steps: Step[], markers: Marker[]): void {
  for (const m of [...markers].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const target = [...steps].reverse().find((s) => s.startedAt.getTime() <= m.at.getTime()) ?? steps[0]!;
    (target.markers ??= []).push(m);
  }
}

/** The recording with its steps split at quiet gaps and named. Recordings without auto steps pass through. */
export function splitSteps(rec: Recording, gapMs: number): Recording {
  const steps: Step[] = [];
  const markers = rec.steps.flatMap((s) => s.markers ?? []);

  for (const raw of rec.steps) {
    const typed = raw.seq > 0; // step 0 is the placeholder before anything was typed
    const groups = bursts(raw.changes, gapMs);

    if (groups.length === 0) {
      // A typed step with nothing yet keeps its name; an empty placeholder is kept so markers have a home.
      if (typed || steps.length === 0) steps.push({ seq: 0, name: raw.name, startedAt: raw.startedAt, changes: [], auto: !typed });
      continue;
    }
    groups.forEach((changes, i) => {
      const named = typed && i === 0;
      steps.push({
        seq: 0,
        name: named ? raw.name : describeChanges(changes),
        startedAt: named ? raw.startedAt : changes[0]!.changedAt,
        changes,
        auto: !named,
      });
    });
  }

  // An empty placeholder in front of real steps is noise.
  const kept = steps.length > 1 && steps[0]!.changes.length === 0 && steps[0]!.auto ? steps.slice(1) : steps;
  kept.forEach((s, i) => { s.seq = kept[0]!.changes.length === 0 && kept[0]!.auto ? i : i + 1; });
  placeMarkers(kept, markers);
  return { ...rec, steps: kept };
}
