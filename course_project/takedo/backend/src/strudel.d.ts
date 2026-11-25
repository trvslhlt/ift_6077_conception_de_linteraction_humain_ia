// Strudel ships no types; compose.ts uses one function and types its result where it reads it.
declare module "@strudel/mini" {
    export const mini: (text: string) => unknown
}
