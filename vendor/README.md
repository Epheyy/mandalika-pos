# vendor/

## xlsx-0.20.3.tgz

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz (SheetJS official build)
- Version: 0.20.3
- sha256: 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
- Vendored: 2026-10-23
- Why: the npm `xlsx` package is abandoned at 0.18.5 with unfixed high advisories
  (prototype pollution, ReDoS), and npm 12 blocks remote tarball dependencies by default.
- Update: download the new tarball from https://cdn.sheetjs.com/ (pinned version URL),
  verify sha256 from two downloads, replace the file, update this README,
  then `npm install ./vendor/xlsx-<ver>.tgz` and rerun `npm ci`, build, and an export smoke test.
