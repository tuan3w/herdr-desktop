// The media lab, opened from the app's root so that nsh reads the REAL `nsh.json` next to it, `capabilities` included.
// A lab under `components/` has none, and a host without capabilities allows every address: a `file://` picture then
// "works" in a test and is refused in the packaged app. Not part of the app.
import "#components/media-lab";
