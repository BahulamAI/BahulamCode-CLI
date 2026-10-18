"""Build a reviewable Teams app ZIP from registered IDs and approved brand assets.

No registration, upload, publication or provider API calls are performed.
"""
import argparse
import json
import struct
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse


def png(path, size):
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", data[16:24]) != (size, size):
        raise ValueError(f"Expected a {size}x{size} PNG: {path}")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app-id", "bot-id", "website", "privacy", "terms", "color", "outline", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    for value in (args.website, args.privacy, args.terms):
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("App links must be HTTPS without embedded credentials")
    manifest = {
        "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.25/MicrosoftTeams.schema.json",
        "manifestVersion": "1.25", "version": "0.3.0", "id": str(uuid.UUID(args.app_id)),
        "developer": {"name": "Bahulam", "websiteUrl": args.website, "privacyUrl": args.privacy, "termsOfUseUrl": args.terms},
        "name": {"short": "Bahulam", "full": "Bahulam for Azure DevOps"},
        "description": {"short": "Review Azure DevOps pull requests with your organization's Bahulam agent.",
            "full": "Connect your Microsoft account in Bahulam, then use personal chat to inspect Azure DevOps pull requests and propose review comments. Organization access policies and human approval protect changes. Requires a Bahulam account and an enabled organization integration."},
        "icons": {"color": "color.png", "outline": "outline.png"}, "accentColor": "#6D28D9",
        "bots": [{"botId": str(uuid.UUID(args.bot_id)), "scopes": ["personal"], "supportsFiles": False,
                  "isNotificationOnly": False}],
        "validDomains": [urlparse(args.website).hostname],
    }
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr("manifest.json", json.dumps(manifest, indent=2))
        output.writestr("color.png", png(args.color, 192))
        output.writestr("outline.png", png(args.outline, 32))
    print(f"Built {args.output}. Validate in Teams Developer Portal; outline must be white on transparent.")


if __name__ == "__main__":
    main()
