#265 Add a test that a request id survives through to an error body
Repo Avatar
TricklePay/tricklepay-backend
Summary
The request id is the link between what a client saw and what the logs hold, so it must appear in the error body as well as the header.

Acceptance criteria
 A test asserts an error body carries the request id.
 A test asserts the header carries the same value.
 The suite still passes.
Getting started
Fork this repository, clone your fork, and add this repo as upstream:

git clone https://github.com/<your-username>/tricklepay-backend.git
cd tricklepay-backend
git remote add upstream https://github.com/TricklePay/tricklepay-backend.git
Create a branch for this issue:

git checkout -b test/issue-265
Suggested commit message:

test: assert request ids reach error bodies
Run npm run typecheck, npm test, and npm run build before opening a pull request and linking this issue.