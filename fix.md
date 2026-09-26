#267 Add a test that a cancelled stream reports consistent derived figures
Repo Avatar
TricklePay/tricklepay-backend
Summary
After cancellation the stored total is frozen, and the derived figures must stay internally consistent rather than implying more will vest.

Acceptance criteria
 A test asserts locked is zero for a cancelled stream.
 A test asserts vested and the total agree.
 The suite still passes.
Getting started
Fork this repository, clone your fork, and add this repo as upstream:

git clone https://github.com/<your-username>/tricklepay-backend.git
cd tricklepay-backend
git remote add upstream https://github.com/TricklePay/tricklepay-backend.git
Create a branch for this issue:

git checkout -b test/issue-267
Suggested commit message:

test: assert cancelled derived figures are consistent
Run npm run typecheck, npm test, and npm run build before opening a pull request and linking this issue.