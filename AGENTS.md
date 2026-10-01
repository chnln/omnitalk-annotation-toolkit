# Annotation Toolkit Agent Instructions

## Choosing how a change lands

Validate every change locally first: run the tests relevant to it, and the full suites for app code (see **Development** in `README.md`).

| Change | How it lands |
| --- | --- |
| Documentation only: `README.md`, `SCHEMA.md`, `AGENTS.md`, examples | Commit directly to `main` and push. No PR needed. |
| New website functionality, or a change to how existing features behave | Open a PR. Merge only after the project owner explicitly approves that PR. |
| Small improvement to an existing feature, such as wording, styling or a minor fix | Ask the project owner whether to open a PR or commit directly to `main`, then follow the answer. |

- Opening a PR is not approval to merge. Approval for one PR or one direct commit does not cover later fixes or follow-up changes; ask again for those.
- If unsure which category applies, treat the change as website functionality and ask.

## Publishing the live demo

- The live demo must match `main`. Whenever browser-app code reaches `main`, whether through an approved merge or an approved direct commit, update the local `main` to that commit and run `uv run python scripts/publish_pages.py` from it. Approval to land the change covers publishing it.
- Confirm the live demo serves the new build (for example, fetch a changed static file from the Pages URL), and report the commit and the `gh-pages` publish result. If publishing fails, say so; do not leave the failure unreported.
- Documentation-only commits need no publishing: the Pages build contains no Markdown files.
- Never publish an unmerged branch, and never push to `gh-pages` except through `scripts/publish_pages.py`.

See **Change review and release** in `README.md` for the contributor-facing summary.
