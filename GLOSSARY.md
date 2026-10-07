# joule

A personal tool that finds Jobs across Sources and drafts application material for the ones worth pursuing. It never submits anything.

## Language

**Job**:
One posting from a Source: a role on a job board or a freelance job on Upwork.
_Avoid_: Listing, posting, opening, gig

**Source**:
A place Jobs come from: a job board, a job-board aggregator, or Upwork.
_Avoid_: Board, feed, provider

**Duplicate**:
A Job from one Source that is the same role as a Job already seen from another Source; it links to that earlier Job, its **Primary**, and shares its state and score.
_Avoid_: Copy, merge

**Scan**:
One run that fetches new Jobs from one or more Sources, started by hand or on a schedule.
_Avoid_: Search, crawl, sync

**Fit Score**:
A 0–100 judgement of how well a Job suits the owner, with a short reason, made by the AI from the Profile. A Job without one is unscored, never zero.
_Avoid_: Match score, rating, rank

**Filtered**:
A Job that failed one of the owner's Preferences before scoring; kept with the reason, not scored, hidden by default. Distinct from dismissed, which is the owner's own choice.
_Avoid_: Rejected, excluded

**Profile**:
The owner's private material the tool reasons from: CV, work history and preferences. Never stored in version control.
_Avoid_: Resume, account, user data

**Master CV**:
The owner's complete, verified CV inside the Profile; every Tailored CV is selected and rewritten from it, never invented beyond it.
_Avoid_: Base resume, main CV

**Preferences**:
The owner's rules inside the Profile for which Jobs are acceptable: roles, work type, pay floors, locations, deal-breakers and Upwork client floors.
_Avoid_: Settings, filters, criteria

**Draft**:
Application material written for one Job on request: a Tailored CV, a Cover Letter or a Proposal. The owner submits it.
_Avoid_: Application, submission

**Proposal**:
A Draft for an Upwork Job: the cover text plus answers to the Job's screening questions.
_Avoid_: Bid, cover letter (for Upwork)
