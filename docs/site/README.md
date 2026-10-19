# Project website

The project homepage introduces the Claude Code plugin and offline CLI. The separate
synthetic evaluator remains at `docs/playground/`, including previously shared threshold links.

Build and preview from the repository root:

```sh
node docs/site/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory _site
```

Open `http://127.0.0.1:8000/`. The build uses only Node's standard library and copies an
explicit set of public files. It does not include working transcripts, private configuration,
or the rest of the checkout. GitHub Actions publishes the same output to GitHub Pages.

The artwork and evaluator screenshot come from `docs/assets/`. The homepage uses relative
links so both the local preview and GitHub's `/agent-context-pruner/` project path work.

The public license is PolyForm Shield 1.0.0. Check `origin/main:LICENSE` before changing the
website's license text; local license work may be unpublished.
