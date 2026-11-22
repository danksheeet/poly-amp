# Third-party notices

Poly Amp itself is licensed under the [MIT License](LICENSE). It uses the following third-party components,
each under its own license. Full license texts are in the [`licenses`](licenses) folder and, for the bundled web
assets, in `public/vendor/alphatab`. In the app folder, the license texts, `LICENSE.txt` and this file are in
`licenses`, and the web assets are in `ui/vendor/alphatab`.

| Component | Used for | License | License text |
| --- | --- | --- | --- |
| [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) 0.6.0 — Steven Atkinson | runs `.nam` models (built into `namcore.dll` / `namcore-sse2.dll`) | MIT | `licenses/NeuralAmpModelerCore-MIT.txt` |
| [Eigen](https://gitlab.com/libeigen/eigen) | linear algebra inside the NAM library | MPL 2.0 | `licenses/Eigen-MPL-2.0.txt` |
| [JSON for Modern C++](https://github.com/nlohmann/json) — Niels Lohmann | model files parsing inside the NAM library | MIT | `licenses/nlohmann-json-MIT.txt` |
| [VST 3 SDK](https://github.com/steinbergmedia/vst3sdk) 3.8.1 — Steinberg Media Technologies (pluginterfaces, base, public.sdk) | hosting VST3 plugins (built into `vst3host.dll`) | MIT | `licenses/VST3-SDK-MIT.txt` |
| [NAudio](https://github.com/naudio/NAudio) — Mark Heath | ASIO audio I/O | MIT | `licenses/NAudio-MIT.txt` |
| [Microsoft Edge WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) | the UI window | Microsoft (BSD-style) | `licenses/WebView2-SDK-LICENSE.txt`, `licenses/WebView2-SDK-NOTICE.txt` |
| [.NET runtime](https://dotnet.microsoft.com/) (bundled in self-contained builds) | runtime | Microsoft .NET Library license | `licenses/dotnet-LICENSE.txt`, `licenses/dotnet-ThirdPartyNotices.txt` |
| [alphaTab](https://github.com/CoderLine/alphaTab) 1.9.0 — CoderLine | Guitar Pro / MusicXML reading, tab rendering, MIDI synth | MPL 2.0 | `public/vendor/alphatab/LICENSE-alphaTab-MPL-2.0.txt` |
| [Bravura](https://github.com/steinbergmedia/bravura) — Steinberg | music notation font used by alphaTab | SIL Open Font License 1.1 | `public/vendor/alphatab/font/Bravura-OFL.txt` |
| Sonivox EAS sound bank — Sonic Network, Inc. | General MIDI sounds for the alphaTab synth | Apache 2.0 | `public/vendor/alphatab/soundfont/LICENSE-sonivox-Apache-2.0.txt` |

## Modified files

`public/vendor/alphatab/alphaTab.js` is alphaTab 1.9.0 with small fixes to tuplet rendering and a hook that
routes its audio output through the app's reverb. Every
change is marked with a `Poly Amp patch` comment and described in
[`public/vendor/alphatab/PATCHES.md`](public/vendor/alphatab/PATCHES.md). As required by the MPL 2.0, the
modified file is distributed in source form under the same license.

## Services

- **TONE3000** — the app lets you browse and download amp and pedal captures from
  [tone3000.com](https://www.tone3000.com) through the TONE3000 API, signed in with your own account. Tones belong
  to their creators and carry the licenses they chose; Poly Amp doesn't bundle or redistribute any of them.
  Powered by TONE3000.
- **Songsterr** — the app can open [songsterr.com](https://www.songsterr.com) in a window, where you can download
  Guitar Pro files with Songsterr's own button (an account is required); the app only chooses the folder the file is
  saved to. Tabs on Songsterr are licensed by Songsterr; Poly Amp doesn't fetch them in any other way.
