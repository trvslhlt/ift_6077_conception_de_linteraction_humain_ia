import {readFileSync} from "node:fs"
import {TypeSafeClient, type JsonValue, type Questions} from "@typesafe-ai/sdk"

// The model gateway (ARCHITECTURE.md, "The model is a setting"): every model call goes through here. Callers name a
// job; config/models.json says which provider and model does it. Each call is logged with its job, provider, model,
// latency and tokens. One adapter per provider; for now only TypeSafe (System One judgments for the fast tier).

type JobConfig = { provider: "typesafe", model: string | null }
type Config = { jobs: Record<string, JobConfig> }
export type ModelLog = (entry: { job: string, provider: string, model: string, ms: number, inputTokens: number,
    agent?: string, error?: string }) => void

export const loadConfig = (path: string): Config => JSON.parse(readFileSync(path, "utf8"))

export class Gateway {
    readonly #config: Config
    readonly #typesafe: TypeSafeClient | null

    constructor(config: Config) {
        this.#config = config
        this.#typesafe = process.env.TYPESAFE_API_KEY ? new TypeSafeClient() : null
    }

    available(job: string): boolean {
        const config = this.#config.jobs[job]
        return config !== undefined && (config.provider !== "typesafe" || this.#typesafe !== null)
    }

    async judge<const Q extends Questions>(job: string, state: { [key: string]: JsonValue }, questions: Q,
                                           log: ModelLog, agent?: string) {
        const config = this.#config.jobs[job]
        if (config === undefined) {throw new Error(`no model configured for job ${job}`)}
        if (this.#typesafe === null) {throw new Error("TYPESAFE_API_KEY is not set (takedo/.env)")}
        const start = performance.now()
        try {
            const result = await this.#typesafe.systemOne({state, questions, ...(config.model ? {model: config.model} : {})})
            log({job, provider: config.provider, model: result.model, ms: Math.round(performance.now() - start),
                inputTokens: result.usage.input_tokens ?? 0, agent})
            return result.answers
        } catch (error) {
            log({job, provider: config.provider, model: config.model ?? "default", ms: Math.round(performance.now() - start),
                inputTokens: 0, agent, error: String(error)})
            throw error
        }
    }
}
