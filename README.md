# EchoPaper

**English** | [简体中文](README.zh-CN.md)

Research usually ends up scattered across too many places: PDFs in one app, translations in a browser tab, notes in Markdown files, manuscripts in a LaTeX editor, and group-meeting slides in PowerPoint. **EchoPaper** brings those pieces together into one ordinary local folder on your computer—open it in your browser, work directly on your own files, and keep everything on disk without cloud lock-in.

## What you can do with it

- **Read papers without losing context**: Connect your local paper folders to browse titles, translated Chinese titles, venues/years, and keywords at a glance, search across originals and translations, and read PDFs side-by-side with translations and Markdown notes.
- **Keep each research topic straight**: Track milestones, daily todos, experiment notes, and explore an interactive map showing how the papers in a topic connect to one another.
- **Write and revise LaTeX in one place**: Edit manuscripts with Tectonic PDF preview, jump back and forth between source lines and the PDF, leave highlights or sticky notes on pages, manage point-by-point reviewer responses, and bundle clean submission archives.
- **Get AI help and draft slides**: Plug in your own OpenAI-compatible model to discuss papers or polish drafts (proposed edits always pause for your review before touching a file), and turn papers or notes into editable `.pptx` slides when a group meeting is coming up.

## Quick start

Use **Node.js 22.13 or later in the 22.x line, or Node.js 24.x**, and install **Git 2.28+** and **Python 3**. Git is needed to open the paper workspace even if you downloaded a ZIP. Keep the whole repository folder together, not just `_system`.

```sh
git clone https://github.com/Blueeeecho/EchoPaper.git
cd EchoPaper
```

**Easiest way**: double-click `启动工作台.command` on macOS or `启动工作台.bat` on Windows. To stop the server, use the matching `停止工作台` script. First launch (or moving between macOS and Windows) needs internet access to install the locked npm dependencies from `registry.npmmirror.com` and their platform binaries. If the browser doesn't open, use the local address printed by the launcher. It normally uses `http://127.0.0.1:4173`, but picks another port if needed.

**Prefer the terminal?**

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

Reading, notes, local search and LaTeX editing don't need an API key. To compile LaTeX, install **Tectonic** (set `TECTONIC_PATH` if it isn't found) and the template's fonts. The first build may need to download a TeX bundle; offline builds need the relevant assets cached. The HZAU slide template requires **LiSu (隶书)** and **Times New Roman** and does not silently replace them. If setup fails, run `npm --prefix _system run doctor` after installing npm dependencies.

For AI chat, document translation, or OCR parsing, add your own endpoint and key in **Settings**. Credentials stay in macOS Keychain or Windows Credential Manager, not in the repository.

## More

- Sample project lives in `papers/DEMO/`; LaTeX edits sync on disk and only compile when you save a build target or click Compile.
- Looking for CLI commands, local APIs, translation setup, or the optional macOS launcher? See [`LOCAL_API.md`](_system/docs/LOCAL_API.md), [`ACADEMIC_API.md`](_system/docs/ACADEMIC_API.md), [`TRANSLATION_SERVICES.md`](_system/docs/TRANSLATION_SERVICES.md), and [`_system/native/README.md`](_system/native/README.md).
- This is a sanitized public source release with no personal papers or credentials ([`SHARING_NOTES.md`](SHARING_NOTES.md)). After using it locally, avoid zipping the whole folder to share.
- Third-party packages keep their original licenses, and the included HZAU slide template assets retain their original rights ([`ACADEMIC_REUSE.md`](_system/docs/ACADEMIC_REUSE.md)); no unified open-source license is declared for the repository as a whole.
