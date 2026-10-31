// Shared by smoke.mjs and experiment.mjs: opens the studio, a new project and the bench panel.
export const openBench = async (page, url, timeout) => {
    // The dev server transforms modules on first request, so the first load is slow.
    const response = await page.goto(url, {waitUntil: "networkidle", timeout: 3 * timeout})
    await page.getByText("New Project", {exact: true}).click()
    await page.getByText("Add instrument").first().waitFor()
    // A fresh browser gets the welcome tour dialog; Escape closes it.
    await page.getByText("Welcome to openDAW").waitFor()
    await page.keyboard.press("Escape")
    await page.getByText("Welcome to openDAW").waitFor({state: "hidden"})
    await page.getByTestId("team-toggle").click()
    await page.getByTestId("bench-panel").waitFor()
    await page.waitForFunction(() => window.editBench !== undefined)
    return response
}
