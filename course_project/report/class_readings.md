# Course readings: support and challenges for TakeDo

This file maps the IFT 6077 readings (Fall 2026 schedule) to TakeDo's claims and design, as they stand in the
proposal and `project_plan/` (November 2026).

**What TakeDo is at this point:**
- The producer gives notes during playback in text, with speech as a stretch goal.
- Agents turn the notes into edits on openDAW through a change bus that gives the human priority.
- Every edit stays visible, can be undone, and remains ordinary openDAW project data.
- A team view shows members, the directions they hold, and the **intent controls** they make.
- Jev (fast, structured) chooses among prepared options; the LLM handles the rest.
- The user's own DAW edits are read as demonstrations.
- Build order: the utility agent working alone first, then Jev's knowledge route, then roles.

**How the quotes were checked.** Each quotation was extracted from the paper's full text, either the arXiv copy or
an author-hosted PDF, and matched word for word. The only changes are ligatures restored (PDF extraction drops "fi"
and "ff") and hyphenation removed at line ends. Where the full text wasn't available, the paper is listed at the
end with no quotes. Locations are given where the text made them clear: the abstract or a named section.

---

## 1. The gap TakeDo addresses: expressive intent versus technical parameters

These papers state the problem in the proposal's introduction, in other domains. Together they make the gap a
general finding in HCI, not a claim particular to music.

**Angert et al. 2023, Spellburst** (Nov 16; abstract)
> "When producing digital artwork, artists usually begin with a high-level semantic construct such as a 'stained
> glass filter' and programmatically implement it by varying code parameters such as shape, color, lines, and
> opacity to produce visually appealing results. Based on interviews with artists, it can be effortful to translate
> semantic constructs to program syntax"

- This is TakeDo's "the chorus should lift" spread across velocities, timing and balance, in creative coding.
- Spellburst's answer is to "seamlessly switch between semantic and syntactic exploration". That supports keeping
  openDAW itself fully usable next to the team view.

**Kim et al. 2022, Stylette** (Sep 28, optional; abstract)
> "end-users lack the knowledge needed to translate high-level styling goals into low-level code edits."

- This is the closest structural precedent for TakeDo's interpretation layer: a language goal becomes a set of
  low-level property changes. The proposal already cites it.
- Its limitation is in §2, item 5.

**Zhang et al. 2026, From Words to Widgets** (Nov 25; §1)
> "Even when users do have a preference, it is still difficult for them to align model output with their
> expectations for the degree to which that preference is expressed, relying on vague modifiers ('more concise,'
> 'not that concise') to communicate subtle adjustments."

- Producer notes are full of these: "a bit more", "less jazzy", "not that much reverb".
- This supports the design choice that Jev returns an *amount* (`amount` 0..3 in the knowledge route), and that a
  note's strength becomes a control and not a re-prompt.

**Shi et al. 2025, Brickify** (Oct 26; abstract)
> "Expressing design intent using natural language prompts requires designers to verbalize the ambiguous visual
> details concisely, which can be challenging or even impossible."

**Chung & Adar 2023, PromptPaint** (Oct 14, optional; abstract)
> "For concepts that are difficult to describe through language, users may struggle to create prompts."

- Brickify and PromptPaint both argue that language alone is not enough for perceptual qualities.
- In TakeDo, sound is the perceptual medium. This is the argument for the non-language inputs: intent controls,
  demonstration, and direct DAW edits.

## 2. Delegation *and* direct manipulation, not one or the other

The proposal says TakeDo "keeps both". These readings give that position a history and a vocabulary.

**Shneiderman & Maes 1997, Direct manipulation vs. interface agents** (Sep 28, optional; Maes' remarks)
> "agents are not an alternative for direct manipulation. A lot of conferences and magazines pitch agents against
> direct manipulation. They are actually complementary metaphors. Whenever you have an agent interface, typically
> you also need a very good application interface because an agent is not a substitute for an interface."

> "this is completely a complementary technique to well-designed interfaces— visualization, and direct
> manipulation—not a replacement. Users still need to be able to bypass the agent if they want to do that."

- This is the clearest historical warrant for the team view sitting *on top of* an unmodified openDAW, and for the
  rule that the producer can do anything directly at any time.
- Maes' "bypass the agent" corresponds to the change bus's human priority: `dropped` while the human holds a
  control, `superseded` after the human changes it.

The same debate argues *against* TakeDo too; see §8.

**Shneiderman 1983, Direct manipulation** (Sep 23; to read; scanned PDF, list item)
> "Rapid, incremental, reversible operations whose impact on the object of interest is immediately visible."

- The change bus already follows each of these principles.
  - **Reversible:** every agent edit is one undo step, and its reply carries its place in the undo history.
  - **Visible:** edits land as ordinary project data.
  - **Incremental:** edits are made per bar, ahead of the playhead.
- Citing this principle against each bus reply type would be a compact way to argue the "without loss of direct
  manipulation" contribution.

**Masson et al. 2024, DirectGPT** (Sep 23; abstract)
> "continuous representation of generated objects of interest; reuse of prompt syntax in a toolbar of commands;
> manipulable outputs to compose or control the effect of prompts; and undo mechanisms."

> "A study shows participants were 50% faster and relied on 50% fewer and 72% shorter prompts to edit text, code,
> and vector images compared to baseline ChatGPT."

- **Support:** DirectGPT is evidence that adding direct manipulation to an LLM interface cuts the effort of
  prompting. That is the shape of TakeDo's research question (less effort, same control).
- **Design parallel:** "reuse of prompt syntax in a toolbar of commands" corresponds to the knowledge base's named
  entries and to direction tags (`#slowly_evolve_this`) that can be edited and reused.

**Beaudouin-Lafon 2000, Instrumental Interaction** (Nov 18; to read)
> "an interaction instrument is the reification of one or more commands. For example, a scrollbar is the
> reification of the command that scrolls a document."

> "The temporal offset is the time difference between the physical action on the instrument and the response of
> the object."

- An intent control is an instrument that reifies a direction.
- *Temporal offset* is the right term for INTERACTION.md's three response styles:
  - instant: macros, which change as the hand moves
  - quick: a prepared option, heard on the next bar
  - slow: worked out by the member, heard in a phrase or so
- The hare and tortoise icons make the temporal offset visible. The model also predicts the cost: a higher
  temporal offset means more indirection. That's a reason to measure whether "next bar" still feels direct.

**Riche et al. 2025, AI-Instruments** (Nov 18; abstract)
> "(1) Reification of user-intent as reusable direct-manipulation instruments; (2) Reflection of multiple
> interpretations of ambiguous user-intents (Reflection-in-intent) as well as the range of AI-model responses
> (Reflection-in-response) to inform design "moves" towards a desired result; and (3) Grounding to instantiate an
> instrument from an example, result, or extrapolation directly from another instrument."

- **Reflection-in-intent** describes the knowledge route's `hint` path. When Jev is unsure, it doesn't guess: up to
  five candidate interpretations go to the utility.
- **Grounding from an example** corresponds to requests by demonstration.
- The proposal already cites AI-Instruments. These three principles are worth naming explicitly in the report.

## 3. Controls the AI makes: intent controls and macro faders

TakeDo's members propose controls such as an era dial or a "hectic" slider, which change what the member does
next. Four readings test this pattern, and they report mostly positive results.

**Vaithilingam et al. 2024, DynaVis** (Nov 30, optional; abstract)
> "NLIs forgo the advantages of traditional GUI: the ability to explore and repeat edits and see instant visual
> feedback. … As the user describes an editing task in natural language, DynaVis performs the edit and synthesizes
> a persistent widget that the user can interact with to make further modifications. Study participants (n=24)
> preferred DynaVis over the NLI-only interface citing ease of further edits and editing confidence due to
> immediate visual feedback."

- This is close to TakeDo's flow: a note is applied, and a control remains for adjusting it.
- It is evidence for turning a direction into a control and not leaving it as chat.

**Zhang et al. 2026, From Words to Widgets** (Nov 25; abstract)
> "It reifies preference expressions in natural language prompts into GUI widgets (e.g., sliders, dropdowns, and
> toggles) that users can directly configure to steer generation … Malleable Prompting helps participants achieve
> target preferences more precisely and is perceived as more controllable and transparent than natural language
> prompting alone."

- It also names the problem TakeDo's team view should avoid (§1):
  > "as specified preferences accumulate across turns, the linear chat history grows long and unwieldy to
  > navigate."
- That supports keeping directions as cards that last (INTERACTION.md, "Directions held by the Team Lead") and not
  only in chat.

**Li et al. 2026, Spatula** (Sep 28, optional; abstract and Fig. 1)
> "a system for generating on-demand, in-situ attribute control interfaces for motion graphics … along four
> dimensions : (a) discoverability via context-aware in-situ hints, (b) scope control for semantically coordinated
> manipulation, (c) multi-resolution adjustment for varying precision, and (d) proactive attribute space
> expansion."

- Spatula is the nearest precedent in a *time-based* medium (motion graphics).
- Its four dimensions are a ready checklist for intent controls:
  - **Discoverability:** does the producer find the controls?
  - **Scope:** one control moves several tracks, like "bass under the kick".
  - **Resolution:** the hare and tortoise stretches.
  - **Expandability:** a member proposes new controls, an open question in INTERACTION.md.

**Suh et al. 2024, Luminate** (Nov 9; Fig. 1)
> "users' prompt triggers (c1) generation of dimensions and subsequently the (c2) generation of responses using the
> dimensions from the previous step."

- This corresponds to a member proposing its controls (the dimensions) before it plays, in the "adjust before
  playing" step.

## 4. Steering *during* the process, not between turns

This is the core of TakeDo's research question: live direction compared with requests made between playbacks.

**Chung et al. 2022, TaleBrush** (Nov 2; abstract)
> "Existing systems often leverage simple turn-taking between the writer and the AI in story development. However,
> writers remain unsupported in intuitively understanding the AI's actions or steering the iterative generation."

- This is the same critique as the proposal's point about DAWZY ("each request becomes an isolated edit made
  between playbacks"), in another medium.
- TaleBrush's line sketch is a curve over the story's timeline that sets a quality at each point (Fig. 1):
  > "The 𝑥 position of the sketched line indicates the chronological position in the story … The 𝑦 position shows
  > how good or bad the protagonist's fortune should be … The width of the line indicates the possible variance"
- That is an automation lane for an *expressive* quality: "intensity" or "how jazzy" drawn across the song, with
  the agents realising it. This is worth considering as a control type: a drawn intent curve, not a slider.

**Chung & Adar 2023, PromptPaint** (Oct 14, optional; two passages)
> "PromptPaint also allows for gradual shaping of the artifact by allowing 1) changing of prompts during generation
> … not many approaches have looked at how to allow users to intervene during generation."

- This supports intervening while the process runs, which in TakeDo means while the track plays.

**Tilekbay et al. 2024, ExpressEdit** (Nov 4, optional; introduction)
> "extracting three types of references from the multimodal edit command: (1) temporal location (e.g., 'whenever a
> display appears'), (2) spatial location within the frame (e.g., 'towards the display'), and (3) references to
> edit operations and their parameters (e.g., 'slow zoom in')"

- This is a ready scheme for parsing producer notes in a time-based medium:
  - a temporal reference ("in the chorus", "after the drop")
  - a target ("the hats")
  - an operation with parameters ("looser")
- Jev's current route judges *kind*, *part* and *amount*, but not *where in the song*. ExpressEdit points to that
  gap.

**Wang et al. 2025, Script2Screen** (Oct 28, optional)
> "This real-time adjustment feature empowers writers to experiment with different delivery styles and immediately
> hear how those changes affect the performance."

## 5. Demonstrations and corrections as intent

**Chung & Kreminski 2024, Patchview** (Oct 14, optional; abstract)
> "When the user disagrees with the LLM's visualization and generation, they can correct those by repositioning the
> element. These corrections can be used to align the LLM's future behaviors to the user's perception."

- This is a recent, working instance of contribution 3: direct edits as demonstrations the agents learn from.
- Myers (1992) is the classic citation, but I couldn't get its text (end of file). Patchview gives you a
  verifiable one.

## 6. The interface metaphor (producer and session team)

**Masson et al. 2025, Textoshop** (Oct 7; abstract and §1)
> "our work highlights the potential of interaction analogies to rethink existing workflows, while capitalizing on
> familiar features."

> "we aim to (1) capitalize on solutions that have been proven to work well and (2) offer solutions most users are
> already familiar with."

- TakeDo is the same move: the producer's habits with a session team carry over. Textoshop is by an Université de
  Montréal co-author, and it's a clean companion citation to Neale & Carroll.

**Shen et al. 2026, Texterial** (Oct 14; abstract)
> "material metaphors shift mental models and bridge gulfs of envisioning, execution, and evaluation in LLM-mediated
> writing."

- This supports the claim that a metaphor does more than label the interface: it changes what users expect the
  system can do.
- That cuts both ways for TakeDo; see Johnny in §8.

## 7. Seeing what the agents did (the team view)

**Suh et al. 2023, Sensecape** (Nov 16, optional; abstract)
> "current interfaces for interacting with LLMs are generally linear to support conversational interaction."

**Zhang et al. 2023, VISAR** (Oct 28; abstract)
> "this approach often neglects implicit writing context and user intent, lacks support for user control and
> autonomy"

- Both argue against chat as the only view. They support the cards, the directions panel and the change log, and
  not the chat alone.

## 8. Readings that challenge the design

These matter most for the report's discussion and for planning the study.

**Zamfirescu-Pereira et al. 2023, Why Johnny Can't Prompt** (Sep 21; abstract and the "Incapability as Explanation"
section)
> "Expectations stemming from human-to-human instructional experiences, and a tendency to overgeneralize, were
> barriers to effective prompt design."

> "A number of participants made assumptions about the kinds of instructions LLMs respond well to after just one
> attempt with a particular prompt design, once again overgeneralizing from a single (typically negative) example.
> Very few participants attempted rephrasing of statements, as participants seemed inclined to infer a lack of
> ability"

- **Risk to TakeDo:** the producer and session team metaphor *invites* human-to-human expectations. That is the
  point of the metaphor, and it is the barrier Johnny found.
- **Likely failure:** a producer's note fails once ("the chorus should lift"), and they conclude "it can't do
  arrangement" and stop trying.
- **Mitigations already in the design:**
  - Each card shows what the member understood its direction to be.
  - The utility reports what it applied by name ("Applied … (chain): …").
- **For the study:** log whether participants rephrase after a failure, or give up on that kind of note.
- **Caveat:** Johnny's participants were *designing* prompts for a chatbot, not giving one-off notes. The
  overgeneralization finding transfers; the prompt-engineering framing doesn't fully.

**Subramonyam et al. 2024, Bridging the Gulf of Envisioning** (Sep 21, optional; abstract)
> "three misalignments on not knowing: (1) what the task should be, (2) how to instruct the LLM to do the task, and
> (3) what to expect for the LLM's output in meeting the goal."

- Point (3) matters most for TakeDo. During playback, the producer can't easily predict what "looser" will do.
  Hearing it on the next bar is the feedback.
- Point (1) argues for proposing controls *before* playing.

**Liu et al. 2023, "What It Wants Me To Say"** (Sep 21, optional; abstract)
> "only a small portion of the infinite space of naturalistic utterances is effective at guiding code generation.
> For non-expert end-user programmers, learning this is the challenge of abstraction matching."

- The knowledge-route bench measures exactly this: 58% of the bench messages match an entry, and the route applies
  66 of the 123 hits directly.
- **The paper's remedy** is "translating the code back into a systematic and predictable naturalistic utterance."
  In TakeDo, the equivalent is a short report after each edit, saying what was done in the system's own terms, so
  the producer learns which notes work.

**Kim et al. 2024, Users' Dissatisfaction with ChatGPT Responses** (Sep 21, optional; abstract)
> "users most frequently experience dissatisfaction when ChatGPT fails to grasp their intentions … even when using
> tactics, 72% of dissatisfaction remained unresolved. Moreover, we found that users with low knowledge of LLMs tend
> to face more dissatisfaction on accuracy while they often put minimal effort in addressing dissatisfaction."

- This predicts that musicians who don't use LLMs often won't correct a misread note. They'll move on. Corrections
  are where the demonstration contribution gets its data, so it may see little input.

**Shneiderman & Maes 1997** (Sep 28, optional; Shneiderman's remarks)
> "Our goal is to create environments where users comprehend the display, where they feel in control, where the
> system is predictable, and where they are willing to take responsibility for their actions. To me, responsibility
> will be the central issues in this debate."

- Agents that edit ahead of the playhead on their own initiative are the hard case for predictability.
- A genre plan that applies five steps over twelve bars is less predictable than one edit at a time.
- Shneiderman also criticises the "anthropomorphic vision" of agents. That bears on presenting members as persons
  ("team lead", "mix engineer") as opposed to roles or tools.
- Of everything in §8, this is the strongest counter-position for the discussion section.

**Kim et al. 2022, Stylette** (Sep 28, optional)
> "As participants acquired more knowledge with Stylette, however, natural language interaction limited their
> productivity as they could not apply this knowledge to directly make changes themselves. These insights suggest a
> need for a hybrid approach"

- **Risk to the research question:** for producers who know the DAW well, language may *add* effort.
- The proposal claims less effort without reducing control. Stylette suggests the answer may depend on expertise,
  so record participants' DAW experience.

**Zhang et al. 2024, VRCopilot** (Dec 7, optional; abstract)
> "We found that scaffolded creation using wireframes enhanced the user agency compared to automatic creation. We
> also found that manual creation via multimodal specification offers the highest sense of creativity and agency."

- This bears on the "without reducing their sense of control" half of the research question.
- It predicts that the most automatic path costs the most agency: a genre plan applied by the knowledge route with
  no model turn.
- A scaffolded middle step could be what INTERACTION.md calls a proposal the producer can hear before it lands.

**Chung et al. 2022, TaleBrush** (Nov 2)
> "when there is a series of granular controls (e.g., sliders), specifying them can be cumbersome (e.g., inputting
> multiple numerical control values)."

- This warns against filling the cards with sliders: several members, each with several controls, during playback.

**Suh et al. 2024, Luminate** (Nov 9; abstract)
> "current interaction paradigms fall short, guiding users towards rapid convergence on a limited set of ideas"

**Lin et al. 2025, Inkspire** (Nov 4, optional)
> "It is difficult to directly build on generated designs—they appear 'too complete', potentially leading to
> fixation."

- Both apply to the knowledge base's genre write-ups. A plan that turns "make it house" into a stock four-on-the-floor
  beat and a stock chord loop is a quick path to convergence, and to a result that is "too complete".
- This is a reason the genre plans should leave room to steer: controls on the direction, not only an apply.

**Yen et al. 2025, Code Shaping** (Nov 4; §4.4.4)
> "The primary challenge was the ambiguity of participants' sketches. For example, arrows were used inconsistently,
> sometimes indicating context [P1] and other times denoting targets of changes [P4]"

- The same holds for producer vocabulary. "Space" can mean reverb, fewer parts, or panning. That ambiguity is the
  case for the route's `hint` path, and against forcing an apply.

## 9. Speech input (stretch goal)

**Aghel Manesh et al. 2024, How People Prompt Generative AI to Create Interactive VR Scenes** (Dec 7, optional;
abstract)
> "(1) they should have an embodied knowledge of the environment; (2) they should understand embodied prompts by
> users; (3) they should recall previous states of the scene and the conversation, and that (4) they should have a
> commonsense understanding of objects in the scene."

- In TakeDo, (1) corresponds to the snapshot the agents read, and (3) to the agents' notebook.
- A musical version of (2) is "like that" said while playing, which is requests by demonstration.

**He et al. 2026, Reference-Based Manipulation** (Dec 7; abstract)
> "we formalize a framework that decomposes spatial references into three core components—Source, Anchor, and
> Frame"

- Producers make *temporal* references the same way: "the bar before the drop", "where the vocal comes in". The
  same decomposition could be applied to time.

**Lin et al. 2024, Rambler** (Dec 7, optional; abstract)
> "writing with speech can produce disfluent, wordy, and incoherent text and thus requires heavy post-processing."

- This is a reason to keep spoken notes short, gist-level and acknowledged, if speech is added.

---

## Readings with no quotes, and why

| Reading | Status |
|---|---|
| Neale & Carroll, *The Role of Metaphors in UI Design* (Oct 7) | Course PDF only; not reachable. Already cited in the proposal, so take quotes from your copy. |
| Myers 1992, *Demonstrational Interfaces* (Nov 2) | No open full text found (the CMU report and the *Watch What I Do* chapter were blocked). Already cited. |
| Bourgault et al. 2025, *Narrative Motion Blocks* (Sep 28) | No open copy. From the Adobe Research listing: "clip-like components located on a timeline" that combine text and manual input. Probably the closest analogue to TakeDo in the syllabus (a timeline medium, language plus direct manipulation), so worth getting from the ACM DL by hand. |
| Peng et al. 2025, *FusAIn* (Nov 23) | No open copy. The authors' 2026 follow-up (arXiv 2603.03074) argues that "alignment is a dynamic negotiation, with AI adopting proactive or reactive roles", which is relevant to agents that act on their own initiative. |
| Wolf & Rhyne 1987; Baldonado et al. 2000; Bressa et al. 2024; Fischer 2006; Bolt 1980; Beaudouin-Lafon & Mackay 2000 | Not retrieved; less directly relevant. Fischer ("how people talk to computers") would back the Johnny point if you can get it. |
| Toyteller, XCreation, Visual Story-Writing, ImaginationVellum, Vistoria, Memolet, Cells/Generators/Lenses, Malleable UIs, Malleable Overview-Detail, BISCUIT, Mobile Touch, ClickDiffusion, Input Visualization | Read or skimmed; nothing that adds to the sections above. |

## Sources (open copies used)

- arXiv: Envisioning [2309.14459](https://arxiv.org/abs/2309.14459) · Dissatisfaction [2311.07434](https://arxiv.org/abs/2311.07434) · What It Wants Me To Say [2304.06597](https://arxiv.org/abs/2304.06597) · DirectGPT [2310.03691](https://arxiv.org/abs/2310.03691) · Textoshop [2409.17088](https://arxiv.org/abs/2409.17088) · Texterial [2603.00452](https://arxiv.org/abs/2603.00452) · PromptPaint [2308.05184](https://arxiv.org/abs/2308.05184) · Patchview [2408.04112](https://arxiv.org/abs/2408.04112) · VISAR [2304.07810](https://arxiv.org/abs/2304.07810) · Script2Screen [2504.14776](https://arxiv.org/abs/2504.14776) · Code Shaping [2502.03719](https://arxiv.org/abs/2502.03719) · Inkspire [2501.18588](https://arxiv.org/abs/2501.18588) · ExpressEdit [2403.17693](https://arxiv.org/abs/2403.17693) · Luminate [2310.12953](https://arxiv.org/abs/2310.12953) · Spellburst [2308.03921](https://arxiv.org/abs/2308.03921) · Sensecape [2305.11483](https://arxiv.org/abs/2305.11483) · AI-Instruments [2502.18736](https://arxiv.org/abs/2502.18736) · DynaVis [2401.10880](https://arxiv.org/abs/2401.10880) · Brickify [2502.21219](https://arxiv.org/abs/2502.21219) · Words to Widgets [2604.10925](https://arxiv.org/abs/2604.10925) · Spatula [2607.10405](https://arxiv.org/abs/2607.10405) · Reference-Based Manipulation [2608.04798](https://arxiv.org/abs/2608.04798) · VR prompting [2402.10525](https://arxiv.org/abs/2402.10525) · VRCopilot [2408.09382](https://arxiv.org/abs/2408.09382) · Rambler [2401.10838](https://arxiv.org/abs/2401.10838) · FusAIn follow-up [2603.03074](https://arxiv.org/abs/2603.03074)
- Author copies: [Why Johnny Can't Prompt](https://people.eecs.berkeley.edu/~bjoern/papers/zamfirescu-johnny-chi2023.pdf) · [TaleBrush](https://johnr0.github.io/assets/publications/CHI2022-TaleBrush.pdf) · [Shneiderman & Maes 1997](https://www.cs.umd.edu/users/ben/papers/Shn-Maes-v4n6-1997.pdf) · [Shneiderman 1983](https://www.cl.cam.ac.uk/~pr10/iui/shneiderman83.pdf) · [Instrumental Interaction](https://www.lri.fr/~mbl/papers/CHI2000/) · [Stylette](https://kixlab.github.io/website-files/2022/chi2022-stylette-paper.pdf)
