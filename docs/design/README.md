# DASH design assets

The [circuit banner](../../dash-desktop/ui/assets/scarlet-circuit.jpg) is a locally bundled JPEG generated with OpenAI ImageGen. The **Compare and benchmark multiple models** slide places the three illustrative model families over this photograph. Quick compare selects two models per run from local on-premises models or closed models accessed through their APIs.

ImageGen received the following prompt.

> Wide 3:1 motorsport editorial photograph for a compact banner. A sweeping racetrack turn at blue hour, viewed from above. Scarlet taillight ribbons trace the apex past ivory-and-red kerbing on the right. Leave the left half in quiet deep burgundy shadow for white type. Real asphalt, restrained film grain, no lettering or logos.

The [DASH mark](../../dash-desktop/ui/assets/dash-mark.svg) is shared by the sidebar and Overview. The Dock uses its [1024 px PNG](../../dash-desktop/ui/assets/dash-icon.png). To regenerate that raster on macOS, run `sips -s format png dash-desktop/ui/assets/dash-mark.svg --out dash-desktop/ui/assets/dash-icon.png` from the repository root. The Mac bundle builds its icon set from the PNG.

Use racing yellow (`#ffcf00`) with charcoal lettering for workflow actions such as **New run**. Model cards, lane controls and planning choices use neutral surfaces. A checkmark and accent outline identify a selected model. At two selections, the remaining cards keep their runtime labels and lose their add symbol. Light/Dark uses a bordered selection on the shell surface. The carousel groups its ivory arrows, slide count and playback control on graphite. Both controls have a separate keyboard focus indicator. Style the device power readout with its neighboring telemetry values.

The [light](overview-light.png) and [dark](overview-dark.png) screenshots show the desktop workbench using an isolated test profile.

The [grader library screenshot](grader-library.png) shows the shipped Financial Services checks, their version-specific run links, and the start of the Manufacturing section in a fresh local profile.

The [original prototype](DASH_Design_Prototype.html), [approved preview](DASH_Design_Preview.png), and [in-progress animation](DASH_Run_Animation.gif) document the first design. The [logo concept sheet](archive/Eval_Bench_Logo_Concepts.png) is archived exploration.

## Industry photographs

The opening slide pairs each domain with its own locally bundled editorial photograph. The images were generated using OpenAI ImageGen and exported as JPEGs for offline use. All six slides share a graphite-to-garnet ground. Feather the photographs at their edges and keep their centers clear. Captions sit below the photographs and identify the shipped examples and the Automotive roadmap. See the [desktop view](industry-overview.png) and [phone-width view](industry-overview-mobile.png) captured from Electron.

- [Financial Services](../../dash-desktop/ui/assets/industry-financial.jpg) — Photorealistic editorial photograph for a DASH Financial Services banner, landscape 4:3. A close overhead view of a quarterly earnings release on ivory paper with paired columns of small printed financial figures, a small understated blue bar chart and a fingertip tracing one reported figure with a graphite pencil. A second sheet of financial statements beneath it on a navy desk. Strong natural window light, understated midnight blue and cream with a small muted crimson accent. Form a simple unmistakable focal point near the center for a small card. Real paper texture, clean precise editorial photography. No digital UI, overlaid titles, logos, car imagery or watermark.
- [Manufacturing](../../dash-desktop/ui/assets/industry-manufacturing.jpg) — Photorealistic editorial photograph for a DASH Manufacturing banner, landscape 4:3. In a modern inspection lab, extreme close-up of a precision outside micrometer measuring the outer diameter of a silver machined bearing, discreet blue engineering drawing underneath on a dark slate inspection bench. A gloved technician's fingers hold the micrometer. Clear central silhouette of the bearing and measuring tool at small size. Directional cool daylight, brushed steel, restrained teal accent, tactile real detail. No overlaid titles, logos, car imagery or watermark.
- [Automotive](../../dash-desktop/ui/assets/industry-automotive.jpg) — Photorealistic editorial photograph for a DASH Automotive proving-ground banner, landscape 4:3. A single unbranded, graphite-silver road vehicle with a small test sensor pod mounted on its roof drives a broad curved vehicle proving-ground track with minimal white lane markings. Elevated front three-quarter perspective, car prominently centered and clearly readable when small. Warm morning sun, muted asphalt, soft red curb accent. Professional, restrained automotive validation photography, not a racing competition. No spectators, logos, lettering, watermarks or overlaid text.

## Capability diagrams

[View all six slides captured in Electron](overview-capabilities.png).

The four [inline diagrams](../../dash-desktop/ui/index.html) show a bearing-inspection objective branching into defect detection and false-alarm metrics, a dataset answer passing through AI Industry Graders, an example case with mismatched earnings bases, and a planned closed loop between a real controller and a simulated motor. A short highlight follows a connection when a diagram plays. Each diagram has a static reading order and an accessible description. Manual navigation pauses the carousel. [Presentation decision](../adr/0018-capability-diagrams.md)
