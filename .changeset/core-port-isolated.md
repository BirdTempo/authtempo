---
"@authtempo/core": minor
---

The storage port has a new required flag, `isolated`. A claim reads it to choose its first statement: the hold of the user row, or the lease.

Breaking: `StorageAdapter` has the required flag `isolated`. Set it on your own adapter and on each transaction port that it answers: true when the open transaction is isolated and `keep` answers false.
