# Copy to LLM

Copy to LLM is a Visual Studio Code extension that allows you to easily copy the contents of directories or files in a format suitable for Large Language Models (LLMs).

## Features

- Copy the contents of a directory or multiple selected files/directories to a new document in LLM-friendly format.
- Copy the content of a single file to the clipboard in LLM-friendly format.
- Configurable file extensions to include when copying directories.
- Context menu integration in VS Code's file explorer.

## Installation

1. Open Visual Studio Code
2. Go to the Extensions view (Ctrl+Shift+X)
3. Search for "Copy to LLM"
4. Click Install

## Usage

1. Right-click on a file or folder in the VS Code explorer
2. Select "Copy to LLM" from the context menu
3. For directories or multiple selections:
   - A new document will open with the formatted content
4. For single files:
   - The formatted content will be copied to your clipboard

## Configuration

You can customize the file extensions that are included when copying directories:

1. Go to File > Preferences > Settings
2. Search for "Copy to LLM"
3. Edit the "copyToLLM.extensions" array to add or remove file extensions

Default extensions: [".ts", ".tsx", ".mjs", ".ex", ".heex", ".svelte"]

## Development

To run this extension in development mode:

1. Clone the repository
2. Run `npm install` to install dependencies
3. Open the project in VS Code
4. Press F5 to start debugging

To package the extension:

1. Run `npm run package`

## License

[MIT License](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter any problems or have any suggestions, please open an issue on the [GitHub repository](https://github.com/TKasperczyk/vscode-copy-to-llm).