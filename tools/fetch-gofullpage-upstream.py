"""Fetch the MIT-licensed historical GoFullPage source at an immutable commit."""
from pathlib import Path
import hashlib
import json
import urllib.request

COMMIT = "d1b6bbbf4c3f8101d787dd737e5476a5be082014"
ROOT = Path(__file__).resolve().parents[1] / "extension/vendor/gofullpage/upstream"
FILES = ["LICENSE", "README.md", "page.js", "api.js", "manifest.json"]
ROOT.mkdir(parents=True, exist_ok=True)
records = []
for name in FILES:
    url = f"https://raw.githubusercontent.com/mrcoles/full-page-screen-capture-chrome-extension/{COMMIT}/{name}"
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read()
    (ROOT / name).write_bytes(data)
    records.append({"file": name, "url": url, "sha256": hashlib.sha256(data).hexdigest()})
(ROOT.parent / "provenance.json").write_text(json.dumps({
    "repository": "https://github.com/mrcoles/full-page-screen-capture-chrome-extension",
    "commit": COMMIT, "license": "MIT", "files": records,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"commit": COMMIT, "downloaded_files": len(records)}, ensure_ascii=False))
