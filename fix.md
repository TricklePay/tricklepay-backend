#266 Add a test that the summary endpoint handles an empty database
Repo Avatar
TricklePay/tricklepay-backend
Summary
Aggregates over no rows are where a sum becomes null and a response becomes malformed. The empty case is not covered.

Acceptance criteria
 A test asserts the summary endpoint returns zeroed figures with no streams.
 The response still validates against its schema.
 The suite still passes.
Getting started
Fork this repository, clone your fork, and add this repo as upstream:

git clone https://github.com/<your-username>/tricklepay-backend.git
cd tricklepay-backend
git remote add upstream https://github.com/TricklePay/tricklepay-backend.git
Create a branch for this issue:

git checkout -b test/issue-266
Suggested commit message:

test: cover the summary endpoint with no data
Run npm run typecheck, npm test, and npm run build before opening a pull request and linking this issue.