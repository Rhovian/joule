import type { Source } from './types';

export function sourceStatus(source: Source) {
  const finished = source.last?.status === 'running' ? source.last_finished : source.last;
  const stamp = finished?.finished_at ?? finished?.started_at;
  const days = stamp ? Math.floor((Date.now() - Date.parse(stamp)) / 86400000) : 0;
  const failed = finished?.status === 'failed' || !!finished?.counts?.errors?.length || !!source.last?.counts?.errors?.length;
  const interrupted = finished?.status === 'interrupted';
  return { finished, stamp, days, failed, interrupted, stale: days >= 14, never: !finished };
}
