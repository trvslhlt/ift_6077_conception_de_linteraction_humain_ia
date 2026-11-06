import {createElement} from "@opendaw/lib-jsx"
import type {TeamMember} from "@/takedo_shared/protocol"

// @mentions in the team view: who can be mentioned (the backend's "team" message), mentions styled in chat lines and
// in the input while typing, and an autocomplete list that opens on "@". The input's own text is transparent over a
// mirror that draws the same text with mentions coloured; no bold, so both lay out the same.

const MentionStyle = {color: "#7fd", background: "rgba(127, 255, 221, 0.14)", borderRadius: "3px"}
const Token = /@(\w+)/g

// Text with each @role of a team member as a styled span; other text (and unknown @names) as is.
export const withMentions = (text: string, team: ReadonlyArray<TeamMember>): Array<Node> => {
    const roles = new Set(team.map(member => member.role))
    const nodes: Array<Node> = []
    let last = 0
    for (const match of text.matchAll(Token)) {
        if (!roles.has(match[1])) {continue}
        nodes.push(document.createTextNode(text.slice(last, match.index)))
        nodes.push(<span data-testid="takedo-mention" data-role={match[1]} style={MentionStyle}>{match[0]}</span>)
        last = match.index + match[0].length
    }
    nodes.push(document.createTextNode(text.slice(last)))
    return nodes
}

type Construct = { team: () => ReadonlyArray<TeamMember>, onSend: (text: string) => void }

export const MentionInput = ({team, onSend}: Construct) => {
    const font = {fontFamily: "inherit", fontSize: "15px", lineHeight: "20px", letterSpacing: "normal"}
    const box = {padding: "0.6em 0.75em", border: "1px solid transparent", borderRadius: "4px", boxSizing: "border-box",
        width: "100%", whiteSpace: "pre", ...font} as const
    const mirror: HTMLElement = (
        <div aria-hidden="true" style={{...box, position: "absolute", inset: "0", overflow: "hidden",
            color: "inherit", pointerEvents: "none"}}/>
    )
    const input: HTMLInputElement = (
        <input data-testid="takedo-input" type="text" placeholder="Message the team (@ to mention someone)"
               autocomplete="off" spellcheck={false}
               style={{...box, position: "relative", background: "transparent", color: "transparent",
                   caretColor: "#cfd8dc", border: "1px solid #444"}}/>
    )
    const list: HTMLElement = (
        <ul data-testid="takedo-mention-list" role="listbox"
            style={{position: "absolute", bottom: "calc(100% + 4px)", left: "0", margin: "0", padding: "4px 0",
                listStyle: "none", minWidth: "220px", background: "#1d2126", border: "1px solid #444",
                borderRadius: "6px", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)", display: "none", zIndex: "1"}}/>
    )
    const element: HTMLElement = (
        <div style={{position: "relative", background: "#101214", borderRadius: "4px"}}>{mirror}{input}{list}</div>
    )
    let matches: ReadonlyArray<TeamMember> = []
    let selected = 0

    const render = (): void => {
        mirror.replaceChildren(...withMentions(input.value, team()))
        mirror.scrollLeft = input.scrollLeft
    }
    // The "@partial" just before the caret, if the caret is in one.
    const partial = (): { start: number, text: string } | null => {
        const before = input.value.slice(0, input.selectionStart ?? input.value.length)
        const match = /(^|\s)@(\w*)$/.exec(before)
        return match === null ? null : {start: before.length - match[2].length - 1, text: match[2].toLowerCase()}
    }
    const close = (): void => {
        matches = []
        list.style.display = "none"
    }
    const show = (): void => {
        list.replaceChildren(...matches.map((member, index) => {
            const item: HTMLElement = (
                <li data-testid="takedo-mention-option" data-role={member.role} role="option"
                    style={{padding: "4px 10px", cursor: "pointer", background: index === selected ? "#2a3a40" : "transparent"}}>
                    <span style={MentionStyle}>@{member.role}</span>
                    <div style={{fontSize: "10px", opacity: "0.7", whiteSpace: "normal"}}>{member.area}</div>
                </li>
            )
            item.onmousedown = (event: MouseEvent) => {
                event.preventDefault()
                accept(member)
            }
            return item
        }))
        list.style.display = matches.length === 0 ? "none" : "block"
    }
    const update = (): void => {
        render()
        const current = partial()
        if (current === null) {return close()}
        matches = team().filter(member => member.role.startsWith(current.text)
            || member.name.toLowerCase().includes(current.text))
        selected = Math.min(selected, Math.max(0, matches.length - 1))
        show()
    }
    const accept = (member: TeamMember): void => {
        const current = partial()
        if (current === null) {return}
        const caret = input.selectionStart ?? input.value.length
        const after = input.value.slice(caret).replace(/^\w*/, "")
        const inserted = `@${member.role} `
        input.value = input.value.slice(0, current.start) + inserted + after.replace(/^\s/, "")
        const position = current.start + inserted.length
        input.setSelectionRange(position, position)
        close()
        render()
    }

    input.oninput = update
    input.onclick = update
    input.onscroll = () => mirror.scrollLeft = input.scrollLeft
    input.onblur = close
    input.onkeydown = (event: KeyboardEvent) => {
        if (matches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                selected = (selected + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length
                return show()
            }
            if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault()
                return accept(matches[selected])
            }
            if (event.key === "Escape") {
                event.preventDefault()
                return close()
            }
        }
        if (event.key === "Enter" && input.value.trim() !== "") {
            onSend(input.value.trim())
            input.value = ""
            render()
        }
    }
    input.onkeyup = (event: KeyboardEvent) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {update()}
    }
    return {element, input, refresh: render}
}
