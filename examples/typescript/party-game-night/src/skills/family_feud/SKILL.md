---
name: family-feud
description: Load when the group wants to play Family Feud (the survey game) — the full hosting flow, judging rules, and the question bank.
---

# Hosting Family Feud

Survey says: you ask a question that was put to 100 people, teams shout
guesses, and the popular answers are hidden on the board with their survey
points. Flip what they guess, strike what they miss.

## Setup

1. If teams aren't registered yet, get 2–4 team names and call `set_teams`.
2. Put up a title card for the game, announce the rules in two sentences:
   guess the popular answers, three strikes ends the round.

## Round flow

1. Pick a question from the bank — never one you've already played
   tonight. Call `render_ui` with `feud_board`, the question, and its
   answers with points, ordered top answer first. Every answer starts
   hidden.
2. Read the question aloud with energy. Never say a hidden answer, not
   even as a hint.
3. Teams alternate guesses, one player at a time — call on people by
   name. When a guess matches a hidden answer, call `reveal_answer` with
   its slot number, celebrate, and `award_points` to the guessing team
   for that answer's points.
4. A guess that matches nothing on the board is a strike: call
   `add_strike` and announce it with a big "X!" energy. The third strike
   ends the round.
5. The round also ends when every answer is face-up. If it ends with
   answers still hidden, the reveal is a board moment, not a speech: call
   `reveal_answer` for each remaining slot, one at a time, naming each as
   it flips ("let's see what you missed!"). The round is not over until
   every slot on the board is face-up — never read out a missed answer
   without flipping it. Then put up the scoreboard and recap before the
   next round.

## Judging guesses

- Match on meaning, not exact wording: "cell", "my mobile", and "the phone"
  are all the Phone answer.
- One guess, one verdict. If a guess is ambiguous, ask the guesser to commit
  to one specific answer before you judge it.
- Be a generous judge on synonyms, a strict judge on category errors. When
  you rule a guess out, say what it needed to be closer to — without hinting
  at hidden answers.

## Question bank

Points are out of 100 surveyed. The bank below is a random hand dealt from a
larger deck for this night — pick freely from anywhere in it, and never
repeat a question in the same night. Inventing is part of hosting: when the
room wants a theme (movies, office life, this very family) or you've played
the best ones, write a fresh question in exactly this format — 4–7 short
answers a family audience could guess, points descending and summing to
about 100.
