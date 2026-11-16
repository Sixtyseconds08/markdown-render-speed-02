# Fast Markdown renderer — make.fun markdown-render-speed-02 entry

`parse(markdown)` returns the HTML marked 18.1.3 renders with its default options (GFM on), byte-identical on the practice set (720/720 cases).

- `parse.js` — hand-written single-pass CommonMark 0.31.2 + GFM parser. It falls back to the vendored marked for any input the fast path cannot prove exact, so correctness comes first.
- `main.ts` — the driver: reads `/input/cases.json`, writes `/output/html.json` (or `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` outside a container).
- `vendor/marked/` — marked 18.1.3 (`marked.esm.js`, MIT, byte for byte from npm) used by the fallback.

Entry by @susilawati for the make.fun bounty "Make Markdown rendering faster" (markdown-render-speed-02).

## License

MIT. See LICENSE. The vendored marked copy keeps its own LICENSE and NOTICE.
