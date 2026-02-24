# Self Review — AI Branch Review

Diff your branch against a base, get AI-powered review findings as inline comments with a task list sidebar.

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
   This compiles the source and produces a file like `self-review-0.1.0.vsix` in the project root.
2. In VS Code, press `Cmd+Shift+P` → **Extensions: Install from VSIX...**
3. Select the generated `.vsix` file.
4. Press `Cmd+Shift+P` → **Developer: Reload Window**
