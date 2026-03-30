import type { FloorPlan } from './types/floorPlan';
import { randomBytes } from 'crypto';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;

const store = new Map<string, { plan: FloorPlan; expires: number }>();

function gc(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires < now) store.delete(k);
  }
  while (store.size > MAX_SESSIONS) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
    else break;
  }
}

export function savePlanSession(plan: FloorPlan): string {
  gc();
  const id = randomBytes(12).toString('hex');
  store.set(id, { plan, expires: Date.now() + TTL_MS });
  return id;
}

export function getPlanSession(id: string): FloorPlan | null {
  gc();
  const row = store.get(id);
  if (!row || row.expires < Date.now()) {
    if (row) store.delete(id);
    return null;
  }
  return row.plan;
}
