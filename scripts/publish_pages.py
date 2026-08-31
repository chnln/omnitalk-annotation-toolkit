"""Publish public browser assets to the gh-pages branch without changing this checkout."""

from pathlib import Path
import shutil
import subprocess
import tempfile

from build_pages import ROOT, build_site


def git(*args: str, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=check)


def publish() -> None:
    remote = git("remote", "get-url", "origin").stdout.strip()
    revision = git("rev-parse", "--short", "HEAD").stdout.strip()
    branch = git("ls-remote", "--exit-code", "--heads", remote, "gh-pages", check=False)
    if branch.returncode not in (0, 2):
        raise RuntimeError(branch.stderr.strip() or "Could not read the publication branch")

    # A disposable checkout keeps the user's main branch and changes untouched.
    # Only build_site's explicit public asset list will be committed here.
    with tempfile.TemporaryDirectory(prefix="omnitalk-pages-") as folder:
        checkout = Path(folder)
        git("init", "-b", "gh-pages", cwd=checkout)
        git("remote", "add", "origin", remote, cwd=checkout)
        if branch.returncode == 0:
            git("fetch", "--depth=1", "origin", "gh-pages", cwd=checkout)
            git("checkout", "-B", "gh-pages", "FETCH_HEAD", cwd=checkout)
        # Honor repository-local author configuration as well as global defaults.
        for setting in ("user.name", "user.email"):
            value = git("config", "--get", setting, check=False)
            if value.returncode == 0:
                git("config", setting, value.stdout.strip(), cwd=checkout)
        for path in checkout.iterdir():
            if path.name == ".git":
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        build_site(checkout)
        git("add", "--all", cwd=checkout)
        changed = git("diff", "--cached", "--quiet", cwd=checkout, check=False)
        if changed.returncode == 0:
            print("The gh-pages branch already contains this browser build.")
            return
        if changed.returncode != 1:
            raise RuntimeError(changed.stderr.strip() or "Could not inspect the browser build")
        git("commit", "-m", f"Publish browser edition from {revision}", cwd=checkout)
        # A normal fast-forward push preserves history and fails safely if a
        # concurrent publisher updated the branch. Run again in that case.
        result = git("push", "origin", "HEAD:gh-pages", cwd=checkout)
        print(result.stdout.strip() or result.stderr.strip())
        print("Browser edition published to gh-pages. GitHub Pages will deploy it.")


if __name__ == "__main__":
    try:
        publish()
    except (subprocess.CalledProcessError, RuntimeError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise SystemExit(f"Publication failed: {detail.strip()}") from error
