# Body editor dependencies

Relay embeds CodeMirror 6 locally. Runtime requests never load scripts from a CDN.
The application sources are in `web/js/body-editor.js`; `core.js` defines the
vendored library exports.

Rebuild from the pinned lockfile with Node.js 20+ and npm:

```sh
cd tools/editor
npm ci
npm run build
```

Commit `package-lock.json`, `web/js/vendor/editor-core.js`, and
`web/js/vendor/editor-LICENSES.txt` together when updating dependencies. The build
rejects duplicate CodeMirror state/view copies: mixing them breaks extension
identity, diagnostics, and undo history. `build.ps1` embeds the existing bundle
and does not require Node.js or network access.

JSON completion is syntax based (pairs, indentation, `true`, `false`, `null`).
Environment/collection/global variable completion uses Relay's shared variable
picker. Business field suggestions require an API schema and are not inferred.
Unquoted `{{variable}}` values retain their original spelling when formatting;
their resolved values are checked by the request pipeline.
