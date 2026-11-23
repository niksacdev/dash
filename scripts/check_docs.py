"""Check repository-local Markdown links and images, including in moved guides."""
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parents[1]
markdown = subprocess.check_output(
    ["git", "ls-files", "-z", "--", "*.md"], cwd=root
).decode().split("\0")
missing = []
for name in filter(None, markdown):
    source = root / name
    for label, target in re.findall(r"\[([^\]]*)\]\(([^)\n]+)\)", source.read_text()):
        url = urlsplit(target.strip("<>"))
        if url.scheme or url.netloc or not url.path:
            continue
        if not (source.parent / unquote(url.path)).exists():
            missing.append(f"{name}: {label} links to missing {url.path}")
if missing:
    raise SystemExit("\n".join(missing))
print("Repository documentation links resolve.")
