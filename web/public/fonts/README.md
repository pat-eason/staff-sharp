# Licensed fonts

The design uses **Degular** (headings, OH no Type Co.) and **ABC Favorit** (body, Dinamo). Both are commercial
fonts, so they are not shipped in this repo. Drop your licensed `.woff2` files here with these names and rebuild
the `web` service (`docker compose up -d --build web`):

| File | Used for |
| --- | --- |
| `Degular-Medium.woff2` | Headings (500) |
| `Degular-Semibold.woff2` | Headings (600) |
| `Degular-Bold.woff2` | Display (700) |
| `ABCFavorit-Regular.woff2` | Body (400) |
| `ABCFavorit-Medium.woff2` | Body emphasis (500) |
| `ABCFavorit-Bold.woff2` | Body bold (700) |

If the fonts are installed on your machine the browser also picks them up via `local()`. Without them the app falls
back to Bricolage Grotesque (headings) and Instrument Sans (body), which are bundled.
