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
large, one action in the profile's action colour (white unless they pick another), and chrome that is only
black, white and grey. Colour belongs to the artwork. The
interface adds hierarchy, spacing and restraint, never ornament.

Density changes by job. Browsing surfaces (Home, the title hero) are cinematic and spacious. The source table
is the one dense, data-bearing surface, and it stays calm through alignment, hairlines and greys. The player
recedes completely until it is needed.

The whole interface scales with the screen: the root size is fluid from 16px at laptop width to about 18.5px
at 1920px, so a 1080p TV reads from the sofa without a separate layout.

**Key Characteristics:**
- Projection-room black ground, lifted graphite surfaces, one action colour: white, or the profile's pick.
- Artwork-first: backdrops, posters and logo art carry every colour on screen.
- One typeface, Mona Sans, in two widths: Expanded for titling, standard width for interface.
- Pill actions, 10px-radius artwork with a 1px inner hairline.
- Restrained motion: fades, a slow backdrop settle, small focus lifts.

## Colors

A neutral near-black world with one action colour; hue appears only in artwork, swarm health and that colour.

### Primary
- **Action** (`--accent`, Action White #ffffff by default): the primary button, the active filter chip, the
  active season tab, the pressed round button, the scrubber fill and meters. It is the only action colour.
  In Appearance a profile can swap it for one of five soft tints: Sun #ffd166, Peach #ffb48a, Mint #7ee2b8,
  Sky #8ecbff, Lilac #c8b4ff, or any colour they pick. A pick too dark for Ink on Light text is lightened towards
  white until its luminance reaches 0.3 (`web/src/colour.ts`), with a note saying so. The focus ring stays white.

### Neutral
- **Projection Black** (#0a0a0b): the page ground and the base of every scrim and gradient.
  - The ground, Raised and Lifted Graphite come as a set (`--theme-bg`, `--bg-1`, `--bg-2`), so a profile can
    pick another near-black family: True black #000, Midnight #080b12, Espresso #0f0b09, Forest #08100c or
    Plum #0e0a10.
  - Every family stays near black. There is no light theme: the chrome's whites and greys assume a dark ground.
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
**The Artwork Owns Colour Rule.** Chrome is black, white and grey, plus the one action colour. Green, amber
and red appear only as swarm health, honest warnings (playback, a firewall or VPN keeping phones out), and a
destructive confirmation. Nothing is green because it is good news. A Mint or Sun action colour is the
profile's choice of action colour, not a state.

**The One Action Rule.** Each screen has one filled action in the action colour (More info, Play). Everything
else is a translucent pill, a ring, or plain text. The bottom-left banner is the exception: it floats over the
page with its own single filled action ("Get the update"), because it's the most urgent thing on any screen.

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
- **Primary:** the action colour with Ink on Light text, weight 620. Hover drops it to 84%; press scales to 0.97.
  While busy it shows a spinner with a progress label ("Finding sources…").
- **Secondary:** 14% white with Screen White text.
- **Round buttons:** 3rem circles, 10% white with a 24% white inner ring. The pressed state turns solid white.
  The hero action group is a wrapping row with room for two of these beside Play.
- **Links:** in running text, `.inline-link`: Screen White with a hairline underline that firms on hover
  ("terms", "Show all", "Read the terms"). The 14% white `.link` pill is only for an action in a toast or a
  banner ("Undo", "Release page", "Later").
- **Icon buttons (player):** 2.75rem, transparent until hover. A small dot under the icon marks "on"; a
  translucent fill marks the open panel.

### Chips and tabs
- **Style:** 2.25rem pills, 7% white with Silver text. A count follows the label at 60% opacity.
- **State:** the active chip or tab is solid in the action colour with Ink text. The destructive chip is Dying Swarm red.

### Cards
- **Poster:** 2:3 art with the art radius and hairline edge, then the name (label) and year (meta). An optional
  caption (meta, Ash, up to two lines) carries the reason, such as "Because you liked X"; every recommended
  title shows one, and the year is dropped when the reason already ends with it. Focus or hover lifts the art
  1.04 with a white ring.
- **Card remove ("Not interested"):** a small round X beside the name, under the art, never over it, so a
  remote's Down reaches it and Left/Right still move between posters. Mouse users see it on hover or focus;
  touch and TV always see it. Removing shows a snackbar with Undo.
- **Rate card (getting started):** a poster with Like and Dislike round buttons under it. The chosen button
  turns solid white; a rated card dims its art and shows a small white thumb badge on it. Progress is a segmented meter in
  the row heading ("1 of 3 likes").
- **Landscape (downloads, episodes, continue watching):** 16:9 art. Downloads and Continue watching carry an
  inset progress bar and a centred play disc; Continue watching's status line is the episode and time left.
  Episodes carry number, name and a two-line overview; the active episode gets a 2px white inner stroke.

### Inputs / Fields
- **Search:** a pill field, 10% white glass with a 14% white inner ring and a leading search icon. Focus
  deepens to near-opaque graphite with a 55% white ring. A "/" key hint shows for mouse users, and a clear
  button appears once there is text.

### Navigation
- **Masthead:** the wordmark left and search right, floating over the billboard on a soft top scrim. It turns
  into a blurred Projection Black veil with a hairline once the page scrolls. Six tabs: Home, Films, Series,
  Music, My List, Downloads. My List and Downloads have no search, only the profile button. On phones the tabs
  are their own full-width row at 0.875rem; a narrower screen scrolls the row, with the current tab kept in
  view.
- **Title and Watch:** a round back button; the Title page also shows the wordmark.
- **Profile button and menu:** a 2.75rem avatar (the profile's initial on one of five neutral grey gradients,
  from graphite to silver, never a hue) at the masthead's end. It opens a glass menu: the profiles with a check on the active one,
  a hairline, then "Your taste", "AI settings", "Manage profiles", "Account", "Storage" and, on the computer,
  "Watch on your phone" (to Account's phones section) or, on a phone, "Switch computer" (to nexttupp.com/watch).
  Arrow keys, Home/End and Escape work as in any menu.
- **Watch on your phone (Account):** the phones switch, then a QR code for nexttupp.com/watch on a white
  8.25rem tile beside the address in words. The tile is the one white surface allowed that isn't an action:
  a camera needs the contrast. Shown only while phones are on.
- **Who's watching:** large avatar tiles centred on Projection Black, the title in Mona Sans Expanded. Shown
  only when there is more than one profile. Manage mode adds a pencil to each tile and an inline form; delete
  asks again with a red chip, and the last profile can't be deleted.

### Tab pages (My List, Downloads)
- **Head:** the page name in the account title style (Expanded 700), with one plain line of facts under it
  ("3 titles · 135 GB free on this computer"). Page-wide actions sit at the head's far end as chips (Pause all
  / Resume all, Open folder).
- **My List:** the poster grid. Each card's remove (X) takes the title off the list with Undo, so the list
  toggle is left off these cards (on Home's My List row too).
- **Downloads:** one list at a 60rem measure, so a row's actions stay near its title on a TV.
  - Each row: 16:9 art that plays the download (play disc, inset progress bar), the title, and a status line
    ("42% of 2.6 GB · 6.1 MB/s · 4 min left", "Paused · 17% of 2.0 GB", "Ready to watch offline").
  - A finished row's status ends with how long it stays: "Kept 23 more days" or "Kept forever".
  - Actions: a Pause icon button, or a labelled Resume chip on a paused row; a Pin toggle, "Keep forever"
    (filled and white when on); Delete asks again in place with a red chip.
  - A footer line says when downloads go, shows the pin, and links to Storage.
- **Empty states:** a bold line, one sentence naming the real control (drawn as its icon, never a typed
  glyph), and a secondary pill to go and find something.

### The phone app (nexttupp.com/watch)

- One column, one heading that says the state ("Watch from Living room laptop.", "Pick your computer.",
  "Can’t reach nexttupp right now."), and one white button for what to do next. The page can't know
  whether a computer is on (computers don't check in), so it never claims "ready"; Connect finds out.
- A second way in sits under a hairline as a secondary button, for example "Open <computer>" under the
  sign-in form when the phone was signed out.
- "Add to home screen" is the last thing on the page: a small line in the quietest grey and a small
  secondary button. It appears on phones only, never inside the installed app.

### Sign-in (nexttupp.com/account, /watch, and the app's Account)
- **One form for signing in and creating an account:** an email, then the 6-digit code sent to it. No
  password, no Sign in / Create account tabs. The website's create mode (/account#create) only adds an optional
  name.
- **Step 1:** the Email field and one white "Email me a code".
- **Step 2:** "We sent a code to <email>. It works for 10 minutes." (the address in Screen White at 620), the
  Code field (1.5rem, 620, 0.3em tracking, proportional figures), and a white Continue. Six digits typed or
  pasted sign in at once. A wrong code stays selected under "That code isn’t right. 4 tries left.", so the
  next one replaces it.
- **Quiet ways out, as text links, never pills:** "Nothing yet? Check your spam folder, or send a new code."
  (busy text on the link itself), then "Use a different email". The page's intro ("We’ll email you a code…")
  hides on step 2.
- **Errors** are Screen White at 560–620 on both surfaces, never red: red is only for destructive actions.
- **Terms:** a fine-print line under the first step's button, "By continuing, you agree to the terms" (inline
  link). The app's Account page ends with a hairline footer: "nexttupp hosts no films or music: what you play
  is your call. Terms of use".

### Storage page
- **Shape:** one reading column at 40rem, like Account.
  - Disk space first: "135 GB free of 641 GB" over a hairline meter, with a legend for nexttupp, other files and
    free space.
  - Then "On this computer": one row per kind of content (Downloads, Watched and streamed, Music, Trailers,
    nexttupp). Each row has a swatch, a name, a size ("Empty" in Ash when there's nothing), one line on what it
    is and when it goes, and its Clear chip.
  - A row with items opens (chevron) into a hairline list of titles with their size and a Delete chip.
  - Then the download folder: the path, and Open / Change chips.
- **Greys only:** each kind of content has its own white alpha (96, 70, 50, 34 and 22%), the same in the
  meter and on its swatch. Other files are 13% white; free space is an empty track with a hairline ring.
- **Deleting:** every Clear or Delete all asks again in place ("Delete 4.9 GB of cache? Downloads stay.") with a
  red chip and Cancel. A toast says what was freed. "Clear cache" (top of the list) clears everything except
  downloads.
- No filled white action: nothing on this page is the screen's main act.

### Feedback
- **Bottom-left banner:** a glass card (icon, title, one line, actions) that floats over every page. One shows at
  a time, in this order:
  1. a desktop update downloading or ready;
  2. **Update needed**, when the cloud says this version is too old to sync: "Get the update" (filled) and
     "Later", which hides it until the app starts again;
  3. the cloud's one-line notice (megaphone icon, a Dismiss ×), gone once dismissed;
  4. on Home, **Phones can't reach this computer** (Windows Firewall, with "Let phones in") or **Your VPN may
     keep phones out**, dismissible.
- **Snackbar:** one at a time, bottom centre, glass with an optional white text action ("Undo"). It lasts 7 s
  with an action and 4 s without. Every removal ("Not interested", "Remove from My List") offers Undo.

### Taste page
- **Shape:** one reading column. A sentence in title style says what nexttupp thinks you like, with one quiet
  line on how picks are made. Then "You lean towards" and "You're less keen on" as feature rows (label, kind,
  "From X, Y and Z") with More / Never chips and Reset, then your ratings and what you've watched, each with
  Undo or Forget. No toggles, sliders or scores.

### Source table (signature)
- **Layout:** a grid of Quality, Release, Size, Seeds, Peers and Indexer. Release names wrap at their dots.
  Seeds show a health dot in a fixed slot, so the dots form one vertical line.
- **Default view:** the top eight ranked rows, behind "Show all N sources". The recommended row sits on Lifted
  Graphite with a white "Recommended" badge.
- **Phone:** each row stacks into a card with units spelled out ("32 seeds").
- **Play, Download and Preview:** every row shows its Play disc (a 16% white ring that fills white when the row
  is pointed at or focused), then Download and Preview (an eye) rings to its left. The whole row plays too. On
  phones Play sits top right, Download under it, and Preview bottom left, under the quality badge.

### Ratings
- **On a poster:** the meta line reads "1995 · IMDb 8.3" in Ash. There are no stars or yellow badges: the number
  is enough.
- **The rating filter:** an "IMDb" pill in the masthead, before the profile menu (on phones, at the start of the
  right-hand group).
  - With a minimum set, it reads "IMDb 7+", filled in the action colour.
  - Its menu has a quiet "Show titles rated" heading and radio items (Any rating, 6+, 7+, 8+) with a check.
  - The minimum is per profile on this device.
- **Filtered search** ends its heading with a Silver line: "25 more below IMDb 7 or without a rating. Show all".
  "Show all" is an inline link.
- **Recommendation rows and Popular** drop titles under the minimum silently. Continue watching, My List and
  the rating onboarding never filter.

### Terms page (nexttupp.com/terms)
- The join page's narrow reading column. A display title "Terms of use.", a Silver short version, and the date
  in Ash at 0.875rem.
- Sections are h2s set off by hairlines. Body and list text in Silver at a 1.65 line height. Disc lists have Ash
  markers. Links are inline.
- The footer of every site page links Terms.

### Before you play
- **The Preview dialog's card, once per browser,** before the first play, download or quick look of a source.
  - The title is "Before you play", followed by two Silver paragraphs: where sources come from, and whose call
    it is.
  - Actions: "I understand" (filled), "Not now" (secondary) and "Read the terms" (inline link).
  - Esc or a click outside counts as Not now.

### Appearance (per profile, from the profile menu)
- **The settings page column:**
  - **Themes:** six preset tiles (Projection room, Lights out, Midnight, Matinee, Greenroom, Velvet). Each
    tile is a miniature of its ground, two graphite cards and an action-colour pill. The picked one gets a
    2px action-colour ring and a check after its name.
  - **Colour:** two rows of 2.75rem round swatches, for the action colour and the background family. The action
    row ends with a rainbow swatch, "Your own colour", that opens the system colour picker. The
    picked swatch gets a white ring set off by a ground-coloured gap. A sample strip on Raised Graphite
    shows a primary button, an active chip and a meter.
  - **Text and shapes:** chips for text size (92%, 100%, 110%, 122% of the fluid root) and poster corners
    (3px, 10px, 18px).
  - **Motion and colour from artwork:** switches. **Calm motion** stops slides, fades and hover lifts.
    **Tint title pages** turns the artwork-colour wash on or off.
- **Every change shows at once.** "Back to the default look" is secondary, and disabled at the default.
- **The look is per profile on this device.** It's applied before the first paint and again on switching
  profile.

### Phones settings: Windows Firewall
- A VPN that's on gets its own amber note, naming it: "NordVPN is on, and most VPNs keep phones out…", then
  where to turn on LAN access.
- When Windows Firewall keeps phones out, the Phones section shows one amber note under the switch, then a
  secondary "Let phones in" button. While Windows' prompt is up, the button reads "Choose Yes in Windows' prompt…".
  If it doesn't take, the note gives the manual path. When phones can get in, nothing shows.

### Source quick look (Preview)
- **Purpose:** judge a file in seconds, before playing it. It uses the Quick view's dialog and card, at 60rem.
- **Stage:** one large still at the film's own shape, on black. "Play 20 seconds" (Stop, with a filled square,
  while it plays) and the time sit bottom left on dark 72% pills, so they stay readable over bright frames. The
  stage stops at half the window's height, so Play this stays in view on a laptop. While the clip plays, a 3px white line along the
  bottom fills over its 20 seconds.
- **Strip:** six 16:9 stills from 10% to 80% of the film, at 62% opacity, full on hover. The picked still gets a
  2px white ring. They pulse while loading. On phones they sit three to a row.
- **Facts:** a two-column definition list (Picture, Bitrate, Sound, Subtitles). Labels are Text 3, values Text.
  Warnings use the amber note style. One quiet hint says to pick a still with people talking. Then the white
  Play this button and the secondary Download.

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
- **Do** keep one filled action per screen, in the action colour, and make everything else translucent.
- **Do** align every screen's left edge to the gutter (clamp(1rem, 4vw, 4.5rem)).
- **Do** give every focusable element a visible white ring. Use 3–4px rings on screens 1800px and wider.
- **Do** honour reduced motion and the profile's Calm motion: no backdrop settle, no hover lift, no slides.

### Don't:
- **Don't** add a second action colour, gradient text or glows. The one action colour is white or the
  profile's pick, and nothing else is filled with it.
- **Don't** use green, amber or red as states for anything but swarm health, honest warnings and destructive
  confirmation.
- **Don't** set body text, buttons or tables in Mona Sans Expanded.
- **Don't** put small labels or kickers above headings; meta sits below the title art.
- **Don't** show invented data. Every number and image comes from Cinemeta, metahub, trackers or the server.
