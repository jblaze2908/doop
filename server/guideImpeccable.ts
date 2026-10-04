/*
 * Adapted from Impeccable (Apache-2.0, © Paul Bakaus, github.com/pbakaus/impeccable @ e103efe).
 * Mapping to source files: server/vendor/impeccable/NOTICE.md.
 */

export const TOPIC_DESIGN_REVIEW = `## Design review — acting on the Design check

Draft runs Impeccable's anti-pattern detector (61 rules) on frames in a real browser, on
computed styles (Tailwind classes and theme tokens resolved). A whole-frame
get_frame_screenshot returns a short "Design check" (rule, selector, detail); audit_frame
returns every finding by rule, with severity and the rule's reasoning. Humans see findings as
a badge on the frame.

- **slop** rules catch reflexes that make a page read as generated; **quality** rules catch
  defects (contrast, overflow, broken images, legibility). Fix quality findings; take a slop
  finding as a prompt to decide. advisory: true findings are hints.
- Order: script-error and content-hidden-at-rest first (they hide everything else), then
  quality, then slop. Fix at the narrowest level: a theme token when the value repeats across
  frames, set_component for a component, edit_frame_html otherwise. Then screenshot again.
- A clean check is a floor, not proof of good design. Never silence a rule by hiding content,
  shrinking text or dodging the detector.
- **Keep a finding only when it is deliberate**: the brief, a style guide, a pinned reference
  or the canvas's design system asks for it (an editorial italic headline, a brand's own cream
  ground). Say so in set_status and leave it. A kit's starting font or ground is not a
  decision: swap the token to fit the brief.
- design-system-* rules fire only when the canvas theme defines tokens. Use the token; if the
  value is a genuine addition, add it to the theme so every frame shares it.

### Slop — fix per rule
- side-tab: drop the thick one-side border; emphasis from weight, a tint, or nothing.
- border-accent-on-rounded: keep the radius or the thick accent border, not both.
- overused-font: a face with character for the brief (set_theme_fonts), not the default wave.
- flat-type-hierarchy: at least one size step ≥1.25×; display vs body is usually 2–4×.
- gradient-text: solid text; emphasis from size or weight.
- ai-color-palette: no purple/violet gradients or cyan-on-dark; derive the accent from the mood.
- cream-palette: a ground from the mood's scene, not the safe warm off-white.
- nested-cards: flatten; separate inner groups with space, type or a divider.
- monotonous-spacing: tight inside groups (gap-2–4), generous between sections (py-20+).
- bounce-easing: ease-out, e.g. cubic-bezier(.16,1,.3,1); no bounce or elastic.
- pulsing-dot: a static dot with a label, unless the data is genuinely live.
- blinking-cursor: remove the fake caret.
- shape-assembled-illustration: a real image or product shot (topic "images"), or nothing.
- dark-glow: neutral shadow with offset and blur; no colored halo.
- radial-halo: a solid or subtly shifted ground; no saturated radial wash.
- radial-spotlight-glow: drop the accent haze, or use a real background (list_backgrounds).
- marquee: a static row with everything visible.
- icon-tile-stack: icon inline beside the heading with no tile, or no icon.
- italic-serif-display: set the headline roman unless the register is truly editorial.
- hero-eyebrow-chip: drop the chip; fold its words into the headline or subhead.
- kicker-above-heading: delete the label; the heading carries itself.
- numbered-section-labels: remove 01/02/03 unless the order is information.
- em-dash-overuse: most dashes become commas, colons or periods.
- marketing-buzzword: the verb and noun for what the product literally does.
- aphoristic-cadence: at most one "X. Not Y." line; write the rest plainly.
- oversized-h1: shorten the headline or set it smaller; the subhead and CTA need the fold too.
- extreme-negative-tracking: no tighter than -0.04em; -0.02 to -0.03em reads best.
- gpt-thin-border-wide-shadow: one elevation, a border or a soft shadow.
- repeating-stripes-gradient: a plain surface or a texture from the subject's world.
- codex-grid-background: no grid unless the surface is a map, canvas or blueprint.
- theater-slop-phrase: say plainly what the thing does or does not do.
- image-hover-transform: images sit still; give the container the hover feedback.

### Quality — fix per rule
- script-error: fix the script first; it can blank the rest of the frame.
- content-hidden-at-rest: visible by default; animate an entrance from visible, never gate it.
- broken-image: a real src (upload_asset) or no <img>.
- buried-raster: let the image show (wash under 0.9 alpha, visible opacity) or remove it.
- organic-clip-path: a cut-out image (transparent PNG/WebP); clip-path only for geometry.
- low-contrast: 4.5:1 body, 3:1 large text; change the token when it repeats.
- gray-on-color: secondary text tinted from the surface hue, or near-white/near-black.
- text-occlusion: move the overlapping layer off the text.
- text-overflow: let it wrap (min-w-0, break-words) or constrain the width.
- first-viewport-column-overflow: balance the opening columns or cap the tall one.
- edge-flush-cards: equal inset on both sides of the scroller.
- clipped-overflow-container: overflow-visible, or move the positioned layer out of the clip.
- line-length: prose max-w-[65ch] to [75ch].
- cramped-padding: 12–16px inside bordered or filled containers.
- body-text-viewport-edge: a container with px-6 or more, or max-w-* mx-auto.
- tight-leading: body leading 1.5–1.7; multi-line headings no tighter than ~1.1.
- heading-rhythm: more space above a heading than below it.
- skipped-heading: levels in order (h1, h2, h3); size with classes, not by skipping a level.
- justified-text: text-left.
- tiny-text: body at least 14px, 16px preferred.
- undersized-ui-text: links, buttons, labels and table text at least 11px (legal print 10px).
- all-caps-body: uppercase only for short labels.
- wide-tracking: body tracking at most 0.05em; wide tracking only on short uppercase labels.
- layout-transition: animate transform and opacity, not width, height, padding or margin.
- repeated-container-text: say it once, where it matters most.
- design-system-color, design-system-radius, design-system-font, design-system-font-size: the
  theme token (bg-<token>, rounded-<token>, font-<token>), or add the value to the theme.
`

export const TOPIC_TYPESET = `## Typeset — a typography pass

Type carries hierarchy and voice. Improve it inside the frame's established look; replacing the
faces is a redesign unless that is what was asked.

**Read the mode.** Persuade surfaces (landing pages, campaigns): display type may carry the
voice, with decisive size contrast and a characterful display face over a quiet body face.
Operate and read surfaces (app screens, dashboards, docs): stability, scanability and measure
come first; one well-tuned family and a fixed role scale are often right.

**Assess first**, on the screenshot and get_frame_outline:
- Roles: heading, body, label, metadata and data tell apart at a glance? Adjacent roles under
  1.25× apart at the same weight are not doing different jobs.
- Scale: a deliberate ramp, or arbitrary sizes? The same role identical across frames?
- Reading: body measure 45–75ch; leading tuned to the face and the width.
- Stress: the longest real headline, a narrow column, a 390-wide variant.

**Set the system in the theme**, not per frame: --font-display and --font-body with
set_theme_fonts and set_theme_tokens, so a change restyles every frame. Use the fewest families
that make the hierarchy unmistakable, and combine size, weight, space and tone instead of
asking size alone to do the work. A second family needs a job only it can do.

**Apply**
- Body 16px on the web (text-base). Dense data roles may go to 14px; functional UI text never
  below 11px.
- Prose max-w-[65ch]; body leading 1.5–1.7, display tighter. Wider lines need more leading.
- Display tracking -0.02em to -0.03em, never past -0.04em. Wide tracking (above 0.05em) only on
  short uppercase labels.
- A one- or two-word headline can be huge; a full-sentence headline sits smaller (about 6rem at
  most) so the fold still holds the subhead and the action.
- Light text on dark grounds: a little more leading, a little more tracking, one weight heavier
  if the face turns thin.
- tabular-nums for numbers in tables and stats. Mono for code, data and measurement only, never
  as a "technical" costume.
- Paragraph rhythm from spacing or a first-line indent, not both. Body left-aligned, never
  justified.
- Load only the weights you use (css2 specs like "Archivo:wght@400;800").
- Reflex faces read as generated: Inter, Roboto, Arial, and the ones the design check calls
  overused (Geist, Fraunces, Space Grotesk, Plus Jakarta Sans). Use one only when the brief or
  the canvas's design system chose it; when a kit handed it to you, swap the token.
- Balance multi-line headings (text-balance) and theme the details: ::selection, link
  underline offset.

**Verify**: screenshot again. Roles read without the copy, long text stays comfortable, and the
Design check has no unexplained type findings (flat-type-hierarchy, tight-leading, line-length,
tiny-text, wide-tracking, extreme-negative-tracking, overused-font). Then "polish".
`

export const TOPIC_LAYOUT = `## Layout — a structure pass

Layout turns priority into reading order, grouping and rhythm. Diagnose the structural problem
before moving boxes, and change structure inside the frame's look, not the look itself.

Persuade surfaces may be asymmetric or disruptive when the direction earns it. Operate and read
surfaces want predictable structure, stable density and a clear linear path.

**Assess** on the screenshot:
- Squint test: with detail blurred, can you still find the primary element, the secondary one
  and the major groups, in order?
- Grouping: related items close, distinct groups apart, or boxes compensating for weak
  proximity?
- Rhythm: tight and generous intervals in deliberate contrast, or one gap everywhere?
- Structure: does the topology fit the content? Are three equal cards genuinely equivalent, or
  a template default?
- Density: information per region matches how often it is used and how hard the decision is.
- Extremes: the longest real copy, empty states, a 390-wide variant.

**Name the thesis before editing**: the primary path, what belongs together, what leads, the
density, and what changes at mobile width.

**Apply**
- Group by meaning; proximity before containers. Cards are for genuinely separate objects,
  not the default wrapper, and never nested.
- Rhythm from contrast: gap-2 to gap-4 inside groups, py-20 to py-32 between sections, more
  space above a heading than below it.
- One spacing scale (Tailwind's 4px steps), no one-off values. gap for sibling rhythm rather
  than margins on children.
- Hierarchy follows product priority, not the framework default: when one item matters more,
  span it, enlarge it or lead with it instead of a third equal column.
- Repeated rows get fixed-width slots for icons and trailing actions, so they form vertical
  lanes.
- Depth only where it clarifies state or hierarchy, and one elevation per surface: a border or
  a soft shadow.
- Responsive is structural: at mobile width reorder, stack or collapse by importance.
  duplicate_frame at 390 wide shows it.
- Touch targets stay at least 44px even when the visible mark is small.
- Optical corrections only after seeing the render. Variation is not a goal; repetition aids
  recognition, so break it only when content or priority changes.

**Verify**: the squint test holds, nothing is clipped or left as dead space, and the Design
check has no unexplained layout findings (monotonous-spacing, nested-cards, heading-rhythm,
cramped-padding, text-overflow, first-viewport-column-overflow, body-text-viewport-edge,
edge-flush-cards). Then "polish".
`

export const TOPIC_COLORIZE = `## Colorize — a color pass

Color carries hierarchy, meaning and atmosphere. Keep confirmed brand colors and semantic
conventions (style guides, the design system, pinned references); a color pass does not replace
the visual world.

Persuade surfaces may let color carry the voice and own large regions. Operate surfaces use it
to encode action, selection, status and wayfinding: rarity gives the accent its force. One
ground and one strong accent stays the default (topic "design-brief").

**Audit first** with get_theme and the screenshot: which colors are brand commitments, the
current roles, where grayscale hides hierarchy or state, contrast failures, meaning carried by
color alone.

**Pick the strategy from the brief's mood**: temperature, the dominant relationship and how
much color. Never a category default (blue for finance, green for health).

**Build roles as theme tokens** (set_theme_tokens) so every frame follows: surface and raised
surface, primary and secondary text, accent (action, focus, selection), line, then success,
warning, error and info, and data series if needed. Kits already name --surface, --surface-2,
--ink, --ink-2, --ink-3, --line, --accent and --on-accent; add semantic roles beside them.

**Apply**
- Let the strongest color own a deliberate region or role rather than scattering small
  accents. Don't spend the primary action's color on decoration.
- Tint neutrals toward the brand hue only when it adds cohesion; neutral gray is valid.
- On a colored surface, derive secondary text from that hue or the foreground, never generic
  gray.
- Data: separate series by lightness, shape or label as well as hue.
- Dark mode is designed, not inverted: raised layers get lighter, accents may need less
  chroma. A dark variant is duplicate_frame plus token edits.
- New palettes in OKLCH (oklch() works in tokens): step lightness, lower chroma near white and
  black.
- Prefer explicit colors to stacked translucent overlays; alpha makes contrast depend on
  whatever sits underneath.
- No gradient text, colored glows, purple/violet or cyan-on-dark AI palettes, or a reflex cream
  ground.

**Contrast** (WCAG AA): body 4.5:1, large text 3:1, controls, icons and focus rings 3:1. Check
hover and disabled states, text on images, and both themes.

**Verify**: every color has a role, attention lands on the intended action, the result reads as
this product rather than "colorful", and the Design check is clear of low-contrast,
gray-on-color, ai-color-palette, cream-palette, dark-glow and design-system-color. Then
"polish".
`

export const TOPIC_POLISH = `## Polish — the finishing pass

Polish is refinement, never a concealed redesign. Keep the frame's look, content and everything
outside scope. If the concept itself is wrong, say so and propose a redesign instead of
smuggling one in.

**1. Establish the system.** Read the theme (get_theme), style guides, components and the
neighboring frames. Classify each drift before fixing it:
- missing token: the value repeats, so add it to the theme (set_theme_tokens);
- one-off: a component already owns the pattern, so use the instance;
- conceptual mismatch: hierarchy or flow differs from comparable frames;
- local defect: simply incomplete or inconsistent, so edit_frame_html.
Fix at the narrowest correct level.

**2. Gather evidence.** A whole-frame get_frame_screenshot (its Design check is defect evidence,
not proof of quality), audit_frame for the full list, selector crops only where a detail is
unclear. For a flow, check every frame in it, not just the one in front of you.

**3. Triage**, in this order:
1. broken or misleading: script errors, hidden content, broken images, unreadable contrast,
   clipped text;
2. missing states the flow will show: empty, loading, error, success, disabled;
3. hierarchy, mobile width and design-system drift;
4. visual and motion inconsistencies;
5. cleanup: dead CSS, one-off values, duplicated styles.
Don't perfect one corner while the rest sits below the same bar.

**4. The pass**
- Layout and type: align to the spacing scale, fix optical alignment too, give the same role the
  same style across frames, and check wrapping with the longest real copy.
- Color and imagery: tokens, not literals; contrast in every state; one icon family, stroke and
  size; images at their real aspect ratio with useful alt text.
- Interaction: every control shows default, hover, focus-visible and disabled; touch targets at
  least 44px. Motion is one authored moment, ease-out, from an already-visible state, on
  transform and opacity.
- Browser surfaces: theme ::selection, caret-color, focus rings, link underline offset and
  scrollbars from the palette. Defaults left here are the cheapest tell that a page was
  assembled, not built.
- Copy: consistent terms, capitalization and punctuation; controls name their action; errors
  name the problem and the recovery. Ask before changing factual claims.

**5. Verify and finish.** Screenshot again, check the mobile variant if one exists, and confirm
the Design check has no unexplained findings. Remove what the pass made redundant. Done when
the whole flow meets one bar.
`

export const TOPIC_CRITIQUE = `## Critique — a structured design review

For when a human asks what is wrong with a frame (yours, another agent's, an imported page),
before a redesign, or to choose between directions. The review is the deliverable; fix only
what you are asked to.

Two passes, kept apart:
A. **Your judgment first**: get_frame_screenshot and get_frame_outline, before reading any
   detector output, so findings do not anchor you.
B. **The detector**: audit_frame. Then combine them: where they agree, what the detector caught
   that you missed, and its false positives, with why.

**What pass A judges**
- Specificity, first: is the design grounded in this product, or could an unrelated product use
  it unchanged?
- Hierarchy, grouping, type, color, states, copy and edge cases.
- Cognitive load: one primary focus; groups of 4 or fewer; at most 4 visible options at a
  decision (1 primary action, 1–2 secondary, the rest in a menu; 5 top-level nav items at
  most); nothing to remember from another screen; complexity disclosed when needed.
- Emotional journey: the peak and the end of the flow, and reassurance at high-stakes moments
  (pay, delete, submit).
- Nielsen's 10 heuristics, 0–4 each: system status, match to the real world, user control,
  consistency, error prevention, recognition over recall, flexibility, minimalist design, error
  recovery, help. Mark one n/a when it cannot apply (a landing page rarely needs flexibility or
  help) and total against the applicable maximum. A 4 is genuinely excellent; most real
  interfaces land between 50% and 80%.
- Personas: walk the primary action as 2–3 of a power user (keyboard, speed), a first-timer
  (jargon, hidden navigation), an accessibility-dependent user (contrast, focus, labels), a
  stress tester (long names, empty data, errors) and a distracted mobile user (thumb reach,
  interruptions). Landing pages: first-timer, stress tester, mobile. Dashboards: power user,
  accessibility.

**Report** in your reply (or reply_to_comment when the request came as a comment), scannable:
- The specificity verdict, then the overall impression: what works, what doesn't, the single
  biggest opportunity.
- 2–3 strengths, specific about why they work.
- 3–5 priority issues, each tagged P0–P3 with what, why it matters, the concrete fix and the
  pass that addresses it ("typeset", "layout", "colorize", "polish", "design-review"). P0 blocks
  the task, P1 causes real difficulty or fails WCAG AA, P2 is an annoyance with a workaround, P3
  is polish. Unsure? If a user would contact support about it, it is at least P1.
- Persona red flags: the exact elements that fail each persona.
- One or two questions that could unlock a better design ("What would a confident version of
  this look like?").
Be direct: vague feedback wastes everyone's time. Never report a detector finding you have not
checked on the screenshot.
`
