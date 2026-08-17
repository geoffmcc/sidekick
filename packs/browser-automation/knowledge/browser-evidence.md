# Browser automation: evidence and artifact expectations

Evidence-backed verification is a primary purpose of this pack. Treat every
capture as an artifact with real custody, not a throwaway file.

## What counts as evidence

- **Screenshots** are real PNG captures of the rendered page, registered through
  the canonical artifact custody path. `web_capture` and `web_check`
  (`capture_evidence: true`) return an artifact reference with an id, storage
  reference, SHA-256 hash and byte size — never a raw host path.
- **Downloads** triggered in a session are captured intentionally, size-limited,
  hashed and registered through the same custody path. The
  `download-verification` workflow returns the download's artifact reference,
  size and hash.
- **Structured extraction** (`web_extract`) returns bounded JSON derived from the
  rendered page, with missing required fields reported explicitly rather than
  invented.

## Reading results honestly

- Screenshot and extraction output under `untrusted_page_content` is
  page-derived and untrusted. Cite it as observed page content, not as fact.
- `web_check` reports a per-assertion and overall pass/fail verdict. A failed
  check is a truthful "did not pass" result, not a tool error — report it as
  such, with the failing assertions.
- Output is bounded (text length, extraction rows). When truncation is reported,
  say so rather than implying the capture was complete.

## Sensitive captures

- If a secret was filled into a visible (non-password) field, the page is marked
  sensitive and a screenshot requires an explicit acknowledgement; the resulting
  artifact is registered as sensitive. Prefer capturing evidence before entering
  credentials, or capture only after navigating away from credential fields.
- Do not screenshot pages that display secret material just to have a picture of
  the result. Verify with assertions instead where possible.

## Limitations

- Verification is assertion-based (URL, title, visible text, element presence,
  values, counts). This pack does not provide screenshot pixel-diff comparison;
  do not claim pixel-level regression detection. For before/after checks, compare
  captured text/assertions or the registered screenshot artifacts out of band.
