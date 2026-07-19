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

## Summary

Font Awesome and JetBrains Mono are bundled locally to support airgap deployments and eliminate external dependencies. WinSW is fetched at package-build time (pinned version, SHA-256 verified) and ships only in the built compute-worker artifact. All license requirements have been met by including the original license files or full license text and preserving copyright notices.
