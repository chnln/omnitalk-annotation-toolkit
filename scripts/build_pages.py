"""Build a static browser edition from the same assets used by the local app."""

from pathlib import Path
import argparse


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "annotation_toolkit" / "static"
# Only public application assets are deployed, never downloads or workspace data.
PUBLIC_FILES = ("index.html", "app.js", "core.js", "styles.css", "downloads.js", "downloads.css")


def build_site(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in PUBLIC_FILES:
        content = (ASSETS / name).read_text(encoding="utf-8")
        if name == "index.html":
            marker = '<body data-mode="local">'
            if content.count(marker) != 1:
                raise ValueError("Expected exactly one local mode marker in index.html")
            content = content.replace(marker, '<body data-mode="static">')
        (destination / name).write_text(content, encoding="utf-8")
    (destination / ".nojekyll").touch()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "pages")
    build_site(parser.parse_args().output)
