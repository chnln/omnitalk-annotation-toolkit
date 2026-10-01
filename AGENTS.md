# Annotation Toolkit Agent Instructions

## Pull requests and deployment approval

- Prepare and validate changes locally, then submit a PR for review before merging or publishing.
- Do not push changes directly to `main` or `gh-pages` to bypass the PR workflow.
- Obtain the project owner's explicit approval for the specific PR or revision before merging or deploying it. Opening a PR is not approval to merge or deploy.
- Approval for an earlier PR or deployment does not authorize later fixes or follow-up changes. A request to adjust the app authorizes preparing the change for review, not publishing it.
- Run `scripts/publish_pages.py`, push to `gh-pages`, or trigger another live deployment only after explicit approval to publish that reviewed change.

See the **Change review and release approval** section in `README.md` for the documented release workflow.
