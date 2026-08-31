"""Check that the public build is portable and excludes local/private files."""

from html.parser import HTMLParser
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_pages", ROOT / "scripts" / "build_pages.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attributes):
        self.urls.extend(value for key, value in attributes if key in ("href", "src") and value)


class PagesTests(unittest.TestCase):
    def test_build_only_contains_public_assets_with_relative_links(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            builder.build_site(output)
            self.assertEqual({p.name for p in output.iterdir()}, {*builder.PUBLIC_FILES, ".nojekyll"})
            html = (output / "index.html").read_text()
            self.assertIn('<body data-mode="static">', html)
            self.assertNotIn('<body data-mode="local">', html)
            references = References()
            references.feed(html)
            for url in references.urls:
                self.assertFalse(url.startswith("/"), f"Project Pages would break: {url}")
                if url.startswith("./") and url != "./":
                    self.assertTrue((output / url).is_file(), url)
            self.assertIn('<body data-mode="local">', (builder.ASSETS / "index.html").read_text())


if __name__ == "__main__":
    unittest.main()
