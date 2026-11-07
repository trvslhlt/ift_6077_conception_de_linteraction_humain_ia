import {readFileSync} from "node:fs"
import Anthropic from "@anthropic-ai/sdk"
import {TypeSafeClient, type JsonValue, type Questions} from "@typesafe-ai/sdk"

// The model gateway (ARCHITECTURE.md, "The model is a setting"): every model call goes through here. Callers name a
// job; config/models.json says which provider and model does it. Each call is logged with its job, provider, model,
// latency and tokens. One adapter per provider: TypeSafe (System One judgments, the fast tier) and Anthropic (text and
// plans, the slow tier).

type Effort = "low" | "medium" | "high"
type JobConfig =
    | { provider: "typesafe", model: string | null }
    | { provider: "anthropic", model: string, effort?: Effort, maxTokens?: number }
type Config = { jobs: Record<string, JobConfig> }
export type ModelLog = (entry: { job: string, provider: string, model: string, ms: number, inputTokens: number,
    outputTokens?: number, cacheRead?: number, cacheWrite?: number, agent?: string, error?: string }) => void

export const loadConfig = (path: string): Config => JSON.parse(readFileSync(path, "utf8"))

const Keys = {typesafe: "TYPESAFE_API_KEY", anthropic: "ANTHROPIC_API_KEY"} as const

const MaxLookupRounds = 2

const textOf = (response: Anthropic.Message): string =>
    response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("")

export class Gateway {
    readonly #config: Config
    readonly #typesafe: TypeSafeClient | null
    readonly #anthropic: Anthropic | null

    constructor(config: Config) {
        this.#config = config
        this.#typesafe = process.env.TYPESAFE_API_KEY ? new TypeSafeClient() : null
        this.#anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
    }

    available(job: string): boolean {
        const config = this.#config.jobs[job]
        if (config === undefined) {return false}
        return config.provider === "typesafe" ? this.#typesafe !== null : this.#anthropic !== null
    }

    // Why a job can't run, for a reply to the producer; null when it can.
    missing(job: string): string | null {
        const config = this.#config.jobs[job]
        if (config === undefined) {return `no model is configured for ${job} (config/models.json)`}
        return this.available(job) ? null : `${Keys[config.provider]} isn't set in takedo/.env`
    }

    async judge<const Q extends Questions>(job: string, state: { [key: string]: JsonValue }, questions: Q,
                                           log: ModelLog, agent?: string) {
        const config = this.#job(job, "typesafe")
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

    // One message in, text out.
    async write(job: string, system: string, user: string, log: ModelLog, agent?: string): Promise<string> {
        const response = await this.#create(job, {system, messages: [{role: "user", content: user}]}, log, agent)
        return textOf(response)
    }

    // One message in, JSON matching `schema` out (structured outputs).
    async structured<T>(job: string, system: string, user: string, schema: Record<string, unknown>, log: ModelLog,
                        agent?: string): Promise<T> {
        const response = await this.#create(job, {system, messages: [{role: "user", content: user}]}, log, agent,
            {type: "json_schema", schema})
        return JSON.parse(textOf(response)) as T
    }

    // One message in, tool calls out: the calls are the plan, carried out by the caller (as in poc/llm_bench). Tools
    // should be strict, so their inputs match their schemas. text: anything said besides. Lookup tools are answered
    // here: while a reply calls one, `lookup` gives the result and the model continues (at most MaxLookupRounds),
    // with the plan's calls so far acknowledged, not repeated.
    async calls(job: string, system: string, user: string, tools: Anthropic.Tool[], log: ModelLog, agent?: string,
                lookup: (name: string, input: unknown) => string | null = () => null)
        : Promise<{ calls: Array<{ name: string, input: unknown }>, text: string }> {
        const messages: Anthropic.MessageParam[] = [{role: "user", content: user}]
        const calls: Array<{ name: string, input: unknown }> = []
        const texts: string[] = []
        for (let round = 0; round <= MaxLookupRounds; round++) {
            const response = await this.#create(job, {system, messages, tools}, log, agent)
            texts.push(textOf(response))
            const uses = response.content.flatMap(block => block.type === "tool_use" ? [block] : [])
            const results = uses.map(use => ({use, found: lookup(use.name, use.input)}))
            results.filter(({found}) => found === null).forEach(({use}) => calls.push({name: use.name, input: use.input}))
            if (results.every(({found}) => found === null) || round === MaxLookupRounds) {break}
            messages.push({role: "assistant", content: response.content}, {role: "user", content: results.map(({use, found}) => ({
                type: "tool_result" as const, tool_use_id: use.id, content: found ?? "Noted; it will be carried out."}))})
        }
        return {calls, text: texts.join(" ").trim()}
    }

    // One turn of a conversation the caller keeps (a tool loop it runs itself, e.g. the utility's look-and-try).
    turn(job: string, system: string, messages: Anthropic.MessageParam[], tools: Anthropic.Tool[], log: ModelLog,
         agent?: string): Promise<Anthropic.Message> {
        return this.#create(job, {system, messages, tools}, log, agent, undefined, true)
    }

    async #create(job: string, params: Pick<Anthropic.MessageCreateParamsNonStreaming, "system" | "messages" | "tools">,
                  log: ModelLog, agent?: string, format?: Anthropic.JSONOutputFormat,
                  cache?: true): Promise<Anthropic.Message> {
        const config = this.#job(job, "anthropic")
        if (this.#anthropic === null) {throw new Error("ANTHROPIC_API_KEY is not set (takedo/.env)")}
        const start = performance.now()
        try {
            const output = {...(config.effort ? {effort: config.effort} : {}), ...(format ? {format} : {})}
            const response = await this.#anthropic.messages.create({
                model: config.model, max_tokens: config.maxTokens ?? 4000, ...params,
                // A conversation re-sent each round: cache it, so a round pays full price only for what's new.
                ...(cache ? {cache_control: {type: "ephemeral" as const}} : {}),
                ...(Object.keys(output).length > 0 ? {output_config: output} : {})
            })
            log({job, provider: config.provider, model: response.model, ms: Math.round(performance.now() - start),
                inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
                cacheRead: response.usage.cache_read_input_tokens ?? 0, cacheWrite: response.usage.cache_creation_input_tokens ?? 0, agent})
            if (response.stop_reason === "refusal") {throw new Error("the model declined")}
            if (response.stop_reason === "max_tokens") {throw new Error("the model ran out of tokens")}
            return response
        } catch (error) {
            log({job, provider: config.provider, model: config.model, ms: Math.round(performance.now() - start),
                inputTokens: 0, agent, error: String(error)})
            throw error
        }
    }

    #job<P extends JobConfig["provider"]>(job: string, provider: P): Extract<JobConfig, { provider: P }> {
        const config = this.#config.jobs[job]
        if (config === undefined) {throw new Error(`no model configured for job ${job}`)}
        if (config.provider !== provider) {throw new Error(`job ${job} is configured for ${config.provider}, not ${provider}`)}
        return config as Extract<JobConfig, { provider: P }>
    }
}
