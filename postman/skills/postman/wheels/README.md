# Postman CI wheels

CI loads these unmodified official PyPI wheels on `PYTHONPATH` using Python's
standard ZIP importer. No pip, apt, extraction or network access is required after
checkout. Normal Postman installation still uses `../requirements.txt`.

Verified on 2026-10-01: both wheels are `py3-none-any`, contain no native modules,
and require no dependencies unless optional extras are requested. Their Python
requirements cover the Forgejo Python 3.11 runtime and GitHub Python 3.12 job.

| Artifact | Requires Python | License | SHA256 |
| --- | --- | --- | --- |
| `markdown-3.11-py3-none-any.whl` | `>=3.11` | BSD-3-Clause | `cd6c89e7eb308c8b332ed673215a52d208a43f8bacc030b1419376129408719e` |
| `dnspython-2.8.0-py3-none-any.whl` | `>=3.10` | ISC | `01d9bbc4a2d76bf0db7c1f729812ded6d912bd318d3b1cf81d30c0f845dbf3af` |

Provenance and published hashes: the public PyPI release JSON records at
`/pypi/Markdown/3.11/json` and `/pypi/dnspython/2.8.0/json`.
The original license notices remain inside each wheel's `.dist-info/licenses/`
directory; keep the whole wheel intact when updating it.

To refresh deliberately, inspect official release metadata for compatibility,
then download through the package tool from the repository root:

```sh
python -m pip --isolated download --only-binary=:all: --no-deps --python-version 3.11 --dest postman/skills/postman/wheels Markdown==3.11 dnspython==2.8.0
```

Compare each downloaded SHA256 with its release's published hash and inspect the
wheel's `METADATA`, `WHEEL` and license files. Update the exact workflow paths and
this table together, removing superseded wheels. Prove Markdown's `nl2br`
extension and `dns.resolver` load from the archives, then run Postman's real
`--selftest` and the existing workflow tests in an owned disposable
`node:22-bookworm` container with `--network none` and the checkout mounted read-only.
This proves the test commands after checkout; action fetching and setup are
separate network-dependent stages.
