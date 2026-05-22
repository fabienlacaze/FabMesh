# MyFabmesh.AI — slideshow screenshots

Drop your real app screenshots here. The hero slideshow on
`docs/index.html` auto-detects them and swaps the CSS mockups for the
real images on page load. If a file is missing, the mockup stays — so
you can ship the page progressively as you produce captures.

## Expected files

Aspect ratio: **16:10** (recommended 1600×1000) or anything in
`object-fit: cover` range. PNG or JPG.

| File | What to show |
|---|---|
| `01-wizard.png` | First-run setup wizard (the System / Mode pages with the colored OK/Warn rows) |
| `02-generate.png` | The main app : drop reference image → mesh generated, ideally a clean before/after split |
| `03-edit-photo.png` | Photo editor in action: clone stamp, mask, inpaint, etc. |
| `04-edit-mesh.png` | Mesh polish view: painting directly on the 3D model, or face refinement zone |
| `05-export.png` | Result gallery / export step — multiple meshes side by side, "Export GLB" button visible |

## Capture tips

- Run the app maximized so the screenshots look pro
- Take captures with the dark theme (default)
- Crop tight around the app window — no Windows taskbar
- Compress with **TinyPNG** before commit to keep the page snappy (each shot < 200 KB ideally)

## Captions

Captions live in `docs/index.html` next to each `<figure class="ss-slide">`
in the `data-caption` attribute. Edit them there if you change the
content of a slide.
