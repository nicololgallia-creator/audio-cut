# Audio Cut

Cut sound out of a video, right in your browser.

Drop in a video and you get a timeline like CapCut's, built for audio. Split it, trim it, reorder it, shape each clip, and export WAV or MP3. Your video never leaves your computer. There's no account, no upload and no install.

![Audio Cut with a video split into clips on a timeline](docs/screenshot.png)

I built this because I had a 4 minute screen recording full of sound effects for a game, and I needed each one as its own named file. One click finds every sound, and naming them takes a few seconds each: type a name, press Enter, and the next one plays.

## Try it

1. Download this repo (the green **Code** button, then **Download ZIP**) and unzip it.
2. Open `index.html` in Chrome or Edge.
3. Drop in an mp4, mov or webm.

There's nothing to build. Firefox and Safari aren't tested yet, and they can't read every video format.

## What it does

**Editing**
- Timeline with no gaps: delete a clip and the rest close up
- Split at the playhead, delete left or right of it, drag edges to trim, drag clips to reorder
- Double click a sound to cut it out as its own clip
- Auto Split finds every sound in a file, with a live count as you adjust it
- Video frames and a waveform on each clip, snapping, markers, undo and redo
- Select several clips and change them together, or apply one clip's settings to all
- Your edit saves itself and comes back when you open the same video again

**Sound**
- Volume, fade in, fade out
- Speed from 0.25x to 4x (pitch moves with it)
- Reverse
- Normalize, which puts a clip's loudest point at -1 dB
- Noise reduction, low cut, high cut and reverb

**Export**
- WAV or MP3
- One joined file, or every clip as its own file in a zip, named the way you named it

What you hear in preview is exactly what you export, because both run through the same code.

## Keys

| Key | Does |
| --- | --- |
| `Space` | Play or pause |
| `S` | Play the selected clip |
| `Ctrl B` | Split at the playhead |
| `Q` / `W` | Delete left or right of the playhead |
| `Delete` | Delete the selected clips |
| `Ctrl Z` / `Ctrl Shift Z` | Undo and redo |
| `Ctrl A` / `Ctrl D` | Select all, duplicate |
| `Up` / `Down` | Previous or next clip |
| `Alt Left` / `Alt Right` | Move the selected clip earlier or later |
| `Left` / `Right` | Step the playhead (`Shift` for one second) |
| `M` / `N` | Add a marker, turn snapping on or off |
| `Z` / `Shift Z` | Zoom to the clip, fit the timeline |
| `E` | Export |
| Scroll | Zoom (`Shift` or `Alt` to move along the timeline) |

Use `Cmd` for `Ctrl` on a Mac.

## How it works

It's plain HTML, CSS and JavaScript with no framework and no build step.

- `js/sound.js` handles everything to do with samples: decoding, finding sounds, rendering a clip, and writing WAV, MP3 and ZIP files.
- `js/app.js` is the editor. A clip is only a window onto the source plus its settings, so edits never touch your video and undo is cheap.
- `js/sun.js` is the first screen. Move your mouse over the horizon.

The audio decodes to 48 kHz with the Web Audio API. Each clip renders once through an `OfflineAudioContext`, and playback and export both use that result.

## Limits

- Files over about 2 GB are too big for a browser to read in one go.
- It works on one video at a time.
- It exports audio only. For text, stickers and exporting video, use CapCut.

## Credits and license

Made by Nicolo Gallia.

The code is under the [MIT License](LICENSE). The MP3 encoder and the fonts have their own licenses, and the Gallia name and rooster logo aren't covered by the MIT License. See [NOTICE.md](NOTICE.md).
