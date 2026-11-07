# Media and file viewers

Playing a video or a sound, and reading any file the Files dialog opens: `components/media-player.tsx` (`MediaPlayer`), `components/file-viewer.tsx` (`FileViewer`, the router), `image-view.tsx` (`ImageView`), `large-text.tsx` (`LargeText`), `file-kinds.tsx` (`PdfView`, `ArchiveView`, `BinaryView`, `CsvView`, `PlayCard`), `file-actions.tsx` (`FileActions`), `copy-progress.tsx` (`CopyProgress`). Rules and state are `lib/media.ts` (`createPlayer`), `lib/media-source.ts` (`openSource`), `lib/image-view.ts`, `lib/csv.ts`, `lib/files.ts`; the work is `herdr_core::files` and the `Media` and `Lines` modules (`native/app/src/media.rs`). `design/files.md` is the browser; this is what opens from it.

## The player

Built on nsh's `Video` (GStreamer on Linux, AVPlayer on macOS: same props and events; no rate on Linux). nsh has no `Audio`: a sound is a `Video` one pixel wide and transparent, with the same bar. **Nothing autoplays**; a player waits on its first frame (the poster) until Play. Opening is cheap: a local file is played where it is, nothing is read or copied (`Media.fetch` answers `ready` at once).

- **Keys** (while the player is on screen, never in a text field): `Space` play or pause, `Left` and `Right` 5 s (`Shift` 30 s), `Up` and `Down` volume by a twentieth step, `m` mute, `l` loop, `f` full screen, `Home` and `End`. Each is also a named control: Play or Pause, the `Position` and `Volume` sliders (nsh `Slider`, so pointer and screen reader work), Mute, Loop, Full screen.
- **Announced politely**: `Playing`, `Paused`, `Ended`, `1:05 of 4:20` after a seek, `Volume 70%`, `Muted`, `Loop on`. A held key is announced at most every 400 ms. The clock is `0:00` / `1:02:03` in tabular figures; its label says `Position 1:05 of 4:20`.
- **The engine only reports while playing**, so a seek sets the position itself and ignores progress reports for 600 ms (`SEEK_SETTLE_MS`): the last report before the jump would pull the bar back.
- **Full screen** is the window's (`Window.toggleFullScreen`), and the stage takes the height the window has. nsh has no per-video full screen. Leaving the viewer in full screen leaves it too.
- **Reduced motion**: no animated chrome; the only moving parts are the video and a `Spinner` while buffering.
- **Errors say what and what next**: `This computer cannot play H.265 video` (the codec read from the file's own headers by `Media.probe`: MP4 boxes, Matroska ids, Ogg headers; never the file) with the system's words under it, `Open in the system player`, `Reveal in Finder` (or `the file manager`) and `Copy path`. A file whose headers name nothing says `cannot play this video`.
- **Another machine's file** is copied first (`openSource`): 1 MB range reads over the machine's ssh connection, off the UI thread, with `CopyProgress` (`Copying from devbox`, `12 MB of 340 MB`, `Cancel`). It plays from the copy.

## The media cache

`<dataDir>/cache/media`, capped at 1 GB (`MEDIA_CAP`), `MediaCache` in `native/core/src/files/cache.rs`:

- **The cap holds**: a copy reserves its whole size before the first byte, so concurrent copies cannot pass it; the unit tests assert the bytes on disk at every progress report.
- **LRU**: when there is no room the least recently used copies nobody has open go; a copy a viewer holds is never taken, and a copy that cannot fit removes nothing before it says so (`This file is 3.0 GB. The cache ... keeps up to 1.0 GB: open it on that machine instead`).
- **Whole or absent**: `.part` then rename; a cancel or failure removes the part; at start leftover parts are removed and the folder is trimmed.
- **Closing a viewer lets go** (`Media.releaseFetch`): the copy stays as a cache within the cap, so reopening is instant, and goes first when room is needed. A copy is named by machine, path, size and time, so a changed file is fetched again.

## Other files

`FileViewer` picks by `ViewKind` (decided by the core from the name and the first bytes): text and Markdown as before; **CSV** as a table with a `Text` switch (first 2000 rows); **minified JSON** laid out (`Media.formatJson`, every number and string exactly as written) with `As written` one switch away; **text over 4 MB** paged by lines (`LargeText`: a sparse index every 512 lines built by one background pass, a page is one range read, `mod+f` streams through the whole file, `Go to line`); **pictures** with zoom, fit, actual size, rotate, drag and arrow-key pan, `Copy image` (`Media.imageDataUrl`; an SVG copies its source instead); **PDF** in the web view from a loopback address that serves exactly that file with ranges (`Media.serve`: random token, 127.0.0.1 only, ended with the viewer); **archives** (zip, tar, tar.gz, gzip: names and sizes from the central directory or by hopping headers, never unpacked); **anything else** as `Not a text file`, what its bytes announce and a hex dump of the first 4 KB. Files over 50 MB are never read whole: text over 4 MB is paged, media is streamed or copied in 1 MB ranges, pictures over 40 MB are not opened.

Always (`FileActions`): `Send to the agent` (`mentionInChat`; it says what to do when no chat is open), `Open` with the system's application (another machine's file is copied first), `Reveal` (Finder on a Mac, `open -R` through nsh's `reveal_path`), `Copy path`, `Copy contents` for text, `Copy image`.

## Browsing

`Space` (with the find field empty) or `mod+y` shows a preview beside the folder list; it follows the highlight 200 ms after it stops, `Enter` opens the full viewer, `Escape` closes the preview before the dialog. A video or sound previews as a `PlayCard` (never decoded, never copied). In the viewer `[` and `]` step through the folder's files (`Left` and `Right` through its pictures); the position is `File 4 of 9` or `Photo 2 of 3`.

## Decided with evidence

- **PDF**: a spike (a web view on a loopback PDF, cairo under Xvfb) drew WebKitGTK's PDF viewer here, so the web view shows PDFs on Linux; `WKWebView` draws them natively on a Mac, unverified.
- **Video under test**: the dev box's GStreamer has Theora, Vorbis, Opus, FLAC and MP3 and no H.264 or VP9: `fixtures/files/media` (`scripts/gen-media.sh`) plays a Theora clip and the H.265 one is the `cannot play` case. `components/media.test.tsx` plays the host's part through `shownPlayer` (a headless run has no media engine); `.shots/media.test.tsx` is the real window.
- **Quick look does not play**: decoding a pipeline per highlighted row would cost more than it tells.

## Not verified

macOS: AVPlayer playback, full screen, `Cmd` hints on a real keyboard, PDFKit in `WKWebView`, `open -R`, the clipboard image. Only the Rust core was checked for `aarch64-apple-darwin`.
