# Annotation Toolkit Agent Instructions

## Pull requests, merging and publishing

- Prepare and validate changes locally, then submit a PR. Do not push changes directly to `main` or `gh-pages`.
- Merge a PR only after the project owner explicitly approves merging that PR. Opening a PR is not approval, and approval for an earlier PR does not cover later fixes or follow-up changes.
- Approval to merge a PR also approves publishing it. Right after merging, update the local `main` to the merged commit and run `uv run python scripts/publish_pages.py` from it, so the live demo always matches `main`. A docs-only merge that leaves the browser build unchanged publishes nothing; the script reports that.
- Confirm the live demo serves the new build (for example, fetch a changed static file from the Pages URL), and report the merge commit and the `gh-pages` publish result. If publishing fails, say so; do not leave the failure unreported.
- Do not run `scripts/publish_pages.py` for unmerged branches, and do not push to `gh-pages` by any other route.

See the **Change review and release** section in `README.md` for the documented workflow.
