// The notebook per opening of a project (notebook.ts). Run from backend/: node --test src/notebook.test.ts
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {existsSync, mkdtempSync, readdirSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Notebook} from "./notebook.ts"

describe("a notebook belongs to one opening of a project", () => {
    it("carries on for the same opening (a reconnect or a backend restart)", () => {
        const dir = mkdtempSync(join(tmpdir(), "notebook-"))
        new Notebook(dir, "song", "a").set("plan", "plan", "drums first", "…")
        assert.equal(new Notebook(dir, "song", "a").get("plan")?.summary, "drums first")
    })
    it("starts empty when the project is opened anew, and archives the old one", () => {
        const dir = mkdtempSync(join(tmpdir(), "notebook-"))
        const first = new Notebook(dir, "song", "a")
        first.set("plan", "plan", "drums first", "…")
        first.setAgentState({session: "s1", pending: null})
        const second = new Notebook(dir, "song", "b")
        assert.equal(second.get("plan"), null)
        assert.equal(second.agentState(), null)
        const archived = readdirSync(join(dir, "archive"))
        assert.equal(archived.length, 1)
        assert.ok(existsSync(join(dir, "archive", archived[0], "song.json")))
    })
    it("carries on when the page doesn't say which opening it is", () => {
        const dir = mkdtempSync(join(tmpdir(), "notebook-"))
        new Notebook(dir, "song", "a").set("plan", "plan", "drums first", "…")
        assert.equal(new Notebook(dir, "song").get("plan")?.summary, "drums first")
    })
})
