# Interaction design: working notes

Ideas being worked through, not a spec. Nothing here is decided until it moves to [FEATURES.md](FEATURES.md).
The clickable prototype is [`../poc/interaction_prototype/index.html`](../poc/interaction_prototype/index.html)
(open the file in a browser, or the published copy at https://claude.ai/artifact/H88iGx4JnGSE1dDVYEin64). The team
is scripted and the DAW is a mock-up: tracks, a playhead, mute buttons and one filter knob.

## Surfaces

- **The DAW.** openDAW as it is. The producer can work in it at any time, also during a performance.
- **The team button.** Floats over the DAW (as in the `team_view` POC); opens the team view.
- **The team view.** One view that grows through the session. When it first opens it holds the project overview
  and the chat with the team lead. As members join, their cards appear beside the chat. Same view, later stage;
  not a second screen.

## A session, step by step

The sketch's example: evolve a lo-fi beat into a house track.

1. **Open.** The producer clicks the team button. The view shows the project overview (FEATURES.md, "Project
   overview") and the team lead asking what they want to do.
2. **Say the goal.** "Let's slowly evolve the base project from a lo-fi beat to a house track." The team lead
   says who it's bringing in; their cards appear, each with its **direction** (what it understood its job to be)
   and the **controls** it proposes ("Designing synths from a range of time periods", with a 1980–2000 dial).
3. **Adjust before playing.** The producer edits a direction in words, nudges a control, or removes a member.
4. **Play.** The producer starts playback in the DAW. The team works ahead of the playhead. The producer steers
   in three ways, mixed freely:
   - **Chat.** Goes to the team lead by default; `@member` addresses one member ("@mix_engineer the kick is
     too loud"). The team lead answers or passes it on and says so.
   - **Controls.** Each card's controls are directions, not parameter changes (AGENT_TEAM_API.md, "Controls"):
     moving the era dial to 1995 changes what the instrument designer does next. The card should show it was
     heard (a "next: …" line).
   - **The DAW.** Playing along or demonstrating ("like that"). The change log shows the team what changed; the
     member it concerns says what it took from it (FEATURES.md, "Requests by demonstration").
5. **Stop.** Playback stops; the team can say what it did and what's left. Whether this is a phase of its own
   ("post-mortem") or just the chat continuing is open.

## Directions held by the Team Lead

Some directions go to the Team Lead, which splits them among members ("evolve this into house": the drum
programmer gets the groove, the instrument designer the sounds, the mix engineer the low end). The producer needs
to see and steer these, not only each member's piece. In the team view, above the member cards, each active
direction shows:

- its text, as the producer gave it;
- who it was split among, and each member's piece;
- a control for the whole direction: Pace for the goal (how often members change something), Strength for later
  ones (how much it should show);
- Cancel: the members drop their pending changes for it and go idle unless another direction still involves
  them. What already landed stays.

Each member card says which direction(s) its work comes from. A message to `@member` goes to that member only and
doesn't become a Team Lead direction.

**Changing a direction goes through the chat**, so there is no separate editing UI. Each direction has a tag made
from its first words (`#slowly_evolve_this`), which stays the same when it's reworded. The direction's Edit
button starts a message, `@team_lead #slowly_evolve_this `, and the producer finishes it: "faster", "less",
"cancel it", or new wording (the card then shows what it was). Typing `#` in the chat lists the directions. The
dial and Cancel stay on the card as shortcuts.

Open: whether directions end on their own ("done: it's house
now"); how directions that pull against each other get resolved, and whether the producer sees that.

## Modes

The sketch has four: Ready, Planning, Performing, Post-mortem. They bound what the team does (no edits while
planning; no long proposals while performing), but the producer may not need to see or switch them.

One option: the team's mode follows what the producer is already doing, with no mode switch of its own. Stopped
with no members yet: planning. Transport running: performing. Stopped after a run: reviewing. The prototype tries
this, with the mode shown small in the corner so we can see whether it ever matters.

## Inactive roles

Easiest first: cards only for members who have joined. The `@` menu lists every role, so the producer can still
find what the team can do without the view getting crowded. Revisit if it turns out nobody discovers roles that
way.

## Roles

Not settled. Some may be abstract, made concrete per session: a *musician* role becomes a pianist or a guitarist.
The prototype uses a handful of examples.

## Open

- What a card shows during a performance: direction, controls, and what it's doing now / next. Too much at once?
- How chat during playback stays short enough to read at a glance.
- How the producer approves or vetoes a pending change (FEATURES.md, "Visible presence") from a card.
- Whether a member can propose a new control mid-performance, and how that is accepted without stopping.
