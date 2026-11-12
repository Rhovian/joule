export type Counts = { new: number; duplicate: number; filtered: number; scored: number; errors: string[] };
export type Scan = { id: number; status: string; started_at: string; finished_at: string | null; sources: string[]; per_source: Record<string, Counts> };
export type Source = { name: string; new_jobs: number; last: (Omit<Scan, 'sources' | 'per_source'> & { counts: Counts | null }) | null };
