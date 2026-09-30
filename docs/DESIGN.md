# Design and free asset provenance

ArchiveGuard is a file utility. The layout emphasizes importing a sample, inspecting evidence and downloading verified copies. It uses three numbered workflow steps, plain tables, visible policy controls and restrained teal status colors. Functional icons always accompany a text label. There are no generated raster icons, decorative sparkles, metrics dashboards or borrowed competitor artwork.

The typography is [IBM Plex Sans](https://github.com/IBM/plex), an authored family designed for interfaces with Cyrillic support. The free alternatives considered were [Noto Sans](https://github.com/google/fonts/tree/main/ofl/notosans) and the [Tabler icon family](https://tabler.io/icons); the selected icons remain [Lucide](https://lucide.dev/license), which already provided a consistent ISC-licensed functional set. No asset purchases or remote font requests are needed.

The three unmodified WOFF2 weights (400/500/600) come from the official npm registry tarball for `@ibm/plex-sans@1.1.0`. Its SHA-512 integrity was compared with official registry metadata before extraction:

```text
sha512-WPgvO6Yfj2w5YbhyAr1tv95RUz4LRJlqN+CmYvBglabXteufP1D1E9BABMde+ZIKdRbFJDoKF5eQzfhpnbgZcQ==
```

The package's matching WOFF character maps were independently read to check Latin, Russian and Kazakh letters, including **Ә Ғ Қ Ң Ө Ұ Ү Һ І** and their lowercase forms. Browser checks load the local WOFF2 family in all three weights. The original [OFL license](../public/fonts/IBMPlexSans-LICENSE.txt) and [combined third-party notices](../public/THIRD_PARTY_NOTICES.txt) are redistributed with the app. Fonts and icons permit commercial reuse under their respective license conditions; this does not waive those conditions or grant a separate license to the whole application.

Body text is 16 px, controls are generally 14 px, and detail text is 12–14 px. Primary spacing uses 16/20/24/40 px with 3–5 px panel/control radii. Interactive buttons and selects use at least 44 px targets. Focus rings, explicit status text, scoped table scrolling, reduced-motion support and wrapping translated labels keep the functional structure accessible. Long filenames remain user content and are never translated.

Layouts are checked at 320/360/390/414/768/1280/1440 in both orientations and with 200% CSS zoom. These are Chromium browser tests and screenshots, not claims of physical-device or Safari coverage.
