# `deploy/orgs/` — retired 2026-09-10

This directory used to hold one non-secret `<org>.yml` per tenant, read by
`scripts/generate-nitric-org-stack.mjs` and `.github/workflows/deploy-org.yml`.

**The org registry now lives in `powerpro-led/org-provisioning`'s
`orgs/<org>.yml`** (see that repo's
`docs/PER_ORG_PROVISIONING_CONTRACT.md` §3) — this repo never contains the
org list any more. `deploy-org.yml` was superseded by
`.github/workflows/deploy-org.reusable.yml` (`on: workflow_call`), which
takes an org's config as `workflow_call` inputs from `org-provisioning`'s
`provision-org.yml` instead of reading a file here.

`mosiq.yml` (worldmonitor's one real tenant, session 57) was transcribed to
`org-provisioning/orgs/mosiq.yml` and deleted from here in the same commit
that landed the reusable workflow.

Nothing new should be added to this directory. It is kept (with this
README) only so a link to the old path resolves to an explanation rather
than a 404.
