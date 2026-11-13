# joule

A personal tool that finds Jobs across Sources and drafts application material for the ones worth pursuing. It submits only an Upwork Proposal the owner confirms in Telegram; auto-submitting is out of scope.

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
A 0–100 judgement of how well the Master CV and work history match a Job's skills, experience and seniority, with a short reason, made by the AI. Pay and location do not count. A Job without one is unscored, never zero.
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
Application material written for one Job on request: a Tailored CV, a Cover Letter or a Proposal. The owner submits it, or confirms an Upwork Proposal submission in Telegram.
_Avoid_: Application, submission

**Proposal**:
A Draft for an Upwork Job: the cover text plus answers to the Job's screening questions.
_Avoid_: Bid, cover letter (for Upwork)

**Fill**:
Writing the owner's saved identity and answers into a form on a destination site from the browser Extension; the owner reviews and submits.

**Extension**:
The unpacked Chrome extension that performs Fills.

**Pipeline**:
The applied Jobs Joule tracks through Stages, including Jobs closed with a Closed reason. Unmarking applied removes a Job from Pipeline, retaining its old Move history privately; re-applying starts a fresh history at Applied.
_Avoid_: Funnel, application tracker

**Stage**:
A Pipeline milestone: Applied, Screen, Interview, Offer or Accepted. Separate from the Job's new / seen / dismissed / applied state.
_Avoid_: Status, step

**Closed reason**:
Why a Pipeline Job was closed: Rejected, No reply or Withdrawn. It retains its last Stage and applied state until the owner unmarks applied.
_Avoid_: Closed Stage, dismissed

**Move**:
One dated Pipeline history entry recording its Stage, Closed reason, next date, how it happened (manual or auto), and an optional note. Manual means an operator action, including confirmed Telegram Send; auto means system action, including migration. History is chronological and retained when the Job leaves Pipeline.
_Avoid_: State change, event log

**Next date**:
An optional timezone-aware appointment or follow-up time on a Pipeline Job, with an optional label such as Technical. Stored in UTC; clearing the date also clears its label.
_Avoid_: Deadline, reminder (no notification is implied)

**Follow-up**:
A short, versioned Draft checking on an unanswered application. Generating one sends nothing; eligibility and No reply auto-close use the current application's date and Move history.
_Avoid_: Reminder (no notification is implied), automatic message

**Inbox connection**:
The owner's validated IMAP account and read-only folder configuration for Pipeline email. Connecting validates access; it does not fetch messages or move Jobs.
_Avoid_: Mail sync (not implemented by connecting)

**Email suggestion**:
A matched email's proposed Pipeline Move or Next date, awaiting the owner's confirmation. Ignore dismisses it; Not this Job excludes that Message-ID/Job pair permanently. Fetching/classifying never makes a Move.
_Avoid_: Automatic move, email action (nothing is sent)
