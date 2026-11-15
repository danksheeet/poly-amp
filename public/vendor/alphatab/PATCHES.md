# Changes to alphaTab 1.9.0

`alphaTab.js` is the `dist/alphaTab.js` build from the `@coderline/alphatab@1.9.0` package (MPL 2.0 license,
source: https://github.com/CoderLine/alphaTab) with a fix for tuplet rendering and a hook for the audio
output. Each changed place is marked with a `Poly Amp patch` comment.

## A tuplet that doesn't start on the first note of a beam group

When rendering rhythm, alphaTab took the tuplet group from the first note of a beam group
(`h.beats[0].tupletGroup`) without checking that it exists. If the tuplet starts on the second or a later
note, the group is `null`, and rendering of the whole tab failed with
`Cannot read properties of null (reading 'beats')` — the page stayed blank.

For example, the official CHON tabs from Sheet Happens (“Perfect Pillow”, “Ghost”, “Knot”, “But” and
others) and Polyphia's “Champagne” didn't open because of this.

Fixed in three places:

- `BarRendererBase._computeBeamingBounds` — a beamed rest with a tuplet: the block runs only if the first
  note has a tuplet group.
- `TabBarRenderer.emitHelperSkyline` (rhythm under the tab) and `emitHelperSkyline` in the renderer with
  the top line — instead of the first note, all notes under the beam are checked, and space for the tuplet
  bracket is reserved for every tuplet that starts inside the group.

## Audio output goes through the app's reverb

alphaTab's synthesizer has no effects of its own, so tabs sounded completely dry. The two web audio
outputs (`AlphaSynthAudioWorkletOutput` and the `ScriptProcessor` fallback) used to connect straight to
`ctx.destination`. Now they connect to `WebAudioHelper.outputFor(ctx)`, a new helper that returns the node
from `window.alphaTabOutputNode(ctx)` when the app provides one, and `ctx.destination` otherwise. Poly Amp
provides a node with a reverb and a limiter (`public/js/modes/tabreverb.js`). Without the hook alphaTab
behaves exactly as before.
