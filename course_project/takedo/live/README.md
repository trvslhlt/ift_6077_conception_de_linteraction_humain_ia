# Live sessions: an agent at the terminal working in the open studio

For comparing the utility with Claude Code working in openDAW directly (project_plan/EXPERIMENTS.md, G).

1. Start a separate Chrome with remote debugging (Chrome refuses it on the everyday profile), on TakeDo's origin:
   ```sh
   open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-opendaw-live" http://localhost:8080
   ```
   Projects live in the browser profile: bring one in as an `.odb` bundle (export it from the other profile).
2. Open the project, set the loop, press play. Leave TakeDo's chat alone in that tab, so the utility doesn't edit too.
3. From `takedo/`: `node live/eval.mjs '<body>'` or `node live/eval.mjs -f file.js`. The body is an async function
   with the utility's names in scope (`takedo`, `project`, `api`, `lib`, `ref`, `bar`, `ppqn`, `pos`, `snapshot`),
   `adapter`, and `apply(plan, when, {wait})`: a fixed operation or script through the bus, landing on a bar
   (`{at: "bar", bar: 5}`, `{at: "next", unit: "bar"}`, `{at: "asap"}`). It resolves once scheduled, or once done
   with `wait: true`. Send a whole staged plan in one call (`Promise.all` of `apply`s) so it's timed from one
   playhead. Scripts go through the same range guard as the utility's.
4. `project.engine.play()` / `.stop()` start and stop playback.

Requests from here are attributed to `agent:live`; their statuses reach the backend's session log.
