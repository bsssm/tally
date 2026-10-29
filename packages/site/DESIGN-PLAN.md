# Tally landing page: design plan

Written before any code, 29 Oct 2026. Direction dealt by tasteskill `draw.mjs`:
**The product performs** (seed 648448569, sector dev-tool, tone technical), hero
**Sentence split by a frame**, type Clash Grotesk, palette Navy on white, motion
Pinned story. Sheet saved at `.taste-skill/direction.json`; app style for the
interface fragments "Achromatic ledger" (seed 435191889) at `.taste-skill/app/`.

## The subject (inventory, what only Tally has)

1. `npx tallywallet`, no key, no account; the first screen comes from files already on disk.
2. `~/.claude/projects/**/*.jsonl`: Claude Code's own session logs, one turn per line.
3. A real 30-day run (29 Oct 2026): $1,601 API-equivalent on a $200 Max 20x plan, 8.0x.
4. 72% of that run on claude-fable-5-1; cache hit rate shown per model.
5. $0.52 billed on OpenRouter in the same window (connected via a Management key).
6. The verdict: one sentence plus levers (model mix, cache health, unclaimed $200/month credits).
7. Deals with dates and labels: Gemini launch pricing ends 30 Nov (verified), Qoder free
   until 31 Oct (asserted), MiniMax M3.1 Flash free 19 to 22 Oct (verified, missed).
8. Data-terms warnings on free models ("may train on prompts").
9. Credits router: a local endpoint that spends expiring plan credits first.
10. Pacing hook: 5-hour window, effort nudged down past 80%.
11. Read-only, local, no telemetry, MIT, github.com/bsssm/tally.
12. The name. A tally is a count kept by marks; a tally stick was split lengthwise so both
    parties held matching halves of one record.

## The argument (claims and proof, in page order)

1. Your plan has a real value and Tally prints it. → the wallet screen, live, in the hero.
2. It reads logs already on disk; nothing leaves the machine. → the readers list, two groups.
3. One turn goes from a log line to a verdict in four steps. → four colour fields, same turn.
4. The verdict is a sentence you can act on. → the live calculator (plan + usage → verdict).
5. Deals have dates and labels, and you can miss one. → three real deal rows, three states.
6. Two of it act for you: router and pacing. → two capability rows with fragments.
7. Against ccusage it is honest about what it does not do yet. → the comparison as text.
8. The questions a developer asks before running a stranger's CLI. → FAQ index.
9. Close on the command. → footer tiles, wordmark large, command with copy.

Dropped from the dealt sheet: `proof` (large marks on tiles). There are no logos or
customers and nothing may be invented; the readers list already carries "what it works with".

## The idea

On this page, **the tally stick, one record split into two matching halves,** becomes
**the headline split in two with the ledger (the wallet screen) passing between them.**
Competitor test: ccusage prints a table; it has no verdict and no name that means a split
record. The sentence does not survive the swap.

Headline (6 words, two halves of 13 characters each): **See what your** / **plan is worth.**

Live thing: the verdict calculator. Pick a plan (API, Pro, Max 5x, Max 20x), drag a 30-day
API-equivalent figure, and the page prints the verdict with the same thresholds as
`packages/core/src/wallet.ts` (below 80% of the plan price the cheaper plan covers it; at or
above, keep it, with the multiple). Thumb-sized on a phone; a static example without script.

## Colour (tokens in `:root`, dark via `prefers-color-scheme`)

Dealt "Navy on white", kept, with the dark scheme mapped from the same roles.

| Role | Light | Dark |
| --- | --- | --- |
| `--bg` ground | `#ffffff` | `#05070a` |
| `--surface` one tone step | `#f4f4f2` | `#10131a` |
| `--ink` | `#1f2b4d` | `#eef0f5` |
| `--muted` (4.5:1 on bg) | `#5c6378` | `#a3a9ba` |
| `--accent` tangerine, the one action only | `#f7941d` | `#f7941d` |
| `--accent-ink` | `#1f2b4d` | `#1f2b4d` |
| `--field-1` near-black field (the terminal) | `#05070a` | `#000000` |
| `--field-2` warm grey field | `#e3e1dc` | `#1b1f27` |
| `--field-3`, `--field-4` for the four-field strip | navy `#1f2b4d`, `#cfd3dd` | `#2a3350`, `#141821` |

Inside `data-ui` fragments (the terminal) the CLI's own conventions apply: ink on near-black,
`ok` green, `warn` yellow, `err` red as the CLI prints them, as small signals only. Colour
budget outside the terminal: under 1% of pixels, all of it the accent on the copy button.

## Type

Clash Grotesk is on Fontshare, and the brief allows Google or system fonts only, so the
text face is **Schibsted Grotesk** (Google Fonts, 400/500/600): a slightly narrow
neo-grotesk with closed apertures, the same character, chosen over Inter and friends
because its tight, newspaper-cut lowercase reads as set type rather than a UI kit.
The terminal fragments are real `<pre>` output set in **IBM Plex Mono** (Google Fonts,
400/500), the one monospace use. Plex Mono was chosen on purpose over Geist Mono, which
the impeccable detector lists as a reflex face: Plex has a typewriter-derived character
(slab-ish serifs on i and l, a real italic) that reads as a terminal rather than a code
editor, and it is not the default of any framework. Two families total.

Five steps: `--step-small` 13 to 14px, `--step-body` 17 to 19px, `--step-lead` 20 to 26px,
`--step-head` 32 to 64px, `--step-display` clamp(40px, 3.6vw, 60px) for the split headline.
Display tracking -0.03em, leading 0.95; body leading 1.45. Tabular figures on every number.

## Layout

- One pair of outer margins (`--margin`, 16px on a phone, up to 32px), one 12-column grid,
  square corners everywhere except the one control radius (4px) inside `data-ui` fragments.
- Hero: wordmark top-left; three links and no button top-right (the action lives in the
  command). Sentence halves at the left and right margins on the vertical centre; between
  them the reel: the wallet screen's three blocks (wallet, verdict, deals) as frames 16:9,
  about 40% of the viewport wide (the direction says the fragment must be readable at true
  size, so the frame is wider than the blueprint's 35%). The stage is sticky for three
  steps; slivers of the previous and next frame show above and below. Bottom-left: the
  supporting sentence and the install command with its copy button.
- Phone: first half flush left at 9vw, frame full width 4:3, second half flush right,
  then the sentence and the command.
- Then, in order: the four-field strip (full-bleed, 84svh), the two-ended readers list
  (520px column at 22%), the verdict calculator (5/7 split), the three deal states
  (columns 4 to 9 with state words right-aligned in 1 to 3), the two capability rows
  (5/7, fragments of different sizes), the comparison table (no lines, alternate row
  tone, Tally column as a filled ink block), the FAQ index with a sticky answer pane,
  and the footer of tiles.
- Sections 120 to 200px apart on desktop; neighbours never share a layout word.

## The one memorable element

The reel: the real terminal output passing through the split sentence as you scroll,
held in place for three steps. Everything else stays quiet so it lands.

## Motion

Signature: the pinned reel. Section entrances in reading order, 70ms stagger, 20px rise,
varied by content (list rows arrive row by row, the four cards settle in turn, the
verdict figure rolls once). Press feedback on the copy button and the plan picker (spring
tab indicator and count-up adapted from `~/dashboard/public/ui-enhance.js`, itself from
beui/transitions.dev patterns). Toast on copy. All transform and opacity;
`prefers-reduced-motion` keeps the finished state and drops the travel.

## Self-audit: would a generic brief for "developer CLI landing page" land here too?

- Centred headline, subhead, two buttons, a screenshot in a browser frame: **yes it would.**
  Revised: the headline is split to the page edges with the live output between them, no
  button pair, the command is the action. No device frame anywhere.
- Dark page with a green accent and monospace everywhere: **yes.** Revised: white ground,
  navy ink, mono only inside the real terminal fragments, tangerine on one control.
- Three feature cards with icons: **yes.** Revised: each capability is a statement beside a
  working fragment of a different size; no icons at all.
- Logo strip and testimonials: **yes.** Dropped; nothing invented, the readers list is the proof.
- A feature table with ticks and crosses: **yes.** Revised: the comparison answers in words,
  including the rows where ccusage is ahead (agents read today, stars).
- Fade-up on every block: **yes.** Revised: one pinned reel, entrances varied by content.
- Cream ground with terracotta: not reached for. Violet or Tailwind blue: not used.
