#268 Add a test for the failed events retention boundary
Repo Avatar
TricklePay/tricklepay-backend
Summary
Failed events are retained for a documented period, and the boundary is where an off-by-one either deletes too early or never cleans up.

Acceptance criteria
 A test asserts a record older than the retention window is eligible for removal.
 A test asserts a newer record is retained.
 The suite still passes.
Getting started
Fork this repository, clone your fork, and add this repo as upstream:

git clone https://github.com/<your-username>/tricklepay-backend.git
cd tricklepay-backend
git remote add upstream https://github.com/TricklePay/tricklepay-backend.git
Create a branch for this issue:

git checkout -b test/issue-268
Suggested commit message:

test: cover the failed event retention boundary
Run npm run typecheck, npm test, and npm run build before opening a pull request and linking this issue.