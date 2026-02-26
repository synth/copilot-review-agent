# Copilot Review Agent — AI Branch Review

Diff your branch against a base, get AI-powered review findings as inline comments with a task list sidebar.

## Installing from GitHub

> The extension is not yet published to the VS Code Marketplace. Use these steps to install it directly from the repository.

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later (`node -v` to check)
- [npm](https://www.npmjs.com/) (bundled with Node.js)
- [VS Code](https://code.visualstudio.com/) 1.90 or later
- The **GitHub Copilot** extension installed and signed in to VS Code

### Steps

1. **Clone the repository:**
   ```bash
   git clone https://github.com/synth/copilot-review-agent.git
   cd copilot-review-agent
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build and package the extension:**
   ```bash
   npm run package
   ```
   This produces a file like `copilot-review-agent-0.1.0.vsix` in the project root.

4. **Install the `.vsix` in VS Code:**
   - Press `Cmd+Shift+P` → **Extensions: Install from VSIX...**
   - Select the generated `.vsix` file.
   - Press `Cmd+Shift+P` → **Developer: Reload Window**

5. **Use the extension:**
   - Open a Git repository in VS Code.
   - The **Copilot Review Agent** panel will appear in the Activity Bar (sidebar).
   - Select a base branch to diff against, then click **Review Branch** to start an AI-powered review.
   - Findings appear as inline comments and in the task list sidebar.

---

## Development

### Quick Reload (development mode)

Use this when you're actively developing and want to iterate quickly:

1. Compile the TypeScript source:
   ```bash
   npm run compile
   ```
   Or start the watcher for automatic recompilation on save:
   ```bash
   npm run watch
   ```
2. In VS Code, press `Cmd+Shift+P` → **Developer: Reload Window**

This works because VS Code loads the extension directly from the `out/` folder in the workspace.

### Full Package Install

Use this when you want to test the fully packaged extension (e.g. in a window outside the development workspace):

1. Build the `.vsix` file:
   ```bash
   npm run package
   ```
   This compiles the source and produces a file like `copilot-review-agent-0.1.0.vsix` in the project root.
2. In VS Code, press `Cmd+Shift+P` → **Extensions: Install from VSIX...**
3. Select the generated `.vsix` file.
4. Press `Cmd+Shift+P` → **Developer: Reload Window**
