# Final Draft

## Project Proposal: Conductair

**Reframing Music Performance through the Metaphor of a Conductor and Autonomous AI Agent Ensembles**

1. Abstract  
   1. Digital Audio Workstations (DAWs) require creators to translate high-level expressive intents into many low-level parameter modifications across a project. This technical friction creates a bottleneck: human creators think in perceptual, qualitative terms (e.g., wanting a lead synth to "float over the mix"), yet software interfaces only accept granular technical inputs like fader automation, plugin bypasses, and EQ frequency bands. Each artistic impulse requires translation into a series of precise parameter moves disconnected from the creator’s intent.  
   2. We propose **Conductair**, an interactive system that reframes live music performance through the metaphor of a *conductor directing an ensemble of autonomous musicians*. Rather than manually tweaking atomic, low-level controls, the user communicates high-level expressive goals (e.g., "make the lead synth float over the mix and have the rhythm section match its intensity"). Grounded in HCI theories of *Interface Metaphors* and *Direct Manipulation*, our system architecture supports multi-modal user input, headlined by expressive physical gestures and supported by natural language interfaces.  
   3. Each track in the DAW is managed by an AI agent that interprets real-time conductor direction into concrete project changes, while preserving the ability to make manual edits in a traditional DAW view. When the conductor communicates a high-level intent, the intent is routed through the change bus to the corresponding agent(s)—such as a 'String Section' bus agent or individual track agents—which dynamically calculate and execute the necessary low-level parameter moves (e.g., boosting saturation, sharpening attack transients, and adjusting EQ dynamic range) on their assigned tracks. Beyond live control, Conductair introduces a live performance capture pipeline that bakes real-time agent interpretations back into the DAW as editable parameter automation curves. This work demonstrates how multi-agent delegation can dramatically expand a creator's control surface in complex domain software without sacrificing post-performance editability.  
2. Introduction  
     
   1. Motivation and Importance  
        
      1. Digital audio production and live performance present a fundamental translation problem: human creators think in perceptual and expressive terms (Cartwright & Pardo, 2013; Stables et al., 2014), but software interfaces only accept concrete technical inputs. A performer might want a string section to sound "more aggressive" or the ambient pads to "recede into the background," but traditional DAWs force them to navigate complex and dynamic UIs to implement these intents.  
      2. This mismatch harms creators in a few ways:  
         1. **Physical Control Limits:** Human operators are limited by two hands. Tweaking parameters across multiple tracks simultaneously in real time is physically impossible without extensive pre-programmed automation. (accessibility limited as well)  
         2. **Experienced producers** suffer cognitive fatigue from repetitive tedious actions.  
         3. **Non-technical musicians** lack the vocabulary and muscle memory required to map expressive goals to complex controls (Seetharaman & Pardo, 2016; Louie et al., 2020).

      

   2. Why Existing Solutions Are Not Enough  
        
      1. Existing solutions address some of the same issues as Conductair, but introduce challenges of their own:  
         1. Text-to-audio generative AI systems like Suno or Udio generate fully rendered audio from prompts. The output is a black box: it lacks precision, offers few adjustment capabilities, and has drawn copyright suits from major labels, only partly resolved by licensing settlements in 2025\.  
         2. Existing LLM-based plugins either hand the user a set of manipulation instructions to carry out, or, more recently, execute edits directly in the DAW (Elkins et al., 2025). Both work one chat request at a time, which forces context-switching between the chat and DAW controls and cannot follow a live performance.  
         3. Early gesture-based music systems, like MIDI gesture controllers, map physical motions directly to single hardware values (e.g., hand height \= master volume) (Hunt et al., 2003). These lack semantic depth and fail to scale beyond simple 1:1 parameter mappings.

      

   2. Solution Description & System Architecture  
        
      1. We propose **Conductair**, a novel interactive system built on the *Performer as Conductor* metaphor. Rather than acting as a low-level operator directly tweaking software parameters, the performer assumes the role of a conductor directing an ensemble of specialized AI agents representing virtual musicians and sound engineers.  
           
         1. **Multi-Modal Conductor Interface:** Designed primarily for expressive physical gesture input (e.g., conducting batons, hand motion tracking), scaffolded by a natural language text interface for precise configuration.  
         2. **Flexible Agent-to-Track Mapping:** By default, each agent manages one DAW track, controlling its volume, effect, and sends. However, the architecture flexibly allows specialized agents such as a Master Bus Engineer managing global dynamics, or multi-agent pairings on complex lead tracks.  
         3. **Dual-View & Bi-Directional Change Bus:** The system features two separate views: a high-level *Conductor View* for directing agents, and a traditional *DAW timeline view* for direct manipulation. A bi-directional change bus ensures that when a performer manually adjusts a fader in the DAW, the corresponding AI agent observes the change and updates its context accordingly.  
         4. **Live Performance Capture:** During a live performance, all real-time agent interventions are recorded in the DAW timeline as non-destructive parameter automation curves (and optionally MIDI performance clips as a stretch goal). After the performance, the creator can inspect, fine-tune, or edit every single node by hand.  
         5. **Two-Tier Intent Interpretation:** Instead of generating free-form parameter values, a fast typed-judgment model (e.g. Jev; TypeSafe, 2026\) chooses among predefined options for routine instructions: the agents addressed, an expressive descriptor (e.g., *aggressive*, *float*, *recede*) and an intensity. Compound or novel instructions go to an LLM, whose plans are also structured: recipes, gesture mappings and coordination rules between agents. Every command that reaches the DAW is therefore well-formed and reproducible.

         

      2. System Layers (**for illustration purposes only**) (Figure 1). Conductor input is interpreted, then routed to the agent ensemble. Agents never write to the DAW directly. They propose changes to the Change Bus, which applies them to the openDAW project state and records them onto automation lanes. Manual edits in the DAW timeline view enter the same project state, and the bus reports them back up to the agents as change events. The conductor view shows what each agent is doing.  
         1. ![][image1]  
         2. **\[Figure 1\]** *System layers. Every change, from an agent or from the performer's hands, passes through the Change Bus, which also records agent moves as editable automation.*

         

      3. **Bi-Directional Control (Figure 2).** When the conductor asks for "aggressive strings," the strings agent proposes drive, attack and EQ moves, and the bus applies and records them. If the performer then grabs the strings fader, openDAW emits a change event marked as human. The bus marks that parameter as *human-held*, and agent writes to it are dropped until the performer lets go, as in the Touch and Latch automation modes DAWs already provide. The agent is notified of the override and adjusts its later moves instead of competing with the performer.  
         1. ![][image2]  
         2. **\[Figure 2\]** *One intent, one override. Conflicts are settled in the Change Bus, and the performer always has priority.*

      

   2. Grounding in Interaction Theories  
        
      1. Interface Metaphors: Conductair leverages the classic conductor-orchestra real-world model (Carroll et al., 1988). By mapping software actions to a familiar conducting paradigm, the system reduces semantic distance (the cognitive effort required to translate intentions into actions; Hutchins et al., 1985\) and increases semantic depth (providing expressive control over complex systems without being overburdened by process or syntax). Rather than formulating concrete parameter changes, the performer uses intuitive gestures and qualitative musical phrasing.  
      2. Direct Manipulation & Mixed-Initiative Interaction: Delegating to agents has long been seen as in tension with direct manipulation (Shneiderman & Maes, 1997). Conductair keeps both. The user retains complete authority: by providing rapid, incremental, and reversible operations (Shneiderman, 1983\) through the dual-view architecture, a primary strength of this solution is that it allows the user to work at a high level without removing their ability to work at a low level. Following mixed-initiative principles (Horvitz, 1999; Amershi et al., 2019), agents act when confident and ask when unsure, and users can instantly override any agent action by touching the physical DAW controls directly (Figure 2).  
2. Related Work  
   1. To contextualize Conductair, we categorize existing literature and commercial tools into three primary themes:  
      1. Theme 1: Conversational AI and Intent-Based Creative Interfaces Prior research in creative software copilots explores shifting user interaction from low-level execution to high-level delegation. Systems in code generation (e.g., GitHub Copilot) and visual design explore agentic execution, but few address real-time continuous performance. In music, Loop Copilot already frames an LLM as conducting an AI ensemble (Zhang et al., 2023), but its ensemble generates audio rather than performing on an existing project. DAWZY translates text and voice requests into reversible DAW edits (Elkins et al., 2025), and LLMs can predict effect parameters from text descriptions (Doh et al., 2025; Chu et al., 2025). These systems work one request at a time and are too slow for gesture-rate control during live playback. Automatic mixing research (De Man et al., 2017; De Man et al., 2019\) and commercial tools like iZotope Neutron (Assistant View & Target Library) and Sonible pure:bundle provide stem-level diagnostics and automated parameter suggestions, but they typically act as diagnostic black boxes or one-off fixers rather than a continuous, collaborative partner. Logic Pro's Session Players (Apple, 2024\) show that an AI backing band is commercially accepted, but those players follow chords, not a conductor.  
      2. Theme 2: Embodied Music Interaction & Gesture-Based Conducting Embodied interaction in music has a rich history, from early motion-tracking conducting jackets (Marrin & Picard, 1998\) and interactive conducting exhibits (Borchers et al., 2004\) to depth-camera gesture controllers. However, these systems were largely bound to fixed mappings (e.g., arm height controlling master gain; Hunt et al., 2003), and even mappings learned from examples (Fiebrink, 2011\) stay fixed during performance, lacking semantic depth and failing to coordinate multiple elements simultaneously. Conductair builds on this work by placing a semantic layer between gesture and sound. A spoken or typed instruction determines what a gesture means: which sub-mix it drives and which expressive quality it shapes. A simple physical gesture can then trigger coordinated multi-parameter moves across entire sub-mixes.  
      3. Theme 3: Digital Audio Workstation Architectures & Mixed-Initiative Control Research into DAW usability highlights the friction between rigid timeline grids and open-ended creative exploration. Projects like *EuterPen* (Cavez et al., 2025\) and interactive score surfaces investigate alternative input modalities for score creation. Conductair differentiates itself by focusing on post-composition performance and arrangement, utilizing open Web-based DAW architectures (e.g., openDAW; Michelle, 2026\) to create an observable, shared state where human and AI agents collaborate synchronously.  
   2. How Our Work Differs and Builds Upon Previous Work  
      1. While prior research and commercial tools have explored generative AI, conversational assistants, and embodied control for music, they leave a critical gap between high-level creative intent and granular session-level control. Conductair addresses these limitations through three core departures:  
         1. Beyond Black-Box Generation (vs. Text-to-Audio Generators):  
            1. *Existing limitations:* Generative tools (such as Suno, Udio, or deep learning music visualizers) produce fully rendered audio stems from text prompts, but they function as opaque black boxes. They strip away user agency, offer zero granular stems or plugin parameter access for post-processing, and have faced copyright litigation over their training data.  
            2. *How Conductair builds on this:* Rather than generating final audio files, Conductair treats AI as a performing ensemble and technical crew operating directly on an existing DAW project state. The output is not a static audio file, but live performance data (parameter automation curves) applied to real tracks, ensuring full transparency, granular editability, and creative ownership. It bridges live emotional expression with traditional non-destructive post-production, easing the long-standing conflict between "live take" and "precision mix."  
         2. Moving Beyond the "To-Do List" Trap (vs. Conversational Copilots):  
            1. *Existing limitations:* Current LLM-based creative copilots and chat plugins act as conversational advisors that instruct the user on what to do (e.g., handing the user a text-based "to-do list" like *"Click Solo on Track 3 and cut 3dB at 200Hz"*). Even assistants that execute edits directly (Elkins et al., 2025\) work turn by turn in a chat box, apart from the performance. This forces the creator into constant, distracting context-switching between the chat thread and a dense DAW timeline.  
            2. *How Conductair builds on this:* Conductair eliminates text-based instruction by introducing a Bi-Directional Change Bus. The AI agents do not tell the user how to mix; they programmatically execute the changes directly within the shared session state, allowing the creator to maintain an uninterrupted artistic flow.  
         2. Scaling Beyond Deterministic 1:1 Mapping (vs. Traditional Gesture & MIDI Controllers):  
            1. *Existing limitations:* Classical embodied music interfaces (such as motion-tracking conducting jackets or depth-camera controllers) map physical motion to digital sound. However, these systems rely on rigid, deterministic 1:1 hardware mappings (e.g., hand height tied strictly to master volume; Hunt et al., 2003), lacking semantic depth and failing to coordinate multiple elements simultaneously.  
            2. *How Conductair builds on this:* Conductair merges expressive physical gesture input with **agentic interpretation**. A System One model turns routine instructions into typed commands addressed to one or more agents, and an LLM plans compound ones as structured coordination rules. Each agent compiles the command into concrete parameter moves on its tracks, and gestures then modulate those moves continuously. Interpretation is probabilistic, but execution is deterministic and inspectable: the same command always produces the same moves, and every move lands on the timeline as editable automation. A single conducting gesture can thus orchestrate multi-parameter shifts across entire sub-mixes (e.g., a leader-follower dynamic where one track's delay adjustment automatically adapts another track's spatial effects).  
   2. By combining multi-modal conductor input, autonomous agent ensembles, and non-destructive performance capture onto a shared DAW timeline, Conductair bridges the gap between live physical expression and rigorous digital production.  
2. Technical Feasibility & Research Impact  
   1. Technical Implementation Plan & Risks  
        
      1. DAW Backend: We leverage openDAW (Michelle, 2026), an open-source, Web Audio API and TypeScript-based DAW. Its state is fully observable and exposed programmatically, making it the ideal engine for real-time bi-directional state synchronization.  
           
      2. Control at Three Speeds (Figure 3): A gesture's audible response should arrive within about 10 ms (Wessel & Wright, 2001), far less than a language model takes, so Conductair separates control into three tiers, much as dual-system robot controllers pair a slow planner with a fast policy (Figure AI, 2025; Kahneman, 2011).  
           
         1. *Every frame:* camera-based hand tracking (e.g., MediaPipe; Zhang et al., 2020\) produces gesture features such as height, speed and spread, which are applied through each agent's gesture mapping with no model in the loop.  
         2. *Per instruction:* spoken or typed instructions are interpreted by **Jev**, TypeSafe's System One model (TypeSafe, 2026), which returns typed judgments and probabilities rather than generated text: whether each agent is addressed, an expressive descriptor chosen from a fixed vocabulary, an intensity score, and whether the instruction needs deeper planning. Agents map each descriptor to a recipe of parameter moves in code, building on crowdsourced descriptor-to-effect maps (Cartwright & Pardo, 2013; Stables et al., 2014\) (e.g., *aggressive* → more drive, faster attack, an upper-mid boost), scaled by intensity, and select their gesture mapping.  
         3. *Per plan:* compound or novel instructions (e.g., "have the rhythm section match the lead's intensity") go to an LLM, which plans over the session state and returns structured output: new recipes (LLMs can already predict effect parameters from text; Doh et al., 2025), gesture mappings, and coordination rules between agents, such as a leader-follower link. These are validated before agents use them and saved for reuse, so execution never waits on a model.  
            1. ![][image3]  
            2. **Figure 3\]** *Three speeds. Gestures never wait on a model; Jev handles routine instructions and the LLM plans complex ones.*

         

      3. Mixed-Initiative Control: Jev's probabilities determine how the system acts (Horvitz, 1999). Confident interpretations execute immediately; uncertain ones, and LLM plans that touch many agents, are shown in the Conductor View for the performer to confirm.  
           
      4. Technical Risks:  
           
         1. *Concurrent writes.* Human and agent changes may target the same parameter. The Change Bus resolves this with the human-held rule (Figure 2\) and must do so without audio jitter.  
         2. *Vocabulary coverage.* A fixed descriptor vocabulary may not cover what musicians actually say. We will measure the share of instructions that need the LLM and grow the vocabulary from those cases.  
         3. *Recipe validity.* A recipe for *aggressive*, hand-written or LLM-authored, may not match what performers hear as aggressive. We will check recipes against listener judgments in a pilot study, following the listener evaluation in Chu et al. (2025).  
         4. *Latency.* We will measure end-to-end latency separately for the gesture, Jev and LLM paths.  
   2. Expected Impact & Scientific Contribution  
      1. This project demonstrates a scalable paradigm for the agentic expansion of human control surfaces in complex creative applications. By showing how multi-agent delegation can coexist with traditional direct-manipulation timelines and non-destructive performance capture, Conductair establishes design principles applicable across domains beyond music—including video editing, 3D animation, and complex live system administration. Furthermore, it introduces novel possibilities such as Emergent Inter-Agent Coordination (e.g., leader-follower dynamics where a rhythm track agent automatically adapts its delay time to match a synth lead) and flexible multi-musician track assignments.

## References

- Amershi, S., Weld, D., Vorvoreanu, M., et al. (2019). Guidelines for Human-AI Interaction. *CHI '19*.  
- Apple (2024). Logic Pro takes music making to the next level with new AI features. Apple Newsroom.  
- Borchers, J., Lee, E., Samminger, W., & Mühlhäuser, M. (2004). Personal Orchestra: A Real-Time Audio/Video System for Interactive Conducting. *Multimedia Systems*, 9(5).  
- Carroll, J. M., Mack, R. L., & Kellogg, W. A. (1988). Interface Metaphors and User Interface Design. In *Handbook of Human-Computer Interaction*. North-Holland.  
- Cartwright, M., & Pardo, B. (2013). Social-EQ: Crowdsourcing an Equalization Descriptor Map. *ISMIR*.  
- Cavez, V., Letondal, C., Appert, C., & Pietriga, E. (2025). EuterPen: Unleashing Creative Expression in Music Score Writing. *CHI '25*.  
- Chu, A., O'Reilly, P., Barnett, J., & Pardo, B. (2025). Text2FX: Harnessing CLAP Embeddings for Text-Guided Audio Effects. *ICASSP*.  
- De Man, B., Reiss, J. D., & Stables, R. (2017). Ten Years of Automatic Mixing. *Workshop on Intelligent Music Production (WIMP)*.  
- De Man, B., Stables, R., & Reiss, J. D. (2019). *Intelligent Music Production*. Focal Press.  
- Doh, S., Koo, J., Martínez-Ramírez, M. A., Liao, W.-H., Nam, J., & Mitsufuji, Y. (2025). Can Large Language Models Predict Audio Effects Parameters from Natural Language? *WASPAA*.  
- Elkins, A. C., Singh, S., Kieback, A., Blankenship, S., Amadasun, U. P., & Chadha, A. (2025). DAWZY: A New Addition to AI powered "Human in the Loop" Music Co-creation. arXiv:2512.03289.  
- Fiebrink, R. (2011). *Real-Time Human Interaction with Supervised Learning Algorithms for Music Composition and Performance*. PhD thesis, Princeton University.  
- Figure AI (2025). Helix: A Vision-Language-Action Model for Generalist Humanoid Control. [https\://www\.figure.ai/news/helix](https://www.figure.ai/news/helix)  
- Horvitz, E. (1999). Principles of Mixed-Initiative User Interfaces. *CHI '99*.  
- Hunt, A., Wanderley, M. M., & Paradis, M. (2003). The Importance of Parameter Mapping in Electronic Instrument Design. *Journal of New Music Research*, 32(4).  
- Hutchins, E. L., Hollan, J. D., & Norman, D. A. (1985). Direct Manipulation Interfaces. *Human–Computer Interaction*, 1(4).  
- Kahneman, D. (2011). *Thinking, Fast and Slow*. Farrar, Straus and Giroux.  
- Louie, R., Coenen, A., Huang, C. Z. A., Terry, M., & Cai, C. J. (2020). Novice-AI Music Co-Creation via AI-Steering Tools for Deep Generative Models. *CHI '20*.  
- Marrin, T., & Picard, R. (1998). The "Conductor's Jacket": A Device for Recording Expressive Musical Gestures. *ICMC*.  
- Michelle, A. (2026). openDAW. [https\://github.com/andremichelle/openDAW](https://github.com/andremichelle/openDAW)  
- Seetharaman, P., & Pardo, B. (2016). Audealize: Crowdsourced Audio Production Tools. *Journal of the Audio Engineering Society*.  
- Shneiderman, B. (1983). Direct Manipulation: A Step Beyond Programming Languages. *Computer*, 16(8).  
- Shneiderman, B., & Maes, P. (1997). Direct Manipulation vs. Interface Agents. *Interactions*, 4(6).  
- Stables, R., Enderby, S., De Man, B., Fazekas, G., & Reiss, J. D. (2014). SAFE: A System for the Extraction and Retrieval of Semantic Audio Descriptors. *ISMIR*.  
- TypeSafe (2026). System One and Jev. [https\://docs.typesafe.ai/concepts/system-one](https://docs.typesafe.ai/concepts/system-one)  
- Wessel, D., & Wright, M. (2001). Problems and Prospects for Intimate Musical Control of Computers. *NIME*.  
- Zhang, F., Bazarevsky, V., Vakunov, A., et al. (2020). MediaPipe Hands: On-device Real-time Hand Tracking. arXiv:2006.10214.  
- Zhang, Y., Maezawa, A., Xia, G., Yamamoto, K., & Dixon, S. (2023). Loop Copilot: Conducting AI Ensembles for Music Generation and Iterative Editing. arXiv:2310.12404.
