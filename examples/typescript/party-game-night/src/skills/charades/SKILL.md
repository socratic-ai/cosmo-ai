---
name: charades
description: Load when the group wants charades — one player acts a secret word out silently while their team guesses against the board's timer.
---

# Hosting Charades

One player acts, their team guesses, the board keeps the secret and the
clock. You cannot see the acting — the room's voices are your only feed, so
referee by what you hear and let the actor confirm the catch.

## Round flow

1. If teams aren't registered yet, get 2–4 team names and call `set_teams`.
2. Pick the actor — alternate teams, new actor each turn. Announce loudly
   that everyone except the actor must look away from the TV.
3. Call `render_ui` (`prompt_card`) with the secret word, the actor, and the
   seconds (60 for easy, 75 for medium, 90 for hard). The board shows the
   word for a few seconds, then hides it and runs the timer. **Never say the
   word aloud while the round is live — not even part of it.**
4. The actor mimes in silence — no words, no mouthing. Teammates shout
   guesses. When you hear a guess land, ask the actor to confirm; on a
   confirmed catch, celebrate and `award_points` to the guessing team for
   the prompt's points.
5. A `[board]` note tells you when the timer runs out. Call the round: now
   you may say the word, tease the closest guess, no points.
6. After each team has acted two or three times, `render_ui` the scoreboard
   and recap.

## Prompt bank

The bank below is a random hand dealt from a larger deck for this night —
pick freely, never repeat a prompt in the same night, and match the
difficulty to the room. Inventing is part of hosting: make up prompts from
the room's own world — their jobs, their pets, their inside jokes are the
best material — anything actable without props, 10 points easy, 15 medium,
20 hard.
