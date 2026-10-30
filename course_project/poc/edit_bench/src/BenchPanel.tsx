import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import type {StudioService} from "@/service/StudioService"
import {runEditRate} from "./EditRate"
import {runLeadTime} from "./LeadTime"
import {runAutomation} from "./Automation"
import {runDeviceChanges} from "./DeviceChanges"
import {AgentLoop, Strategy} from "./DragUndo"
import {Holds} from "./Holds"

// Edit bench: runs the checks in project_plan/OPENDAW.md ("Checks") against the open project, from buttons
// or from window.editBench (the headless test). Each check adds its own instruments to the project, so run it in a
// scratch project. Results are logged here and returned as JSON.

type Construct = { lifecycle: Lifecycle, service: StudioService }

export type EditBenchApi = {
    editRate(seconds: number): Promise<unknown>
    leadTime(): Promise<unknown>
    automation(): Promise<unknown>
    devices(): Promise<unknown>
    startAgent(strategy: Strategy): void
    stopAgent(): unknown
    holds(): unknown
}

declare global {
    interface Window {editBench?: EditBenchApi}
}

const EditRateSeconds = 30
const Strategies: ReadonlyArray<Strategy> = ["direct", "append", "queue"]

export const BenchPanel = ({lifecycle, service}: Construct): HTMLElement => {
    const status: HTMLElement = <p data-testid="bench-status" style={{margin: "0"}}>No project open.</p>
    const held: HTMLElement = <span data-testid="bench-held">none</span>
    const output: HTMLElement = (
        <pre data-testid="bench-output"
             style={{flex: "1 0 0", overflow: "auto", margin: "0", fontSize: "11px", whiteSpace: "pre-wrap"}}/>
    )
    const button = (testId: string, text: string): HTMLButtonElement =>
        <button data-testid={testId} disabled>{text}</button>
    const editRate = button("bench-edit-rate", `1. Edit rate (${EditRateSeconds} s per case)`)
    const leadTime = button("bench-lead-time", "2. Lead time")
    const automation = button("bench-automation", "3. Automation")
    const devices = button("bench-devices", "7. Devices")
    const agentToggle = button("bench-agent", "4. Start agent")
    const strategy: HTMLSelectElement = (
        <select data-testid="bench-strategy">{Strategies.map(name => <option value={name}>{name}</option>)}</select>
    )
    const runButtons = [editRate, leadTime, automation, devices]
    const log = (line: string): void => {
        output.textContent += `${line}\n`
        output.scrollTop = output.scrollHeight
        console.debug(`[bench] ${line}`)
    }

    const projectRuntime = lifecycle.own(new Terminator())
    lifecycle.own({terminate: () => delete window.editBench})
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        projectRuntime.terminate()
        delete window.editBench
        optProfile.match({
            none: () => {
                status.textContent = "No project open."
                for (const element of [...runButtons, agentToggle]) {element.disabled = true}
            },
            some: ({project, meta}) => {
                status.textContent = `Project '${meta.name}'. Checks add instruments: use a scratch project.`
                const holds = projectRuntime.own(new Holds(project))
                projectRuntime.own(holds.subscribe(() => held.textContent =
                    holds.any() ? holds.held().map(record => `${record.label} ${record.address}`).join(", ") : "none"))
                let agent: AgentLoop | null = null
                projectRuntime.own({terminate: () => agent?.stop()})
                const api: EditBenchApi = {
                    editRate: seconds => exclusive(() => runEditRate(project, service.audioContext.sampleRate, {seconds}, log)),
                    leadTime: () => exclusive(() => runLeadTime(project, log)),
                    automation: () => exclusive(() => runAutomation(project, log)),
                    devices: () => exclusive(() => runDeviceChanges(project, service.audioContext.sampleRate, log)),
                    startAgent: name => {
                        if (agent !== null) {return}
                        agent = new AgentLoop(project, holds, name)
                        agentToggle.textContent = "4. Stop agent"
                        log(`agent: editing every 250 ms (${name})`)
                    },
                    stopAgent: () => {
                        if (agent === null) {return null}
                        const result = agent.stop()
                        agent = null
                        agentToggle.textContent = "4. Start agent"
                        log(`agent: ${JSON.stringify(result)}`)
                        return result
                    },
                    holds: () => holds.records()
                }
                const exclusive = async <T, >(check: () => Promise<T>): Promise<T> => {
                    runButtons.forEach(element => element.disabled = true)
                    try {
                        const result = await check()
                        log(JSON.stringify(result))
                        return result
                    } catch (error) {
                        log(`failed: ${error instanceof Error ? error.message : String(error)}`)
                        throw error
                    } finally {
                        runButtons.forEach(element => element.disabled = false)
                    }
                }
                window.editBench = api
                for (const element of [...runButtons, agentToggle]) {element.disabled = false}
                editRate.onclick = () => api.editRate(EditRateSeconds)
                leadTime.onclick = () => api.leadTime()
                automation.onclick = () => api.automation()
                devices.onclick = () => api.devices()
                agentToggle.onclick = () => agent === null
                    ? api.startAgent(Strategies.find(name => name === strategy.value) ?? "direct")
                    : api.stopAgent()
            }
        })
    }))

    return (
        <div data-testid="bench-panel"
             style={{flex: "1 0 0", display: "flex", flexDirection: "column", rowGap: "0.5em", padding: "1em",
                 minWidth: "0", minHeight: "0", overflow: "hidden"}}>
            <h3 style={{margin: "0"}}>Edit bench</h3>
            {status}
            <p style={{margin: "0", display: "flex", flexWrap: "wrap", gap: "0.5em"}}>{runButtons}</p>
            <p style={{margin: "0"}}>{agentToggle} strategy {strategy}</p>
            <p style={{margin: "0"}}>5. Held: {held}</p>
            {output}
        </div>
    )
}
