# /// script
# requires-python = ">=3.10"
# dependencies = ["pyjwt[crypto]>=2.8"]
# ///
"""Talk to the App Store Connect API for what `xcrun altool` cannot do.

    uv run scripts/release/asc.py audit [--version 1.0]
    uv run scripts/release/asc.py get    /v1/apps/<id>/appInfos
    uv run scripts/release/asc.py patch  /v1/appInfos/<id> '<JSON body>'
    uv run scripts/release/asc.py post   /v1/reviewSubmissions '<JSON body>'
    uv run scripts/release/asc.py delete /v1/<resource>/<id>

`audit` reads everything a submission needs for the version that is being
prepared (the one given, or the only one App Store Connect still lets you
edit) and prints one line per item: `ok`, `MISSING` or `note`. It writes
nothing, and exits 1 when anything is missing. App Store Connect reports
most of these only as a refusal at submission time, one item at a time,
and several have no visible default: a version with no build, a null age
rating, no primary category, no content-rights answer and a locale without
a privacy policy URL all look "unset" in the API and nowhere else. The
checks are what the 1.0 submission turned out to need.

The audit cannot see two things. The App Privacy answers are not in the
public API; adding the version to a draft `reviewSubmissions` is the check
that can, since App Store Connect refuses the item with every remaining
blocker listed under `meta.associatedErrors` (a draft is not sent until it
is PATCHed `submitted: true`, and an item can be deleted again). And the
first in-app purchase of a type has to join the version's submission from
App Store Connect's web UI (the purchase's page → Add for Review): the API's
`inAppPurchaseSubmissions` refuses it with
FIRST_NON_CONSUMABLE_MUST_BE_SUBMITTED_ON_VERSION, `reviewSubmissionItems`
has no relationship for a purchase, and once added the item reads back with
no relationships at all — confirm it in the web UI's App Review page.

`get` / `patch` / `post` / `delete` are the bare calls, printing the status
and the JSON answer. One-off writes (a price schedule, a review submission)
stay one-off: the body is written for the occasion rather than kept here.

Environment, the same names `upload_pkg.sh` reads:
    APPLE_API_KEY        the key id
    APPLE_API_ISSUER     the key's issuer id
    APPLE_API_KEY_PATH   the .p8 file; defaults to
                         ~/.appstoreconnect/private_keys/AuthKey_<APPLE_API_KEY>.p8

The token is an ES256 JWT with a 20-minute lifetime, minted per request.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt

BASE = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = "llc.fuji.parqsee"

# App Store Connect keeps a version editable in these states; the audit
# looks at that one. Anything past them is in review or on sale.
# READY_FOR_REVIEW is a version sitting in a draft review submission that
# has not been sent yet — the state it is in right before the last check.
EDITABLE_STATES = {
    "PREPARE_FOR_SUBMISSION",
    "READY_FOR_REVIEW",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
}


def _env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"asc.py: {name} is not set (see --help)")
    return value


def _token() -> str:
    key_id = _env("APPLE_API_KEY")
    path = os.environ.get("APPLE_API_KEY_PATH") or os.path.expanduser(
        f"~/.appstoreconnect/private_keys/AuthKey_{key_id}.p8"
    )
    with open(path) as f:
        key = f.read()
    now = int(time.time())
    return jwt.encode(
        {"iss": _env("APPLE_API_ISSUER"), "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": key_id},
    )


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    url = path if path.startswith("http") else BASE + path
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + _token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else None


def get(path: str) -> dict:
    status, body = call("GET", path)
    if status != 200:
        sys.exit(f"asc.py: GET {path} answered {status}: {json.dumps(body)[:400]}")
    return body


class Audit:
    def __init__(self) -> None:
        self.missing = 0

    def check(self, label: str, passed: bool, detail: str = "") -> None:
        if not passed:
            self.missing += 1
        print(f"{'ok     ' if passed else 'MISSING'}  {label}" + (f" — {detail}" if detail else ""))

    def note(self, label: str, detail: str) -> None:
        print(f"note     {label} — {detail}")


def audit(version: str | None) -> int:
    a = Audit()
    app = get(f"/v1/apps?filter[bundleId]={BUNDLE_ID}")["data"][0]
    app_id = app["id"]
    a.check(
        "content rights declaration",
        app["attributes"]["contentRightsDeclaration"] is not None,
        str(app["attributes"]["contentRightsDeclaration"]),
    )

    versions = get(f"/v1/apps/{app_id}/appStoreVersions?include=build,appStoreReviewDetail")
    candidates = [
        v
        for v in versions["data"]
        if (v["attributes"]["versionString"] == version if version else v["attributes"]["appStoreState"] in EDITABLE_STATES)
    ]
    if len(candidates) != 1:
        found = [(v["attributes"]["versionString"], v["attributes"]["appStoreState"]) for v in versions["data"]]
        sys.exit(f"asc.py: cannot tell which version to audit (pass --version): {found}")
    ver = candidates[0]
    va = ver["attributes"]
    print(f"app {app_id} · version {va['versionString']} ({ver['id']}) · {va['appStoreState']}")
    a.check("copyright", bool(va["copyright"]), str(va["copyright"]))
    a.note("release type", str(va["releaseType"]))

    build = get(f"/v1/appStoreVersions/{ver['id']}/build")["data"]
    if build:
        ba = build["attributes"]
        a.check(
            "build attached",
            ba["processingState"] == "VALID" and not ba["expired"],
            f"{ba['version']} {ba['processingState']}, expired {ba['expired']}, "
            f"non-exempt encryption {ba['usesNonExemptEncryption']}",
        )
    else:
        a.check("build attached", False, "no build on the version")

    detail = get(f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail")["data"]
    fields = ("contactFirstName", "contactLastName", "contactPhone", "contactEmail")
    a.check(
        "App Review contact",
        bool(detail) and all(detail["attributes"][f] for f in fields),
        "" if not detail else ", ".join(f"{f}={detail['attributes'][f]}" for f in fields)
        + f", demo account required {detail['attributes']['demoAccountRequired']}",
    )

    for info in get(f"/v1/apps/{app_id}/appInfos")["data"]:
        if info["attributes"]["state"] == "READY_FOR_DISTRIBUTION":
            continue  # the live version's info; the one being prepared follows
        category = get(f"/v1/appInfos/{info['id']}/primaryCategory")["data"]
        a.check("primary category", category is not None, category["id"] if category else "")
        rating = get(f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]["attributes"]
        # The questionnaire's own answers; the overrides default to NONE and
        # the follow-ups (kids band, age-restricted social media) stay null
        # unless the question they follow is answered yes.
        unanswered = [
            k
            for k, v in rating.items()
            if v is None
            and k
            not in {
                "kidsAgeBand",
                "socialMediaAgeRestricted",
                "gracRatingClassificationNumber",
                "developerAgeRatingInfoUrl",
            }
        ]
        a.check("age rating questionnaire", not unanswered, "unanswered: " + ", ".join(unanswered) if unanswered else "")
        a.note("computed age rating", str(info["attributes"]["appStoreAgeRating"]))
        for loc in get(f"/v1/appInfos/{info['id']}/appInfoLocalizations")["data"]:
            la = loc["attributes"]
            a.check(f"privacy policy URL [{la['locale']}]", bool(la["privacyPolicyUrl"]), str(la["privacyPolicyUrl"]))

    for loc in get(f"/v1/appStoreVersions/{ver['id']}/appStoreVersionLocalizations")["data"]:
        la = loc["attributes"]
        for field in ("description", "keywords", "supportUrl"):
            a.check(f"{field} [{la['locale']}]", bool(la[field]))
        shots = []
        for s in get(f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")["data"]:
            shots += get(f"/v1/appScreenshotSets/{s['id']}/appScreenshots")["data"]
        states = [s["attributes"]["assetDeliveryState"]["state"] for s in shots]
        a.check(
            f"screenshots [{la['locale']}]",
            bool(states) and all(s == "COMPLETE" for s in states),
            f"{len(states)}, {sorted(set(states))}",
        )

    status, prices = call("GET", f"/v1/apps/{app_id}/appPriceSchedule")
    a.check("price schedule", status == 200 and prices["data"] is not None)
    availability = get(f"/v1/apps/{app_id}/appAvailabilityV2")["data"]
    territories = get(f"/v2/appAvailabilities/{availability['id']}/territoryAvailabilities?limit=200")["data"]
    available = sum(1 for t in territories if t["attributes"]["available"])
    a.check("territories", available > 0, f"{available} of {len(territories)} available")

    for iap in get(f"/v1/apps/{app_id}/inAppPurchasesV2")["data"]:
        ia = iap["attributes"]
        a.note(f"in-app purchase {ia['productId']}", ia["state"])
        if ia["state"] in {"APPROVED", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"}:
            continue
        a.check(f"{ia['productId']} ready to submit", ia["state"] == "READY_TO_SUBMIT", ia["state"])
        shot = get(f"/v2/inAppPurchases/{iap['id']}/appStoreReviewScreenshot")["data"]
        a.check(
            f"{ia['productId']} review screenshot",
            bool(shot) and shot["attributes"]["assetDeliveryState"]["state"] == "COMPLETE",
        )
        a.check(f"{ia['productId']} review note", bool(ia["reviewNote"]))

    submissions = get(f"/v1/reviewSubmissions?filter[app]={app_id}")["data"]
    a.note(
        "review submissions",
        ", ".join(f"{s['id']} {s['attributes']['state']}" for s in submissions) or "none",
    )
    # Not in the public API at all: the App Privacy answers (the "nutrition
    # label") are only visible in App Store Connect's web UI.
    a.note("App Privacy", "not readable through the API; check it is published in App Store Connect")
    print(f"\n{a.missing} missing")
    return 1 if a.missing else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("audit")
    p.add_argument("--version", help="the version string to audit (default: the editable one)")
    for name in ("get", "delete"):
        sub.add_parser(name).add_argument("path")
    for name in ("patch", "post"):
        p = sub.add_parser(name)
        p.add_argument("path")
        p.add_argument("body", help="the JSON request body")
    args = parser.parse_args()

    if args.command == "audit":
        return audit(args.version)
    body = json.loads(args.body) if args.command in ("patch", "post") else None
    status, answer = call(args.command.upper(), args.path, body)
    print(status)
    if answer is not None:
        print(json.dumps(answer, indent=1, ensure_ascii=False))
    return 0 if status < 300 else 1


if __name__ == "__main__":
    sys.exit(main())
