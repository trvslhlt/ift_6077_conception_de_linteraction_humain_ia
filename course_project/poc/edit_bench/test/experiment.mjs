// Runs one experiment from project_plan/EXPERIMENTS.md in headless Chromium, in a new project, and saves its result
// to results/experiment-<name>-<time>.json. EXPERIMENT is C or D; TRIALS sets C's trials per condition.
// Run via `make experiment EXPERIMENT=C`.
import {chromium} from "playwright"
import {mkdirSync, writeFileSync} from "node:fs"
import {openBench} from "./studio.mjs"

const URL = process.env.URL ?? "http://localhost:8080/"
const TIMEOUT = 60000
const NAME = (process.env.EXPERIMENT ?? "").toUpperCase()
const TRIALS = process.env.TRIALS ? Number(process.env.TRIALS) : undefined
if (!["C", "D"].includes(NAME)) {
    console.error("EXPERIMENT must be C or D")
    process.exit(2)
}

mkdirSync("results", {recursive: true})
const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
const page = await browser.newPage({viewport: {width: 1440, height: 900}})
page.setDefaultTimeout(TIMEOUT)
page.on("console", message => {if (message.text().startsWith("[bench] experiment")) console.log(message.text())})
let failed = false
try {
    await openBench(page, URL, TIMEOUT)
    const startedAt = new Date().toISOString()
    const result = await page.evaluate(([name, trials]) => window.editBench.experiment(name, trials), [NAME, TRIALS])
    const file = `results/experiment-${NAME}-${startedAt.replace(/[:.]/g, "-")}.json`
    writeFileSync(file, JSON.stringify({experiment: NAME, startedAt, result}, null, 2))
    console.log(JSON.stringify(NAME === "C" ? result.summary : result, null, 2))
    console.log(`saved to ${file}`)
} catch (error) {
    console.error(`experiment ${NAME} failed: ${error.message.split("\n")[0]}`)
    failed = true
} finally {
    await browser.close()
}
process.exit(failed ? 1 : 0)
