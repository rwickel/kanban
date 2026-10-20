# Unit Test Matrix

| ID | Test | Status |
|---|---|---|
| SW-UR-FILEPATHS-01 | `classifyHref` returns `file` for a `file-preview:` href. | planned |
| SW-UR-FILEPATHS-01 | `classifyHref` returns `file` for a root path with mixed case. | planned |
| SW-UR-FILEPATHS-01 | `classifyHref` returns `external` for a path outside the root. | planned |
| SW-UR-FILEPATHS-01 | `classifyHref` returns `external` for `https://` and empty hrefs. | planned |
| SW-UR-FILEPATHS-02 | A bare extensionless root path becomes a `file-preview:` link. | planned |
| SW-UR-FILEPATHS-02 | A bare extensionless path outside the root is left plain. | planned |
| SW-UR-FILEPATHS-02 | Existing `[text](url)` links are not modified. | planned |
| SW-UR-FILEPATHS-03 | A Windows path renders with a basename label, not the full path. | written |
| SW-UR-FILEPATHS-03 | A Unix path renders with a basename label, not the full path. | written |
| SW-UR-FILEPATHS-03 | The full path stays in the encoded href. | written |

Run: `npm test`

Result: planned (3 of 10 written).
