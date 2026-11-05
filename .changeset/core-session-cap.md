---
"@authtempo/core": minor
---

Breaking: a user now holds at most `session.maxPerUser` live sessions, 1 to 1000, default 100. Before its insert, a session create ends the oldest sessions of the user past the cap. `session.afterEnd` and the event `session.end` get the new reason `capped`, after the commit and before `afterCreate`. An impersonation session neither counts nor ends a session. An app whose users keep more than 100 sessions sets a higher cap.

Each session create sends one more query, the read of the newest sessions of the user, and one more at the cap, the delete. On D1 every pin of a session create moved by one. The tightest is the ID-token claim after a unique-key retry, at 48 of the 50 queries of D1 Free. Two creates at once on D1 can leave one session past the cap, and the next create ends it. On Postgres and MySQL the creates of a verified user wait on each other.

A claim with a `session.afterEnd` hook on D1, SQLite, or the memory store now ends at most two chunks of 50 sessions. It writes the pending-end row of a ban for the rest, with the new reason `claimed`, and the sweep ends them with the hook. That row ends only the sessions whose `proved` flag is false, so the owner's sessions stay. Before, each 50 sessions of the claimant added one query, and a reset link over 1000 sessions answered 500 at query 51 on D1. Postgres and MySQL end every session in the claim, as before. A revoke of the platform role does not count a claim's row as a row of its own.
