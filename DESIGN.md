---
name: nexttupp
description: Search any film or series and watch it in the browser; the artwork is the interface.
colors:
  projection-black: "#0a0a0b"
  raised-graphite: "#131315"
  lifted-graphite: "#1b1b1e"
  hairline: "rgb(255 255 255 / 0.08)"
  hairline-strong: "rgb(255 255 255 / 0.16)"
  screen-white: "#f5f5f7"
  silver-text: "#b4b4bb"
  ash-text: "#8d8d95"
  action-white: "#ffffff"
  ink-on-light: "#0a0a0b"
  true-black: "#000000"
  healthy-swarm: "#46d18a"
  thin-swarm: "#f0bf4c"
  dying-swarm: "#ff6a5c"
typography:
  title-card:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 5vw, 5rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.035em"
    fontVariation: "'wdth' 125"
  wordmark:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.045em"
    fontVariation: "'wdth' 125"
  headline:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112.5"
  title:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112.5"
  title-compact:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112.5"
  player-title:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.25rem, 2.2vw, 2rem)"
    fontWeight: 720
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112.5"
  subtitle-cue:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 2.5vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 440
    lineHeight: 1.5
  synopsis:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 440
    lineHeight: 1.6
  label:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.35
  meta:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 440
    lineHeight: 1.4
  caption:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.35
  micro:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "0.01em"
  clock:
    fontFamily: "Mona Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    fontFeature: "'tnum' 1"
rounded:
  hairline-label: "0.25rem"
  tag: "0.375rem"
  art: "0.625rem"
  list-item: "0.75rem"
  panel: "1.125rem"
  pill: "999px"
spacing:
  gutter: "clamp(1rem, 4vw, 4.5rem)"
  action-gap: "0.75rem"
  card-gap: "clamp(0.625rem, 1vw, 1rem)"
  shelf-gap: "clamp(1.75rem, 4vh, 2.75rem)"
components:
  button-primary:
    backgroundColor: "{colors.action-white}"
    textColor: "{colors.ink-on-light}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "3rem"
    padding: "0 1.625rem 0 1.375rem"
  button-secondary:
    backgroundColor: "rgb(255 255 255 / 0.14)"
    textColor: "{colors.screen-white}"
    rounded: "{rounded.pill}"
    height: "3rem"
    padding: "0 1.375rem"
  round-button:
    backgroundColor: "rgb(255 255 255 / 0.1)"
    textColor: "{colors.screen-white}"
    rounded: "{rounded.pill}"
    size: "3rem"
  round-button-pressed:
    backgroundColor: "{colors.action-white}"
    textColor: "{colors.ink-on-light}"
    rounded: "{rounded.pill}"
    size: "3rem"
  chip:
    backgroundColor: "rgb(255 255 255 / 0.07)"
    textColor: "{colors.silver-text}"
    rounded: "{rounded.pill}"
    height: "2.25rem"
    padding: "0 0.875rem"
  chip-active:
    backgroundColor: "{colors.action-white}"
    textColor: "{colors.ink-on-light}"
    rounded: "{rounded.pill}"
    height: "2.25rem"
  search-field:
    backgroundColor: "rgb(255 255 255 / 0.1)"
    textColor: "{colors.screen-white}"
    rounded: "{rounded.pill}"
    height: "2.75rem"
  poster-card:
    backgroundColor: "{colors.raised-graphite}"
    rounded: "{rounded.art}"
  player-panel:
    backgroundColor: "rgb(24 24 27 / 0.84)"
    textColor: "{colors.screen-white}"
    rounded: "{rounded.panel}"
    width: "min(24rem, calc(100vw - 2rem))"
---

# Design System: nexttupp

## Overview

**Creative North Star: "The Projection Room"**

The room goes dark and the film's own artwork does the talking. nexttupp plays the streaming canon straight,
at the finish of the Apple TV app, Netflix, Mubi and A24: full-bleed backdrops, the title's own logo art set
large, one white action, and chrome that is only black, white and grey. Colour belongs to the artwork. The
interface adds hierarchy, spacing and restraint, never ornament.

Density changes by job. Browsing surfaces (Home, the title hero) are cinematic and spacious. The source table
is the one dense, data-bearing surface, and it stays calm through alignment, hairlines and greys. The player
recedes completely until it is needed.

The whole interface scales with the screen: the root size is fluid from 16px at laptop width to about 18.5px
at 1920px, so a 1080p TV reads from the sofa without a separate layout.

**Key Characteristics:**
- Projection-room black ground, lifted graphite surfaces, white as the only action colour.
- Artwork-first: backdrops, posters and logo art carry every colour on screen.
- One typeface, Mona Sans, in two widths: Expanded for titling, standard width for interface.
- Pill actions, 10px-radius artwork with a 1px inner hairline.
- Restrained motion: fades, a slow backdrop settle, small focus lifts.

## Colors

A neutral near-black world with white actions; hue appears only in artwork and in swarm health.

### Primary
- **Action White** (#ffffff): the primary button, the active filter chip, the active season tab, the pressed
  round button, the focus ring, the scrubber fill. It is the only action colour.

### Neutral
- **Projection Black** (#0a0a0b): the page ground and the base of every scrim and gradient.
- **Raised Graphite** (#131315): artwork placeholders and skeletons before images decode.
- **Lifted Graphite** (#1b1b1e): the hovered or recommended source row and other lifted surfaces.
- **Hairline** (8% white) and **Strong Hairline** (16% white): rules, inner card edges and keyboard-hint
  outlines.
- **Screen White** (#f5f5f7): primary text.
- **Silver** (#b4b4bb): secondary text, synopsis meta, honest notes such as "Plays without conversion".
- **Ash** (#8d8d95): tertiary text: years, separators, column headers, indexer names.
- **Ink on Light** (#0a0a0b): text and icons on white actions.
- **True Black** (#000000): the player's field and its scrims, so letterboxing is real black; black at
  35–95% opacity is also the shadow and scrim colour over artwork.

### State
- **Healthy Swarm** (#46d18a), **Thin Swarm** (#f0bf4c), **Dying Swarm** (#ff6a5c): the seeders dot and the
  live-tracker dot. Amber also marks honest playback warnings ("Large, likely to buffer"); red also fills the
  destructive Delete chip.

### Named Rules
**The Artwork Owns Colour Rule.** Chrome is black, white and grey. Green, amber and red appear only as swarm
health, honest playback warnings, and a destructive confirmation. Nothing is green because it is good news.

**The One White Action Rule.** Each screen has one filled white action (More info, Play). Everything else is a
translucent pill, a ring, or plain text.

## Typography

**Display Font:** Mona Sans Expanded (wdth 125), self-hosted variable woff2
**Body Font:** Mona Sans (wdth 100, optical size axis on), same file
**Fallback:** ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif

**Character:** One superfamily in two voices, the way Apple pairs SF Pro Display with Text and Netflix runs one
house sans. The Expanded heavy cuts read as a title card. The standard width is neutral, open and quiet
enough to sit under artwork.

**Why Mona Sans.** It replaced Instrument Serif and Geist. It is licensed under the SIL Open Font License 1.1
(Reserved Font Name "Mona"), so self-hosting is allowed. The file ships unmodified, so the name does not need
to change, and the licence sits beside it at `web/public/fonts/OFL.txt`.
- **One file covers every role.** It is a single variable file with width 75–125, weight 200–900 and an
  optical size axis, so the wordmark, title cards and the whole UI come from one download.
- **The width axis is the signature.** At 125/800 the wordmark's two t's share one crossbar, which no
  fixed-width family could give.
- **Alternatives rejected:**
  - Switzer (Fontshare) was clean but anonymous at display sizes.
  - Archivo has a width axis, but its text weights are more mechanical.
  - Serif display pairings read as editorial, not cinematic.
- **Open item.** The impeccable detector lists Mona Sans as an overused face. That finding stands, and the
  owner has not yet confirmed the choice.

### Hierarchy
- **Title card** (800, wdth 125, clamp(2.5rem, 5vw, 5rem), 0.98): the title's name, only when its logo art is
  missing. Logo art is the normal title display.
- **Wordmark** (800, wdth 125, 1.5rem, -0.045em): the brand, top left.
- **Headline** (700, wdth 112.5, 1.5rem, 1.2): page and section heads (Results, Episodes, Sources).
- **Title** (700, wdth 112.5, 1.25rem, 1.2): row heads. **Title compact** (1.125rem) is the same role on phone
  and for empty-state titles.
- **Player title** (720, wdth 112.5, clamp(1.25rem, 2.2vw, 2rem)): the film or series name in the player.
- **Subtitle cue** (600, clamp(1.125rem, 2.5vw, 2.5rem), 1.35): white on a 55% black box.
- **Body** (440, 1rem, 1.5): interface text. **Synopsis** (440, 1.0625rem, 1.6, max 52ch) on heroes.
- **Label** (580–620, 0.875–1rem): buttons, chips, tabs, card names.
- **Meta** (440, 0.8125rem): years, file names, source facts.
- **Caption** (600–620, 0.75rem): column headers, key hints, a card's reason line.
- **Micro** (650–800, 0.6875rem, +0.01em): badges and tags (Recommended, Series, IMDb, Matches release).
  This is the floor; nothing functional is set smaller.

### Named Rules
**The Two Widths Rule.** Expanded is for the brand and for titling. Standard width is for everything you read
or press. Never set body copy, buttons or tables in Expanded.

**The Ticking Figures Rule.** Tabular figures appear only on running clocks (the player time, the scrubber
tip, the subtitle offset). Static numbers use the face's proportional figures, because its tabular set reads
as code.

## Layout

- **Gutter and columns.** One fluid gutter (clamp(1rem, 4vw, 4.5rem)) aligns every screen's left edge: the
  wordmark, the billboard copy, row heads and the first card of each row. Rows are horizontal scrollers that
  bleed to the screen edge. Their first card snaps to the gutter and the next card peeks into the right
  gutter.
- **Episode rows** fit exactly N stills inside the gutters: 5 at 1700px and wider, 4 by default, 3 at 1100px
  and below, 2 at 820px and below, 78vw on phone.
- **Home.** A full-bleed billboard at max(32rem, min(86svh, 52vw)). The first shelf rises 7.5rem into its
  lower edge. On phone the billboard becomes a centred 2:3 poster card with meta and one action beneath.
- **Title.** The backdrop hero fills about 94svh, with copy in a 42rem column on the left. On phone the
  backdrop sits on top at 4:3.3 and the copy overlaps it.
- **Watch.** Full black. The chrome is a bottom stack: title, scrubber, then two control groups. On coarse
  pointers and on phone, large centre controls appear and panels become bottom sheets.
- **Breakpoints:** 640px (phone), 900px (the source table stacks), 1800px (TV: thicker focus rings, more
  caption clearance).

## Elevation & Depth

Depth comes from the artwork and from scrims, not from cards. Surfaces are flat at rest. Shadows appear only
in three places:
- under artwork that has lifted on hover or focus;
- under floating player surfaces (panels, toasts, the scrubber tip);
- under the phone billboard card.

Glass (backdrop blur) is used only on controls that sit over imagery: the solid masthead, the search field,
round buttons and player panels.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 1.25rem 2.5rem -1rem rgb(0 0 0 / 0.85)`): a poster or episode still on hover or focus.
- **Float** (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1), 0 1.5rem 3.5rem -1.25rem rgb(0 0 0 / 0.85)`): player panels.
- **Hairline edge** (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.07)`): every piece of artwork at rest.

### Named Rules
**The Scrim Not Card Rule.** Text over artwork is made legible with gradients from Projection Black, never by
boxing it in a card.

## Shapes

Artwork has gently rounded corners (10px) and a 1px inner hairline, so dark posters still read as objects
on a dark ground. Every action is a full pill or a circle. Panels and the player's status card round at 18px,
and the items inside a panel at 12px. Small labels use 4px (the IMDb badge) or 6px (the "/" key hint, the
Series tag, the scrubber time tip).

## Components

### Buttons
- **Shape:** full pill (999px), 3rem tall; the icon sits before the label.
- **Primary:** Action White with Ink on Light text, weight 620. Hover drops to 84% white; press scales to 0.97.
  While busy it shows a spinner with a progress label ("Finding sources…").
- **Secondary:** 14% white with Screen White text.
- **Round buttons:** 3rem circles, 10% white with a 24% white inner ring. The pressed state turns solid white.
  The hero action group is a wrapping row with room for two of these beside Play.
- **Icon buttons (player):** 2.75rem, transparent until hover. A small dot under the icon marks "on"; a
  translucent fill marks the open panel.

### Chips and tabs
- **Style:** 2.25rem pills, 7% white with Silver text. A count follows the label at 60% opacity.
- **State:** the active chip or tab is solid white with Ink text. The destructive chip is Dying Swarm red.

### Cards
- **Poster:** 2:3 art with the art radius and hairline edge, then the name (label) and year (meta). An optional
  one-line caption (meta, Ash) can carry a reason such as "Because you liked X". Focus or hover lifts the art
  1.04 with a white ring.
- **Landscape (downloads, episodes):** 16:9 art. Downloads carry an inset progress bar and a centred play
  disc. Episodes carry number, name and a two-line overview; the active episode gets a 2px white inner
  stroke.

### Inputs / Fields
- **Search:** a pill field, 10% white glass with a 14% white inner ring and a leading search icon. Focus
  deepens to near-opaque graphite with a 55% white ring. A "/" key hint shows for mouse users, and a clear
  button appears once there is text.

### Navigation
- **Masthead:** the wordmark left and search right, floating over the billboard on a soft top scrim. It turns
  into a blurred Projection Black veil with a hairline once the page scrolls.
- **Title and Watch:** a round back button; the Title page also shows the wordmark.

### Source table (signature)
- **Layout:** a grid of Quality, Release, Size, Seeds, Peers and Indexer. Release names wrap at their dots.
  Seeds show a health dot in a fixed slot, so the dots form one vertical line.
- **Default view:** the top eight ranked rows, behind "Show all N sources". The recommended row sits on Lifted
  Graphite with a white "Recommended" badge.
- **Phone:** each row stacks into a card with units spelled out ("32 seeds").

### Player
- **Chrome:** the title in title style with the file name in meta beneath, a hairline scrubber that thickens
  on hover with a time tip, and two control groups.
- **Panels:** subtitles, audio and info open as anchored glass panels: a title row with a close button, then
  items with a check for the active one.
- **Connecting state:** a centred logo, an indeterminate hairline loader, the step name and its detail, over a
  dimmed backdrop.

## Do's and Don'ts

### Do:
- **Do** let artwork carry colour: full-bleed backdrops, logo art cropped to its mark, posters at 2:3.
- **Do** keep one white filled action per screen and make everything else translucent.
- **Do** align every screen's left edge to the gutter (clamp(1rem, 4vw, 4.5rem)).
- **Do** give every focusable element a visible white ring. Use 3–4px rings on screens 1800px and wider.
- **Do** honour reduced motion: no backdrop settle, no hover lift.

### Don't:
- **Don't** add accent colours, gradient text, glows or coloured buttons; white is the only action colour.
- **Don't** use green, amber or red for anything but swarm health, honest playback warnings and destructive
  confirmation.
- **Don't** set body text, buttons or tables in Mona Sans Expanded.
- **Don't** put small labels or kickers above headings; meta sits below the title art.
- **Don't** show invented data. Every number and image comes from Cinemeta, metahub, trackers or the server.
