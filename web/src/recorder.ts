// The recording controls, shared by the Record page and the floating window.
import { useState } from 'react';
import { api } from './api';
import { toError } from './hooks';
import type { ApiError, Recording } from './types';

export type Action = 'step' | 'pause' | 'resume' | 'flag' | 'stop';

export interface RecorderCallbacks {
  /** Something changed: refresh the status. */
  onChange: () => void;
  onStopped: (rec: Recording) => void;
}

export function useRecorderActions({ onChange, onStopped }: RecorderCallbacks) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  /** Runs one action; true when it worked. */
  const run = async (action: Action, call: () => Promise<unknown>): Promise<boolean> => {
    setBusy(action);
    setError(null);
    try {
      await call();
      onChange();
      return true;
    } catch (err) {
      setError(toError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return {
    busy,
    error,
    step: (name: string) => run('step', () => api('POST', '/record/step', { name })),
    pause: () => run('pause', () => api('POST', '/record/pause')),
    resume: () => run('resume', () => api('POST', '/record/resume')),
    flag: (note: string) => run('flag', () => api('POST', '/record/flag', { note })),
    stop: () => run('stop', async () => onStopped(await api<Recording>('POST', '/record/stop'))),
  };
}
