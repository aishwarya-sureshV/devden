---
description: UI bug pipeline — reproduce (browser) → plan → fix → verify → review
argument-hint: "[plan=<model>] [fix=<model>] [review=<model>] <bug description>"
---
Fix this UI bug end to end using the pipeline below: $ARGUMENTS

If no bug description follows the colon above, stop and ask which UI bug to
fix — do not start the pipeline.

First parse optional role args from the description: `plan=<model>`, `fix=<model>`,
`review=<model>` (any subset — model names resolve fuzzily, e.g. grok, claude-sonnet-5,
glm-5.3-flash). Roles without a model run on this session's default model. These are
one-run choices — never persist them to settings.

Run this sequence as one async subagent workflowScript:

1. REPRODUCE — playwright agent: verify the dev server is healthy
   (`curl -sf http://127.0.0.1:4319/api/health`, UI on <http://localhost:5319>),
   then reproduce the bug in the real browser. Record exact repro steps,
   observed vs expected, and console errors. This repro IS the acceptance check.
   If it cannot be reproduced, stop and report — do not fix blindly.
2. PLAN — read-only planner child (use scout): follow the repo's CLAUDE.md
   debugging protocol — hypothesis before any read, localize to ≤3 files with
   named symbols. Deliverables: root-cause hypothesis, minimal fix plan, and the
   exact replay steps that will prove it fixed.
3. FIX — worker child (the only writer): root-cause fix, no symptom patches —
   fix the shared function, not the one caller. Then run
   `npm run typecheck && npm run build && npm test`; all must pass.
4. VERIFY — playwright agent: replay the exact repro from step 1. PASS/FAIL
   with evidence (snapshot, screenshot, console state). On FAIL, resume the fix
   child with the findings — max 1 retry, then report.
5. REVIEW — fresh reviewer child: audit the diff against the plan; hunt edge
   cases, sibling callers of anything the fix touched, and regressions. On
   findings: fix child resumes, then replay the repro again. Hard cap 3 review
   rounds — after that report findings back instead of looping.

Final report: root cause (file:symbol), diff summary, before/after repro evidence,
verification commands and results, and remaining reviewer findings if the cap was hit.
