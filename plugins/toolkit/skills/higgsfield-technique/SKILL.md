---
name: higgsfield-technique
description: "Craft layer for Higgsfield generation — the technique the official higgsfield-* skills omit. Load alongside them whenever generating images or video with Higgsfield: choosing an entry point, writing image or video prompts, animating a logo or product, keeping a character or brand consistent across shots, or diagnosing flat, generic, obviously-AI output. The official skills cover CLI mechanics and the model catalogue; this covers what to actually write and which layer to call."
---

# Higgsfield technique

Companion to the official `higgsfield-*` skills. **They cover mechanics** — model catalogue, CLI flags, marketing modes, troubleshooting. **This covers craft.** Their `prompt-engineering.md` is one page; everything below is missing from it.

Distilled from community tutorials.

## Pick the right layer first

The most common mistake is calling a raw model with a freehand prompt. That is the bottom of the stack.

| Want | Call |
|---|---|
| Brand / product imagery | `product_photoshoot` (10 modes) |
| Cinematic stills | `cinematic_studio_2_5` — supports **21:9 and 4k**, raw `gpt_image_2` does not |
| Ads, UGC, avatars | `marketing_studio_image` / `marketing_studio_video` |
| Marketplace listings | `marketplace_cards` |
| Identity-consistent | `soul_cinema_studio` + a trained Soul |
| Video from a still | `seedance_2_0` |

The workflows apply **backend prompt enhancement**. The `product-photoshoot` skill states it outright: *"Backend assembles the final prompt; never freehand it."* Reach for a raw model only when no workflow fits.

Always price first: `higgsfield generate cost <model> [params]`. GPT Image 2 at 2k = 7 credits.

## Image prompts

**Describe the shot, not the subject.** The single highest-leverage change. State what the subject is doing, **what is behind it**, and **where the light comes from**. A prompt naming only the subject and a palette produces a flat image that also animates badly.

**`aspect_ratio` defaults to `1:1` and the prompt cannot override it.** Writing "wide banner" produces a square. Always pass it explicitly. This is not documented in the official skill — it lists the options without warning about the default.

**Size up one step from the target medium.** Generating 2K/16:9 for a 1080p 16:9 video means nothing gets cropped or stretched downstream. Match the final aspect ratio from the start rather than cropping later.

**Image-to-image: describe only what changes.** Do not redescribe the input — the model already has it.

**Phrase negatives positively.** "Tack sharp", not "no blur". Most models expose no `negative_prompt`.

## Video prompts

- **Write as numbered shots.** Four shots in 15s ≈ 3–4s each, which matches real action-film cut length.
- **Add an explicit speed instruction** — a closing line like *"everything runs at real speed"*. Models drift into slow motion on action scenes.
- **Describe motion only.** `start_image` already carries the frame; do not redescribe it.
- **`generate_audio` defaults true on `seedance_2_0`** — sound is generated with the video. No separate audio pass needed.

## Consistency comes from saved assets, not better prompts

Faces and locations drift when re-described each shot; they hold when they are **saved objects referenced by handle**.

- **AI Cast** builds a character from settings (genre, era, archetype, physical details) — no text prompt. Output is a sheet with **front, back, and close-up**, which is what keeps the face stable as the camera moves.
- **Give every character one distinctive feature** (a scar, a specific garment). A clear anchor measurably improves cross-shot consistency.
- **Save locations and props** as elements (upload media → elements → new element) so they are reusable.
- **The video prompt then contains only choreography** — what happens, in what order. It never describes appearance; the handles carry that.

## Logo and brand animation — chained references

The method behind the widely-shared logo-morph clips:

1. **Prep**: 4K canvas, black background, logo as white art. This is reference #1 for every step.
2. **Scene 1** = logo-on-black + prompt
3. **Scene 2** = logo-on-black + *scene 1 image* + prompt
4. **Scene 3** = logo-on-black + *scene 2 image* + prompt

The logo stays pinned as reference #1 throughout while reference #2 rotates to the previous frame. That is what keeps the mark intact while the scene evolves.

5. **Transitions**: `seedance_2_0` with `start_image` = scene N and `end_image` = scene N+1, prompt describing the transition.
6. Stitch the clips; speed them up slightly if motion feels thin.

`seedance_2_0` accepts up to 9 image references (counting start/end) and generates audio inline — no separate SFX tool required.

## Ads and avatars

- **Prompt an avatar as a list of imperfections** — stray hairs, visible pores, uneven skin — and explicitly instruct *not* plastic skin. **Perfect skin is the number one thing that reads as AI.**
- Save the avatar, then reference it by **handle in brackets**.
- **UGC mode: the prompt is only handles + dialogue.** No scene description — dialogue fills the runtime, saved references carry visuals. Put all effort into the dialogue.
- **Duration = length of the spoken line.** Dead air at the end is where a talking ad starts looking AI again.
- **Hypermotion** is the product-only style: the entire prompt is just the product handle.
- **Voice change** swaps voice on finished footage — use for A/B testing and for localisation with identical visuals.

## Agent mode (Supercomputer)

- **Set "ask before generation"** so it pauses for approval and never spends credits on something unseen.
- **Specify the order in the prompt**: elements first, then storyboard, then video. Same order as the manual flow, and what produces consistency.

## Refusals

Terminal statuses `nsfw` and `ip_detected`. **Trademarks and branded characters trigger `ip_detected`** — third-party logos and known characters may hard-refuse regardless of intent. Use owned marks, or abstract far enough that the filter passes. Real public figures are also rejected.

## Pairs with

`redesign-existing-projects` — this skill governs what gets generated; that one governs how the surrounding interface looks. Generation technique plus design judgment is the pair that produces work that does not read as AI.
