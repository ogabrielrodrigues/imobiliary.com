# The sharing image

`public/og-image.png` is rendered from `og-image.html` by a headless browser.
Edit the HTML, never the PNG, then regenerate:

```powershell
# from docs/
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new `
  --disable-gpu --hide-scrollbars --allow-file-access-from-files `
  --force-device-scale-factor=1 --window-size=1200,900 --virtual-time-budget=3000 `
  --screenshot="$env:TEMP\og-raw.png" "file:///$((Resolve-Path scripts/og-image/og-image.html).Path.Replace('\','/'))"
```

Then crop the top 1200×630 of `og-raw.png` into `public/og-image.png`.

Two things that have bitten already:

- **Render in a taller window and crop.** Headless Chrome takes the browser
  frame out of `--window-size`, so a 1200×630 window leaves a viewport about
  95px short and the bottom of the image is cut off.
- **The fonts load from `node_modules`** through relative `file://` URLs, which
  is why `--allow-file-access-from-files` is required. Without it the image
  silently renders in a fallback font.
