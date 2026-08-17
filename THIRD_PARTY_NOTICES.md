# Third-Party Notices

This project includes the following third-party assets:

## Font Awesome Free 6.5.1

**License:** 
- CSS: MIT License
- Fonts: SIL OFL 1.1
- SVG icons: CC BY 4.0

**Source:** https://fontawesome.com/download

**Copyright:** © Fonticons, Inc. (fontawesome.com)

**License Text:** See `static/fontawesome/LICENSE.txt`

---

## JetBrains Mono 2.304

**License:** SIL OFL 1.1

**Source:** https://github.com/JetBrains/JetBrainsMono

**Copyright:** © JetBrains s.r.o.

**License Text:** See `static/fonts/jetbrains-mono/LICENSE.txt`

---

## WinSW 2.12.0

**License:** MIT License

**Source:** https://github.com/winsw/winsw (release v2.12.0, `WinSW.NET461.exe`)

**Copyright:** © 2008–2020 Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees, Inc., Oleg Nenashev and other contributors

**Distribution:** Not stored in this repository. The compute-worker package build (`scripts/build-worker-package.js`) downloads the pinned, SHA-256-verified release binary and bundles it in the built worker package as `sidekick-compute-worker.exe`, where it serves as the Windows service wrapper.

**License Text:**

```text
MIT License

Copyright (c) 2008-2020 Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees, Inc., Oleg Nenashev and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## playwright-core 1.62.1

**License:** Apache License 2.0

**Source:** https://github.com/microsoft/playwright (npm package `playwright-core`, pinned exactly in `package.json` / `package-lock.json`)

**Copyright:** © Microsoft Corporation

**Distribution:** Bundled as a normal production dependency (`node_modules/playwright-core`). It is the browser-automation engine that drives the Governed Browser Automation subsystem (`src/browser/`). `playwright-core` performs **no** browser download at install time — see the Chromium entry below.

**License Text:** Apache-2.0, full text at `node_modules/playwright-core/LICENSE`. The Apache-2.0 license permits redistribution provided the license and copyright notices are preserved.

---

## Chromium (Chrome for Testing) — build 151.0.7922.34 (Playwright revision 1234)

**License:** BSD 3-Clause and a combination of other open-source licenses (see the Chromium project's `LICENSE` and `credits`).

**Source:** Fetched from the Playwright browser CDN via `node scripts/install-browser.js`. The exact Chromium build is pinned by `playwright-core`'s own `browsers.json`, so the lockfile that pins `playwright-core` transitively pins the browser build.

**Copyright:** © The Chromium Authors and others.

**Distribution:** **Not stored in this repository.** An operator installs it once per host with `node scripts/install-browser.js`, which downloads the pinned build into the Sidekick data directory (`SIDEKICK_DATA_DIR/browser/ms-playwright`), outside the application checkout so deployments do not remove it. Nothing in Sidekick downloads the browser implicitly at runtime — a missing runtime is a health state and an actionable error, never a silent fetch. The installed Chromium retains its own bundled `LICENSE` and `credits` files.

---

## Summary

Font Awesome and JetBrains Mono are bundled locally to support airgap deployments and eliminate external dependencies. WinSW is fetched at package-build time (pinned version, SHA-256 verified) and ships only in the built compute-worker artifact. `playwright-core` is a normal pinned production dependency that ships no browser binary. Chromium is fetched by a deliberate operator install step (`scripts/install-browser.js`), pinned transitively through `playwright-core`, and installed into the data directory rather than committed. All license requirements have been met by including the original license files or full license text and preserving copyright notices.
