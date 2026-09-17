# @imobiliary/docx

The reading of a `.docx`, the block model both platforms draw it with, the
writer that puts blocks back into a file, and the preview component.

Both platforms show a template as a document: *Imobiliary Docs* to fill and to
edit a template, and *Imobiliary* to review a lease before generating it. The
code is here so there is one reading of a file and one preview, instead of two
that can disagree.

| Export | What |
|---|---|
| `@imobiliary/docx/blocks` | the block model, its marks and formats, and `listPositions` |
| `@imobiliary/docx/block-source` | the stored `imobiliary/source.json` tree, parsed and serialised |
| `@imobiliary/docx/placeholder` | placeholder names: validity, grouping and accented labels |
| `@imobiliary/docx/zip` | a ZIP reader and writer over `node:zlib`, server side only |
| `@imobiliary/docx/parse` | WordprocessingML to blocks |
| `@imobiliary/docx/build` | blocks to a `.docx` |
| `@imobiliary/docx/preview` | the document preview, with each placeholder rendered by the caller |

**The preview is a view, never the source of truth.** A document is always
rendered by the document API from the original archive, so what this reader
leaves out — fonts, images, tables — is missing from the preview only.

`zip`, `parse` and `build` use `node:zlib` and must stay on the server. The
preview is a React component and takes `cn` from `@imobiliary/ui`.

```bash
pnpm --filter @imobiliary/docx check
```
