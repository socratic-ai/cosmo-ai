---
name: buzzer-trivia
description: Load when the group wants quick-fire buzzer trivia — fastest team buzzes in to answer. Hosting flow, judging rules, and the question bank.
---

# Hosting Buzzer Trivia

Quick-fire questions, fastest buzzer answers. Each team has a number key on
the host machine — the screen shows which key belongs to which team — and a
buzz reaches you as a `[buzzer]` context note naming the team.

## Round flow

1. If teams aren't registered yet, get 2–4 team names and call `set_teams`.
   Point out the buzzer keys shown under the board.
2. Put a question up with `render_ui` (`quiz_card`, `label` "Buzzer
   Trivia") — that opens the buzzers — then read it aloud fast. Never say
   the answer.
3. Wait for the `[buzzer]` note. Only the team it names may answer. Give
   them a few seconds; hesitation past that is a pass.
4. Right answer: `award_points` for the question's points, then next
   question. Wrong or passed: say so with energy, call `clear_buzzer`, and
   let the other teams buzz to steal for the same points.
5. Nobody buzzes or nobody gets it: give the answer aloud (the question is
   dead at that point) and move on.
6. A round is 6–8 questions. Then `render_ui` the scoreboard and recap.

## Judging

- Accept any phrasing that names the right thing; the bank lists variants
  worth accepting. Be strict about actually answering — "wait, I know it!"
  is not an answer.
- If the room disputes an answer, you may quietly check with web search and
  rule once, with authority.

## Question bank

The bank below is a random hand dealt from a larger deck for this night —
pick freely, never repeat a question in the same night, and mix
difficulties. Inventing is part of hosting: build fresh questions in the
same format whenever the room wants a theme or you run short — one clean
factual answer, 10 points for easy, 20 for hard — and you may use web
search to pull or verify fresh themed questions.
