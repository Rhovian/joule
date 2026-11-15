export type Counts = { new: number; duplicate: number; filtered: number; scored: number; errors: string[] };
export type Scan = { id: number; status: string; started_at: string; finished_at: string | null; sources: string[]; per_source: Record<string, Counts> };
type SourceScan = Omit<Scan, 'sources' | 'per_source'> & { counts: Counts | null };
export type Source = { name: string; new_jobs: number; last: SourceScan | null; last_finished: SourceScan | null };
export type DraftKind = 'cover_letter' | 'proposal' | 'tailored_cv' | 'follow_up';
export type Draft = { id: number; created_at: string; content: { text?: string; cover?: string; answers?: string[] }; note: string | null };
export type Job = {
  drafts?: Partial<Record<DraftKind, Draft>>; draft_versions?: Partial<Record<DraftKind, Draft[]>>; content_purged_at?: string | null;
  posted_at: string | null; first_seen_at: string;
  id: number; title: string; company: string | null; source: string; link: string; state: string;
  score_stale?: boolean; score_points?: { stance: string; text: string }[]; score: number | null; rank?: number | null; score_reason: string | null; filtered_reason: string | null;
  location_raw: string | null; location_unclear: number | null; pay_min: number | null;
  pay_max: number | null; pay_currency: string | null; pay_period: string | null;
  queued: number; duplicates: { id: number; source: string; link: string }[]; description?: string | null;
  extra?: { client?: Record<string, unknown>; screening_questions?: string[]; apply_url?: string } | null;
};
