# copilot-session-costs

A GitHub Copilot App canvas extension that lists your Copilot sessions and shows cost (AIU / USD), rate of change (last call, last 10, last hour), totals (today, yesterday, 3/7/30 days), parent/child grouping and per-model token breakdowns.

![Session costs (dummy data)](docs/screenshot.png)

## Install

**Ask an agent:**

> Install the extension from https://github.com/kewalaka/copilot-session-costs to user scope.

**Manual:**

- Open the Canvas (right hand) pane → Press '+' → Canvas → Import canvas from gist/URL
- Paste `https://github.com/kewalaka/copilot-session-costs`
- Choose User scope (~/.copilot)

It will then open the "Session costs" canvas.

## Subsequent use

Once installed, it will appear under '+' -> Canvas -> Session costs.

## Caveats

- Assumes 1 AIU = $0.01 (`AIU_USD` in `extension.mjs`).
- Reads the app's local SQLite stores read-only; internal schemas may change without notice.
- Requires a Node runtime with `node:sqlite`.

## Removal

- Go to Customize → Extensions → session-costs
- Use the link to delete from the file system (it installs under .copilot/extensions)
